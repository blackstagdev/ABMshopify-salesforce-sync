import { buildPlan } from './mapping/plan.js';
import { executePlan } from './salesforce/executor.js';
import { BlockedError } from './errors.js';

// Returns { status, result } for a stored event, or throws.
export async function processEvent(event, { mode, mapping, salesforce, sf }) {
  const plan = buildPlan(event.topic, event.payload, mapping);
  if (!plan) {
    return { status: 'ignored', result: { reason: `Topic ${event.topic} is not synced` } };
  }

  if (mode === 'dry_run') {
    return { status: 'dry_run', result: plan };
  }

  if (plan.blockers.length > 0) {
    throw new BlockedError(plan.blockers, plan);
  }

  const outcome = await executePlan(plan, sf, salesforce);
  return { status: 'synced', result: { ...plan, outcome } };
}
