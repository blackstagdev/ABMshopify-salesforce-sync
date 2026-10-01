import { test } from 'node:test';
import assert from 'node:assert/strict';
import { executePlan } from '../src/salesforce/executor.js';
import { processEvent } from '../src/processor.js';
import { BlockedError, SalesforceError } from '../src/errors.js';
import { backoffSeconds } from '../src/worker.js';

// A fake Salesforce that records calls and answers from simple rules.
function fakeSf({ accountExists = false, contacts = [], account = {}, collectionFails = false } = {}) {
  const calls = [];
  let nextId = 0;
  return {
    calls,
    async request(method, path, body) {
      calls.push({ method, path, body });
      if (method === 'GET' && path.includes('Provider_ID__c')) {
        if (!accountExists) throw new SalesforceError('not found', 404);
        return { status: 200, data: { Id: '001EXISTING', ...account } };
      }
      if (method === 'PATCH' && path.includes('Provider_ID__c')) return { status: 201, data: { id: '001NEW' } };
      if (path.startsWith('/composite/sobjects')) {
        const count = body?.records?.length ?? path.split('ids=')[1].split('&')[0].split(',').length;
        return {
          status: 200,
          data: Array.from({ length: count }, () => (collectionFails
            ? { success: false, errors: [{ statusCode: 'REQUIRED_FIELD_MISSING', message: 'Unit Price' }] }
            : { success: true, id: `a1LINE${++nextId}` })),
        };
      }
      if (method === 'POST' && path === '/sobjects/Provider_Order__c') return { status: 201, data: { id: `a0ORDER${++nextId}` } };
      if (method === 'POST') return { status: 201, data: { id: '003NEW' } };
      return { status: 204, data: null };
    },
    async query(soql) {
      calls.push({ method: 'QUERY', soql });
      if (soql.includes('FROM RecordType')) return [{ Id: '012CUSTOMER' }];
      return contacts;
    },
  };
}

// The salesforce_orders table, in memory.
function fakeStore() {
  const rows = new Map();
  return {
    rows,
    async getOrderLink(id) { return rows.get(id) ?? null; },
    async saveOrderLink(l) {
      rows.set(l.shopifyOrderId, {
        shopify_order_id: l.shopifyOrderId, salesforce_id: l.salesforceId, shopify_customer_id: l.shopifyCustomerId,
        account_id: l.accountId, lines: { ...l.lines },
      });
    },
    async unlinkedOrdersForCustomer(cid) {
      return [...rows.values()].filter((r) => r.shopify_customer_id === cid && !r.account_id);
    },
  };
}

const sfOpts = { accountRecordType: 'Customer', orderObject: 'Provider_Order__c', orderLineObject: 'Order_Product__c' };

const plan = {
  ops: [
    { op: 'upsertAccount', providerId: 'ABM 1/2', createFields: { Name: 'Clinic', Phone: '1' }, updateFields: { Phone: '1' } },
    { op: 'upsertContact', email: "o'neil@clinic.com", fields: { LastName: "O'Neil", Email: "o'neil@clinic.com" } },
  ],
  warnings: [],
  blockers: [],
};

test('new practice: upsert with record type, then create contact', async () => {
  const sf = fakeSf();
  const results = await executePlan(plan, sf, sfOpts);

  const upsert = sf.calls.find((c) => c.method === 'PATCH');
  assert.equal(upsert.path, '/sobjects/Account/Provider_ID__c/ABM%201%2F2');
  assert.equal(upsert.body.RecordTypeId, '012CUSTOMER');
  assert.equal(upsert.body.Name, 'Clinic');

  const contactQuery = sf.calls.find((c) => c.soql?.includes('FROM Contact'));
  assert.match(contactQuery.soql, /Email = 'o\\'neil@clinic.com'/);

  const create = sf.calls.find((c) => c.method === 'POST');
  assert.equal(create.body.AccountId, '001NEW');
  assert.deepEqual(results.map((r) => r.action), ['created', 'created']);
});

test('existing practice: update by Id without Name or RecordTypeId, update matched contact', async () => {
  const sf = fakeSf({ accountExists: true, contacts: [{ Id: '003OLD' }] });
  const results = await executePlan(plan, sf, sfOpts);

  const patches = sf.calls.filter((c) => c.method === 'PATCH');
  assert.equal(patches[0].path, '/sobjects/Account/001EXISTING');
  assert.deepEqual(patches[0].body, { Phone: '1' });
  assert.equal(patches[1].path, '/sobjects/Contact/003OLD');
  assert.deepEqual(results.map((r) => r.action), ['updated', 'updated']);
});

test('processor: dry run never calls Salesforce; live mode refuses plans with blockers', async () => {
  const event = { topic: 'customers/create', payload: { id: 1, email: 'a@b.com', last_name: 'B', tags: '' } };
  const mapping = { providerIdStrategy: 'none', lineOfBusiness: 'Alpha BioMed' };

  const dry = await processEvent(event, { mode: 'dry_run', mapping, sf: null });
  assert.equal(dry.status, 'dry_run');

  await assert.rejects(processEvent(event, { mode: 'live', mapping, sf: fakeSf() }), BlockedError);

  const ignored = await processEvent({ topic: 'products/create', payload: {} }, { mode: 'live', mapping });
  assert.equal(ignored.status, 'ignored');
});

test('only 429 and 5xx Salesforce errors are retried; backoff is capped', () => {
  assert.equal(new SalesforceError('x', 400).retryable, false);
  assert.equal(new SalesforceError('x', 429).retryable, true);
  assert.equal(new SalesforceError('x', 503).retryable, true);
  assert.equal(backoffSeconds(1), 30);
  assert.equal(backoffSeconds(3), 120);
  assert.equal(backoffSeconds(20), 3600);
});

test('processor looks up Provider ID, order count and first order from Shopify, even in dry run', async () => {
  const lookups = [];
  const shopify = {
    async getCustomerContext(id, namespace, key) {
      lookups.push([id, namespace, key]);
      return { providerIdMetafield: 'PROV-1', numberOfOrders: 2, firstOrderId: '900' };
    },
  };
  const mapping = { providerIdStrategy: 'customer_metafield', providerIdMetafield: 'custom.provider_id', lineOfBusiness: 'Alpha BioMed', orderSyncEnabled: true };
  const event = { topic: 'customers/update', payload: { id: 42, email: 'a@b.com', last_name: 'B' } };

  const { status, result } = await processEvent(event, { mode: 'dry_run', mapping, shopify });
  assert.equal(status, 'dry_run');
  assert.deepEqual(lookups, [[42, 'custom', 'provider_id']]);
  assert.equal(result.ops[0].providerId, 'PROV-1');
  assert.equal(result.ops[0].createFields.ABM_Status__c, 'Active');

  const orderEvent = { topic: 'orders/create', payload: { id: 901, created_at: '2026-10-01T09:00:00-07:00', total_price: '10', customer: { id: 42, last_name: 'B' }, email: 'a@b.com', line_items: [] } };
  const order = (await processEvent(orderEvent, { mode: 'dry_run', mapping, shopify })).result.ops.at(-1);
  assert.equal(order.fields.Order_Type__c, 'Reorder', 'order 901 is not the first order (900)');

  await assert.rejects(
    processEvent(event, { mode: 'dry_run', mapping: { ...mapping, providerIdMetafield: 'provider_id' }, shopify }),
    /namespace\.key/,
  );
});

// --- Alpha BioMed Status ---

const statusPlan = (abmStatus, fromNewOrder = false) => ({
  ops: [{ op: 'upsertAccount', providerId: 'P1', createFields: { Name: 'Clinic', ABM_Status__c: abmStatus }, updateFields: { Phone: '1' }, abmStatus, fromNewOrder }],
});
const accountPatch = (sf) => sf.calls.find((c) => c.method === 'PATCH' && c.path === '/sobjects/Account/001EXISTING')?.body;

test('status is set on create and moved forward on update', async () => {
  const created = fakeSf();
  await executePlan(statusPlan('Prospect'), created, sfOpts);
  assert.equal(created.calls.find((c) => c.method === 'PATCH').body.ABM_Status__c, 'Prospect');

  const blank = fakeSf({ accountExists: true, account: { ABM_Status__c: null } });
  await executePlan(statusPlan('Prospect'), blank, sfOpts);
  assert.equal(accountPatch(blank).ABM_Status__c, 'Prospect');

  const upgrade = fakeSf({ accountExists: true, account: { ABM_Status__c: 'Prospect' } });
  await executePlan(statusPlan('Active'), upgrade, sfOpts);
  assert.equal(accountPatch(upgrade).ABM_Status__c, 'Active');

  const noDowngrade = fakeSf({ accountExists: true, account: { ABM_Status__c: 'Active' } });
  await executePlan(statusPlan('Prospect'), noDowngrade, sfOpts);
  assert.equal('ABM_Status__c' in accountPatch(noDowngrade), false);
});

test('status is never sent once an Alpha BioMed Owner is assigned', async () => {
  const sf = fakeSf({ accountExists: true, account: { ABM_Owner__c: '005REP', ABM_Status__c: 'Prospect' } });
  const [result] = await executePlan(statusPlan('Active'), sf, sfOpts);
  assert.deepEqual(accountPatch(sf), { Phone: '1' });
  assert.match(result.warning, /left to the rep/);
});

test('Lapsed is kept, except when the practice places a new order', async () => {
  const kept = fakeSf({ accountExists: true, account: { ABM_Status__c: 'Lapsed' } });
  await executePlan(statusPlan('Active'), kept, sfOpts);
  assert.equal('ABM_Status__c' in accountPatch(kept), false);

  const reactivated = fakeSf({ accountExists: true, account: { ABM_Status__c: 'Lapsed' } });
  await executePlan(statusPlan('Active', true), reactivated, sfOpts);
  assert.equal(accountPatch(reactivated).ABM_Status__c, 'Active');
});

// --- Provider Orders ---

const orderOp = (extra = {}) => ({
  op: 'upsertOrder', shopifyOrderId: '5001', shopifyCustomerId: '77', orderNumber: '#1001', linked: true, cancelled: false,
  fields: { Line_of_Business__c: 'Alpha BioMed', Order_Amount__c: 240, Order_Date__c: '2026-09-20', Paid__c: true },
  lines: [
    { shopifyLineId: '11', remove: false, fields: { Quantity__c: 2, Unit_Price__c: 120, Product_Name__c: 'Kit' } },
    { shopifyLineId: '12', remove: false, fields: { Quantity__c: 1, Unit_Price__c: 20, Product_Name__c: 'Cap' } },
  ],
  ...extra,
});
const accountOp = { op: 'upsertAccount', providerId: 'P1', createFields: { Name: 'Clinic' }, updateFields: {}, shopifyCustomerId: '77' };

test('new order: Provider Order linked to the practice, lines created, link stored', async () => {
  const sf = fakeSf({ accountExists: true });
  const store = fakeStore();
  const [, result] = await executePlan({ ops: [accountOp, orderOp()] }, sf, sfOpts, store);

  const create = sf.calls.find((c) => c.method === 'POST' && c.path === '/sobjects/Provider_Order__c');
  assert.equal(create.body.Account__c, '001EXISTING');
  assert.equal(create.body.Order_Amount__c, 240);

  const lines = sf.calls.find((c) => c.method === 'POST' && c.path === '/composite/sobjects');
  assert.equal(lines.body.allOrNone, true);
  assert.deepEqual(lines.body.records[0], {
    attributes: { type: 'Order_Product__c' }, Provider_Order__c: result.id, Quantity__c: 2, Unit_Price__c: 120, Product_Name__c: 'Kit',
  });

  const link = store.rows.get('5001');
  assert.equal(link.salesforce_id, result.id);
  assert.equal(link.account_id, '001EXISTING');
  assert.equal(Object.keys(link.lines).length, 2);
  assert.equal(result.action, 'created');
});

test('re-sent order is updated, never duplicated; removed lines are deleted', async () => {
  const store = fakeStore();
  await executePlan({ ops: [accountOp, orderOp()] }, fakeSf({ accountExists: true }), sfOpts, store);
  const { salesforce_id: orderId, lines } = store.rows.get('5001');

  const sf = fakeSf({ accountExists: true });
  const changed = orderOp({ lines: [orderOp().lines[0], { ...orderOp().lines[1], remove: true }] });
  const [, result] = await executePlan({ ops: [accountOp, changed] }, sf, sfOpts, store);

  assert.equal(sf.calls.some((c) => c.method === 'POST' && c.path === '/sobjects/Provider_Order__c'), false);
  assert.ok(sf.calls.find((c) => c.method === 'PATCH' && c.path === `/sobjects/Provider_Order__c/${orderId}`));
  const update = sf.calls.find((c) => c.method === 'PATCH' && c.path === '/composite/sobjects');
  assert.equal(update.body.records[0].id, lines['11']);
  const del = sf.calls.find((c) => c.method === 'DELETE');
  assert.match(del.path, new RegExp(`ids=${lines['12']}&allOrNone=true`));
  assert.deepEqual(Object.keys(store.rows.get('5001').lines), ['11']);
  assert.equal(result.action, 'updated');
});

test('cancelled order that was never synced is skipped', async () => {
  const sf = fakeSf();
  const store = fakeStore();
  const [result] = await executePlan({ ops: [orderOp({ linked: false, cancelled: true })] }, sf, sfOpts, store);
  assert.equal(result.action, 'skipped');
  assert.equal(sf.calls.length, 0);
  assert.equal(store.rows.size, 0);
});

test('unlinked order is created without a Provider and linked once the practice exists', async () => {
  const store = fakeStore();
  const first = fakeSf();
  await executePlan({ ops: [orderOp({ linked: false })] }, first, sfOpts, store);
  const create = first.calls.find((c) => c.path === '/sobjects/Provider_Order__c');
  assert.equal('Account__c' in create.body, false);
  const orderId = store.rows.get('5001').salesforce_id;
  assert.equal(store.rows.get('5001').account_id, null);

  // Later the customer gets a Provider ID and is synced.
  const later = fakeSf({ accountExists: true });
  const [account] = await executePlan({ ops: [accountOp] }, later, sfOpts, store);
  assert.equal(account.linkedOrders, 1);
  const link = later.calls.find((c) => c.method === 'PATCH' && c.path === `/sobjects/Provider_Order__c/${orderId}`);
  assert.deepEqual(link.body, { Account__c: '001EXISTING' });
  assert.equal(store.rows.get('5001').account_id, '001EXISTING');
});

test('failed line creation is not retried blindly, and the next attempt only adds the lines', async () => {
  const store = fakeStore();
  await assert.rejects(
    executePlan({ ops: [accountOp, orderOp()] }, fakeSf({ accountExists: true, collectionFails: true }), sfOpts, store),
    (err) => err instanceof SalesforceError && err.retryable === false && /Unit Price/.test(err.message),
  );
  assert.ok(store.rows.get('5001').salesforce_id, 'the order is remembered');

  const sf = fakeSf({ accountExists: true });
  await executePlan({ ops: [accountOp, orderOp()] }, sf, sfOpts, store);
  assert.equal(sf.calls.some((c) => c.path === '/sobjects/Provider_Order__c' && c.method === 'POST'), false);
  assert.equal(sf.calls.find((c) => c.method === 'POST' && c.path === '/composite/sobjects').body.records.length, 2);
});
