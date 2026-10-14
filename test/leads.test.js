import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mapLead, leadStatusFor } from '../src/ghl/leads.js';
import { processEvent, GHL_TOPIC } from '../src/processor.js';
import { executePlan } from '../src/salesforce/executor.js';
import { createApp } from '../src/server.js';

const cfg = {
  lineOfBusiness: 'Alpha BioMed', adLeadTag: 'bsd-lead', pipelineId: 'P1',
  stageStatus: { S1: 'New', S2: 'Contacted', S3: 'Qualified' },
};
const fieldKeys = { cf1: 'contact.clinic_name', cf2: 'contact.title', cf3: 'contact.suffix', cf4: 'contact.npi_number' };
const opp = { id: 'o1', contactId: 'c1', pipelineId: 'P1', pipelineStageId: 'S1', status: 'open', createdAt: '2026-10-01T15:00:00.000Z' };
const contact = {
  id: 'c1', firstName: 'Ann', lastName: 'Romero', email: 'Ann@Clinic.com', phone: '+17145550100',
  companyName: 'Acu Wellness', address1: '473 Main St', city: 'San Diego', state: 'California', postalCode: '92101',
  country: 'US', website: 'https://acu.example', tags: ['october 25', 'bsd-lead'],
  customFields: [{ id: 'cf2', value: 'Owner' }, { id: 'cf3', value: 'MD' }, { id: 'cf4', value: '1588888888' }],
};

test('GHL contact maps to the Lead fields from the workbook', () => {
  const { fields, blockers } = mapLead(opp, contact, fieldKeys, cfg, 'New');
  assert.deepEqual(blockers, []);
  assert.deepEqual(fields, {
    FirstName: 'Ann', LastName: 'Romero', Company: 'Acu Wellness', Email: 'ann@clinic.com', Phone: '+17145550100',
    Street: '473 Main St', City: 'San Diego', State: 'California', PostalCode: '92101', Country: 'US',
    Website: 'https://acu.example', Title: 'Owner', Suffix: 'MD',
    Line_of_Business__c: 'Alpha BioMed', LeadSource: 'Black Stag', Status: 'New',
  });
});

test('the GHL contact ID is sent once a Lead field for it is configured', () => {
  const { fields } = mapLead(opp, contact, fieldKeys, { ...cfg, leadIdField: 'GHL_Contact_ID__c' }, 'New');
  assert.equal(fields.GHL_Contact_ID__c, 'c1');
});

test('never sends owner, self-sourced, NPI or Entered Salesforce', () => {
  const { fields } = mapLead(opp, contact, fieldKeys, cfg, 'New');
  for (const f of ['OwnerId', 'Self_Sourced__c', 'NPI__c', 'Entered_Salesforce__c']) assert.equal(f in fields, false, f);
});

test('only the exact ad tag makes a Black Stag lead', () => {
  const nonAd = mapLead(opp, { ...contact, tags: ['non-bsd-lead', 'blackstag'] }, fieldKeys, cfg, 'New');
  assert.equal('LeadSource' in nonAd.fields, false);
  assert.equal(mapLead(opp, { ...contact, tags: [' BSD-Lead '] }, fieldKeys, cfg, 'New').fields.LeadSource, 'Black Stag');
});

test('Alpha Sync: Clinic Name is the company; fallbacks for missing names', () => {
  const sync = { ...cfg, lineOfBusiness: 'AlphaSync' };
  const c = { ...contact, companyName: '', customFields: [{ id: 'cf1', value: 'Evolve Med Spa' }] };
  const { fields } = mapLead(opp, c, fieldKeys, sync, 'New');
  assert.equal(fields.Company, 'Evolve Med Spa');
  assert.equal(fields.Line_of_Business__c, 'AlphaSync');

  const bare = mapLead(opp, { email: 'x@y.com' }, fieldKeys, cfg, 'New');
  assert.equal(bare.fields.Company, 'x@y.com');
  assert.equal(bare.fields.LastName, 'x');
  assert.match(bare.warnings.join(), /No state/);

  assert.equal(mapLead(opp, {}, fieldKeys, cfg, 'New').blockers.length, 1);
});

test('Lead Status comes from the stage; lost or abandoned is Unresponsive; unmapped is not sent', () => {
  assert.equal(leadStatusFor(opp, cfg), 'New');
  assert.equal(leadStatusFor({ ...opp, pipelineStageId: 'S2' }, cfg), 'Contacted');
  assert.equal(leadStatusFor({ ...opp, pipelineStageId: 'S3', status: 'won' }, cfg), 'Qualified');
  assert.equal(leadStatusFor({ ...opp, status: 'lost' }, cfg), 'Unresponsive');
  assert.equal(leadStatusFor({ ...opp, pipelineStageId: 'S3', status: 'abandoned' }, cfg), 'Unresponsive');
  assert.equal(leadStatusFor({ ...opp, pipelineStageId: 'ARCHIVE' }, cfg), null, 'unmapped stage');
  assert.equal(leadStatusFor({ ...opp, pipelineId: 'P2' }, cfg), null, 'other pipeline');
});

test('the real Alpha BioMed mapping matches what was agreed', async () => {
  const { config } = await import('../src/config.js');
  const abm = config.ghl.accounts.abm;
  const counts = {};
  for (const v of Object.values(abm.stageStatus)) counts[v] = (counts[v] ?? 0) + 1;
  assert.deepEqual(counts, { New: 1, Contacted: 5, Qualified: 4, Disqualified: 1, Unresponsive: 1 });
  assert.equal(abm.stageStatus['249396ff-9b90-4680-8d1c-54d6fffd4c50'], 'New');
  assert.equal(abm.stageStatus['bd825aaf-429e-4178-9b1f-01de76a7915c'], 'Contacted', 'Duplicate NPI');
  assert.equal(abm.stageStatus['52c70ca7-54e4-412e-931e-6139b606105a'], undefined, 'GPO & Partners is not sent');
});

// --- processing ---

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
  assert.equal(dry.result.ops[0].op, 'upsertLead');
  assert.equal(dry.result.ops[0].fields.Company, 'Acu Wellness');
  assert.equal(dry.result.ops[0].fields.Status, 'New');

  const off = await processEvent(event, { mode: 'dry_run', ghl: { abm: fakeAccount() }, ghlConfig: { leadSyncEnabled: false } });
  assert.equal(off.result.ops.length, 0);
  assert.equal(off.result.leadPreview.length, 1);
});

test('processor: unmapped stages are ignored; the latest opportunity per contact sets the status', async () => {
  const ignored = await processEvent(event, { mode: 'live', ghl: { abm: fakeAccount([{ ...opp, pipelineStageId: 'ARCHIVE' }]) }, ghlConfig: { leadSyncEnabled: true } });
  assert.equal(ignored.status, 'ignored');
  await assert.rejects(processEvent(event, { mode: 'live', ghl: {}, ghlConfig: {} }), /not configured/);

  const two = [
    { ...opp, id: 'old', pipelineStageId: 'S1', updatedAt: '2026-10-01T00:00:00Z' },
    { ...opp, id: 'new', pipelineStageId: 'S3', updatedAt: '2026-10-10T00:00:00Z' },
  ];
  const { result } = await processEvent(event, { mode: 'dry_run', ghl: { abm: fakeAccount(two) }, ghlConfig: { leadSyncEnabled: true } });
  assert.equal(result.ops.length, 1);
  assert.equal(result.ops[0].ghlOpportunityId, 'new');
  assert.equal(result.ops[0].fields.Status, 'Qualified');
});

// --- creating and updating ---

function leadStore() {
  const links = new Map();
  return {
    links,
    async getLeadLink(a, c) { return links.get(`${a}:${c}`) ?? null; },
    async saveLeadLink(l) { links.set(`${l.account}:${l.ghlContactId}`, { salesforce_id: l.salesforceId }); },
  };
}
const leadOp = (fields = {}) => ({
  op: 'upsertLead', account: 'abm', ghlContactId: 'c1', ghlOpportunityId: 'o1',
  fields: { LastName: 'R', Company: 'C', Line_of_Business__c: 'Alpha BioMed', Status: 'New', ...fields },
});

test('a GHL contact becomes one Lead; later only its Status is updated', async () => {
  const store = leadStore();
  const calls = [];
  const sf = { async request(method, path, body) { calls.push({ method, path, body }); return { status: 201, data: { id: '00QNEW' } }; } };

  const [first] = await executePlan({ ops: [leadOp()] }, sf, {}, store);
  assert.equal(first.action, 'created');
  assert.equal(calls[0].method, 'POST');
  assert.equal(calls[0].path, '/sobjects/Lead');

  const [second] = await executePlan({ ops: [leadOp({ Status: 'Contacted', Company: 'Changed' })] }, sf, {}, store);
  assert.equal(second.action, 'updated');
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[1], { method: 'PATCH', path: '/sobjects/Lead/00QNEW', body: { Status: 'Contacted' } });
});

test('converted or deleted Leads are left alone', async () => {
  const cases = [
    [Object.assign(new Error('PATCH -> 400 CANNOT_UPDATE_CONVERTED_LEAD: cannot reference converted lead'), { status: 400 }), 'converted'],
    [Object.assign(new Error('not found'), { status: 404 }), 'deleted in Salesforce'],
  ];
  for (const [error, action] of cases) {
    const store = leadStore();
    store.links.set('abm:c1', { salesforce_id: '00QOLD' });
    const sf = { async request() { throw error; } };
    const [r] = await executePlan({ ops: [leadOp({ Status: 'Qualified' })] }, sf, {}, store);
    assert.equal(r.action, action);
  }
});

test('with a GHL ID field, new Leads are upserted on it (key in the URL only)', async () => {
  const store = leadStore();
  const calls = [];
  const sf = { async request(method, path, body) { calls.push({ method, path, body }); return { status: 201, data: { id: '00QUP' } }; } };
  const op = { ...leadOp({ GHL_Contact_ID__c: 'c1' }), idField: 'GHL_Contact_ID__c' };

  const [r] = await executePlan({ ops: [op] }, sf, {}, store);
  assert.equal(calls[0].method, 'PATCH');
  assert.equal(calls[0].path, '/sobjects/Lead/GHL_Contact_ID__c/c1');
  assert.equal('GHL_Contact_ID__c' in calls[0].body, false);
  assert.equal(r.action, 'created');

  // Already linked: the ID is filled in along with the Status.
  const [u] = await executePlan({ ops: [op] }, sf, {}, store);
  assert.deepEqual(calls[1].body, { Status: 'New', GHL_Contact_ID__c: 'c1' });
  assert.equal(u.action, 'updated');
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
