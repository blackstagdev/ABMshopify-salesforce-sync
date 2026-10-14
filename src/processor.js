import { buildPlan, customerIdFor, isOrderTopic } from './mapping/plan.js';
import { executePlan } from './salesforce/executor.js';
import { BlockedError } from './errors.js';
import { mapLead, leadStatusFor } from './ghl/leads.js';

export const GHL_TOPIC = 'ghl/opportunity';

// Returns { status, result } for a stored event, or throws.
export async function processEvent(event, deps) {
  if (event.topic === GHL_TOPIC) return processGhlEvent(event, deps);
  const { mode, mapping, salesforce, sf, shopify, store } = deps;
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

  const outcome = await executePlan(plan, sf, salesforce, store);
  return { status: 'synced', result: { ...plan, outcome } };
}

// A GHL Workflow ping (or backfill entry) for an opportunity in the lead
// pipeline. The current opportunity and contact are read from GHL; its
// stage (and won/lost/abandoned state) decides the Lead Status.
async function processGhlEvent(event, { mode, ghl, ghlConfig, salesforce, sf, store }) {
  const account = ghl?.[event.payload.account];
  if (!account) throw new BlockedError(`GHL sub-account "${event.payload.account}" is not configured (token and location id)`);

  // One Lead per contact: if a contact has several opportunities in the
  // pipeline, the most recently updated one sets the status.
  const latestByContact = new Map();
  for (const opp of await account.findOpportunities(event.payload)) {
    const status = leadStatusFor(opp, account.cfg);
    const contactId = opp.contactId ?? opp.contact?.id;
    if (!status || !contactId) continue;
    const prev = latestByContact.get(contactId);
    if (!prev || String(opp.updatedAt ?? '') > String(prev.opp.updatedAt ?? '')) latestByContact.set(contactId, { opp, status });
  }
  if (latestByContact.size === 0) {
    return { status: 'ignored', result: { reason: 'Not in a lead stage of the pipeline (other pipeline, unmapped stage, or not found)' } };
  }

  const fieldKeys = await account.fieldKeys();
  const plan = { ops: [], warnings: [], blockers: [] };
  for (const [contactId, { opp, status }] of latestByContact) {
    const contact = await account.client.contact(contactId);
    if (!contact) {
      plan.blockers.push(`Opportunity ${opp.id} has no readable contact`);
      continue;
    }
    const lead = mapLead(opp, contact, fieldKeys, account.cfg, status);
    plan.warnings.push(...lead.warnings);
    plan.blockers.push(...lead.blockers);
    plan.ops.push({
      op: 'upsertLead',
      account: account.name,
      ghlContactId: contactId,
      ghlOpportunityId: opp.id,
      idField: account.cfg.leadIdField || undefined,
      fields: lead.fields,
    });
  }

  if (!ghlConfig?.leadSyncEnabled) {
    plan.warnings.push('Lead not sent: LEAD_SYNC_ENABLED is false');
    plan.leadPreview = plan.ops;
    plan.ops = [];
  }

  if (mode === 'dry_run') return { status: 'dry_run', result: plan };
  if (plan.blockers.length > 0) throw new BlockedError(plan.blockers, plan);

  const outcome = await executePlan(plan, sf, salesforce, store);
  return { status: 'synced', result: { ...plan, outcome } };
}

// Reads from Shopify only (never Salesforce), so it also runs in dry run.
// Values are read at processing time, so a Provider ID added to a customer
// after the event arrived is picked up on requeue.
async function lookupContext(event, mapping, shopify) {
  if (mapping.providerIdStrategy !== 'customer_metafield') return {};
  const customerId = customerIdFor(event.topic, event.payload);
  if (!customerId) return {};

  const [namespace, key] = splitMetafield(mapping.providerIdMetafield);
  if (!shopify) throw new BlockedError('Shopify Admin API is not configured (SHOPIFY_SHOP_DOMAIN and credentials)');
  const isOrder = isOrderTopic(event.topic);
  const { firstOrderId, ...context } = await shopify.getCustomerContext(customerId, namespace, key, { withFirstOrder: isOrder });
  if (isOrder && firstOrderId) {
    context.isFirstOrder = String(firstOrderId) === String(event.payload.id);
  }
  return context;
}

function splitMetafield(value) {
  const dot = value.indexOf('.');
  if (dot <= 0 || dot === value.length - 1) {
    throw new BlockedError(`PROVIDER_ID_METAFIELD must be "namespace.key" (got "${value}")`);
  }
  return [value.slice(0, dot), value.slice(dot + 1)];
}
