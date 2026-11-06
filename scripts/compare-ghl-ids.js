// Read-only. For the "same practice, two GHL IDs" rows in duplicates.csv
// (run report-duplicates first), looks up both GHL contacts in the Alpha
// BioMed sub-account and suggests which ID is right. Writes nothing except
// compare-ghl-ids.csv (download: /admin/reports/compare-ghl-ids.csv).
//
//   npm run -s compare-ghl-ids
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { config } from '../src/config.js';
import { parseCsv, toCsv } from '../src/csv.js';
import { createGhlAccounts } from '../src/ghl/accounts.js';
import { suggestProviderId } from '../src/ghl/compareIds.js';
import { isUuid } from '../src/salesforce/providerIdFix.js';

if (!existsSync('duplicates.csv')) {
  console.error('Run npm run -s report-duplicates first (it writes duplicates.csv).');
  process.exit(1);
}
const account = createGhlAccounts(config.ghl).abm;
if (!account) {
  console.error('The Alpha BioMed GHL sub-account is not configured.');
  process.exit(1);
}

const rows = parseCsv(readFileSync('duplicates.csv', 'utf8')).filter((r) => {
  const sfId = r['Provider ID in Salesforce'];
  const shId = r['Provider ID in Shopify'];
  return sfId && shId && !isUuid(sfId) && sfId.toUpperCase() !== shId.toUpperCase();
});
if (rows.length === 0) {
  console.log('No "two GHL IDs" rows in duplicates.csv.');
  process.exit(0);
}

const stageNames = {};
for (const p of await account.client.pipelines()) for (const s of p.stages ?? []) stageNames[s.id] = s.name;

async function side(id) {
  let contact = null;
  try {
    contact = await account.client.contact(id);
  } catch (err) {
    if (!/ (400|404|422) /.test(err.message)) throw err;
  }
  if (!contact) return { exists: false, name: '', email: '', stage: '', approved: false };
  const { opportunities } = await account.client.searchOpportunities({ pipelineId: account.cfg.pipelineId, contactId: id, status: 'all', limit: 20 });
  const latest = [...opportunities].sort((a, b) => String(b.updatedAt ?? '').localeCompare(String(a.updatedAt ?? '')))[0];
  const stage = latest ? `${stageNames[latest.pipelineStageId] ?? latest.pipelineStageId} (${latest.status})` : 'no opportunity';
  return {
    exists: true,
    name: [contact.firstName, contact.lastName].filter(Boolean).join(' ') || contact.name || '',
    email: contact.email ?? '',
    added: contact.dateAdded?.slice(0, 10) ?? '',
    stage,
    approved: opportunities.some((o) => /approved/i.test(stageNames[o.pipelineStageId] ?? '')),
  };
}

const out = [];
for (const r of rows) {
  const sfId = r['Provider ID in Salesforce'];
  const shId = r['Provider ID in Shopify'];
  const [sfSide, shSide] = [await side(sfId), await side(shId)];
  const { suggestion, why } = suggestProviderId(sfSide, shSide, r.Email);
  out.push({
    Practice: r['Shopify customer'],
    'Shopify email': r.Email,
    'Shopify customer id': r['Shopify customer id'],
    'Salesforce Account': r['Matching Salesforce Account'],
    'Salesforce Account Id': r['Salesforce Account Id'],
    'Salesforce GHL ID': sfId,
    'SF ID: GHL contact': sfSide.exists ? `${sfSide.name} <${sfSide.email}> added ${sfSide.added}` : 'NOT FOUND',
    'SF ID: GHL stage': sfSide.stage ?? '',
    'Shopify GHL ID': shId,
    'Shopify ID: GHL contact': shSide.exists ? `${shSide.name} <${shSide.email}> added ${shSide.added}` : 'NOT FOUND',
    'Shopify ID: GHL stage': shSide.stage ?? '',
    Suggestion: suggestion,
    Why: why,
    'Decision (Salesforce / Shopify / new practice)': '',
  });
  process.stderr.write(`\rChecked ${out.length}/${rows.length}...`);
}
process.stderr.write('\n');

for (const o of out) {
  console.log(`\n${o.Practice}  ->  ${o.Suggestion}: ${o.Why}`);
  console.log(`  Salesforce ${o['Salesforce GHL ID']}: ${o['SF ID: GHL contact']} | ${o['SF ID: GHL stage']}`);
  console.log(`  Shopify    ${o['Shopify GHL ID']}: ${o['Shopify ID: GHL contact']} | ${o['Shopify ID: GHL stage']}`);
}
const n = (s) => out.filter((o) => o.Suggestion === s).length;
console.log(`\n${out.length} practices: Salesforce ID ${n('Salesforce')}, Shopify ID ${n('Shopify')}, ASK ${n('ASK')}`);
writeFileSync('compare-ghl-ids.csv', toCsv(Object.keys(out[0]), out));
console.log('Saved as compare-ghl-ids.csv (download: /admin/reports/compare-ghl-ids.csv)');
