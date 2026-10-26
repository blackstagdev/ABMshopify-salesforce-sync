import { BlockedError } from './errors.js';
import { isApiLimitError, isBackfill } from './salesforce/apiBudget.js';

// After Salesforce reports the daily API limit, nothing is sent for this long.
const LIMIT_PAUSE_MS = 30 * 60_000;

// Polls the event table and processes events one at a time, in the order
// they arrived, so an update is never applied before its create.
// `budget` (optional) holds backfill events back while the daily Salesforce
// API allowance is low. Hitting the limit itself pauses everything for a
// while; those events wait and keep their attempts.
export function startWorker({ db, handle, intervalMs, batchSize, maxAttempts, budget = null, log = console, now = Date.now }) {
  let stopped = false;
  let timer = null;
  let current = Promise.resolve();
  let pausedUntil = 0;

  async function tick() {
    let claimed = 0;
    try {
      if (now() >= pausedUntil) {
        const events = await db.claimEvents(batchSize);
        claimed = events.length;
        for (const event of events) {
          if (stopped || now() < pausedUntil) {
            await db.deferEvent(event.id, 0);
            continue;
          }
          if (budget && isBackfill(event) && !(await budget.backfillAllowed())) {
            await db.deferEvent(event.id, 30 * 60);
            continue;
          }
          await runOne(event);
        }
      }
    } catch (err) {
      log.error('[worker] poll failed:', err.message);
    }
    if (!stopped) timer = setTimeout(schedule, claimed === batchSize && now() >= pausedUntil ? 0 : intervalMs);
  }

  function schedule() {
    current = tick();
  }

  async function runOne(event) {
    try {
      const { status, result } = await handle(event);
      await db.finishEvent(event.id, status, result);
      log.info(`[worker] event ${event.id} ${event.topic} -> ${status}`);
    } catch (err) {
      if (isApiLimitError(err)) {
        pausedUntil = now() + LIMIT_PAUSE_MS;
        await db.deferEvent(event.id, LIMIT_PAUSE_MS / 1000, err.message);
        log.warn(`[worker] Salesforce daily API limit reached: pausing ${LIMIT_PAUSE_MS / 60_000} min`);
      } else if (err instanceof BlockedError) {
        await db.finishEvent(event.id, 'blocked', err.details ?? null, err.message);
        log.warn(`[worker] event ${event.id} blocked: ${err.message}`);
      } else if (err.retryable === false || event.attempts >= maxAttempts) {
        await db.finishEvent(event.id, 'failed', null, err.message);
        log.error(`[worker] event ${event.id} failed: ${err.message}`);
      } else {
        const delay = backoffSeconds(event.attempts);
        await db.retryEvent(event.id, err.message, delay);
        log.warn(`[worker] event ${event.id} retry in ${delay}s: ${err.message}`);
      }
    }
  }

  schedule();

  return {
    async stop() {
      stopped = true;
      clearTimeout(timer);
      await current;
    },
  };
}

// 30s, 60s, 2m, 4m ... capped at 1 hour.
export function backoffSeconds(attempts) {
  return Math.min(30 * 2 ** Math.max(attempts - 1, 0), 3600);
}
