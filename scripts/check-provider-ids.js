// Read-only check of the Provider IDs entered in Shopify. Lists every
// customer that has one, flags values the sync would reject or that may
// create duplicate practices, and shows what happened to each customer's
// latest sync. Writes nothing to Shopify, Salesforce or the database.
//
//   npm run check-provider-ids
//   npm run check-provider-ids -- --missing     also list customers without one
import { config } from '../src/config.js';
import { createDb } from '../src/db.js';
import { createShopifyAdmin } from '../src/shopify/admin.js';

const showMissing = process.argv.includes('--missing');
const metafield = config.mapping.providerIdMetafield;
const dot = metafield.indexOf('.');
if (dot <= 0) {
  console.error('Set PROVIDER_ID_METAFIELD (e.g. custom.provider_id) first.');
  process.exit(1);
}

const shopify = createShopifyAdmin(config.shopify);
const all = [];
for await (const page of shopify.listCustomersWithMetafield(metafield.slice(0, dot), metafield.slice(dot + 1))) {
  all.push(...page);
  process.stderr.write(`\rRead ${all.length} customers...`);
}
process.stderr.write('\n');

const withId = all.filter((c) => c.providerId);
const without = all.filter((c) => !c.providerId);

// Customers sharing one ID are treated as one practice (one Account, a
// Contact each). The same company under different IDs becomes two Accounts.
const byId = group(withId, (c) => c.providerId.toUpperCase());
const byCompany = group(withId, (c) => c.company?.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim() || null);

let latest = new Map();
let db = null;
if (config.databaseUrl) {
  db = createDb(config);
  latest = await db.latestCustomerEvents(withId.map((c) => c.id));
}

const toRequeue = [];
const rows = withId.map((c) => {
  const issues = [];
  if (c.providerId.length > 30) issues.push('TOO LONG (max 30): will be blocked');
  if (c.rawValue !== c.providerId) issues.push('has spaces around it (trimmed, OK)');
  // Salesforce's unique Provider ID ignores letter case, so IDs that differ
  // only in case land on the same Account.
  const sharing = (byId.get(c.providerId.toUpperCase()) ?? []).filter((o) => o.id !== c.id);
  const exact = sharing.filter((o) => o.providerId === c.providerId);
  const caseOnly = sharing.filter((o) => o.providerId !== c.providerId);
  if (exact.length) issues.push(`same ID as ${names(exact)}: one Account`);
  if (caseOnly.length) issues.push(`ID differs from ${names(caseOnly)} ONLY in letter case: Salesforce treats them as the same Account`);
  const companyKey = c.company?.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  const sameCompanyOtherId = companyKey
    ? (byCompany.get(companyKey) ?? []).filter((o) => o.providerId.toUpperCase() !== c.providerId.toUpperCase())
    : [];
  if (sameCompanyOtherId.length) issues.push(`same company as ${names(sameCompanyOtherId)} but a DIFFERENT ID: two Accounts`);
  if (!c.company) issues.push('no company: Account named after the person');
  if (!c.email) issues.push('no email: no Contact');

  const event = latest.get(String(c.id));
  let sync = db ? 'no event yet' : '(no database)';
  if (event) {
    sync = `${event.status} (event ${event.id})`;
    if (event.status === 'synced') sync += ' ✓';
    // Processed before the ID was added, or in dry run: replaying it now
    // picks up the Provider ID, because it is looked up at processing time.
    if (['blocked', 'dry_run', 'failed'].includes(event.status)) toRequeue.push(event.id);
  }

  return {
    'Shopify ID': c.id,
    Name: c.name,
    Company: c.company ?? '',
    'Provider ID': c.providerId,
    'Latest sync': sync,
    Issues: issues.join('; '),
  };
});

if (rows.length) console.table(rows);
else console.log('No customers have a Provider ID yet.');

if (showMissing && without.length) {
  console.log('\nCustomers WITHOUT a Provider ID (not synced):');
  console.table(without.map((c) => ({ 'Shopify ID': c.id, Name: c.name, Email: c.email ?? '', Company: c.company ?? '' })));
}

console.log(`
Customers in store:        ${all.length}
With a Provider ID:        ${withId.length}   (distinct practices: ${byId.size})
Without one (not synced):  ${without.length}${showMissing ? '' : '   (list them with --missing)'}
To check:                  ${rows.filter((r) => /TOO LONG|DIFFERENT ID|ONLY in letter case/.test(r.Issues)).length} (TOO LONG, DIFFERENT ID or letter-case issues)`);

const noEvent = rows.filter((r) => r['Latest sync'] === 'no event yet').length;
if (toRequeue.length) {
  console.log(`\n${toRequeue.length} customer(s) with a Provider ID were last processed without one or in dry run. To send them again:`);
  console.log(`  npm run requeue -- --ids=${toRequeue.join(',')}`);
}
if (noEvent) {
  console.log(`\n${noEvent} customer(s) with a Provider ID have no event yet: save each one once in Shopify to send it.`);
}

await db?.pool.end();

function group(items, keyFn) {
  const map = new Map();
  for (const item of items) {
    const key = keyFn(item);
    if (!key) continue;
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(item);
  }
  return map;
}

function names(list) {
  const shown = list.slice(0, 3).map((o) => o.name || o.email).join(', ');
  return list.length > 3 ? `${shown} +${list.length - 3} more` : shown;
}
