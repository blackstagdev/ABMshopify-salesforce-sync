import { test } from 'node:test';
import assert from 'node:assert/strict';
import { executePlan } from '../src/salesforce/executor.js';
import { processEvent } from '../src/processor.js';
import { BlockedError, SalesforceError } from '../src/errors.js';
import { backoffSeconds } from '../src/worker.js';

// A fake Salesforce that records calls and answers from simple rules.
function fakeSf({ accountExists = false, contacts = [] } = {}) {
  const calls = [];
  return {
    calls,
    async request(method, path, body) {
      calls.push({ method, path, body });
      if (method === 'GET' && path.includes('Provider_ID__c')) {
        if (!accountExists) throw new SalesforceError('not found', 404);
        return { status: 200, data: { Id: '001EXISTING' } };
      }
      if (method === 'PATCH' && path.includes('Provider_ID__c')) return { status: 201, data: { id: '001NEW' } };
      if (method === 'POST') return { status: 201, data: { id: '003NEW' } };
      return { status: 204, data: null };
    },
    async query(soql) {
      calls.push({ method: 'QUERY', soql });
      if (soql.includes('FROM RecordType')) return [{ Id: '012CUSTOMER' }];
      return contacts;
    },
  };
}

const plan = {
  ops: [
    { op: 'upsertAccount', providerId: 'ABM 1/2', createFields: { Name: 'Clinic', Phone: '1' }, updateFields: { Phone: '1' } },
    { op: 'upsertContact', email: "o'neil@clinic.com", fields: { LastName: "O'Neil", Email: "o'neil@clinic.com" } },
  ],
  warnings: [],
  blockers: [],
};

test('new practice: upsert with record type, then create contact', async () => {
  const sf = fakeSf();
  const results = await executePlan(plan, sf, { accountRecordType: 'Customer' });

  const upsert = sf.calls.find((c) => c.method === 'PATCH');
  assert.equal(upsert.path, '/sobjects/Account/Provider_ID__c/ABM%201%2F2');
  assert.equal(upsert.body.RecordTypeId, '012CUSTOMER');
  assert.equal(upsert.body.Name, 'Clinic');

  const contactQuery = sf.calls.find((c) => c.soql?.includes('FROM Contact'));
  assert.match(contactQuery.soql, /Email = 'o\\'neil@clinic.com'/);

  const create = sf.calls.find((c) => c.method === 'POST');
  assert.equal(create.body.AccountId, '001NEW');
  assert.deepEqual(results.map((r) => r.action), ['created', 'created']);
});

test('existing practice: update by Id without Name or RecordTypeId, update matched contact', async () => {
  const sf = fakeSf({ accountExists: true, contacts: [{ Id: '003OLD' }] });
  const results = await executePlan(plan, sf, { accountRecordType: 'Customer' });

  const patches = sf.calls.filter((c) => c.method === 'PATCH');
  assert.equal(patches[0].path, '/sobjects/Account/001EXISTING');
  assert.deepEqual(patches[0].body, { Phone: '1' });
  assert.equal(patches[1].path, '/sobjects/Contact/003OLD');
  assert.deepEqual(results.map((r) => r.action), ['updated', 'updated']);
});

test('order operation is blocked until Provider_Order__c is mapped', async () => {
  const sf = fakeSf({ accountExists: true });
  await assert.rejects(
    executePlan({ ops: [plan.ops[0], { op: 'upsertOrder', order: {} }] }, sf, { accountRecordType: 'Customer' }),
    BlockedError,
  );
});

test('processor: dry run never calls Salesforce; live mode refuses plans with blockers', async () => {
  const event = { topic: 'customers/create', payload: { id: 1, email: 'a@b.com', last_name: 'B', tags: '' } };
  const mapping = { providerIdStrategy: 'none', lineOfBusiness: 'Alpha BioMed' };

  const dry = await processEvent(event, { mode: 'dry_run', mapping, sf: null });
  assert.equal(dry.status, 'dry_run');

  await assert.rejects(processEvent(event, { mode: 'live', mapping, sf: fakeSf() }), BlockedError);

  const ignored = await processEvent({ topic: 'products/create', payload: {} }, { mode: 'live', mapping });
  assert.equal(ignored.status, 'ignored');
});

test('only 429 and 5xx Salesforce errors are retried; backoff is capped', () => {
  assert.equal(new SalesforceError('x', 400).retryable, false);
  assert.equal(new SalesforceError('x', 429).retryable, true);
  assert.equal(new SalesforceError('x', 503).retryable, true);
  assert.equal(backoffSeconds(1), 30);
  assert.equal(backoffSeconds(3), 120);
  assert.equal(backoffSeconds(20), 3600);
});
