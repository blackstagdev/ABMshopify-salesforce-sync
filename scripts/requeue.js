// Puts processed events back in the queue.
//
//   npm run requeue -- --status=blocked            after fixing a blocker
//   npm run requeue -- --ids=12,13
//   npm run requeue -- --status=failed --error=REQUEST_LIMIT_EXCEEDED
//                                                  only failures with that text
//   npm run requeue -- --status=synced --latest    re-send only the newest event
//                                                  per customer / per order
//   npm run requeue -- --status=synced --latest --topic=orders     orders only
//   npm run requeue -- --status=synced --latest --topic=customers  customers only
//
// --latest never replays older data over newer data. Use it to re-send
// records already synced, e.g. to fill in a newly mapped field.
import { config } from '../src/config.js';
import { createDb } from '../src/db.js';

const arg = (name) => process.argv.find((a) => a.startsWith(`--${name}=`))?.split('=')[1];
const status = arg('status');
const ids = arg('ids')?.split(',').map(Number).filter(Number.isFinite);
const latest = process.argv.includes('--latest');
const topic = arg('topic');
const error = arg('error');

if (topic && !['customers', 'orders', 'ghl'].includes(topic)) {
  console.error('--topic must be customers, orders or ghl');
  process.exit(1);
}

if (error && latest) {
  console.error('--error cannot be combined with --latest');
  process.exit(1);
}
if (latest && !status) {
  console.error('--latest needs --status=<status>');
  process.exit(1);
}
if (!status && !ids?.length) {
  console.error('Pass --status=<status> (optionally --latest) or --ids=1,2,3');
  process.exit(1);
}

const db = createDb(config);
const count = latest ? await db.requeueLatest(status, topic ?? null) : await db.requeue({ status, ids, error });
console.log(`Requeued ${count} event(s).`);
await db.pool.end();
