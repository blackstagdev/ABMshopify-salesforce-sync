import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mapAffiliate, isSyncedAffiliate, firstAffiliateByCustomer } from '../src/goaffpro/mapping.js';
import { runAffiliateSync } from '../src/goaffpro/sync.js';
import { SalesforceError } from '../src/errors.js';

const jane = {
  id: 21259262, name: 'James Wilkes', email: 'Jim@Clinic.com', phone: '+14405550100', company_name: 'CH Wellness',
  address_1: '247 Main St', city: 'Columbus', state: 'Ohio', zip: '44001', country: 'US',
  ref_code: 'JAMESWILKES', status: 'approved', parent: { id: 17768819, name: 'Gabe', email: 'gabe@x.com' },
};

test('affiliate maps to existing Account fields only', () => {
  const m = mapAffiliate(jane);
  assert.equal(m.providerId, '21259262');
  assert.equal(m.parentId, '17768819');
  assert.deepEqual(m.createFields, {
    Name: 'CH Wellness', Primary_Provider_Name__c: 'James Wilkes', Primary_Email__c: 'jim@clinic.com', Phone: '+14405550100',
    BillingStreet: '247 Main St', BillingCity: 'Columbus', BillingState: 'Ohio', BillingPostalCode: '44001', BillingCountry: 'US',
    Referral_Code__c: 'JAMESWILKES',
  });
  assert.equal('Name' in m.updateFields, false, 'Name is create-only');
  assert.equal(mapAffiliate({ ...jane, company_name: '' }).createFields.Name, 'James Wilkes');
  assert.deepEqual(mapAffiliate(jane).blockers, []);
});

test('only approved affiliates are synced', () => {
  assert.equal(isSyncedAffiliate(jane), true);
  assert.equal(isSyncedAffiliate({ ...jane, status: 'pending' }), false);
  assert.equal(isSyncedAffiliate({ ...jane, status: 'blocked' }), false);
});

test('a practice belongs to the affiliate on its first counted order', () => {
  const map = firstAffiliateByCustomer([
    { customer: { id: 9 }, affiliate_id: 2, created_at: '2026-05-01T00:00:00Z', status: 'approved' },
    { customer: { id: 9 }, affiliate_id: 1, created_at: '2026-03-01T00:00:00Z', status: 'approved' },
    { customer: { id: 9 }, affiliate_id: 3, created_at: '2026-01-01T00:00:00Z', status: 'rejected' },
    { customer: { id: 8 }, affiliate_id: 2, created_at: '2026-02-01T00:00:00Z', status: 'pending' },
  ]);
  assert.equal(map.get('9'), '1', 'earliest non-rejected order wins');
  assert.equal(map.get('8'), '2');
});

// --- the job, with fakes ---

function fakes({ existing = {}, providerIds = {}, failCreate = false } = {}) {
  const accounts = { ...existing }; // providerId -> { Id, Affiliate__c, RecordTypeId }
  const calls = [];
  let n = 0;
  const sf = {
    calls,
    async query(soql) {
      if (soql.includes('FROM RecordType')) return [{ Id: '012AFF' }];
      const ids = [...soql.matchAll(/'([^']+)'/g)].map((m) => m[1]);
      return ids.filter((id) => accounts[id]).map((id) => ({ ...accounts[id], Provider_ID__c: id }));
    },
    async request(method, path, body) {
      calls.push({ method, path, body });
      const byPid = path.match(/Provider_ID__c\/([^?]+)/);
      if (method === 'GET' && byPid) {
        const acc = accounts[decodeURIComponent(byPid[1])];
        if (!acc) throw new SalesforceError('not found', 404);
        return { status: 200, data: acc };
      }
      if (method === 'PATCH' && byPid) {
        if (failCreate) throw new SalesforceError('PATCH -> 400 DUPLICATES_DETECTED: practice may already exist', 400);
        const id = `001A${++n}`;
        accounts[decodeURIComponent(byPid[1])] = { Id: id, Affiliate__c: null, RecordTypeId: body.RecordTypeId };
        return { status: 201, data: { id } };
      }
      return { status: 204, data: null };
    },
  };
  const gap = {
    async *list(path) {
      if (path === '/affiliates') {
        yield* [
          { ...jane, id: 100, parent: null },
          { ...jane, id: 200, parent: { id: 100 }, company_name: 'Sub Co', ref_code: 'SUB' },
          { ...jane, id: 300, status: 'pending', parent: null },
        ];
      } else {
        yield* [
          { customer: { id: 7 }, affiliate_id: 200, created_at: '2026-01-01', status: 'approved' },
          { customer: { id: 8 }, affiliate_id: 300, created_at: '2026-01-01', status: 'approved' },
          { customer: { id: 6 }, affiliate_id: 100, created_at: '2026-01-01', status: 'approved' },
        ];
      }
    },
  };
  const shopify = {
    async getProviderIds(ids) { return new Map(ids.map((id) => [id, providerIds[id] ?? null])); },
  };
  return { sf, gap, shopify, accounts };
}

test('apply: creates affiliates, sets the upline, links referred practices', async () => {
  const f = fakes({
    existing: { GHL7: { Id: '001P7', Affiliate__c: '001OLD', RecordTypeId: '012CUST' } },
    providerIds: { 7: 'GHL7', 6: 'GHL6' },
  });
  const s = await runAffiliateSync({ ...f, providerIdMetafield: 'custom.provider_id', apply: true });

  assert.deepEqual(s.affiliates, { seen: 3, approved: 2, created: 2, updated: 0, unchanged: 0, failed: 0 });
  const created = f.sf.calls.filter((c) => c.method === 'PATCH' && c.path.includes('Provider_ID__c'));
  assert.equal(created[0].body.RecordTypeId, '012AFF');
  assert.equal(created[0].body.Referral_Code__c, 'JAMESWILKES');

  assert.equal(s.uplines.set, 1);
  const upline = f.sf.calls.find((c) => c.method === 'PATCH' && c.body?.Affiliate__c && c.path === `/sobjects/Account/${f.accounts['200'].Id}`);
  assert.equal(upline.body.Affiliate__c, f.accounts['100'].Id);

  // Practice 7 had a different affiliate: always matches GoAffPro.
  const link = f.sf.calls.find((c) => c.path === '/sobjects/Account/001P7');
  assert.deepEqual(link.body, { Affiliate__c: f.accounts['200'].Id });
  assert.equal(s.practices.linked, 1);
  assert.equal(s.practices.affiliateNotSynced, 1, 'customer 8 was referred by a pending affiliate');
  assert.equal(s.practices.notInSalesforce, 1, 'customer 6 has a Provider ID but no practice yet');
});

test('dry run writes nothing', async () => {
  const f = fakes({ providerIds: { 7: 'GHL7' } });
  const s = await runAffiliateSync({ ...f, providerIdMetafield: 'custom.provider_id', apply: false });
  assert.equal(f.sf.calls.filter((c) => c.method !== 'GET').length, 0);
  assert.equal(s.affiliates.created, 2);
});

test('a blocked create is reported and the job carries on', async () => {
  const f = fakes({ failCreate: true });
  const s = await runAffiliateSync({ ...f, providerIdMetafield: 'custom.provider_id', apply: true });
  assert.equal(s.affiliates.failed, 2);
  assert.match(s.errors[0].error, /DUPLICATES_DETECTED/);
});

test('an existing non-Affiliate Account with that ID is never converted', async () => {
  const f = fakes({ existing: { 100: { Id: '001X', RecordTypeId: '012CUST' } } });
  const s = await runAffiliateSync({ ...f, providerIdMetafield: 'custom.provider_id', apply: true });
  assert.match(s.errors.find((e) => e.id === 100).error, /non-Affiliate/);
});

test('the client stops when GoAffPro ignores the offset', async () => {
  const { createGoAffProClient } = await import('../src/goaffpro/client.js');
  const page = { orders: Array.from({ length: 100 }, (_, i) => ({ id: i })) };
  const fetchImpl = async () => ({ ok: true, status: 200, text: async () => JSON.stringify(page) });
  const gap = createGoAffProClient({ accessToken: 't' }, fetchImpl);
  let seen = 0;
  await assert.rejects(async () => {
    for await (const _ of gap.list('/orders', 'orders', ['id'])) seen++;
  }, /same page again/);
  assert.equal(seen, 100);
});

test('an affiliate with two emails keeps the first one', () => {
  const m = mapAffiliate({ ...jane, email: 'danielle@matrixmedical.vip, manish@matrixmedical.vip' });
  assert.equal(m.createFields.Primary_Email__c, 'danielle@matrixmedical.vip');
  assert.match(m.warnings.join(), /only danielle@matrixmedical.vip was kept/);
});
