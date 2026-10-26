// One-time load of historical Shopify orders into Salesforce through the
// Bulk API (see src/orders/bulkImport.js). Dry run by default: reads Shopify,
// Salesforce and the database, writes sample CSVs and counts, sends nothing.
//
//   npm run -s bulk-import-orders                         dry run, everything
//   npm run -s bulk-import-orders -- --limit=100          dry run, 100 orders
//   npm run -s bulk-import-orders -- --limit=100 --apply  load 100
//   npm run -s bulk-import-orders -- --apply              load everything
//
// --apply needs SALESFORCE_MODE=live and the worker stopped
// (WORKER_ENABLED=false). Safe to run again: it only loads what's missing.
// Files (samples, problems.csv) go to ./bulk-import/.
import { resolve } from 'node:path';
import { config } from '../src/config.js';
import { createDb } from '../src/db.js';
import { createSalesforceClient } from '../src/salesforce/client.js';
import { createShopifyAdmin } from '../src/shopify/admin.js';
import { createBulk } from '../src/salesforce/bulk.js';
import { runOrderImport } from '../src/orders/bulkImport.js';

const arg = (name) => process.argv.find((a) => a.startsWith(`--${name}=`))?.split('=')[1];
const apply = process.argv.includes('--apply');
const limit = Number(arg('limit') ?? Infinity);
const chunkSize = Number(arg('chunk') ?? 3000);
const workDir = resolve('bulk-import');

if (apply && config.salesforce.mode !== 'live') {
  console.error('--apply needs SALESFORCE_MODE=live.');
  process.exit(1);
}
if (!config.mapping.providerIdMetafield.includes('.')) {
  console.error('Set PROVIDER_ID_METAFIELD (e.g. custom.provider_id).');
  process.exit(1);
}

const log = (m) => console.log(m);
const db = createDb(config);
await db.migrate();
const sf = createSalesforceClient(config.salesforce);

console.log(apply ? 'APPLYING: orders will be loaded into Salesforce.' : 'DRY RUN: nothing will be sent or saved.');
try {
  const s = await runOrderImport({
    shopify: createShopifyAdmin(config.shopify),
    sf,
    db,
    bulk: createBulk(sf, { log }),
    mapping: config.mapping,
    salesforce: config.salesforce,
    apply,
    limit,
    chunkSize,
    workDir,
    log,
  });
  const verb = apply ? '' : ' (would be)';
  console.log('\nSHOPIFY ORDERS:');
  console.table([s.shopify]);
  console.log(`PROVIDER ORDERS${verb}:`);
  console.table([s.orders]);
  console.log(`ORDER LINES${verb}:`);
  console.table([s.lines]);
  if (apply) console.log(`Queued backfill events closed as imported: ${s.eventsMarkedImported}`);
  if (s.problems.length) {
    console.log(`\nPROBLEMS (${s.problems.length}, first 20; all in ${workDir}/problems.csv):`);
    console.table(s.problems.slice(0, 20));
  }
  console.log(apply
    ? '\nDone. Run it again to retry anything that failed; it only loads what is still missing.'
    : `\nDry run. Sample rows: ${workDir}/sample-orders.csv and sample-lines.csv. Add --apply to load (start with --limit=100).`);
} finally {
  await db.pool.end();
}
