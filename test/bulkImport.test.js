import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runOrderImport, toRecord } from '../src/orders/bulkImport.js';
import { mapProviderOrder } from '../src/mapping/plan.js';
import { parseCsv, toCsv } from '../src/csv.js';

const mapping = { lineOfBusiness: 'Alpha BioMed', providerIdMetafield: 'custom.provider_id' };
const salesforce = { orderObject: 'Provider_Order__c', orderLineObject: 'Order_Product__c' };

const order = (id, customerId, createdAt, extra = {}) => ({
  id, name: `ABM-${id}`, created_at: createdAt, financial_status: 'paid', current_subtotal_price: '100.00',
  customer: customerId ? { id: customerId } : null,
  line_items: [{ id: id * 10, title: 'Cu GLOW', quantity: 2, current_quantity: 2, price: '50.00', sku: 'CU-1', product_id: 5, variant_id: 6 }],
  ...extra,
});

// Shopify returns newest first.
const ORDERS = [
  order(5, 900, '2026-03-01T10:00:00-05:00'),
  order(4, 900, '2026-02-01T10:00:00-05:00'), // already synced
  order(3, 901, '2026-01-15T10:00:00-05:00', { cancelled_at: '2026-01-16T00:00:00-05:00' }),
  order(2, null, '2026-01-10T10:00:00-05:00'), // guest
  order(1, 900, '2026-01-01T10:00:00-05:00'),
];

function fakes({ workerActive = false, unique = true, failLine = null } = {}) {
  const links = new Map([['4', { shopify_order_id: '4', salesforce_id: 'a0O4', account_id: '001P', has_lines: true }]]);
  const saved = new Map();
  const marked = [];
  const jobs = [];
  let n = 0;
  const db = {
    async workerActive() { return workerActive; },
    async orderLinkSummary() { return links; },
    async getOrderLink(id) { return saved.get(id) ?? null; },
    async saveOrderLink(link) { saved.set(link.shopifyOrderId, { ...link, lines: link.lines, account_id: link.accountId }); },
    async markOrdersImported(ids) { marked.push(...ids); return ids.length; },
  };
  const sf = {
    async request(method, path) {
      return { data: { fields: [
        { name: 'Shopify_Order_ID__c', unique, externalId: true },
        { name: 'Shopify_Line_Item_ID__c', unique, externalId: true },
      ] } };
    },
    async queryAll(soql) {
      if (soql.includes('FROM Account')) return [{ Id: '001P', Provider_ID__c: 'GHL900' }];
      return [];
    },
  };
  const shopify = {
    async *listCustomersWithMetafield() { yield [{ id: '900', providerId: 'GHL900' }, { id: '901', providerId: null }]; },
    async *paginate() { yield ORDERS; },
    async getCustomerContext() { return { firstOrderId: 1 }; },
  };
  const bulk = {
    async run({ object, operation, csv }) {
      const rows = parseCsv(csv);
      jobs.push({ object, operation, rows });
      const failed = rows.filter((r) => r.Shopify_Line_Item_ID__c === failLine);
      const ok = rows.filter((r) => !failed.includes(r)).map((r) => ({ sf__Id: `sf${++n}`, sf__Created: 'true', ...r }));
      return { ok, failed: failed.map((r) => ({ sf__Error: 'REQUIRED_FIELD_MISSING', ...r })) };
    },
  };
  return { db, sf, shopify, bulk, saved, marked, jobs };
}

const workDir = () => mkdtempSync(join(tmpdir(), 'bulk-'));

test('imports only missing orders, with New/Reorder and the practice link', async () => {
  const f = fakes();
  const s = await runOrderImport({ ...f, mapping, salesforce, apply: true, workDir: workDir() });

  assert.deepEqual(s.shopify, { read: 5, alreadyInSalesforce: 1, cancelledNeverSynced: 1, blocked: 0, toImport: 3, linesToRepair: 0 });
  const [orders, lines] = f.jobs;
  assert.equal(orders.object, 'Provider_Order__c');
  assert.equal(orders.operation, 'upsert');
  const byId = Object.fromEntries(orders.rows.map((r) => [r.Shopify_Order_ID__c, r]));
  assert.deepEqual(Object.keys(byId).sort(), ['1', '2', '5']);
  assert.equal(byId['1'].Order_Type__c, 'New');
  assert.equal(byId['5'].Order_Type__c, 'Reorder');
  assert.equal(byId['2'].Order_Type__c, '', 'guests have no order type');
  assert.equal(byId['1'].Account__c, '001P');
  assert.equal(byId['2'].Account__c, '', 'no Provider ID: unlinked');

  assert.equal(lines.object, 'Order_Product__c');
  assert.equal(lines.operation, 'insert');
  assert.equal(lines.rows.length, 3);
  assert.ok(lines.rows.every((r) => r.Provider_Order__c.startsWith('sf')));

  // Links saved with order and line Ids, so later edits update them.
  const link = f.saved.get('5');
  assert.equal(link.accountId, '001P');
  assert.deepEqual(Object.keys(link.lines), ['50']);
  assert.deepEqual(f.marked.sort(), ['1', '2', '5']);
  assert.equal(s.orders.linkedToPractice, 2);
  assert.equal(s.orders.unlinked, 1);
});

test('the order fields are exactly what the live sync sends', () => {
  const o = ORDERS[0];
  const live = mapProviderOrder(o, mapping, { isFirstOrder: false });
  const record = toRecord(o, mapping);
  assert.deepEqual({ ...record.fields, Order_Type__c: 'Reorder' }, live.fields);
  assert.deepEqual(record.lines.map((l) => l.fields), live.lines.map((l) => l.fields));
});

test('dry run sends and saves nothing, and writes samples', async () => {
  const f = fakes({ workerActive: true });
  const dir = workDir();
  const s = await runOrderImport({ ...f, mapping, salesforce, apply: false, workDir: dir });
  assert.equal(f.jobs.length, 0);
  assert.equal(f.saved.size, 0);
  assert.equal(f.marked.length, 0);
  assert.equal(s.orders.created, 3);
  assert.equal(parseCsv(readFileSync(join(dir, 'sample-orders.csv'), 'utf8')).length, 3);
});

test('refuses to write while the worker is running', async () => {
  const f = fakes({ workerActive: true });
  await assert.rejects(runOrderImport({ ...f, mapping, salesforce, apply: true, workDir: workDir() }), /WORKER_ENABLED=false/);
});

test('refuses when Salesforce does not enforce unique Shopify IDs', async () => {
  const f = fakes({ unique: false });
  await assert.rejects(runOrderImport({ ...f, mapping, salesforce, apply: true, workDir: workDir() }), /Unique/);
});

test('an order whose line failed is linked but its event stays open', async () => {
  const f = fakes({ failLine: '50' });
  const s = await runOrderImport({ ...f, mapping, salesforce, apply: true, workDir: workDir() });
  assert.equal(s.lines.failed, 1);
  assert.ok(f.saved.has('5'), 'the order Id is still recorded');
  assert.deepEqual(f.marked.sort(), ['1', '2']);
});

test('a --limit run asks Shopify for the first order', async () => {
  const f = fakes();
  const s = await runOrderImport({ ...f, mapping, salesforce, apply: true, limit: 1, workDir: workDir() });
  assert.equal(s.shopify.toImport, 1);
  assert.equal(f.jobs[0].rows[0].Order_Type__c, 'Reorder', 'order 5 is not the first (Shopify says 1)');
});

test('csv round trip keeps commas, quotes and new lines', () => {
  const rows = [{ a: 'x, "y"', b: 'line1\nline2' }, { a: '', b: 3 }];
  assert.deepEqual(parseCsv(toCsv(['a', 'b'], rows)), [{ a: 'x, "y"', b: 'line1\nline2' }, { a: '', b: '3' }]);
});
