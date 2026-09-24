// Puts processed events back in the queue.
//
//   npm run requeue -- --status=dry_run   replay everything seen in dry run
//   npm run requeue -- --status=blocked   after fixing a blocker
//   npm run requeue -- --ids=12,13
import { config } from '../src/config.js';
import { createDb } from '../src/db.js';

const arg = (name) => process.argv.find((a) => a.startsWith(`--${name}=`))?.split('=')[1];
const status = arg('status');
const ids = arg('ids')?.split(',').map(Number).filter(Number.isFinite);

if (!status && !ids?.length) {
  console.error('Pass --status=<status> or --ids=1,2,3');
  process.exit(1);
}

const db = createDb(config);
console.log(`Requeued ${await db.requeue({ status, ids })} event(s).`);
await db.pool.end();
