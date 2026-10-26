// Keeps backfills from using up the org's daily API allowance, which the
// sync shares with the Salesforce team's own integrations. Backfill events
// wait while less than `reservePercent` of the allowance is left; live
// webhook events always go. Salesforce's /limits is read at most every
// `checkEveryMs`; if it can't be read, the last answer stands.
export function createApiBudget(sf, { reservePercent, checkEveryMs = 5 * 60_000, now = Date.now, log = console }) {
  let checkedAt = -Infinity;
  let allowed = true;

  async function backfillAllowed() {
    if (now() - checkedAt < checkEveryMs) return allowed;
    checkedAt = now();
    try {
      const { data } = await sf.request('GET', '/limits');
      const { Max, Remaining } = data.DailyApiRequests;
      const nowAllowed = Remaining > (Max * reservePercent) / 100;
      if (nowAllowed !== allowed) {
        log.warn(`[api-budget] ${Remaining} of ${Max} daily API requests left: backfill ${nowAllowed ? 'resumed' : `paused (keeping ${reservePercent}% in reserve)`}`);
      }
      allowed = nowAllowed;
    } catch (err) {
      log.warn(`[api-budget] could not read /limits: ${err.message}`);
    }
    return allowed;
  }

  return { backfillAllowed };
}

export const isBackfill = (event) => String(event.webhook_id ?? '').startsWith('backfill:');
export const isApiLimitError = (err) => /REQUEST_LIMIT_EXCEEDED/.test(String(err?.message ?? ''));
