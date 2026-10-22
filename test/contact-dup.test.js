import { test } from 'node:test';
import assert from 'node:assert/strict';
import { executePlan } from '../src/salesforce/executor.js';
import { SalesforceError } from '../src/errors.js';

function sf() {
  const calls = [];
  return {
    calls,
    async request(method, path, body) {
      calls.push({ method, path, body });
      if (method === 'GET') return { status: 200, data: { Id: '001X', Name: 'Clinic' } };
      if (method === 'POST' && path === '/sobjects/Contact') {
        throw new SalesforceError('POST /sobjects/Contact -> 400 DUPLICATES_DETECTED: duplicate record', 400);
      }
      if (method === 'POST' && path === '/sobjects/Provider_Order__c') return { status: 201, data: { id: 'a0O' } };
      if (path.startsWith('/composite/sobjects')) return { status: 200, data: (body.records ?? []).map(() => ({ success: true, id: 'a1L' })) };
      return { status: 204, data: null };
    },
    async query() { return []; },
  };
}

function store() {
  const rows = new Map();
  return {
    async getOrderLink(id) { return rows.get(id) ?? null; },
    async saveOrderLink(l) { rows.set(l.shopifyOrderId, { salesforce_id: l.salesforceId, account_id: l.accountId, lines: l.lines }); },
    async unlinkedOrdersForCustomer() { return []; },
  };
}

test('a Contact blocked as a duplicate does not stop the order', async () => {
  const s = sf();
  const plan = { ops: [
    { op: 'upsertAccount', providerId: 'P1', createFields: { Name: 'Clinic' }, updateFields: { Phone: '1' }, shopifyCustomerId: '7' },
    { op: 'upsertContact', email: 'a@b.com', fields: { LastName: 'B', Email: 'a@b.com' } },
    { op: 'upsertOrder', shopifyOrderId: '9', shopifyCustomerId: '7', linked: true, cancelled: false,
      fields: { Line_of_Business__c: 'Alpha BioMed', Order_Amount__c: 10, Order_Date__c: '2026-07-01' },
      lines: [{ shopifyLineId: '1', remove: false, fields: { Quantity__c: 1, Unit_Price__c: 10, Product_Name__c: 'X' } }] },
  ] };
  const results = await executePlan(plan, s, { accountRecordType: 'Customer', orderObject: 'Provider_Order__c', orderLineObject: 'Order_Product__c' }, store());
  assert.deepEqual(results.map((r) => r.action), ['updated', 'skipped', 'created']);
  assert.match(results[1].warning, /already exists/);
  assert.equal(s.calls.find((c) => c.path === '/sobjects/Provider_Order__c').body.Account__c, '001X');
});

test('other Contact errors still fail the event', async () => {
  const s = sf();
  s.request = async (method) => {
    if (method === 'GET') return { status: 200, data: { Id: '001X', Name: 'Clinic' } };
    if (method === 'POST') throw new SalesforceError('POST /sobjects/Contact -> 400 REQUIRED_FIELD_MISSING', 400);
    return { status: 204, data: null };
  };
  await assert.rejects(
    executePlan({ ops: [
      { op: 'upsertAccount', providerId: 'P1', createFields: { Name: 'C' }, updateFields: {} },
      { op: 'upsertContact', email: 'a@b.com', fields: { LastName: 'B' } },
    ] }, s, { accountRecordType: 'Customer' }, store()),
    /REQUIRED_FIELD_MISSING/,
  );
});
