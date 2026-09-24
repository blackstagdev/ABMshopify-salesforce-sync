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
