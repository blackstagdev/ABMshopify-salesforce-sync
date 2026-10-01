import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildPlan } from '../src/mapping/plan.js';
import { resolveProviderId } from '../src/mapping/providerId.js';

const baseOpts = {
  providerIdStrategy: 'customer_tag',
  providerIdTagPrefix: 'provider:',
  providerIdPrefix: 'SHOPIFY-',
  lineOfBusiness: 'Alpha BioMed',
  orderSyncEnabled: false,
};

const customer = {
  id: 7382910,
  email: 'Front.Desk@SunriseClinic.com',
  first_name: 'Dana',
  last_name: 'Lee',
  phone: '+15551234567',
  tags: 'wholesale, provider:ABM-00123',
  default_address: {
    company: 'Sunrise Clinic',
    address1: '1 Main St',
    address2: 'Suite 200',
    city: 'Austin',
    province: 'Texas',
    zip: '78701',
    country: 'United States',
  },
};

test('customer becomes an Account upsert on Provider_ID__c plus a Contact', () => {
  const plan = buildPlan('customers/create', customer, baseOpts);
  assert.deepEqual(plan.blockers, []);

  const [account, contact] = plan.ops;
  assert.equal(account.op, 'upsertAccount');
  assert.equal(account.providerId, 'ABM-00123');
  assert.equal(account.createFields.Name, 'Sunrise Clinic');
  assert.equal(account.createFields.BillingStreet, '1 Main St\nSuite 200');
  assert.equal(account.createFields.Primary_Email__c, 'front.desk@sunriseclinic.com');
  assert.equal(account.updateFields.Name, undefined, 'Name is create-only');

  assert.equal(contact.op, 'upsertContact');
  assert.equal(contact.fields.LastName, 'Lee');
  assert.equal(contact.fields.MailingCity, 'Austin');
});

test('never sends guarded or Salesforce-maintained fields', () => {
  const plan = buildPlan('customers/update', customer, baseOpts);
  const sent = plan.ops.flatMap((op) => Object.keys({ ...op.createFields, ...op.updateFields, ...op.fields }));
  for (const field of sent) {
    assert.doesNotMatch(field, /Status__c|Owner__c|OwnerId|Revenue|Order_|NPI__c/, field);
  }
});

test('default strategy "none" blocks instead of guessing a Provider ID', () => {
  const plan = buildPlan('customers/create', customer, { ...baseOpts, providerIdStrategy: 'none' });
  assert.equal(plan.blockers.length, 1);
  assert.equal(plan.ops[0].providerId, null);
});

test('missing tag, over-long ids and unknown strategies are blocked', () => {
  assert.equal(resolveProviderId({ tags: 'wholesale' }, baseOpts).value, null);
  assert.equal(resolveProviderId({ tags: `provider:${'x'.repeat(31)}` }, baseOpts).value, null);
  assert.equal(resolveProviderId(customer, { ...baseOpts, providerIdStrategy: 'npi' }).value, null);
  assert.equal(resolveProviderId(customer, { ...baseOpts, providerIdStrategy: 'shopify_customer_id' }).value, 'SHOPIFY-7382910');
});

test('long text is truncated to the Salesforce field length', () => {
  const plan = buildPlan('customers/create', { ...customer, first_name: 'A'.repeat(60) }, baseOpts);
  assert.equal(plan.ops[1].fields.FirstName.length, 40);
});

test('empty Shopify values are left out rather than blanking Salesforce', () => {
  const plan = buildPlan('customers/update', { ...customer, phone: '', default_address: null }, baseOpts);
  assert.equal('Phone' in plan.ops[0].updateFields, false);
  assert.equal('BillingCity' in plan.ops[0].updateFields, false);
});

test('customer without a usable email gets no Contact', () => {
  const plan = buildPlan('customers/create', { ...customer, email: null }, baseOpts);
  assert.equal(plan.ops.length, 1);
  assert.match(plan.warnings.join(), /No usable email/);
});

const order = {
  id: 5001,
  name: '#1001',
  email: 'front.desk@sunriseclinic.com',
  created_at: '2026-09-20T22:30:00-07:00',
  total_price: '260.00',
  current_total_price: '240.00',
  financial_status: 'paid',
  fulfillment_status: 'fulfilled',
  customer,
  billing_address: customer.default_address,
  line_items: [
    { id: 11, title: 'Kit', variant_title: '5mg', quantity: 2, current_quantity: 2, price: '125.00', discount_allocations: [{ amount: '10.00' }] },
    { id: 12, title: 'Removed item', quantity: 1, current_quantity: 0, price: '20.00' },
  ],
};
const orderOpts = { ...baseOpts, orderSyncEnabled: true };

test('order with a Provider ID: Account (Active) + Contact + Provider Order with lines', () => {
  const plan = buildPlan('orders/create', order, orderOpts, { isFirstOrder: true });
  assert.deepEqual(plan.blockers, []);
  assert.deepEqual(plan.ops.map((o) => o.op), ['upsertAccount', 'upsertContact', 'upsertOrder']);

  const [account, , op] = plan.ops;
  assert.equal(account.createFields.ABM_Status__c, 'Active');
  assert.equal(account.abmStatus, 'Active');
  assert.equal(account.fromNewOrder, true);
  assert.equal('ABM_Status__c' in account.updateFields, false, 'status on update is decided by the executor');

  assert.equal(op.linked, true);
  assert.equal(op.shopifyOrderId, '5001');
  assert.deepEqual(op.fields, {
    Line_of_Business__c: 'Alpha BioMed',
    Order_Amount__c: 240,
    Order_Date__c: '2026-09-20',
    Order_Type__c: 'New',
    Paid__c: true,
  });
  assert.deepEqual(op.lines[0], {
    shopifyLineId: '11',
    remove: false,
    fields: { Quantity__c: 2, Unit_Price__c: 120, Product_Name__c: 'Kit - 5mg' },
  });
  assert.equal(op.lines[1].remove, true);
});

test('orders never carry Fulfilment Status, owner or AlphaSync fields', () => {
  const plan = buildPlan('orders/updated', order, orderOpts, { isFirstOrder: false });
  const sent = plan.ops.flatMap((o) => Object.keys({ ...o.createFields, ...o.updateFields, ...o.fields, ...o.lines?.[0]?.fields }));
  for (const field of sent) assert.doesNotMatch(field, /Fulfilment|OwnerId|Owner__c|AlphaSync|Sync_/, field);
  assert.equal(plan.ops.at(-1).fields.Order_Type__c, 'Reorder');
  assert.equal(plan.ops[0].fromNewOrder, false);
});

test('order sync switched off: customer still synced, order only previewed', () => {
  const plan = buildPlan('orders/create', order, baseOpts, { isFirstOrder: true });
  assert.deepEqual(plan.ops.map((o) => o.op), ['upsertAccount', 'upsertContact']);
  assert.equal(plan.orderPreview.fields.Order_Amount__c, 240);
});

test('order without a Provider ID, or a guest checkout, is sent unlinked', () => {
  const noId = buildPlan('orders/create', { ...order, customer: { ...customer, tags: '' } }, orderOpts, { isFirstOrder: true });
  assert.deepEqual(noId.blockers, []);
  assert.deepEqual(noId.ops.map((o) => o.op), ['upsertOrder']);
  assert.equal(noId.ops[0].linked, false);
  assert.match(noId.warnings.join(), /unlinked/);

  const guest = buildPlan('orders/create', { ...order, customer: null }, orderOpts);
  assert.deepEqual(guest.ops.map((o) => o.op), ['upsertOrder']);
  assert.equal('Order_Type__c' in guest.ops[0].fields, false, 'no Order Type without a customer');
});

test('Paid, unknown order history and cancelled orders', () => {
  const pending = buildPlan('orders/updated', { ...order, financial_status: 'pending' }, orderOpts).ops.at(-1);
  assert.equal(pending.fields.Paid__c, false);
  assert.equal('Order_Type__c' in pending.fields, false, 'no Order Type when the first order is unknown');

  const refunded = buildPlan('orders/updated', { ...order, financial_status: 'refunded' }, orderOpts).ops.at(-1);
  assert.equal(refunded.fields.Paid__c, true);

  const cancelled = buildPlan('orders/updated', { ...order, cancelled_at: '2026-09-21T10:00:00-07:00' }, orderOpts).ops.at(-1);
  assert.equal(cancelled.cancelled, true);
  assert.equal(cancelled.fields.Order_Amount__c, 0);
});

test('customer status: Prospect without orders, Active with orders, unset when unknown', () => {
  const status = (context) => buildPlan('customers/update', customer, baseOpts, context).ops[0].createFields.ABM_Status__c;
  assert.equal(status({ numberOfOrders: 0 }), 'Prospect');
  assert.equal(status({ numberOfOrders: 3 }), 'Active');
  assert.equal(status({}), undefined);
});

test('unhandled topics return no plan', () => {
  assert.equal(buildPlan('products/create', {}, baseOpts), null);
});

test('customer_metafield strategy uses the looked-up Provider ID metafield', () => {
  const opts = { ...baseOpts, providerIdStrategy: 'customer_metafield', providerIdMetafield: 'custom.provider_id' };
  const plan = buildPlan('customers/update', customer, opts, { providerIdMetafield: ' HWwmF72if9TJU9G1AZ9f ' });
  assert.deepEqual(plan.blockers, []);
  assert.equal(plan.ops[0].providerId, 'HWwmF72if9TJU9G1AZ9f');

  const missing = buildPlan('customers/update', customer, opts, { providerIdMetafield: null });
  assert.match(missing.blockers.join(), /no custom\.provider_id metafield/);
});

test('Shopify customer id is written to Shopify_ID__c on create and update', () => {
  const [account] = buildPlan('customers/update', customer, baseOpts).ops;
  assert.equal(account.createFields.Shopify_ID__c, '7382910');
  assert.equal(account.updateFields.Shopify_ID__c, '7382910');
});

test('generated Provider IDs are 20 unambiguous uppercase characters', async () => {
  const { generateProviderId } = await import('../src/mapping/providerId.js');
  const crypto = await import('node:crypto');
  const ids = new Set(Array.from({ length: 1000 }, () => generateProviderId(crypto.randomBytes)));
  assert.equal(ids.size, 1000);
  for (const id of ids) assert.match(id, /^[A-HJ-NP-Z2-9]{20}$/);
});

test('customers that look like the same practice are flagged', async () => {
  const { flagSamePractice } = await import('../src/mapping/samePractice.js');
  const all = [
    { id: '1', name: 'Albert C', email: 'albert@blackstag.us', company: 'Blackstag', providerId: 'HWWM1' },
    { id: '2', name: 'Bea D', email: 'bea@blackstag.us', company: null, providerId: null },
    { id: '3', name: 'Cal E', email: 'cal@gmail.com', company: 'BLACKSTAG ', providerId: null },
    { id: '4', name: 'Dee F', email: 'dee@gmail.com', company: null, providerId: null },
    { id: '5', name: 'Eve G', email: 'eve@sunrise.com', company: 'Sunrise', providerId: null },
    { id: '6', name: 'Fay H', email: 'fay@sunrise.com', company: null, providerId: null },
  ];
  const notes = flagSamePractice(all.filter((c) => !c.providerId), all);
  assert.match(notes.get('2'), /Albert C, who already has Provider ID HWWM1/);
  assert.match(notes.get('3'), /Albert C/, 'company match ignores case and spacing');
  assert.equal(notes.has('4'), false, 'free-mail domains are not a match');
  assert.match(notes.get('5'), /Fay H/);
});
