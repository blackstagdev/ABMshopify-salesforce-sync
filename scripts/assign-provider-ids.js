// Gives Shopify customers without a Provider ID a new, unique one, writes
// it to their Provider ID metafield, and queues them for syncing.
// The field reference: "where they do not [hold one], a value is generated
// during migration and written back so the practice is addressable".
//
//   npm run assign-provider-ids                      preview the next 100, writes nothing
//   npm run assign-provider-ids -- --limit=20        preview a different batch size
//   npm run assign-provider-ids -- --apply           write IDs + queue those customers
//   npm run assign-provider-ids -- --apply --include-flagged
//
// Customers are taken most recently updated first. Customers who look like
// the same practice as someone else are skipped unless --include-flagged,
// so they can be given a shared ID by hand. Needs the write_customers scope.
import crypto from 'node:crypto';
import { config } from '../src/config.js';
import { createDb } from '../src/db.js';
import { createShopifyAdmin } from '../src/shopify/admin.js';
import { generateProviderId } from '../src/mapping/providerId.js';
import { flagSamePractice } from '../src/mapping/samePractice.js';

const args = process.argv.slice(2);
const apply = args.includes('--apply');
const includeFlagged = args.includes('--include-flagged');
const limit = Number(args.find((a) => a.startsWith('--limit='))?.split('=')[1] ?? 100);

const metafield = config.mapping.providerIdMetafield;
const dot = metafield.indexOf('.');
if (dot <= 0) {
  console.error('Set PROVIDER_ID_METAFIELD (e.g. custom.provider_id) first.');
  process.exit(1);
}
const namespace = metafield.slice(0, dot);
const key = metafield.slice(dot + 1);

const shopify = createShopifyAdmin(config.shopify);

// 1. Read every customer, so new IDs are unique and same-practice matches
//    can be spotted across the whole store.
const all = [];
for await (const page of shopify.listCustomersWithMetafield(namespace, key)) {
  all.push(...page);
  process.stderr.write(`\rRead ${all.length} customers...`);
}
process.stderr.write('\n');

// 2. Pick the batch and generate IDs.
const taken = new Set(all.filter((c) => c.providerId).map((c) => c.providerId.toUpperCase()));
const candidates = all.filter((c) => !c.providerId).slice(0, limit);
const notes = flagSamePractice(candidates, all);

const rows = candidates.map((c) => {
  let id;
  do id = generateProviderId(crypto.randomBytes); while (taken.has(id));
  taken.add(id);
  const note = notes.get(c.id);
  return { ...c, newId: id, note, skip: Boolean(note) && !includeFlagged };
});

console.table(rows.map((r) => ({
  'Shopify ID': r.id,
  Name: r.name,
  Email: r.email ?? '',
  Company: r.company ?? '(none: Account named after the person)',
  'New Provider ID': r.skip ? '(skipped)' : r.newId,
  Note: r.note ? `${r.skip ? 'SKIPPED, ' : ''}${r.note}` : '',
})));

const toWrite = rows.filter((r) => !r.skip);
console.log(`
Customers in store:          ${all.length}
Already have a Provider ID:  ${all.length - all.filter((c) => !c.providerId).length}
Without one:                 ${all.filter((c) => !c.providerId).length}
In this batch:               ${rows.length}
  would get a new ID:        ${toWrite.length}
  skipped (possible same practice as another customer): ${rows.length - toWrite.length}
  with no company name:      ${toWrite.filter((r) => !r.company).length}`);

if (!apply) {
  console.log('\nPreview only: nothing was written. Re-run with --apply to write these IDs to Shopify and queue the customers.');
  process.exit(0);
}

// 3. Write the metafields, 25 per call. compareDigest: null means "only if
//    the customer still has no value", so an ID someone set by hand in the
//    meantime is never overwritten.
const written = [];
for (let i = 0; i < toWrite.length; i += 25) {
  const batch = toWrite.slice(i, i + 25);
  const { metafieldsSet } = await shopify.graphql(
    `mutation ($metafields: [MetafieldsSetInput!]!) {
      metafieldsSet(metafields: $metafields) {
        metafields { owner { ... on Customer { legacyResourceId } } }
        userErrors { field message code }
      }
    }`,
    {
      metafields: batch.map((r) => ({
        ownerId: r.gid, namespace, key, type: 'single_line_text_field', value: r.newId, compareDigest: null,
      })),
    },
  );
  for (const e of metafieldsSet.userErrors) console.error(`! ${e.field?.join('.')}: ${e.message}`);
  const ok = new Set(metafieldsSet.metafields.map((m) => m.owner?.legacyResourceId));
  written.push(...batch.filter((r) => ok.has(r.id)));
}
console.log(`\nWrote ${written.length} Provider ID(s) to Shopify.`);

// 4. Queue the updated customers, in the same shape as a webhook, so they
//    sync without waiting for their next change in Shopify.
const db = createDb(config);
await db.migrate();
let queued = 0;
for (let i = 0; i < written.length; i += 250) {
  const ids = written.slice(i, i + 250).map((r) => r.id).join(',');
  for await (const page of shopify.paginate(`/customers.json?ids=${ids}&limit=250`, 'customers')) {
    for (const customer of page) {
      const inserted = await db.insertEvent({
        webhookId: `provider-id-assigned:${customer.id}:${customer.updated_at}`,
        topic: 'customers/update',
        shopDomain: config.shopify.shopDomain,
        payload: customer,
      });
      if (inserted) queued++;
    }
  }
}
await db.pool.end();
console.log(`Queued ${queued} customer(s). In live mode they reach Salesforce within about a minute; check /admin/stats.`);
