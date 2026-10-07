import { test } from 'node:test';
import assert from 'node:assert/strict';
import { flattenRecord, inventory, mask } from '../src/ghl/explore.js';
import { createGhlClient } from '../src/ghl/client.js';

const opp = {
  id: 'o1', name: 'Sunrise Clinic', source: 'Facebook Ads', monetaryValue: 500, status: 'open',
  customFields: [{ id: 'cf1', fieldValue: 'Sunrise Clinic LLC' }],
};
const contact = {
  id: 'c1', firstName: 'Dana', lastName: 'Lee', email: 'dana@sunrise.com', state: 'TX', tags: ['ad lead', 'abm'],
  attributionSource: { utmSource: 'facebook', medium: 'paid' },
  customFields: [{ id: 'cf2', value: 'MD' }],
};
const names = { cf1: 'Practice Name {opportunity.practice_name}', cf2: 'Role {contact.role}' };

test('flattens opportunity, contact, nested and custom fields', () => {
  const rec = flattenRecord(opp, contact, names);
  assert.equal(rec['opportunity.name'], 'Sunrise Clinic');
  assert.equal(rec['opportunity.custom: Practice Name {opportunity.practice_name}'], 'Sunrise Clinic LLC');
  assert.equal(rec['contact.state'], 'TX');
  assert.equal(rec['contact.tags'], 'ad lead, abm');
  assert.equal(rec['contact.attributionSource.utmSource'], 'facebook');
  assert.equal(rec['contact.custom: Role {contact.role}'], 'MD');
  assert.equal('contact.id' in rec, false);
});

test('inventory shortens personal values but shows sources, tags and states', () => {
  const rows = inventory([flattenRecord(opp, contact, names), flattenRecord({ name: 'Other' }, { state: 'CA' }, names)]);
  const row = (f) => rows.find((r) => r.Field === f);
  assert.equal(row('contact.email').Examples, 'dan…(16)');
  assert.equal(row('contact.email').Filled, '1/2');
  assert.equal(row('contact.state').Examples, 'TX | CA');
  assert.equal(row('opportunity.source').Examples, 'Facebook Ads');
  assert.equal(row('contact.tags').Examples, 'ad lead, abm');
  assert.equal(row('contact.attributionSource.utmSource').Examples, 'facebook');

  const fullRows = inventory([flattenRecord(opp, contact, names)], { full: true });
  assert.equal(fullRows.find((r) => r.Field === 'contact.email').Examples, 'dana@sunrise.com');
  assert.equal(mask('MD'), 'MD');
});

test('GHL client sends the token and API version, and pages opportunities', async () => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url: String(url), headers: init.headers });
    return new Response(JSON.stringify({ opportunities: [{ id: 'o1' }], meta: { total: 1 } }), { status: 200 });
  };
  const ghl = createGhlClient({ token: 'pit-123', locationId: 'loc1' }, fetchImpl);
  const page = await ghl.searchOpportunities({ pipelineId: 'p1', stageId: 's1', limit: 5 });
  assert.equal(page.meta.total, 1);
  assert.match(calls[0].url, /\/opportunities\/search\?location_id=loc1&pipeline_id=p1&pipeline_stage_id=s1&limit=5$/);
  assert.equal(calls[0].headers.Authorization, 'Bearer pit-123');
  assert.equal(calls[0].headers.Version, '2021-07-28');
});
