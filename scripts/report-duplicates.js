// Read-only report of events Salesforce rejected as duplicates
// (DUPLICATES_DETECTED). For each customer it shows what the record collided
// with in Salesforce and who can fix it. Writes nothing anywhere.
//
//   npm run report-duplicates
//
// Then, after fixing: npm run requeue -- --status=failed --latest
import { config } from '../src/config.js';
import { createDb } from '../src/db.js';
import { createShopifyAdmin } from '../src/shopify/admin.js';
import { createSalesforceClient, soqlString } from '../src/salesforce/client.js';
import { explainDuplicate, soslEscape } from '../src/mapping/duplicates.js';

const db = createDb(config);
const sf = createSalesforceClient(config.salesforce);
const shopify = createShopifyAdmin(config.shopify);
const [namespace, key] = config.mapping.providerIdMetafield.split('.');

// The newest failed event per customer only.
const { rows: events } = await db.pool.query(
  `SELECT * FROM (
     SELECT DISTINCT ON (payload->>'id') id, payload, last_error
     FROM shopify_events
     WHERE topic LIKE 'customers/%' AND status = 'failed'
     ORDER BY payload->>'id', id DESC
   ) latest
   WHERE last_error LIKE '%DUPLICATES_DETECTED%'
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
  rows.push({
    Event: event.id,
    Type: kind === 'account' ? 'Practice' : 'Contact',
    Customer: customer.company || customer.name || customer.email,
    Email: customer.email ?? '',
    'Provider ID': providerId ?? '',
    Action: action,
    Detail: detail,
  });
  process.stderr.write(`\rChecked ${rows.length}/${events.length}...`);
}
process.stderr.write('\n');

// Wide table first, then the details one per line so long text is readable.
console.table(rows.map(({ Detail, ...r }) => r));
console.log('\nDetails:');
for (const r of rows) console.log(`\n[${r.Action}] event ${r.Event}: ${r.Customer} <${r.Email}>\n  ${r.Detail}`);

const count = (a) => rows.filter((r) => r.Action.startsWith(a)).length;
console.log(`
Duplicate failures: ${rows.length}
  YOU CAN FIX: ${count('YOU CAN FIX')}  (set the Provider ID on the Salesforce Account shown)
  ASK TEAM:    ${count('ASK TEAM')}  (different Provider ID, several matches, Leads, or a person on another practice)
  CHECK:       ${count('CHECK')}  (matched on something we can't see; look in Salesforce)

After fixing, re-send them with:
  npm run requeue -- --status=failed --latest`);

await db.pool.end();
