// The GoAffPro -> Salesforce affiliate sync: a job, not webhook-driven.
//   A. Approved affiliates -> Affiliate Accounts (upsert on Provider_ID__c)
//   B. Each affiliate's upline -> its Affiliate__c
//   C. Each referred practice -> its Affiliate__c (first affiliate, always
//      matching GoAffPro)
// With apply=false nothing is written: Salesforce and Shopify are only read,
// and the summary shows what would change.
import { soqlString } from '../salesforce/client.js';
import { AFFILIATE_FIELDS, ORDER_FIELDS, isSyncedAffiliate, mapAffiliate, firstAffiliateByCustomer } from './mapping.js';

export async function runAffiliateSync({ gap, sf, shopify, providerIdMetafield, apply, limit = Infinity, log = () => {} }) {
  const summary = {
    affiliates: { seen: 0, approved: 0, created: 0, updated: 0, unchanged: 0, failed: 0 },
    uplines: { set: 0, unchanged: 0, parentNotSynced: 0, failed: 0 },
    practices: { referred: 0, linked: 0, unchanged: 0, affiliateNotSynced: 0, noProviderId: 0, notInSalesforce: 0, failed: 0 },
    errors: [],
  };
  const fail = (what, id, err) => summary.errors.push({ what, id, error: String(err?.message ?? err).slice(0, 200) });

  const affiliateRt = await recordTypeId(sf, 'Affiliate');
  const accountByAffiliate = new Map(); // GoAffPro id -> Salesforce Account Id
  const currentUpline = new Map(); // Salesforce Account Id -> Affiliate__c now

  // --- A. Affiliate Accounts ---
  log('Reading affiliates from GoAffPro...');
  const affiliates = [];
  for await (const a of gap.list('/affiliates', 'affiliates', AFFILIATE_FIELDS)) {
    summary.affiliates.seen++;
    if (isSyncedAffiliate(a)) affiliates.push(a);
  }
  const batch = affiliates.slice(0, limit);
  summary.affiliates.approved = affiliates.length;
  log(`${affiliates.length} approved of ${summary.affiliates.seen}; processing ${batch.length}.`);

  for (const a of batch) {
    const m = mapAffiliate(a);
    if (m.blockers.length) {
      summary.affiliates.failed++;
      fail('affiliate', a.id, m.blockers.join('; '));
      continue;
    }
    try {
      const path = `/sobjects/Account/Provider_ID__c/${encodeURIComponent(m.providerId)}`;
      const existing = await getOrNull(sf, `${path}?fields=Id,Affiliate__c,RecordTypeId`);
      if (existing) {
        if (existing.RecordTypeId && existing.RecordTypeId !== affiliateRt) {
          throw new Error(`Provider ID ${m.providerId} already belongs to a non-Affiliate Account ${existing.Id}`);
        }
        if (apply) await sf.request('PATCH', `/sobjects/Account/${existing.Id}`, m.updateFields);
        summary.affiliates.updated++;
        accountByAffiliate.set(m.providerId, existing.Id);
        currentUpline.set(existing.Id, existing.Affiliate__c ?? null);
      } else {
        let id = `(new:${m.providerId})`;
        if (apply) {
          const res = await sf.request('PATCH', path, { ...m.createFields, RecordTypeId: affiliateRt });
          id = res.data?.id ?? (await getOrNull(sf, `${path}?fields=Id`))?.Id;
        }
        summary.affiliates.created++;
        accountByAffiliate.set(m.providerId, id);
        currentUpline.set(id, null);
      }
    } catch (err) {
      summary.affiliates.failed++;
      fail('affiliate', a.id, err);
    }
  }

  // --- B. Uplines ---
  for (const a of batch) {
    const childId = accountByAffiliate.get(String(a.id));
    const parentGoAffProId = a.parent?.id != null ? String(a.parent.id) : null;
    if (!childId || !parentGoAffProId) continue;
    const parentId = accountByAffiliate.get(parentGoAffProId) ?? (await accountIdFor(sf, parentGoAffProId, affiliates));
    if (!parentId) {
      summary.uplines.parentNotSynced++;
      continue;
    }
    if (currentUpline.get(childId) === parentId) {
      summary.uplines.unchanged++;
      continue;
    }
    try {
      if (apply) await sf.request('PATCH', `/sobjects/Account/${childId}`, { Affiliate__c: parentId });
      summary.uplines.set++;
    } catch (err) {
      summary.uplines.failed++;
      fail('upline', a.id, err);
    }
  }

  // --- C. Referred practices ---
  log('Reading affiliate orders from GoAffPro...');
  const orders = [];
  for await (const o of gap.list('/orders', 'orders', ORDER_FIELDS)) orders.push(o);
  const referred = firstAffiliateByCustomer(orders);
  const syncedIds = new Set(batch.map((a) => String(a.id)));
  summary.practices.referred = referred.size;
  log(`${orders.length} affiliate orders; ${referred.size} referred customers.`);

  const [namespace, key] = providerIdMetafield.split('.');
  for (const [customerId, affiliateId] of referred) {
    if (!syncedIds.has(affiliateId)) {
      summary.practices.affiliateNotSynced++;
      continue;
    }
    try {
      const { providerIdMetafield: providerId } = await shopify.getCustomerContext(customerId, namespace, key);
      if (!providerId?.trim()) {
        summary.practices.noProviderId++;
        continue;
      }
      const practice = await getOrNull(sf, `/sobjects/Account/Provider_ID__c/${encodeURIComponent(providerId.trim())}?fields=Id,Affiliate__c`);
      if (!practice) {
        summary.practices.notInSalesforce++;
        continue;
      }
      const target = accountByAffiliate.get(affiliateId);
      if (practice.Affiliate__c === target) {
        summary.practices.unchanged++;
        continue;
      }
      if (apply) await sf.request('PATCH', `/sobjects/Account/${practice.Id}`, { Affiliate__c: target });
      summary.practices.linked++;
    } catch (err) {
      summary.practices.failed++;
      fail('practice', customerId, err);
    }
  }

  return summary;
}

// An upline that isn't in this batch (e.g. a --limit run) may already be in
// Salesforce; approved parents only.
async function accountIdFor(sf, goAffProId, affiliates) {
  const parent = affiliates.find((a) => String(a.id) === goAffProId);
  if (!parent) return null;
  return (await getOrNull(sf, `/sobjects/Account/Provider_ID__c/${encodeURIComponent(goAffProId)}?fields=Id`))?.Id ?? null;
}

async function recordTypeId(sf, developerName) {
  const rows = await sf.query(
    `SELECT Id FROM RecordType WHERE SobjectType = 'Account' AND DeveloperName = ${soqlString(developerName)} AND IsActive = true`,
  );
  if (!rows.length) throw new Error(`Account record type "${developerName}" was not found`);
  return rows[0].Id;
}

async function getOrNull(sf, path) {
  try {
    return (await sf.request('GET', path)).data;
  } catch (err) {
    if (err.status === 404) return null;
    throw err;
  }
}
