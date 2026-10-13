import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildPlan } from '../src/mapping/plan.js';
import { executePlan } from '../src/salesforce/executor.js';
import { SalesforceError } from '../src/errors.js';

const opts = { providerIdStrategy: 'customer_tag', providerIdTagPrefix: 'provider:', lineOfBusiness: 'Alpha BioMed' };
const base = {
  id: 7, email: 'dana@sunrise.com', first_name: 'Dana', last_name: 'Lee', tags: 'provider:P1',
  default_address: { company: '', city: 'Austin' },
  addresses: [{ company: '' }, { company: 'Sunrise Clinic' }],
};
const accountOp = (customer) => buildPlan('customers/update', customer, opts).ops[0];

test('company is taken from another address when the default has none', () => {
  const op = accountOp(base);
  assert.equal(op.createFields.Name, 'Sunrise Clinic');
  assert.equal(op.companyName, 'Sunrise Clinic');
  assert.deepEqual(op.fallbackNames, ['Dana Lee', 'dana@sunrise.com']);
});

test('the default address company wins; no company anywhere falls back to the person', () => {
  assert.equal(accountOp({ ...base, default_address: { company: 'Main Clinic' } }).createFields.Name, 'Main Clinic');
  const none = accountOp({ ...base, addresses: [{ company: '' }] });
  assert.equal(none.createFields.Name, 'Dana Lee');
  assert.equal(none.companyName, undefined);
});

// Existing Account in a fake Salesforce, with a given name.
function sfWithAccount(name) {
  const calls = [];
  return {
    calls,
    async request(method, path, body) {
      calls.push({ method, path, body });
      if (method === 'GET') return { status: 200, data: { Id: '001X', Name: name } };
      return { status: 204, data: null };
    },
    async query() { return []; },
  };
}
const patchOf = (sf) => sf.calls.find((c) => c.method === 'PATCH')?.body ?? {};
const run = (sf, op) => executePlan({ ops: [op] }, sf, { accountRecordType: 'Customer' });

test('an Account still named after the person is renamed to the company', async () => {
  for (const oldName of ['Dana Lee', 'dana lee', 'dana@sunrise.com']) {
    const sf = sfWithAccount(oldName);
    const [result] = await run(sf, accountOp(base));
    assert.equal(patchOf(sf).Name, 'Sunrise Clinic', oldName);
    assert.equal(result.renamedTo, 'Sunrise Clinic');
  }
});

test('a name chosen in Salesforce, or already the company, is never changed', async () => {
  for (const oldName of ['Sunrise Clinic of Austin', 'Sunrise Clinic', 'SUNRISE CLINIC']) {
    const sf = sfWithAccount(oldName);
    await run(sf, accountOp(base));
    assert.equal('Name' in patchOf(sf), false, oldName);
  }
  // No company in Shopify: nothing to rename to.
  const sf = sfWithAccount('Dana Lee');
  await run(sf, accountOp({ ...base, addresses: [] }));
  assert.equal('Name' in patchOf(sf), false);
});

test('new Accounts are unaffected: GET 404 creates with the company name', async () => {
  const calls = [];
  const sf = {
    async request(method, path, body) {
      calls.push({ method, path, body });
      if (method === 'GET') throw new SalesforceError('not found', 404);
      return { status: 201, data: { id: '001NEW' } };
    },
    async query() { return [{ Id: '012C' }]; },
  };
  await run(sf, accountOp(base));
  assert.equal(calls.find((c) => c.method === 'PATCH').body.Name, 'Sunrise Clinic');
});

test('a rename blocked by the duplicate rule keeps the old name but saves everything else', async () => {
  const calls = [];
  const sf = {
    async request(method, path, body) {
      calls.push({ method, path, body });
      if (method === 'GET') return { status: 200, data: { Id: '001X', Name: 'Dana Lee' } };
      if (method === 'PATCH' && body.Name) {
        throw new SalesforceError(`PATCH ${path} -> 400 DUPLICATES_DETECTED: This practice may already be in Salesforce`, 400);
      }
      return { status: 204, data: null };
    },
    async query() { return []; },
  };
  const [result] = await run(sf, accountOp(base));
  const patches = calls.filter((c) => c.method === 'PATCH');
  assert.equal(patches.length, 2);
  assert.equal('Name' in patches[1].body, false);
  assert.equal(patches[1].body.Primary_Email__c, 'dana@sunrise.com');
  assert.equal(result.renameBlocked, 'Sunrise Clinic');
  assert.match(result.warning, /probably already exists/);
});

test('other update errors still fail the event', async () => {
  const sf = {
    async request(method) {
      if (method === 'GET') return { status: 200, data: { Id: '001X', Name: 'Dana Lee' } };
      throw new SalesforceError('PATCH -> 400 FIELD_INTEGRITY_EXCEPTION', 400);
    },
    async query() { return []; },
  };
  await assert.rejects(run(sf, accountOp(base)), /FIELD_INTEGRITY_EXCEPTION/);
});
