// Replaces old UUID Provider IDs with the GHL contact ID that Shopify holds
// for the same customer, for the Accounts behind the DUPLICATE_VALUE on
// Shopify_ID__c failures (see report-shopify-id-conflicts). Only
// Provider_ID__c changes; the checks are in src/salesforce/providerIdFix.js.
//
//   npm run -s fix-uuid-provider-ids                      dry run: what would change
//   npm run -s fix-uuid-provider-ids -- --apply --limit=5  try a few first
//   npm run -s fix-uuid-provider-ids -- --apply            the rest
//
// Writes provider-id-fix.csv (download: /admin/reports/provider-id-fix.csv).
// It lists every Account with its old UUID, so the change can be undone.
// With --apply, the newest failed event per fixed customer and per order is
// re-queued, so the worker re-sends them to the now-matching practices.
import { writeFileSync } from 'node:fs';
import { config } from '../src/config.js';
import { toCsv } from '../src/csv.js';
import { createDb } from '../src/db.js';
import { createSalesforceClient, soqlString } from '../src/salesforce/client.js';
import { createShopifyAdmin } from '../src/shopify/admin.js';
import { planProviderIdFixes } from '../src/salesforce/providerIdFix.js';

const apply = process.argv.includes('--apply');
const limit = Number(process.argv.find((a) => a.startsWith('--limit='))?.split('=')[1]) || Infinity;
if (apply && config.salesforce.mode !== 'live') {
  console.error('--apply needs SALESFORCE_MODE=live.');
  process.exit(1);
}
const [namespace, key] = config.mapping.providerIdMetafield.split('.');
if (!namespace || !key) {
  console.error('PROVIDER_ID_METAFIELD must be "namespace.key".');
  process.exit(1);
}

const db = createDb(config);
const sf = createSalesforceClient(config.salesforce);
const shopify = createShopifyAdmin(config.shopify);
const log = (msg) => process.stderr.write(`${msg}\n`);
const chunks = (items, size) => Array.from({ length: Math.ceil(items.length / size) }, (_, i) => items.slice(i * size, i * size + size));
const ERROR = '%Shopify_ID__c duplicates value%';

console.log(apply ? 'APPLYING changes to Salesforce.' : 'DRY RUN: nothing will be written.');

// 1. The Accounts in the way, from the failed events.
const { rows: failures } = await db.pool.query(
  `SELECT coalesce(payload->'customer'->>'id', payload->>'id') AS customer_id, last_error
   FROM shopify_events WHERE status = 'failed' AND last_error LIKE $1`,
  [ERROR],
);
const byAccount = new Map();
for (const f of failures) {
  const accountId = f.last_error.match(/record with id: (\w+)/)?.[1];
  if (!accountId) continue;
  const c = byAccount.get(accountId) ?? { accountId, shopifyCustomerId: String(f.customer_id), failedEvents: 0 };
  c.failedEvents++;
  byAccount.set(accountId, c);
}
const candidates = [...byAccount.values()].sort((a, b) => b.failedEvents - a.failedEvents);
if (candidates.length === 0) {
  console.log('No Shopify_ID__c conflicts left.');
  await db.pool.end();
  process.exit(0);
}
log(`${failures.length} failed events, ${candidates.length} Accounts.`);

// 2. Live values: the Accounts now, Shopify's Provider IDs now, and who holds those IDs.
const accounts = new Map();
for (const ids of chunks(candidates.map((c) => c.accountId), 200)) {
  for (const a of await sf.query(`SELECT Id, Name, Provider_ID__c, Shopify_ID__c FROM Account WHERE Id IN (${ids.map(soqlString).join(',')})`)) {
    accounts.set(a.Id, a);
  }
}
const shopifyIds = new Map();
for (const ids of chunks(candidates.map((c) => c.shopifyCustomerId), 100)) {
  for (const [k, v] of await shopify.getProviderIds(ids, namespace, key)) shopifyIds.set(k, v);
}
const takenBy = new Map();
const wanted = [...new Set([...shopifyIds.values()].filter(Boolean))];
for (const ids of chunks(wanted, 200)) {
  for (const a of await sf.query(`SELECT Id, Provider_ID__c FROM Account WHERE Provider_ID__c IN (${ids.map(soqlString).join(',')})`)) {
    takenBy.set(String(a.Provider_ID__c).toUpperCase(), a.Id);
  }
}

// 3. Decide, then (with --apply) write.
const rows = planProviderIdFixes(candidates, accounts, shopifyIds, takenBy);
let toUpdate = rows.filter((r) => r.action === 'update');
if (toUpdate.length > limit) {
  const keep = new Set(toUpdate.slice(0, limit).map((r) => r.accountId));
  for (const r of rows) if (r.action === 'update' && !keep.has(r.accountId)) Object.assign(r, { action: 'skip', reason: 'Over --limit; run again' });
  toUpdate = rows.filter((r) => r.action === 'update');
}

const fixedCustomers = [];
if (apply) {
  for (const batch of chunks(toUpdate, 200)) {
    const res = await sf.request('PATCH', '/composite/sobjects', {
      allOrNone: false,
      records: batch.map((r) => ({ attributes: { type: 'Account' }, id: r.accountId, Provider_ID__c: r.newProviderId })),
    });
    batch.forEach((r, i) => {
      const out = res.data?.[i];
      if (out?.success) {
        r.result = 'updated';
        fixedCustomers.push(r.shopifyCustomerId);
      } else {
        r.result = 'error';
        r.reason = (out?.errors ?? []).map((e) => `${e.statusCode}: ${e.message}`).join('; ') || 'unknown error';
      }
    });
  }
}

// 4. Re-send: the newest event per fixed customer and per order, when that
// newest event failed on this conflict.
let requeued = 0;
if (fixedCustomers.length > 0) {
  ({ rowCount: requeued } = await db.pool.query(
    `UPDATE shopify_events
     SET status = 'pending', attempts = 0, next_attempt_at = now(), last_error = NULL, locked_at = NULL
     WHERE id IN (
       SELECT id FROM (
         SELECT DISTINCT ON (split_part(topic, '/', 1), payload->>'id') id, status, last_error,
                coalesce(payload->'customer'->>'id', payload->>'id') AS customer_id
         FROM shopify_events
         WHERE split_part(topic, '/', 1) IN ('customers', 'orders')
         ORDER BY split_part(topic, '/', 1), payload->>'id', id DESC
       ) latest
       WHERE status = 'failed' AND last_error LIKE $1 AND customer_id = ANY($2)
     )`,
    [ERROR, fixedCustomers],
  ));
}

const csvPath = 'provider-id-fix.csv';
writeFileSync(csvPath, toCsv(
  ['Account', 'Salesforce Account Id', 'Old Provider ID (UUID)', 'New Provider ID (GHL)', 'Shopify customer id', 'Failed events', 'Action', 'Result', 'Reason'],
  rows.map((r) => ({
    Account: r.name,
    'Salesforce Account Id': r.accountId,
    'Old Provider ID (UUID)': r.oldProviderId,
    'New Provider ID (GHL)': r.newProviderId,
    'Shopify customer id': r.shopifyCustomerId,
    'Failed events': r.failedEvents,
    Action: r.action,
    Result: r.result ?? (apply ? '' : 'dry run'),
    Reason: r.reason,
  })),
));

const counts = {};
for (const r of rows) {
  const k = r.action === 'update' ? (r.result ?? 'would update') : `skip: ${r.reason}`;
  counts[k] = (counts[k] ?? 0) + 1;
}
console.log(`\n${candidates.length} Accounts:`);
for (const [k, n] of Object.entries(counts).sort((a, b) => b[1] - a[1])) console.log(`  ${String(n).padStart(5)}  ${k}`);
if (apply) console.log(`\nRe-queued ${requeued} event(s) (newest per customer / order) for the worker.`);
console.log(`\nSaved as ${csvPath} (download: /admin/reports/${csvPath}). Keep it: it has every old UUID.`);
if (!apply) console.log('\nThis was a dry run. Add --apply to write (start with --limit=5).');

await db.pool.end();
