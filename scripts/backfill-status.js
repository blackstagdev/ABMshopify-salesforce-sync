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

const failures = await q(
  `SELECT left(last_error, 90) AS error, count(*)::int AS n
   FROM shopify_events WHERE webhook_id LIKE $1 AND status = 'failed'
   GROUP BY 1 ORDER BY 2 DESC LIMIT 5`,
  [BACKFILL],
);
if (failures.length) {
  console.log('\nFailed, most common reasons:');
  console.table(failures);
}

console.log(queue.waiting < 200
  ? '\nQueue is (nearly) empty: run the next batch with  npm run backfill -- --orders --limit=15000'
  : '\nStill working through the queue: check again later.');
await db.pool.end();
