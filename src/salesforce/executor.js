// Runs a plan's operations against Salesforce, in order.
import { BlockedError } from '../errors.js';
import { soqlString } from './client.js';

const recordTypeCache = new Map();

export async function executePlan(plan, sf, opts) {
  const results = [];
  let accountId = null;

  for (const op of plan.ops) {
    switch (op.op) {
      case 'upsertAccount': {
        const r = await upsertAccount(op, sf, opts);
        accountId = r.id;
        results.push(r);
        break;
      }
      case 'upsertContact':
        results.push(await upsertContact(op, accountId, sf));
        break;
      case 'upsertOrder':
        results.push(await upsertOrder(op, accountId, sf));
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
async function upsertAccount(op, sf, opts) {
  const byProviderId = `/sobjects/Account/Provider_ID__c/${encodeURIComponent(op.providerId)}`;
  const existing = await getOrNull(sf, `${byProviderId}?fields=Id`);

  if (existing) {
    if (Object.keys(op.updateFields).length > 0) {
      await sf.request('PATCH', `/sobjects/Account/${existing.Id}`, op.updateFields);
    }
    return { op: 'upsertAccount', action: 'updated', id: existing.Id, providerId: op.providerId };
  }

  const RecordTypeId = await accountRecordTypeId(sf, opts.accountRecordType);
  const res = await sf.request('PATCH', byProviderId, { ...op.createFields, RecordTypeId });
  const id = res.data?.id ?? (await getOrNull(sf, `${byProviderId}?fields=Id`))?.Id;
  return { op: 'upsertAccount', action: res.status === 201 ? 'created' : 'updated', id, providerId: op.providerId };
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

// TODO: map to Provider_Order__c once the Salesforce team sends its field
// reference (field names, required fields, external ID for upserts, and how
// line items are stored).
async function upsertOrder() {
  throw new BlockedError('Provider_Order__c field mapping is not implemented yet');
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
