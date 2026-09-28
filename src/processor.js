import { buildPlan, customerIdFor } from './mapping/plan.js';
import { executePlan } from './salesforce/executor.js';
import { BlockedError } from './errors.js';

// Returns { status, result } for a stored event, or throws.
export async function processEvent(event, { mode, mapping, salesforce, sf, shopify }) {
  const context = await lookupContext(event, mapping, shopify);
  const plan = buildPlan(event.topic, event.payload, mapping, context);
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

// Reads from Shopify only (never Salesforce), so it also runs in dry run.
// The value is read at processing time, so a Provider ID added to a
// customer after the event arrived is picked up on requeue.
async function lookupContext(event, mapping, shopify) {
  if (mapping.providerIdStrategy !== 'customer_metafield') return {};
  const customerId = customerIdFor(event.topic, event.payload);
  if (!customerId) return {};

  const [namespace, key] = splitMetafield(mapping.providerIdMetafield);
  if (!shopify) throw new BlockedError('Shopify Admin API is not configured (SHOPIFY_SHOP_DOMAIN and credentials)');
  return { providerIdMetafield: await shopify.getCustomerMetafield(customerId, namespace, key) };
}

function splitMetafield(value) {
  const dot = value.indexOf('.');
  if (dot <= 0 || dot === value.length - 1) {
    throw new BlockedError(`PROVIDER_ID_METAFIELD must be "namespace.key" (got "${value}")`);
  }
  return [value.slice(0, dot), value.slice(dot + 1)];
}
