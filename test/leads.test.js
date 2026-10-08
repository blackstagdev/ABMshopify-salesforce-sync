import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mapLead, isLeadOpportunity } from '../src/ghl/leads.js';
import { processEvent, GHL_TOPIC } from '../src/processor.js';
import { executePlan } from '../src/salesforce/executor.js';
import { createApp } from '../src/server.js';

const cfg = { lineOfBusiness: 'Alpha BioMed', adLeadTag: 'bsd-lead', pipelineId: 'P1', stageId: 'S1' };
const fieldKeys = { cf1: 'contact.clinic_name', cf2: 'contact.title', cf3: 'contact.suffix', cf4: 'contact.npi_number' };
const opp = { id: 'o1', contactId: 'c1', pipelineId: 'P1', pipelineStageId: 'S1', status: 'open', createdAt: '2026-10-01T15:00:00.000Z' };
const contact = {
  id: 'c1', firstName: 'Ann', lastName: 'Romero', email: 'Ann@Clinic.com', phone: '+17145550100',
  companyName: 'Acu Wellness', address1: '473 Main St', city: 'San Diego', state: 'California', postalCode: '92101',
  country: 'US', website: 'https://acu.example', tags: ['october 25', 'bsd-lead'],
  customFields: [{ id: 'cf2', value: 'Owner' }, { id: 'cf3', value: 'MD' }, { id: 'cf4', value: '1588888888' }],
};

test('GHL contact maps to the Lead fields from the workbook', () => {
  const { fields, blockers } = mapLead(opp, contact, fieldKeys, cfg);
  assert.deepEqual(blockers, []);
  assert.deepEqual(fields, {
    FirstName: 'Ann', LastName: 'Romero', Company: 'Acu Wellness', Email: 'ann@clinic.com', Phone: '+17145550100',
    Street: '473 Main St', City: 'San Diego', State: 'California', PostalCode: '92101', Country: 'US',
    Website: 'https://acu.example', Title: 'Owner', Suffix: 'MD',
    Line_of_Business__c: 'Alpha BioMed', LeadSource: 'Black Stag', Entered_Salesforce__c: '2026-10-01T15:00:00.000Z',
  });
});

test('never sends owner, self-sourced or NPI', () => {
  const { fields } = mapLead(opp, contact, fieldKeys, cfg);
  for (const f of ['OwnerId', 'Self_Sourced__c', 'NPI__c']) assert.equal(f in fields, false, f);
});

test('only the exact ad tag makes a Black Stag lead', () => {
  const nonAd = mapLead(opp, { ...contact, tags: ['non-bsd-lead', 'blackstag'] }, fieldKeys, cfg);
  assert.equal('LeadSource' in nonAd.fields, false);
  assert.equal(mapLead(opp, { ...contact, tags: [' BSD-Lead '] }, fieldKeys, cfg).fields.LeadSource, 'Black Stag');
});

test('Alpha Sync: Clinic Name is the company; fallbacks for missing names', () => {
  const sync = { ...cfg, lineOfBusiness: 'AlphaSync' };
  const c = { ...contact, companyName: '', customFields: [{ id: 'cf1', value: 'Evolve Med Spa' }] };
  const { fields } = mapLead(opp, c, fieldKeys, sync);
  assert.equal(fields.Company, 'Evolve Med Spa');
  assert.equal(fields.Line_of_Business__c, 'AlphaSync');

  const bare = mapLead(opp, { email: 'x@y.com' }, fieldKeys, cfg);
  assert.equal(bare.fields.Company, 'x@y.com');
  assert.equal(bare.fields.LastName, 'x');
  assert.match(bare.warnings.join(), /No state/);

  assert.equal(mapLead(opp, {}, fieldKeys, cfg).blockers.length, 1);
});

test('only open opportunities in the configured stage count', () => {
  assert.equal(isLeadOpportunity(opp, cfg), true);
  assert.equal(isLeadOpportunity({ ...opp, status: 'abandoned' }, cfg), false);
  assert.equal(isLeadOpportunity({ ...opp, pipelineStageId: 'S2' }, cfg), false);
  assert.equal(isLeadOpportunity({ ...opp, pipelineId: 'P2' }, cfg), false);
});

// --- processing and creating ---

function fakeAccount(opportunities = [opp]) {
  return {
    name: 'abm',
    cfg,
    client: { async contact() { return contact; } },
    async fieldKeys() { return fieldKeys; },
    async findOpportunities() { return opportunities; },
  };
}
const event = { topic: GHL_TOPIC, payload: { id: 'abm:c1', account: 'abm', contactId: 'c1' } };

test('processor: dry run previews the lead; sync switch off keeps it as a preview', async () => {
  const dry = await processEvent(event, { mode: 'dry_run', ghl: { abm: fakeAccount() }, ghlConfig: { leadSyncEnabled: true } });
  assert.equal(dry.status, 'dry_run');
  assert.equal(dry.result.ops[0].op, 'createLead');
  assert.equal(dry.result.ops[0].fields.Company, 'Acu Wellness');

  const off = await processEvent(event, { mode: 'dry_run', ghl: { abm: fakeAccount() }, ghlConfig: { leadSyncEnabled: false } });
  assert.equal(off.result.ops.length, 0);
  assert.equal(off.result.leadPreview.length, 1);
});

test('processor: closed or moved opportunities are ignored; unknown account is blocked', async () => {
  const ignored = await processEvent(event, { mode: 'live', ghl: { abm: fakeAccount([{ ...opp, status: 'lost' }]) }, ghlConfig: { leadSyncEnabled: true } });
  assert.equal(ignored.status, 'ignored');
  await assert.rejects(processEvent(event, { mode: 'live', ghl: {}, ghlConfig: {} }), /not configured/);
});

test('a GHL contact becomes one Lead, never two', async () => {
  const links = new Map();
  const store = {
    async getLeadLink(a, c) { return links.get(`${a}:${c}`) ?? null; },
    async saveLeadLink(l) { links.set(`${l.account}:${l.ghlContactId}`, { salesforce_id: l.salesforceId }); },
  };
  const calls = [];
  const sf = { async request(method, path, body) { calls.push({ method, path, body }); return { status: 201, data: { id: '00QNEW' } }; } };
  const plan = { ops: [{ op: 'createLead', account: 'abm', ghlContactId: 'c1', ghlOpportunityId: 'o1', fields: { LastName: 'R', Company: 'C', Line_of_Business__c: 'Alpha BioMed' } }] };

  const [first] = await executePlan(plan, sf, {}, store);
  assert.equal(first.action, 'created');
  assert.equal(calls[0].path, '/sobjects/Lead');

  const [second] = await executePlan(plan, sf, {}, store);
  assert.equal(second.action, 'exists');
  assert.equal(calls.length, 1);
});

// --- webhook ---

test('GHL webhook needs the secret and stores contact/opportunity ids', async () => {
  const stored = [];
  const db = { async insertEvent(e) { stored.push(e); return true; } };
  const config = { salesforce: {}, shopify: {}, ghl: { webhookSecret: 's3cret', accounts: { abm: {}, sync: {} } } };
  const server = createApp({ db, config, log: { info() {}, error() {} } }).listen(0);
  const base = `http://localhost:${server.address().port}/webhooks/ghl`;
  const post = (path, body) => fetch(`${base}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

  try {
    assert.equal((await post('/abm?secret=wrong', { contact_id: 'c1' })).status, 401);
    assert.equal((await post('/other?secret=s3cret', { contact_id: 'c1' })).status, 404);
    assert.equal((await post('/abm?secret=s3cret', {})).status, 400);
    assert.equal((await post('/abm?secret=s3cret', { contact_id: 'c1', customData: { opportunity_id: 'o1' } })).status, 200);
  } finally {
    server.close();
  }
  assert.equal(stored.length, 1);
  assert.equal(stored[0].topic, 'ghl/opportunity');
  assert.deepEqual(stored[0].payload, { id: 'abm:c1', account: 'abm', contactId: 'c1', opportunityId: 'o1' });
});
