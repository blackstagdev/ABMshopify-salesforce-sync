import { test } from 'node:test';
import assert from 'node:assert/strict';
import { explainDuplicate, soslEscape } from '../src/mapping/duplicates.js';

const customer = { providerId: 'GHL123', email: 'amy@clinic.com', name: 'Amy B', company: 'Clinic' };
const none = { accounts: [], contacts: [], leads: [] };

test('practice duplicate: blank Provider ID on the match is fixable by you', () => {
  const r = explainDuplicate('account', customer, { ...none, accounts: [{ Id: '001A', Name: 'Clinic', Provider_ID__c: null }] });
  assert.equal(r.action, 'YOU CAN FIX');
  assert.match(r.detail, /set its Provider ID to GHL123/);
});

test('practice duplicate: a different Provider ID goes to the team', () => {
  const r = explainDuplicate('account', customer, { ...none, accounts: [{ Id: '001A', Name: 'Clinic', Provider_ID__c: 'MIG-9' }] });
  assert.equal(r.action, 'ASK TEAM');
  assert.match(r.detail, /already has Provider ID MIG-9, but Shopify has GHL123/);
});

test('practice duplicate: several blank matches need a decision; none found needs a manual check', () => {
  const two = [{ Id: '1', Name: 'Clinic', Provider_ID__c: null }, { Id: '2', Name: 'Clinic East', Provider_ID__c: null }];
  assert.equal(explainDuplicate('account', customer, { ...none, accounts: two }).action, 'ASK TEAM');
  assert.equal(explainDuplicate('account', customer, none).action, 'CHECK');
});

test('contact duplicate: lead, other practice, or nothing visible', () => {
  const lead = explainDuplicate('contact', customer, { ...none, leads: [{ Name: 'Amy B', Company: 'Clinic', Status: 'Open' }] });
  assert.equal(lead.action, 'ASK TEAM (lead)');
  const other = explainDuplicate('contact', customer, { ...none, contacts: [{ Name: 'Amy B', accountName: 'Other Spa', accountProviderId: 'X1' }] });
  assert.match(other.detail, /another practice: "Other Spa"/);
  assert.equal(explainDuplicate('contact', customer, none).action, 'CHECK');
});

test('SOSL special characters are escaped', () => {
  assert.equal(soslEscape('a+b-c@x.com'), 'a\+b\-c@x.com');
});
