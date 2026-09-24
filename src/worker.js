import { BlockedError } from './errors.js';

// Polls the event table and processes events one at a time, in the order
// they arrived, so an update is never applied before its create.
export function startWorker({ db, handle, intervalMs, batchSize, maxAttempts, log = console }) {
  let stopped = false;
  let timer = null;
  let current = Promise.resolve();

  async function tick() {
    let claimed = 0;
    try {
      const events = await db.claimEvents(batchSize);
      claimed = events.length;
      for (const event of events) {
        if (stopped) break;
        await runOne(event);
      }
    } catch (err) {
      log.error('[worker] poll failed:', err.message);
    }
    if (!stopped) timer = setTimeout(schedule, claimed === batchSize ? 0 : intervalMs);
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
      if (err instanceof BlockedError) {
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
