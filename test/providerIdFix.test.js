import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isUuid, planProviderIdFixes } from '../src/salesforce/providerIdFix.js';

const UUID = 'e6d116b2-b4b3-476c-8764-738188f5846f';
const GHL = '8xC6RIHlHbECANWvUPfn';
const acct = (over = {}) => ({ Id: '001A', Name: 'The Phoenix Edge', Provider_ID__c: UUID, Shopify_ID__c: '9007', ...over });
const cand = (over = {}) => ({ accountId: '001A', shopifyCustomerId: '9007', failedEvents: 3, ...over });
const plan = ({ accounts = [acct()], shopify = [['9007', GHL]], taken = [], candidates = [cand()] } = {}) => planProviderIdFixes(
  candidates, new Map(accounts.map((a) => [a.Id, a])), new Map(shopify), new Map(taken),
);

test('isUuid', () => {
  assert.equal(isUuid(UUID), true);
  assert.equal(isUuid(GHL), false);
  assert.equal(isUuid('12439271'), false);
});

test('old UUID + GHL ID in Shopify + ID free: updated', () => {
  const [r] = plan();
  assert.equal(r.action, 'update');
  assert.equal(r.oldProviderId, UUID);
  assert.equal(r.newProviderId, GHL);
});

test('every safety check skips instead of updating', () => {
  const reason = (opts) => plan(opts)[0].reason;
  assert.match(reason({ accounts: [] }), /not found/);
  assert.match(reason({ accounts: [acct({ Shopify_ID__c: '1' })] }), /no longer holds/);
  assert.match(reason({ accounts: [acct({ Provider_ID__c: GHL })] }), /Already fixed/);
  assert.match(reason({ accounts: [acct({ Provider_ID__c: '12439271' })] }), /not an old UUID/);
  assert.match(reason({ shopify: [['9007', null]] }), /No Provider ID/);
  assert.match(reason({ shopify: [['9007', UUID.replace('e6', 'f7')]] }), /also has a UUID/);
  assert.match(reason({ taken: [[GHL.toUpperCase(), '001OTHER']] }), /already used by Account 001OTHER/);
});

test('two Accounts heading for the same GHL ID: neither is changed', () => {
  const rows = plan({
    accounts: [acct(), acct({ Id: '001B', Shopify_ID__c: '9008' })],
    shopify: [['9007', GHL], ['9008', GHL]],
    candidates: [cand(), cand({ accountId: '001B', shopifyCustomerId: '9008' })],
  });
  assert.deepEqual(rows.map((r) => r.action), ['skip', 'skip']);
  assert.match(rows[0].reason, /same GHL ID/);
});
