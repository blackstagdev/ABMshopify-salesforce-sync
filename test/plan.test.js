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

test('order syncs its customer and previews the order while order sync is off', () => {
  const order = {
    id: 5001,
    name: '#1001',
    email: 'front.desk@sunriseclinic.com',
    created_at: '2026-09-20T10:00:00Z',
    currency: 'USD',
    total_price: '250.00',
    financial_status: 'paid',
    customer,
    billing_address: customer.default_address,
    line_items: [{ sku: 'ABM-1', title: 'Kit', quantity: 2, price: '125.00', product_id: 9, variant_id: 10 }],
  };
  const plan = buildPlan('orders/create', order, baseOpts);
  assert.deepEqual(plan.ops.map((o) => o.op), ['upsertAccount', 'upsertContact']);
  assert.equal(plan.orderPreview.shopifyOrderId, '5001');
  assert.equal(plan.orderPreview.lineOfBusiness, 'Alpha BioMed');
  assert.equal(plan.orderPreview.lineItems[0].productId, '9');

  const enabled = buildPlan('orders/create', order, { ...baseOpts, orderSyncEnabled: true });
  assert.equal(enabled.ops.at(-1).op, 'upsertOrder');
});

test('guest checkout order is blocked for lack of a customer', () => {
  const plan = buildPlan('orders/create', { id: 1, email: 'a@b.com', line_items: [] }, baseOpts);
  assert.equal(plan.blockers.length, 1);
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
