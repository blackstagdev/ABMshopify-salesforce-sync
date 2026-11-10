// Read-only report of events Salesforce rejected as duplicates
// (DUPLICATES_DETECTED). For each customer it shows what the record collided
// with in Salesforce and who can fix it. Writes nothing except duplicates.csv
// (download it from /admin/reports/duplicates.csv).
//
//   npm run report-duplicates
//
// Then, after fixing: npm run requeue -- --status=failed --latest
import { writeFileSync } from 'node:fs';
import { config } from '../src/config.js';
import { toCsv } from '../src/csv.js';
import { createDb } from '../src/db.js';
import { createShopifyAdmin } from '../src/shopify/admin.js';
import { createSalesforceClient, soqlString } from '../src/salesforce/client.js';
import { explainDuplicate, soslEscape } from '../src/mapping/duplicates.js';

const db = createDb(config);
const sf = createSalesforceClient(config.salesforce);
const shopify = createShopifyAdmin(config.shopify);
const [namespace, key] = config.mapping.providerIdMetafield.split('.');

// The newest event per customer, only when that one failed: an older failure
// whose customer has since synced is not a problem any more.
const { rows: events } = await db.pool.query(
  `SELECT * FROM (
     SELECT DISTINCT ON (payload->>'id') id, payload, status, last_error
     FROM shopify_events
     WHERE topic LIKE 'customers/%'
     ORDER BY payload->>'id', id DESC
   ) latest
   WHERE status = 'failed' AND last_error LIKE '%DUPLICATES_DETECTED%'
   ORDER BY id`,
);

if (events.length === 0) {
  console.log('No duplicate failures.');
  await db.pool.end();
  process.exit(0);
}

const rows = [];
for (const event of events) {
  const p = event.payload;
  const kind = event.last_error.includes('/sobjects/Contact') ? 'contact' : 'account';
  const providerId = event.last_error.match(/Provider_ID__c\/([^ ]+)/)?.[1]
    ?? (await shopify.getCustomerContext(p.id, namespace, key)).providerIdMetafield;
  const customer = {
    providerId,
    email: p.email?.toLowerCase() ?? null,
    name: [p.first_name, p.last_name].filter(Boolean).join(' '),
    company: p.default_address?.company?.trim() || null,
  };

  const candidates = { accounts: [], contacts: [], leads: [] };
  if (kind === 'account') {
    const names = [customer.company, customer.name].filter(Boolean);
    // Duplicate rules match fuzzily, so also look for names containing the company.
    const where = [
      ...names.map((n) => `Name = ${soqlString(n)}`),
      ...(customer.company ? [`Name LIKE ${soqlString(`%${customer.company}%`)}`] : []),
      ...(customer.email ? [`Primary_Email__c = ${soqlString(customer.email)}`] : []),
    ];
    if (where.length) {
      candidates.accounts = (await sf.query(
        `SELECT Id, Name, Provider_ID__c, Primary_Email__c, Owner.Name FROM Account WHERE ${where.join(' OR ')} LIMIT 5`,
      )).map((a) => ({ ...a, ownerName: a.Owner?.Name }));
    }
  } else if (customer.email) {
    const q = `FIND {${soslEscape(customer.email)}} IN EMAIL FIELDS RETURNING `
      + 'Contact(Id, Name, Email, Account.Name, Account.Provider_ID__c), Lead(Id, Name, Company, Status, IsConverted WHERE IsConverted = false)';
    const { data } = await sf.request('GET', `/search?q=${encodeURIComponent(q)}`);
    for (const r of data.searchRecords || []) {
      if (r.attributes.type === 'Contact') {
        candidates.contacts.push({ Id: r.Id, Name: r.Name, Email: r.Email, accountName: r.Account?.Name, accountProviderId: r.Account?.Provider_ID__c });
      } else if (r.attributes.type === 'Lead') {
        candidates.leads.push(r);
      }
    }
  }

  const { action, detail } = explainDuplicate(kind, customer, candidates);
  // The Account it most likely collided with: one holding another Provider ID, else the first match.
  const match = candidates.accounts.find((a) => a.Provider_ID__c && a.Provider_ID__c.toUpperCase() !== providerId?.toUpperCase())
    ?? candidates.accounts[0];
  rows.push({
    Event: event.id,
    Type: kind === 'account' ? 'Practice' : 'Contact',
    Customer: customer.company || customer.name || customer.email,
    Email: customer.email ?? '',
    'Provider ID': providerId ?? '',
    Action: action,
    Detail: detail,
    shopifyCustomer: p.id,
    matchName: match?.Name,
    matchId: match?.Id,
    matchProviderId: match?.Provider_ID__c,
    // Old UUID Provider IDs are covered by the separate UUID update.
    oldUuid: /^[0-9a-f]{8}-[0-9a-f]{4}-/i.test(match?.Provider_ID__c ?? ''),
  });
  process.stderr.write(`\rChecked ${rows.length}/${events.length}...`);
}
process.stderr.write('\n');

// Wide table first, then the details one per line so long text is readable.
console.table(rows.map((r) => ({ Event: r.Event, Type: r.Type, Customer: r.Customer, Email: r.Email, 'Provider ID': r['Provider ID'], Action: r.Action })));
console.log('\nDetails:');
for (const r of rows) console.log(`\n[${r.Action}] event ${r.Event}: ${r.Customer} <${r.Email}>\n  ${r.Detail}`);

const count = (a) => rows.filter((r) => r.Action.startsWith(a)).length;

const csvRows = rows.map((r) => ({
  'Shopify customer': r.Customer,
  Email: r.Email,
  'Shopify customer id': r.shopifyCustomer,
  'Provider ID in Shopify': r['Provider ID'],
  Type: r.Type,
  'Matching Salesforce Account': r.matchName,
  'Salesforce Account Id': r.matchId,
  'Provider ID in Salesforce': r.matchProviderId,
  'Old UUID Provider ID': r.oldUuid ? 'yes' : '',
  Action: r.Action,
  Detail: r.Detail,
}));
writeFileSync('duplicates.csv', toCsv(Object.keys(csvRows[0]), csvRows));
console.log(`
Duplicate failures: ${rows.length}
  YOU CAN FIX: ${count('YOU CAN FIX')}  (set the Provider ID on the Salesforce Account shown)
  ASK TEAM:    ${count('ASK TEAM')}  (different Provider ID, several matches, Leads, or a person on another practice)
  CHECK:       ${count('CHECK')}  (matched on something we can't see; look in Salesforce)
  Of these, ${rows.filter((r) => r.oldUuid).length} collide with an Account holding an old UUID Provider ID (covered by the UUID update).

Saved as duplicates.csv (download: /admin/reports/duplicates.csv)

After fixing, re-send them with:
  npm run requeue -- --status=failed --latest`);

await db.pool.end();
