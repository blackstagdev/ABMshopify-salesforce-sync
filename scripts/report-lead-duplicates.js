// Read-only report of GHL contacts whose Lead was blocked by the Salesforce
// Lead duplicate rule ("This lead may already exist..."). For each one it
// shows the existing Account, Contact or Lead it most likely matched.
// Writes nothing except lead-duplicates.csv
// (download it from /admin/reports/lead-duplicates.csv).
//
//   npm run -s report-lead-duplicates -- --account=abm
//
// Salesforce is read in bulk (2,000 rows per call) and GHL a pipeline page at
// a time, so it uses few API calls.
import { writeFileSync } from 'node:fs';
import { config } from '../src/config.js';
import { toCsv } from '../src/csv.js';
import { createDb } from '../src/db.js';
import { createGhlAccounts } from '../src/ghl/accounts.js';
import { createSalesforceClient } from '../src/salesforce/client.js';
import { buildIndex, explainLeadDuplicate } from '../src/ghl/leadDuplicates.js';

const arg = (name) => process.argv.find((a) => a.startsWith(`--${name}=`))?.split('=')[1];
const name = arg('account') ?? 'abm';
const account = createGhlAccounts(config.ghl)[name];
if (!account) {
  console.error('Pass --account=abm or --account=sync (and set its GHL token and location id).');
  process.exit(1);
}

const db = createDb(config);
const sf = createSalesforceClient(config.salesforce);
const log = (msg) => process.stderr.write(`${msg}\n`);

// The newest event per contact, where it failed on the Lead duplicate rule.
const { rows: events } = await db.pool.query(
  `SELECT * FROM (
     SELECT DISTINCT ON (payload->>'id') id, payload, status, last_error
     FROM shopify_events
     WHERE topic = 'ghl/opportunity' AND payload->>'account' = $1
     ORDER BY payload->>'id', id DESC
   ) latest
   WHERE status = 'failed' AND last_error LIKE '%/sobjects/Lead%' AND last_error ILIKE '%may already exist%'
   ORDER BY id`,
  [name],
);
if (events.length === 0) {
  console.log('No Lead duplicate failures.');
  await db.pool.end();
  process.exit(0);
}
log(`${events.length} contacts blocked by the Lead duplicate rule.`);

// GHL: every opportunity in the pipeline, with its embedded contact.
const stageNames = {};
for (const p of await account.client.pipelines()) {
  for (const s of p.stages ?? []) stageNames[s.id] = s.name;
}
const ghl = new Map();
let startAfter;
let startAfterId;
do {
  const { opportunities, meta } = await account.client.searchOpportunities({
    pipelineId: account.cfg.pipelineId, status: 'all', limit: 100, startAfter, startAfterId,
  });
  for (const opp of opportunities) {
    const contactId = opp.contactId ?? opp.contact?.id;
    if (!contactId) continue;
    const prev = ghl.get(contactId);
    if (prev && String(prev.opp.updatedAt ?? '') >= String(opp.updatedAt ?? '')) continue;
    ghl.set(contactId, { opp, contact: opp.contact ?? {} });
  }
  const more = opportunities.length > 0 && meta.startAfterId && meta.startAfterId !== startAfterId;
  startAfter = more ? meta.startAfter : undefined;
  startAfterId = more ? meta.startAfterId : undefined;
  process.stderr.write(`\rGHL opportunities read: ${ghl.size}...`);
} while (startAfterId);
process.stderr.write('\n');

// Salesforce, in bulk.
log('Reading Salesforce Accounts, Contacts and open Leads...');
const accounts = await sf.queryAll('SELECT Id, Name, Provider_ID__c, Primary_Email__c, Phone FROM Account');
const contacts = (await sf.queryAll('SELECT Id, Name, Email, Phone, AccountId, Account.Name, Account.Provider_ID__c FROM Contact'))
  .map((c) => ({ ...c, accountId: c.AccountId, accountName: c.Account?.Name, accountProviderId: c.Account?.Provider_ID__c }));
const ourLeads = new Map((await db.pool.query('SELECT salesforce_id, ghl_contact_id FROM salesforce_leads')).rows
  .map((r) => [r.salesforce_id, r.ghl_contact_id]));
const leads = (await sf.queryAll('SELECT Id, Name, Company, Email, Phone, Status, Owner.Name FROM Lead WHERE IsConverted = false'))
  .map((l) => ({ ...l, ghlContactId: ourLeads.get(l.Id) }));
log(`Salesforce: ${accounts.length} Accounts, ${contacts.length} Contacts, ${leads.length} open Leads.`);
const idx = buildIndex({ accounts, contacts, leads });

const rows = [];
let fetched = 0;
for (const event of events) {
  const contactId = event.payload.contactId;
  let { opp, contact } = ghl.get(contactId) ?? {};
  // Not in the pipeline search (moved or deleted): read the contact itself.
  if (!contact?.email && !contact?.phone) {
    try {
      contact = (await account.client.contact(contactId)) ?? contact ?? {};
      fetched++;
    } catch {
      contact ??= {};
    }
  }
  const person = contact.name || [contact.firstName, contact.lastName].filter(Boolean).join(' ');
  const company = contact.companyName || '';
  const r = explainLeadDuplicate({ id: contactId, email: contact.email, phone: contact.phone, company }, idx);
  rows.push({
    'GHL contact id': contactId,
    Name: person,
    Company: company,
    Email: contact.email ?? '',
    Phone: contact.phone ?? '',
    'GHL stage': stageNames[opp?.pipelineStageId] ?? '',
    'GHL status': opp?.status ?? '',
    Category: r.category,
    'Matched on': r.matchedOn,
    'Matched record type': r.match?.type ?? '',
    'Matched record': r.match?.name ?? '',
    'Matched record Id': r.match?.id ?? '',
    'Matched Account': r.match?.accountName ?? '',
    'Matched Account Provider ID': r.match?.providerId ?? '',
    'Matched Lead status': r.match?.status ?? '',
    'Other matches': r.others || '',
    Action: r.action,
  });
}

const csvPath = 'lead-duplicates.csv';
writeFileSync(csvPath, toCsv(Object.keys(rows[0]), rows));

const by = (key) => {
  const counts = {};
  for (const r of rows) counts[r[key] || '(none)'] = (counts[r[key] || '(none)'] ?? 0) + 1;
  return Object.entries(counts).sort((a, b) => b[1] - a[1]);
};
console.log(`\nLead duplicate failures (${name}): ${rows.length}${fetched ? ` (${fetched} contacts read one by one)` : ''}\n`);
console.log('By category:');
for (const [k, n] of by('Category')) console.log(`  ${String(n).padStart(6)}  ${k}`);
console.log('\nMatched on:');
for (const [k, n] of by('Matched on')) console.log(`  ${String(n).padStart(6)}  ${k}`);
console.log(`\nSaved as ${csvPath} (download: /admin/reports/${csvPath})`);

await db.pool.end();
