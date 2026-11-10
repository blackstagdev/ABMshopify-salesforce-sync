// Read-only progress of the historical order load (backfill) and the queue.
//
//   npm run -s backfill-status
import { config } from '../src/config.js';
import { createDb } from '../src/db.js';

const db = createDb(config);
const q = async (sql, params = []) => (await db.pool.query(sql, params)).rows;
const BACKFILL = 'backfill:orders:%';

const byStatus = await q(
  `SELECT status, count(*)::int AS orders,
          left(min(payload->>'created_at'), 10) AS oldest_order,
          left(max(payload->>'created_at'), 10) AS newest_order
   FROM shopify_events WHERE webhook_id LIKE $1 GROUP BY 1 ORDER BY 1`,
  [BACKFILL],
);
console.log('\nHISTORICAL ORDER LOAD (all backfill runs):');
console.table(byStatus);

const [queue] = await q(`SELECT count(*) FILTER (WHERE status IN ('pending', 'processing'))::int AS waiting FROM shopify_events`);
const [recent] = await q(`SELECT count(*)::int AS n FROM shopify_events WHERE processed_at > now() - interval '10 minutes'`);
const perMinute = recent.n / 10;
const hours = perMinute > 0 ? queue.waiting / perMinute / 60 : null;
console.log(`Waiting in the queue: ${queue.waiting}`);
console.log(`Speed: ~${Math.round(perMinute)} events/min${hours != null ? ` -> about ${hours < 1 ? `${Math.round(hours * 60)} min` : `${hours.toFixed(1)} h`} left` : ' (not processing right now)'}`);

const [links] = await q('SELECT count(*)::int AS n, count(account_id)::int AS linked FROM salesforce_orders');
const [oldestSent] = await q(`SELECT left(min(payload->>'created_at'), 10) AS d FROM shopify_events WHERE webhook_id LIKE $1 AND status = 'synced'`, [BACKFILL]);
console.log(`Orders in Salesforce via the sync: ${links.n} (${links.linked} linked to a practice)`);
console.log(`Oldest order sent so far: ${oldestSent.d ?? '-'}`);

// A failed backfill attempt whose order reached Salesforce through a newer
// event is not a problem any more: only orders with no link count as failed.
const NOT_IN_SF = `NOT EXISTS (SELECT 1 FROM salesforce_orders o WHERE o.shopify_order_id = payload->>'id')`;
const [stale] = await q(
  `SELECT count(*)::int AS n FROM shopify_events WHERE webhook_id LIKE $1 AND status = 'failed' AND NOT ${NOT_IN_SF}`,
  [BACKFILL],
);
if (stale.n > 0) console.log(`(${stale.n} of the failed ones are already in Salesforce through a newer event: not counted below.)`);

const failures = await q(
  // Grouped by the error itself: the Provider ID and query string are
  // blanked out so the same failure on different practices counts once.
  `SELECT left(regexp_replace(regexp_replace(last_error, 'Provider_ID__c/[^ ?]+', 'Provider_ID__c/<id>'), '[?][^ ]*', ''), 160) AS error,
          count(*)::int AS n
   FROM shopify_events WHERE webhook_id LIKE $1 AND status = 'failed' AND ${NOT_IN_SF}
   GROUP BY 1 ORDER BY 2 DESC LIMIT 8`,
  [BACKFILL],
);
if (failures.length) {
  console.log('\nFailed, most common reasons:');
  console.table(failures);

  // An order upserts its practice first, so it fails whenever the customer
  // does. Orders whose customer has since synced can simply be retried.
  const byCustomer = await q(
    `WITH failed AS (
       SELECT payload->'customer'->>'id' AS customer_id, last_error FROM shopify_events
       WHERE webhook_id LIKE $1 AND status = 'failed' AND ${NOT_IN_SF}
     ), customer AS (
       SELECT DISTINCT ON (payload->>'id') payload->>'id' AS customer_id, status FROM shopify_events
       WHERE topic LIKE 'customers/%' ORDER BY payload->>'id', id DESC
     )
     SELECT CASE WHEN f.customer_id IS NULL THEN 'guest checkout' ELSE coalesce(c.status, 'never queued') END AS customer_status,
            CASE WHEN last_error LIKE '%Shopify_ID__c duplicates%' THEN 'old UUID Provider ID'
                 WHEN last_error LIKE '%DUPLICATES_DETECTED%' THEN 'possible duplicate practice'
                 WHEN last_error LIKE '%REQUEST_LIMIT%' THEN 'API limit'
                 ELSE 'other' END AS reason,
            count(*)::int AS orders, count(DISTINCT f.customer_id)::int AS customers
     FROM failed f LEFT JOIN customer c USING (customer_id)
     GROUP BY 1, 2 ORDER BY 3 DESC`,
    [BACKFILL],
  );
  console.log('Failed orders by their customer\'s sync status:');
  console.table(byCustomer);
  const retryable = byCustomer.filter((r) => r.customer_status === 'synced' || r.reason === 'API limit');
  if (retryable.length) {
    console.log(`${retryable.reduce((n, r) => n + r.orders, 0)} of these can be retried now (customer synced, or an API limit error):`);
    console.log('  npm run requeue -- --status=failed --latest --error=REQUEST_LIMIT   (or --error=<text> for the others)');
  }
}

console.log(queue.waiting < 200
  ? '\nQueue is (nearly) empty: run the next batch with  npm run backfill -- --orders --limit=15000'
  : '\nStill working through the queue: check again later.');

// Reminder: customers whose latest event is from the dry-run period have
// never been sent. They need a customer backfill once the orders are done.
const [neverSent] = await q(
  `SELECT count(*)::int AS n FROM (
     SELECT DISTINCT ON (payload->>'id') status FROM shopify_events
     WHERE topic LIKE 'customers/%' ORDER BY payload->>'id', id DESC
   ) latest WHERE status = 'dry_run'`,
);
if (neverSent.n > 0) {
  console.log(`\nREMINDER: ${neverSent.n} customers have never been sent to Salesforce (last seen in dry run).`);
  console.log('When the order backfill is finished, run:  npm run backfill -- --customers');
}
await db.pool.end();
