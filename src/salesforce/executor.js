// Runs a plan's operations against Salesforce, in order.
import { BlockedError, SalesforceError } from '../errors.js';
import { soqlString } from './client.js';

const recordTypeCache = new Map();

// Alpha BioMed Status only ever moves forward from the sync. Lapsed is set by
// reps and is only replaced when the practice places a new order.
const STATUS_RANK = { 'Not a customer': 0, Prospect: 1, Active: 2 };

// store: the database (order links). Only order operations need it.
export async function executePlan(plan, sf, opts, store) {
  const results = [];
  let accountId = null;

  for (const op of plan.ops) {
    switch (op.op) {
      case 'upsertAccount': {
        const r = await upsertAccount(op, sf, opts, store);
        accountId = r.id;
        results.push(r);
        break;
      }
      case 'upsertContact':
        results.push(await upsertContact(op, accountId, sf));
        break;
      case 'upsertOrder':
        results.push(await upsertOrder(op, accountId, sf, opts, store));
        break;
      case 'createLead':
        results.push(await createLead(op, sf, store));
        break;
      default:
        throw new Error(`Unknown operation ${op.op}`);
    }
  }
  return results;
}

// Accounts are always addressed through Provider_ID__c, never by name,
// email or NPI. The existence check lets RecordTypeId and Name be set on
// create only, so an Affiliate account is never switched to Customer.
async function upsertAccount(op, sf, opts, store) {
  const byProviderId = `/sobjects/Account/Provider_ID__c/${encodeURIComponent(op.providerId)}`;
  const existing = await getOrNull(sf, `${byProviderId}?fields=Id,ABM_Owner__c,ABM_Status__c`);
  let result;

  if (existing) {
    const status = statusChange(existing, op);
    const patch = { ...op.updateFields, ...(status.value && { ABM_Status__c: status.value }) };
    if (Object.keys(patch).length > 0) {
      await sf.request('PATCH', `/sobjects/Account/${existing.Id}`, patch);
    }
    result = {
      op: 'upsertAccount', action: 'updated', id: existing.Id, providerId: op.providerId,
      ...(status.value && { abmStatus: status.value }),
      ...(status.warning && { warning: status.warning }),
    };
  } else {
    const RecordTypeId = await accountRecordTypeId(sf, opts.accountRecordType);
    const res = await sf.request('PATCH', byProviderId, { ...op.createFields, RecordTypeId });
    const id = res.data?.id ?? (await getOrNull(sf, `${byProviderId}?fields=Id`))?.Id;
    result = {
      op: 'upsertAccount', action: res.status === 201 ? 'created' : 'updated', id, providerId: op.providerId,
      ...(op.createFields.ABM_Status__c && { abmStatus: op.createFields.ABM_Status__c }),
    };
  }

  const linked = await linkUnlinkedOrders(op.shopifyCustomerId, result.id, sf, opts, store);
  if (linked) result.linkedOrders = linked;
  return result;
}

function statusChange(existing, op) {
  if (!op.abmStatus) return {};
  // The Account trigger lets only the owner or their manager change the
  // status once an owner is assigned; sending it would reject the update.
  if (existing.ABM_Owner__c) {
    return { warning: 'Alpha BioMed Owner is assigned, so Alpha BioMed Status is left to the rep' };
  }
  const current = existing.ABM_Status__c;
  if (current === op.abmStatus) return {};
  if (current === 'Lapsed') {
    return op.fromNewOrder && op.abmStatus === 'Active' ? { value: 'Active' } : {};
  }
  const currentRank = current ? STATUS_RANK[current] : 0;
  if (currentRank === undefined) return {};
  return STATUS_RANK[op.abmStatus] > currentRank ? { value: op.abmStatus } : {};
}

// Contact has no external ID, and Salesforce's duplicate rules only warn,
// so the integration matches on Account + Email itself.
async function upsertContact(op, accountId, sf) {
  if (!accountId) throw new Error('Contact cannot be written without an Account');
  const matches = await sf.query(
    `SELECT Id FROM Contact WHERE AccountId = ${soqlString(accountId)} AND Email = ${soqlString(op.email)} ORDER BY CreatedDate LIMIT 2`,
  );

  if (matches.length > 0) {
    await sf.request('PATCH', `/sobjects/Contact/${matches[0].Id}`, op.fields);
    return {
      op: 'upsertContact',
      action: 'updated',
      id: matches[0].Id,
      ...(matches.length > 1 && { warning: 'More than one Contact on this Account has this email; updated the oldest' }),
    };
  }

  const res = await sf.request('POST', '/sobjects/Contact', { ...op.fields, AccountId: accountId });
  return { op: 'upsertContact', action: 'created', id: res.data.id };
}

// Provider Order has no external ID ("sending the same order twice creates
// two orders"), so the store remembers which Salesforce record each Shopify
// order became. The link is saved straight after the create, and lines are
// added from the link, so a retry never duplicates the order or its lines.
async function upsertOrder(op, accountId, sf, opts, store) {
  if (!store) throw new Error('Order sync needs the database');
  const accountForOrder = op.linked ? accountId : null;
  const link = await store.getOrderLink(op.shopifyOrderId);

  if (link) {
    const patch = { ...op.fields, ...(accountForOrder && { Account__c: accountForOrder }) };
    try {
      await sf.request('PATCH', `/sobjects/${opts.orderObject}/${link.salesforce_id}`, patch);
    } catch (err) {
      // Deleted in Salesforce since: treat it as new.
      if (err.status !== 404) throw err;
      return createOrder(op, accountForOrder, sf, opts, store);
    }
    const saved = {
      shopifyOrderId: op.shopifyOrderId,
      salesforceId: link.salesforce_id,
      shopifyCustomerId: op.shopifyCustomerId ?? link.shopify_customer_id,
      accountId: accountForOrder ?? link.account_id,
      lines: link.lines ?? {},
    };
    if (saved.accountId !== link.account_id) await store.saveOrderLink(saved);
    const lines = await syncLines(op, saved, sf, opts, store);
    return { op: 'upsertOrder', action: 'updated', id: link.salesforce_id, orderNumber: op.orderNumber, linked: Boolean(saved.accountId), lines };
  }

  if (op.cancelled) {
    return { op: 'upsertOrder', action: 'skipped', orderNumber: op.orderNumber, reason: 'Cancelled before it was synced' };
  }
  return createOrder(op, accountForOrder, sf, opts, store);
}

async function createOrder(op, accountForOrder, sf, opts, store) {
  const res = await sf.request('POST', `/sobjects/${opts.orderObject}`, {
    ...op.fields,
    ...(accountForOrder && { Account__c: accountForOrder }),
  });
  const saved = {
    shopifyOrderId: op.shopifyOrderId,
    salesforceId: res.data.id,
    shopifyCustomerId: op.shopifyCustomerId,
    accountId: accountForOrder,
    lines: {},
  };
  await store.saveOrderLink(saved);
  const lines = await syncLines(op, saved, sf, opts, store);
  return { op: 'upsertOrder', action: 'created', id: res.data.id, orderNumber: op.orderNumber, linked: Boolean(accountForOrder), lines };
}

// Order Product lines, through sObject Collections (200 records per call,
// all or none). Lines removed in Shopify are deleted.
async function syncLines(op, saved, sf, opts, store) {
  const known = { ...saved.lines };
  const toCreate = op.lines.filter((l) => !l.remove && !known[l.shopifyLineId]);
  const toUpdate = op.lines.filter((l) => !l.remove && known[l.shopifyLineId]);
  const toDelete = op.lines.filter((l) => l.remove && known[l.shopifyLineId]);
  const type = opts.orderLineObject;

  for (const batch of chunks(toCreate, 200)) {
    const res = await sf.request('POST', '/composite/sobjects', {
      allOrNone: true,
      records: batch.map((l) => ({ attributes: { type }, Provider_Order__c: saved.salesforceId, ...l.fields })),
    });
    checkCollection(res.data, 'create order lines');
    batch.forEach((l, i) => { known[l.shopifyLineId] = res.data[i].id; });
    await store.saveOrderLink({ ...saved, lines: known });
  }

  for (const batch of chunks(toUpdate, 200)) {
    const res = await sf.request('PATCH', '/composite/sobjects', {
      allOrNone: true,
      records: batch.map((l) => ({ attributes: { type }, id: known[l.shopifyLineId], ...l.fields })),
    });
    checkCollection(res.data, 'update order lines');
  }

  for (const batch of chunks(toDelete, 200)) {
    const ids = batch.map((l) => known[l.shopifyLineId]).join(',');
    const res = await sf.request('DELETE', `/composite/sobjects?ids=${ids}&allOrNone=true`);
    checkCollection(res.data, 'delete order lines');
    for (const l of batch) delete known[l.shopifyLineId];
    await store.saveOrderLink({ ...saved, lines: known });
  }

  return { created: toCreate.length, updated: toUpdate.length, deleted: toDelete.length };
}

// A GHL lead becomes one Salesforce Lead, once per GHL contact and
// sub-account. Lead has no external ID, so the link table remembers it; a
// contact that enters the stage again is not re-created. Salesforce assigns
// the owner on insert.
async function createLead(op, sf, store) {
  if (!store) throw new Error('Lead sync needs the database');
  const link = await store.getLeadLink(op.account, op.ghlContactId);
  if (link) {
    return { op: 'createLead', action: 'exists', id: link.salesforce_id, ghlContactId: op.ghlContactId };
  }
  const res = await sf.request('POST', '/sobjects/Lead', op.fields);
  await store.saveLeadLink({
    account: op.account,
    ghlContactId: op.ghlContactId,
    ghlOpportunityId: op.ghlOpportunityId,
    salesforceId: res.data.id,
  });
  return { op: 'createLead', action: 'created', id: res.data.id, ghlContactId: op.ghlContactId };
}

// Orders sent while the customer had no Provider ID are linked to the
// practice as soon as its Account is known.
async function linkUnlinkedOrders(shopifyCustomerId, accountId, sf, opts, store) {
  if (!store?.unlinkedOrdersForCustomer || !shopifyCustomerId || !accountId) return 0;
  const rows = await store.unlinkedOrdersForCustomer(shopifyCustomerId);
  for (const row of rows) {
    await sf.request('PATCH', `/sobjects/${opts.orderObject}/${row.salesforce_id}`, { Account__c: accountId });
    await store.saveOrderLink({
      shopifyOrderId: row.shopify_order_id,
      salesforceId: row.salesforce_id,
      shopifyCustomerId: row.shopify_customer_id,
      accountId,
      lines: row.lines ?? {},
    });
  }
  return rows.length;
}

// sObject Collections answer per record; with allOrNone one failure rolls
// back the whole call.
function checkCollection(results, what) {
  const failed = (results || []).filter((r) => !r.success);
  if (failed.length > 0) {
    const detail = failed.flatMap((r) => (r.errors || []).map((e) => `${e.statusCode}: ${e.message}`)).join('; ');
    throw new SalesforceError(`Could not ${what}: ${detail || 'unknown error'}`, 400, results);
  }
}

function chunks(items, size) {
  const out = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

async function accountRecordTypeId(sf, developerName) {
  if (recordTypeCache.has(developerName)) return recordTypeCache.get(developerName);
  // Ids differ per org, so resolve by DeveloperName at runtime.
  const rows = await sf.query(
    `SELECT Id FROM RecordType WHERE SobjectType = 'Account' AND DeveloperName = ${soqlString(developerName)} AND IsActive = true`,
  );
  if (rows.length === 0) throw new BlockedError(`Account record type "${developerName}" was not found`);
  recordTypeCache.set(developerName, rows[0].Id);
  return rows[0].Id;
}

async function getOrNull(sf, path) {
  try {
    const { data } = await sf.request('GET', path);
    return data;
  } catch (err) {
    if (err.status === 404) return null;
    throw err;
  }
}
