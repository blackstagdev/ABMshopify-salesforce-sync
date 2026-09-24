// Loads existing Shopify customers and/or orders into the event queue, so
// they go through exactly the same mapping as live webhooks.
//
//   npm run backfill -- --customers
//   npm run backfill -- --orders --since=2026-01-01
//
// Orders older than 60 days need the read_all_orders scope.
import { config } from '../src/config.js';
import { createDb } from '../src/db.js';
import { createShopifyAdmin } from '../src/shopify/admin.js';

const args = process.argv.slice(2);
const doCustomers = args.includes('--customers');
const doOrders = args.includes('--orders');
const since = args.find((a) => a.startsWith('--since='))?.split('=')[1];

if (!doCustomers && !doOrders) {
  console.error('Pass --customers and/or --orders (optionally --since=YYYY-MM-DD).');
  process.exit(1);
}

const db = createDb(config);
await db.migrate();
const shopify = createShopifyAdmin(config.shopify);
const sinceParam = since ? `&created_at_min=${encodeURIComponent(new Date(since).toISOString())}` : '';

async function load(label, path, key, topic) {
  let queued = 0;
  let skipped = 0;
  for await (const page of shopify.paginate(path, key)) {
    for (const record of page) {
      // Same record + same updated_at = same event, so re-runs do not duplicate.
      const inserted = await db.insertEvent({
        webhookId: `backfill:${key}:${record.id}:${record.updated_at}`,
        topic,
        shopDomain: config.shopify.shopDomain,
        payload: record,
      });
      inserted ? queued++ : skipped++;
    }
    console.log(`${label}: ${queued} queued, ${skipped} already queued`);
  }
}

if (doCustomers) await load('Customers', `/customers.json?limit=250${sinceParam}`, 'customers', 'customers/update');
if (doOrders) await load('Orders', `/orders.json?status=any&limit=250${sinceParam}`, 'orders', 'orders/updated');

await db.pool.end();
