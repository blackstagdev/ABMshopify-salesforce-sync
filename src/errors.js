// An event that cannot be synced until someone makes a decision or changes
// configuration. Blocked events are not retried; requeue them once fixed.
export class BlockedError extends Error {
  constructor(reasons, details) {
    const list = Array.isArray(reasons) ? reasons : [reasons];
    super(list.join('; '));
    this.name = 'BlockedError';
    this.reasons = list;
    this.details = details;
    this.retryable = false;
  }
}

export class SalesforceError extends Error {
  constructor(message, status, body) {
    super(message);
    this.name = 'SalesforceError';
    this.status = status;
    this.body = body;
    // 4xx means the request itself is wrong (bad field, guarded field,
    // missing required value); retrying will not help.
    this.retryable = status === 429 || status >= 500;
  }
}
