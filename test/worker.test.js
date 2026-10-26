import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startWorker } from '../src/worker.js';
import { createApiBudget } from '../src/salesforce/apiBudget.js';
import { SalesforceError } from '../src/errors.js';

const quiet = { info() {}, warn() {}, error() {} };

// A fake queue that hands out its events once and records what happened.
function fakeDb(events) {
  const log = [];
  let queue = [...events];
  return {
    log,
    async claimEvents(n) {
      const batch = queue.slice(0, n);
      queue = queue.slice(n);
      return batch.map((e) => ({ attempts: 1, ...e }));
    },
    async finishEvent(id, status) { log.push(['finish', id, status]); },
    async retryEvent(id) { log.push(['retry', id]); },
    async deferEvent(id, delay) { log.push(['defer', id, delay]); },
  };
}

async function runOnce(opts) {
  const worker = startWorker({ intervalMs: 60_000, batchSize: 10, maxAttempts: 8, log: quiet, ...opts });
  await new Promise((resolve) => setTimeout(resolve, 20));
  await worker.stop();
}

test('backfill events wait while the API allowance is low; live events still go', async () => {
  const db = fakeDb([{ id: 1, webhook_id: 'backfill:orders:1:x' }, { id: 2, webhook_id: 'shopify-abc' }]);
  const budget = { async backfillAllowed() { return false; } };
  await runOnce({ db, budget, handle: async () => ({ status: 'synced' }) });
  assert.deepEqual(db.log, [['defer', 1, 1800], ['finish', 2, 'synced']]);
});

test('hitting the daily limit pauses the worker without using up attempts', async () => {
  const db = fakeDb([{ id: 1, webhook_id: 'shopify-a' }, { id: 2, webhook_id: 'shopify-b' }]);
  const handle = async () => {
    throw new SalesforceError('GET /x -> 403 REQUEST_LIMIT_EXCEEDED: TotalRequests Limit exceeded.', 403);
  };
  await runOnce({ db, handle });
  assert.deepEqual(db.log, [['defer', 1, 1800], ['defer', 2, 0]], 'the second event is released untried');
});

test('the budget keeps the reserve and re-reads /limits only now and then', async () => {
  let remaining = 50_000;
  let calls = 0;
  let clock = 0;
  const sf = { async request() { calls++; return { data: { DailyApiRequests: { Max: 100_000, Remaining: remaining } } }; } };
  const budget = createApiBudget(sf, { reservePercent: 30, now: () => clock, log: quiet });
  assert.equal(await budget.backfillAllowed(), true);
  remaining = 20_000;
  assert.equal(await budget.backfillAllowed(), true, 'cached for 5 minutes');
  clock += 5 * 60_000;
  assert.equal(await budget.backfillAllowed(), false);
  assert.equal(calls, 2);
});
