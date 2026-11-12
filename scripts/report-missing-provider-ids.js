// Read-only. Lists the Shopify customers whose newest event was blocked
// (usually: no Provider ID in Shopify), so they are not in Salesforce, with
// how many of their orders are in Salesforce without a practice.
//
//   npm run -s report-missing-provider-ids
//
// Writes missing-provider-ids.csv (download: /admin/reports/missing-provider-ids.csv).
// Fix: fill in the customer's "Provider ID" metafield in Shopify (their GHL
// contact ID), then: npm run requeue -- --status=blocked --latest --topic=customers
// The practice's unlinked orders are linked when its Account is created.
import { writeFileSync } from 'node:fs';
import { config } from '../src/config.js';
import { toCsv } from '../src/csv.js';
import { createDb } from '../src/db.js';

const db = createDb(config);
const { rows } = await db.pool.query(
  `WITH latest AS (
     SELECT DISTINCT ON (payload->>'id') id, payload, status, last_error, processed_at
     FROM shopify_events WHERE topic LIKE 'customers/%'
     ORDER BY payload->>'id', id DESC
   ), orders AS (
     SELECT shopify_customer_id, count(*)::int AS n FROM salesforce_orders
     WHERE account_id IS NULL GROUP BY 1
   )
   SELECT l.payload->>'id' AS customer_id,
          trim(concat_ws(' ', l.payload->>'first_name', l.payload->>'last_name')) AS name,
          l.payload->>'email' AS email,
          l.payload->'default_address'->>'company' AS company,
          left(l.payload->>'created_at', 10) AS created,
          l.last_error, coalesce(o.n, 0) AS unlinked_orders
   FROM latest l LEFT JOIN orders o ON o.shopify_customer_id = l.payload->>'id'
   WHERE l.status = 'blocked'
   ORDER BY unlinked_orders DESC, created DESC`,
);
await db.pool.end();

const out = rows.map((r) => ({
  'Shopify customer id': r.customer_id,
  Name: r.name,
  Email: r.email ?? '',
  Company: r.company ?? '',
  'Customer since': r.created,
  'Orders in Salesforce without a practice': r.unlinked_orders,
  Reason: r.last_error ?? '',
  'Provider ID to enter in Shopify (GHL contact ID)': '',
}));
writeFileSync('missing-provider-ids.csv', toCsv(Object.keys(out[0] ?? { 'Shopify customer id': '' }), out));

const withOrders = out.filter((r) => r['Orders in Salesforce without a practice'] > 0);
const reasons = {};
for (const r of out) reasons[r.Reason] = (reasons[r.Reason] ?? 0) + 1;
console.log(`${out.length} customers are not in Salesforce (newest event blocked).`);
console.log(`${withOrders.length} of them have orders in Salesforce without a practice (${withOrders.reduce((n, r) => n + r['Orders in Salesforce without a practice'], 0)} orders).`);
console.log('\nReasons:');
for (const [k, n] of Object.entries(reasons).sort((a, b) => b[1] - a[1])) console.log(`  ${String(n).padStart(5)}  ${k.slice(0, 140)}`);
console.log('\nSaved as missing-provider-ids.csv (download: /admin/reports/missing-provider-ids.csv)');
