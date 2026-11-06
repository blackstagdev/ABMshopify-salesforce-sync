import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildIndex, explainLeadDuplicate, normCompany, normPhone } from '../src/ghl/leadDuplicates.js';

const idx = buildIndex({
  accounts: [{ Id: 'A1', Name: 'Glow Med Spa, LLC', Provider_ID__c: 'ghlAAA', Primary_Email__c: 'front@glow.com', Phone: '555-010-1000' }],
  contacts: [{ Id: 'C1', Name: 'Dr Who', Email: 'who@clinic.com', accountName: 'Clinic', accountId: 'A2', accountProviderId: 'ghlBBB' }],
  leads: [
    { Id: 'L1', Name: 'Jane Lead', Company: 'Vital Health', Email: 'jane@vital.com', Status: 'New' },
    { Id: 'L2', Name: 'Sam Sync', Company: 'Sync Co', Email: 'sam@sync.com', Status: 'New', ghlContactId: 'ghlSAM' },
  ],
});

test('normalizes phones and company names', () => {
  assert.equal(normPhone('+1 (555) 010-1000'), '5550101000');
  assert.equal(normPhone('123'), null);
  assert.equal(normCompany('Glow Med Spa, LLC'), normCompany('glow med spa'));
});

test('lead duplicate: GHL contact id held as an Account Provider ID is an existing customer', () => {
  const r = explainLeadDuplicate({ id: 'ghlaaa', email: 'x@y.com' }, idx);
  assert.equal(r.matchedOn, 'GHL contact ID = Account Provider ID');
  assert.equal(r.match.id, 'A1');
  assert.equal(r.category, 'Already a customer');
});

test('lead duplicate: email on a Contact, phone or company on an Account', () => {
  assert.equal(explainLeadDuplicate({ id: 'x', email: 'WHO@clinic.com' }, idx).match.id, 'C1');
  assert.equal(explainLeadDuplicate({ id: 'x', phone: '(555) 010 1000' }, idx).matchedOn, 'Phone');
  assert.equal(explainLeadDuplicate({ id: 'x', company: 'GLOW MED SPA' }, idx).matchedOn, 'Company name');
});

test('lead duplicate: Leads made by the sync vs outside it, and no match', () => {
  assert.equal(explainLeadDuplicate({ id: 'x', email: 'jane@vital.com' }, idx).category, 'Lead already exists');
  assert.equal(explainLeadDuplicate({ id: 'other', email: 'sam@sync.com' }, idx).category, 'Another GHL contact at the same practice');
  // Its own Lead never counts as the duplicate.
  assert.equal(explainLeadDuplicate({ id: 'ghlSAM', email: 'sam@sync.com' }, idx).category, 'No visible match');
});
