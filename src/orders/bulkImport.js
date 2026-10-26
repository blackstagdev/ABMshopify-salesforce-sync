// One-time import of historical Shopify orders through the Salesforce Bulk
// API, instead of one event per order through the worker (several REST calls
// each, which the daily API allowance can't carry for 100k+ orders).
//
// It produces exactly what the live sync produces:
//   - orders and lines come from the same mapProviderOrder()
//   - New / Reorder from the customer's first Shopify order (by created_at)
//   - Account__c = the practice found by the customer's Provider ID; with no
//     Provider ID or no practice yet, the order goes in unlinked and the sync
//     links it when the practice is next upserted
//   - every Salesforce Id is saved in salesforce_orders, so later Shopify
//     edits update these records instead of creating new ones
// Only orders without a link are loaded (cancelled-before-synced ones are
// skipped, as live). Orders are keyed on the unique Shopify_Order_ID__c and
// lines on Shopify_Line_Item_ID__c, so Salesforce itself refuses a second
// copy. Re-running picks up whatever is still missing.
import { appendFileSync, createReadStream, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { join } from 'node:path';
import { mapProviderOrder } from '../mapping/plan.js';
import { soqlString } from '../salesforce/client.js';
import { toCsv } from '../csv.js';

export async function runOrderImport({
  shopify, sf, db, bulk, mapping, salesforce, apply, limit = Infinity, chunkSize = 5000, workDir, log = () => {},
}) {
  const summary = {
    shopify: { read: 0, alreadyInSalesforce: 0, cancelledNeverSynced: 0, blocked: 0, toImport: 0, linesToRepair: 0 },
    orders: { created: 0, alreadyInSalesforce: 0, failed: 0, linkedToPractice: 0, unlinked: 0, new: 0, reorder: 0 },
    lines: { created: 0, alreadyThere: 0, failed: 0 },
    eventsMarkedImported: 0,
    problems: [],
  };
  const problem = (order, error) => summary.problems.push({ order, error: String(error).slice(0, 300) });

  // --- Safety checks ---
  if (apply) {
    const w = await db.workerActivity();
    if (w.processing > 0 || w.finished > 0) {
      throw new Error(
        `The worker is still processing events (${w.processing} in progress, ${w.finished} finished in the last 3 minutes, last at ${w.last_finished?.toISOString?.() ?? w.last_finished}). ` +
        'Set WORKER_ENABLED=false on Render, wait until the redeploy is live and 3 minutes have passed, then run this again.',
      );
    }
  }
  const orderOp = await checkKeys(sf, salesforce);

  // --- What's already known ---
  log('Reading order links, practices and Provider IDs...');
  const links = await db.orderLinkSummary();
  const accounts = await accountsByProviderId(sf);
  const [namespace, key] = mapping.providerIdMetafield.split('.');
  const providerIds = new Map();
  for await (const page of shopify.listCustomersWithMetafield(namespace, key)) {
    for (const c of page) if (c.providerId) providerIds.set(String(c.id), c.providerId);
  }
  log(`${links.size} orders already linked, ${accounts.exact.size} practices with a Provider ID, ${providerIds.size} customers with a Provider ID.`);

  // --- Read Shopify: the orders still to load go to a file, not memory ---
  mkdirSync(workDir, { recursive: true });
  const pending = join(workDir, 'orders.jsonl');
  rmSync(pending, { force: true });
  const firstOrder = new Map(); // customer id -> { t, id }
  const limited = Number.isFinite(limit);

  log('Reading orders from Shopify...');
  pages: for await (const page of shopify.paginate('/orders.json?status=any&limit=250', 'orders')) {
    const out = [];
    for (const order of page) {
      summary.shopify.read++;
      const id = String(order.id);
      const customerId = order.customer?.id != null ? String(order.customer.id) : null;
      const t = Date.parse(order.created_at);
      if (customerId) {
        const first = firstOrder.get(customerId);
        if (!first || t < first.t || (t === first.t && Number(order.id) < Number(first.id))) firstOrder.set(customerId, { t, id });
      }

      const record = toRecord(order, mapping);
      const link = links.get(id);
      if (link) {
        if (link.has_lines || record.lines.length === 0) {
          summary.shopify.alreadyInSalesforce++;
          continue;
        }
        // In Salesforce, but its lines never got recorded (an earlier failure).
        record.repairOf = link.salesforce_id;
        record.accountId = link.account_id;
        summary.shopify.linesToRepair++;
      } else if (order.cancelled_at) {
        summary.shopify.cancelledNeverSynced++;
        continue;
      } else if (record.blockers.length) {
        summary.shopify.blocked++;
        problem(order.name, record.blockers.join('; '));
        continue;
      } else {
        summary.shopify.toImport++;
      }
      out.push(JSON.stringify(record));
      if (summary.shopify.toImport + summary.shopify.linesToRepair >= limit) {
        appendFileSync(pending, out.join('\n') + '\n');
        break pages;
      }
    }
    if (out.length) appendFileSync(pending, out.join('\n') + '\n');
    if (summary.shopify.read % 10_000 < 250) log(`  ${summary.shopify.read} Shopify orders read...`);
  }
  log(`${summary.shopify.read} read: ${summary.shopify.toImport} to import, ${summary.shopify.linesToRepair} need their lines, ${summary.shopify.alreadyInSalesforce} already in Salesforce.`);

  // A full read sees every order, so the first order per customer is known.
  // A --limit run stops early, so it asks Shopify, exactly as the live sync.
  const firstCache = new Map();
  async function isFirstOrder(record) {
    if (!limited) return firstOrder.get(record.customerId)?.id === record.id;
    if (!firstCache.has(record.customerId)) {
      const ctx = await shopify.getCustomerContext(record.customerId, namespace, key, { withFirstOrder: true });
      firstCache.set(record.customerId, ctx.firstOrderId != null ? String(ctx.firstOrderId) : null);
    }
    return firstCache.get(record.customerId) === record.id;
  }

  // --- Load, a chunk at a time ---
  let chunk = [];
  let chunkNo = 0;
  const flush = async () => {
    if (!chunk.length) return;
    chunkNo++;
    await loadChunk(chunk, chunkNo);
    chunk = [];
  };
  const lines = createInterface({ input: createReadStream(pending), crlfDelay: Infinity });
  for await (const line of lines) {
    if (!line) continue;
    chunk.push(JSON.parse(line));
    if (chunk.length >= chunkSize) await flush();
  }
  await flush();

  writeFileSync(join(workDir, 'problems.csv'), toCsv(['order', 'error'], summary.problems));
  return summary;

  async function loadChunk(records, n) {
    // Finish each order: New/Reorder and the practice link.
    for (const r of records) {
      if (r.repairOf) continue;
      if (r.customerId) {
        const first = await isFirstOrder(r);
        r.fields.Order_Type__c = first ? 'New' : 'Reorder';
        summary.orders[first ? 'new' : 'reorder']++;
      }
      const pid = r.customerId ? providerIds.get(r.customerId) : null;
      r.accountId = pid ? (accounts.exact.get(pid) ?? accounts.lower.get(pid.toLowerCase()) ?? null) : null;
      if (r.accountId) r.fields.Account__c = r.accountId;
      summary.orders[r.accountId ? 'linkedToPractice' : 'unlinked']++;
    }
    const fresh = records.filter((r) => !r.repairOf).sort((a, b) => String(a.accountId ?? '').localeCompare(String(b.accountId ?? '')));

    if (!apply) {
      if (n === 1) writeSamples(fresh);
      summary.orders.created += fresh.length;
      summary.lines.created += records.reduce((sum, r) => sum + r.lines.length, 0);
      return;
    }

    log(`Chunk ${n}: ${fresh.length} orders, ${records.length - fresh.length} line repairs...`);
    const byId = new Map(records.map((r) => [r.id, r]));
    const salesforceIdOf = new Map(records.filter((r) => r.repairOf).map((r) => [r.id, r.repairOf]));
    const existingInSalesforce = new Set(records.filter((r) => r.repairOf).map((r) => r.id));

    // 1. Orders. The link is saved straight away, so a later failure never
    // loses a Salesforce Id.
    if (fresh.length) {
      const res = await bulk.run({
        object: salesforce.orderObject,
        operation: orderOp,
        externalIdFieldName: orderOp === 'upsert' ? 'Shopify_Order_ID__c' : undefined,
        csv: toCsv(columnsOf(fresh.map((r) => r.fields)), fresh.map((r) => r.fields)),
      });
      for (const row of res.ok) {
        const r = byId.get(row.Shopify_Order_ID__c);
        if (!r) continue;
        salesforceIdOf.set(r.id, row.sf__Id);
        if (row.sf__Created === 'false') {
          existingInSalesforce.add(r.id);
          summary.orders.alreadyInSalesforce++;
        } else {
          summary.orders.created++;
        }
        const prior = await db.getOrderLink(r.id);
        await db.saveOrderLink({
          shopifyOrderId: r.id, salesforceId: row.sf__Id, shopifyCustomerId: r.customerId, accountId: r.accountId, lines: prior?.lines ?? {},
        });
      }
      for (const row of res.failed) {
        summary.orders.failed++;
        problem(byId.get(row.Shopify_Order_ID__c)?.number ?? row.Shopify_Order_ID__c, row.sf__Error);
      }
    }

    // 2. Lines. Orders that were already in Salesforce may have some: those
    // are read first so only missing lines are added.
    const known = await existingLines(sf, salesforce, [...existingInSalesforce].map((id) => salesforceIdOf.get(id)));
    const orderOfSalesforceId = new Map([...salesforceIdOf].map(([shopifyId, sfId]) => [sfId, shopifyId]));
    const lineRows = [];
    const skipLines = new Set();
    for (const [shopifyId, sfId] of salesforceIdOf) {
      const have = known.get(sfId) ?? { byLine: {}, unmatched: 0 };
      if (have.unmatched > 0) {
        // Lines we can't tell apart: adding ours could double them.
        skipLines.add(shopifyId);
        problem(byId.get(shopifyId).number, 'Already in Salesforce with order lines that have no Shopify line ID; lines left as they are');
        continue;
      }
      for (const l of byId.get(shopifyId).lines) {
        if (have.byLine[l.lineId]) summary.lines.alreadyThere++;
        else lineRows.push({ Provider_Order__c: sfId, ...l.fields });
      }
    }

    const newLines = new Map(); // shopify order id -> { lineId: sfId }
    const lineFailures = new Set();
    if (lineRows.length) {
      const res = await bulk.run({
        object: salesforce.orderLineObject,
        operation: 'insert',
        csv: toCsv(columnsOf(lineRows), lineRows),
      });
      for (const row of res.ok) {
        const shopifyId = orderOfSalesforceId.get(row.Provider_Order__c);
        if (!newLines.has(shopifyId)) newLines.set(shopifyId, {});
        newLines.get(shopifyId)[row.Shopify_Line_Item_ID__c] = row.sf__Id;
        summary.lines.created++;
      }
      for (const row of res.failed) {
        const shopifyId = orderOfSalesforceId.get(row.Provider_Order__c);
        lineFailures.add(shopifyId);
        summary.lines.failed++;
        problem(byId.get(shopifyId)?.number ?? row.Provider_Order__c, `line ${row.Shopify_Line_Item_ID__c}: ${row.sf__Error}`);
      }
    }

    // 3. Record the lines, and close the queued backfill events of complete orders.
    const complete = [];
    for (const [shopifyId, sfId] of salesforceIdOf) {
      const r = byId.get(shopifyId);
      const prior = await db.getOrderLink(shopifyId);
      const lineIds = { ...(prior?.lines ?? {}), ...(known.get(sfId)?.byLine ?? {}), ...(newLines.get(shopifyId) ?? {}) };
      await db.saveOrderLink({
        shopifyOrderId: shopifyId, salesforceId: sfId, shopifyCustomerId: r.customerId ?? prior?.shopify_customer_id ?? null,
        accountId: prior?.account_id ?? r.accountId ?? null, lines: lineIds,
      });
      if (!lineFailures.has(shopifyId) && !skipLines.has(shopifyId)) complete.push(shopifyId);
    }
    summary.eventsMarkedImported += await db.markOrdersImported(complete);
    log(`Chunk ${n} done: ${summary.orders.created} orders and ${summary.lines.created} lines created so far, ${summary.orders.failed + summary.lines.failed} failed.`);
  }

  function writeSamples(fresh) {
    const sample = fresh.slice(0, 200);
    writeFileSync(join(workDir, 'sample-orders.csv'), toCsv(columnsOf(sample.map((r) => r.fields)), sample.map((r) => r.fields)));
    const sampleLines = sample.flatMap((r) => r.lines.map((l) => ({ Provider_Order__c: `(order ${r.number})`, ...l.fields })));
    writeFileSync(join(workDir, 'sample-lines.csv'), toCsv(columnsOf(sampleLines), sampleLines));
  }
}

// What the importer keeps of a Shopify order: the mapped fields (New/Reorder
// and the practice are added later) and the lines Salesforce should have.
export function toRecord(order, mapping) {
  const mapped = mapProviderOrder(order, mapping, {});
  return {
    id: String(order.id),
    number: order.name,
    customerId: order.customer?.id != null ? String(order.customer.id) : null,
    fields: mapped.fields,
    lines: mapped.lines.filter((l) => !l.remove).map((l) => ({ lineId: l.shopifyLineId, fields: l.fields })),
    blockers: mapped.blockers,
  };
}

// Duplicates are only impossible if Salesforce enforces the Shopify IDs as
// unique. Upsert also needs the order key to be an External ID.
async function checkKeys(sf, salesforce) {
  const field = async (object, name) => {
    const { data } = await sf.request('GET', `/sobjects/${object}/describe`);
    return data.fields.find((f) => f.name === name);
  };
  const orderKey = await field(salesforce.orderObject, 'Shopify_Order_ID__c');
  const lineKey = await field(salesforce.orderLineObject, 'Shopify_Line_Item_ID__c');
  if (!orderKey?.unique || !lineKey?.unique) {
    throw new Error('Shopify_Order_ID__c and Shopify_Line_Item_ID__c must both be Unique in Salesforce, or a re-run could duplicate orders. Ask the Salesforce team to tick Unique on them.');
  }
  return orderKey.externalId ? 'upsert' : 'insert';
}

async function accountsByProviderId(sf) {
  const rows = await sf.queryAll('SELECT Id, Provider_ID__c FROM Account WHERE Provider_ID__c != null');
  const exact = new Map();
  const lower = new Map();
  for (const r of rows) {
    exact.set(r.Provider_ID__c, r.Id);
    lower.set(r.Provider_ID__c.toLowerCase(), r.Id);
  }
  return { exact, lower };
}

// Salesforce order Id -> { byLine: { shopify line id: Id }, unmatched: lines without one }
async function existingLines(sf, salesforce, orderIds) {
  const found = new Map();
  for (let i = 0; i < orderIds.length; i += 150) {
    const ids = orderIds.slice(i, i + 150);
    const rows = await sf.queryAll(
      `SELECT Id, Provider_Order__c, Shopify_Line_Item_ID__c FROM ${salesforce.orderLineObject} WHERE Provider_Order__c IN (${ids.map(soqlString).join(',')})`,
    );
    for (const row of rows) {
      const entry = found.get(row.Provider_Order__c) ?? { byLine: {}, unmatched: 0 };
      if (row.Shopify_Line_Item_ID__c) entry.byLine[row.Shopify_Line_Item_ID__c] = row.Id;
      else entry.unmatched++;
      found.set(row.Provider_Order__c, entry);
    }
  }
  return found;
}

function columnsOf(rows) {
  const columns = new Set();
  for (const r of rows) for (const k of Object.keys(r)) columns.add(k);
  return [...columns];
}
