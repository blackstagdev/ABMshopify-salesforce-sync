// Read-only look at a GHL sub-account, to decide how leads map to
// Salesforce. Lists pipelines and stages, counts the opportunities in the
// lead stage, and shows which fields are filled on a sample of them.
//
//   npm run ghl-explore -- --account=abm              Alpha BioMed, stage "New Providers"
//   npm run ghl-explore -- --account=sync             Alpha Sync, stage "New Leads"
//   npm run ghl-explore -- --account=abm --sample=20  look at more opportunities
//   npm run ghl-explore -- --account=abm --full       show values unshortened (don't paste these)
//
// Needs GHL_ABM_TOKEN + GHL_ABM_LOCATION_ID (or GHL_SYNC_...).
import { createGhlClient, GHL_ACCOUNTS } from '../src/ghl/client.js';
import { flattenRecord, inventory } from '../src/ghl/explore.js';

const arg = (name) => process.argv.find((a) => a.startsWith(`--${name}=`))?.split('=').slice(1).join('=');
const account = GHL_ACCOUNTS[arg('account') ?? ''];
if (!account) {
  console.error('Pass --account=abm or --account=sync');
  process.exit(1);
}
const stageName = arg('stage') ?? account.stage;
const sampleSize = Number(arg('sample') ?? 10);
const full = process.argv.includes('--full');

const ghl = createGhlClient({
  token: process.env[`${account.env}_TOKEN`],
  locationId: process.env[`${account.env}_LOCATION_ID`],
});

console.log(`\n=== ${account.label} (location ${ghl.locationId})`);

const pipelines = await ghl.pipelines();
console.log('\nPipelines and stages:');
for (const p of pipelines) {
  console.log(`  ${p.name}  [${p.id}]`);
  for (const s of p.stages ?? []) console.log(`    - ${s.name}  [${s.id}]`);
}

const matches = pipelines.flatMap((p) => (p.stages ?? [])
  .filter((s) => s.name.trim().toLowerCase() === stageName.toLowerCase())
  .map((s) => ({ pipeline: p, stage: s })));
if (matches.length === 0) {
  console.error(`\nNo stage named "${stageName}". Pass --stage="<exact name>" from the list above.`);
  process.exit(1);
}
if (matches.length > 1) console.log(`\nNote: "${stageName}" exists in ${matches.length} pipelines; showing all.`);

const customFieldNames = Object.fromEntries((await ghl.customFields()).map((f) => [f.id, `${f.name} {${f.fieldKey ?? f.id}}`]));

for (const { pipeline, stage } of matches) {
  const { opportunities, meta } = await ghl.searchOpportunities({ pipelineId: pipeline.id, stageId: stage.id, limit: Math.min(sampleSize, 100) });
  console.log(`\nStage "${stage.name}" in "${pipeline.name}": ${meta.total ?? opportunities.length} opportunities. Sample of ${opportunities.length}:`);

  const records = [];
  for (const opp of opportunities.slice(0, sampleSize)) {
    const contactId = opp.contactId ?? opp.contact?.id;
    const contact = contactId ? await ghl.contact(contactId) : null;
    records.push(flattenRecord(opp, contact, customFieldNames));
  }
  console.table(inventory(records, { full }));
}

if (!full) console.log('\nPersonal values are shortened (e.g. "Joh…(10)"). Sources, tags, states and campaign fields are shown in full.');
