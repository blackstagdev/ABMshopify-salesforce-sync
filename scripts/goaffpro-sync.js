// GoAffPro affiliates -> Salesforce. Dry run by default (reads only and
// reports what would change); --apply writes, and only in live mode.
//
//   npm run -s goaffpro-sync                     dry run, everything
//   npm run -s goaffpro-sync -- --limit=10       dry run, first 10 approved affiliates
//   npm run -s goaffpro-sync -- --limit=10 --apply
//   npm run -s goaffpro-sync -- --apply
//
// Needs GOAFFPRO_ACCESS_TOKEN, the Salesforce and Shopify settings, and
// PROVIDER_ID_METAFIELD.
import { config } from '../src/config.js';
import { createSalesforceClient } from '../src/salesforce/client.js';
import { createShopifyAdmin } from '../src/shopify/admin.js';
import { createGoAffProClient } from '../src/goaffpro/client.js';
import { runAffiliateSync } from '../src/goaffpro/sync.js';

const arg = (name) => process.argv.find((a) => a.startsWith(`--${name}=`))?.split('=')[1];
const apply = process.argv.includes('--apply');
const limit = Number(arg('limit') ?? Infinity);

if (apply && config.salesforce.mode !== 'live') {
  console.error('--apply needs SALESFORCE_MODE=live.');
  process.exit(1);
}
if (!config.mapping.providerIdMetafield.includes('.')) {
  console.error('Set PROVIDER_ID_METAFIELD (e.g. custom.provider_id).');
  process.exit(1);
}

console.log(apply ? 'APPLYING changes to Salesforce.' : 'DRY RUN: nothing will be written.');
const summary = await runAffiliateSync({
  gap: createGoAffProClient({ accessToken: process.env.GOAFFPRO_ACCESS_TOKEN }),
  sf: createSalesforceClient(config.salesforce),
  shopify: createShopifyAdmin(config.shopify),
  providerIdMetafield: config.mapping.providerIdMetafield,
  apply,
  limit,
  log: (m) => console.log(m),
});

const verb = apply ? '' : ' (would be)';
console.log(`\nAFFILIATE ACCOUNTS${verb}:`);
console.table([summary.affiliates]);
console.log(`UPLINES${verb}:`);
console.table([summary.uplines]);
console.log(`REFERRED PRACTICES${verb}:`);
console.table([summary.practices]);
if (summary.errors.length) {
  console.log(`\nPROBLEMS (${summary.errors.length}):`);
  console.table(summary.errors);
}
if (!apply) console.log('\nThis was a dry run. Add --apply to write (start with --limit=10).');
