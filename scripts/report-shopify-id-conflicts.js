// Read-only report of DUPLICATE_VALUE failures on Shopify_ID__c: Shopify
// gives the customer one Provider ID, but a Salesforce Account already holds
// that Shopify customer under a different Provider ID. Someone has to say
// which Provider ID is right (fix it in Shopify or in Salesforce); the sync
// never matches on Shopify_ID__c. Writes nothing except the CSV.
//
//   npm run -s report-shopify-id-conflicts
//
// Then, after fixing: npm run requeue -- --status=failed --error=Shopify_ID__c
import { writeFileSync } from 'node:fs';
import { config } from '../src/config.js';
import { createDb } from '../src/db.js';
import { createSalesforceClient, soqlString } from '../src/salesforce/client.js';

const db = createDb(config);
const sf = createSalesforceClient(config.salesforce);

const { rows } = await db.pool.query(
  `SELECT coalesce(payload->'customer'->>'id', payload->>'id') AS customer_id, last_error
   FROM shopify_events
   WHERE status = 'failed' AND last_error LIKE '%Shopify_ID__c duplicates value%'`,
);

// One row per Salesforce Account in the way.
const conflicts = new Map();
for (const r of rows) {
  const accountId = r.last_error.match(/record with id: (\w+)/)?.[1];
  const shopifyPid = decodeURIComponent(r.last_error.match(/Provider_ID__c\/([^ ?]+)/)?.[1] ?? '');
  if (!accountId) continue;
  const c = conflicts.get(accountId) ?? { accountId, shopifyCustomer: r.customer_id, shopifyProviderId: shopifyPid, failedEvents: 0 };
  c.failedEvents++;
  conflicts.set(accountId, c);
}

const ids = [...conflicts.keys()];
for (let i = 0; i < ids.length; i += 200) {
  const accounts = await sf.query(
    `SELECT Id, Name, Provider_ID__c, CreatedBy.Name, CreatedDate FROM Account
     WHERE Id IN (${ids.slice(i, i + 200).map(soqlString).join(',')})`,
  );
  for (const a of accounts) {
    Object.assign(conflicts.get(a.Id), {
      name: a.Name,
      salesforceProviderId: a.Provider_ID__c,
      createdBy: a.CreatedBy?.Name,
      created: a.CreatedDate?.slice(0, 10),
    });
  }
}

const list = [...conflicts.values()].sort((a, b) => b.failedEvents - a.failedEvents);
console.log(`${rows.length} failed events, ${list.length} Salesforce Accounts.\n`);
console.table(list.map((c) => ({
  account: c.name, accountId: c.accountId, salesforcePid: c.salesforceProviderId, shopifyPid: c.shopifyProviderId,
  shopifyCustomer: c.shopifyCustomer, createdBy: c.createdBy, created: c.created, events: c.failedEvents,
})));

const csvCell = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
const header = ['Account', 'Salesforce Account Id', 'Provider ID in Salesforce', 'Provider ID in Shopify', 'Shopify customer id', 'Created by', 'Created', 'Failed events'];
const csv = [header, ...list.map((c) => [c.name, c.accountId, c.salesforceProviderId, c.shopifyProviderId, c.shopifyCustomer, c.createdBy, c.created, c.failedEvents])]
  .map((row) => row.map(csvCell).join(','))
  .join('\n');
writeFileSync('shopify-id-conflicts.csv', csv + '\n');
console.log('\nSaved as shopify-id-conflicts.csv');
await db.pool.end();
