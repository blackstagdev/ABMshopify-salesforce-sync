// GoAffPro affiliate -> Salesforce Account (record type Affiliate), using
// only fields that exist in the field reference (Account tab). Pure: no I/O.
//
// Decisions (Alpha BioMed, Oct 2026):
// - Provider_ID__c = the GoAffPro affiliate ID; Referral_Code__c = its ref code.
// - Only approved affiliates are synced.
// - A practice's Affiliate__c is the affiliate on its FIRST GoAffPro order,
//   and always follows GoAffPro.
// - Sales and commission have no Salesforce field yet, so they are not sent.
import { clean, text, compact, checkEmail } from '../mapping/fields.js';

export const AFFILIATE_FIELDS = [
  'id', 'name', 'first_name', 'last_name', 'email', 'phone', 'company_name',
  'address_1', 'city', 'state', 'zip', 'country', 'ref_code', 'status', 'parent',
];
export const ORDER_FIELDS = ['id', 'number', 'affiliate_id', 'customer', 'status', 'created_at'];

// Order statuses that mean the referral didn't count.
const VOID_ORDER = new Set(['rejected', 'declined', 'cancelled', 'canceled', 'refunded', 'void']);

export function isSyncedAffiliate(affiliate) {
  return String(affiliate?.status ?? '').toLowerCase() === 'approved';
}

export function mapAffiliate(affiliate) {
  const warnings = [];
  const providerId = affiliate?.id != null ? String(affiliate.id) : null;
  const person = clean(affiliate?.name) || [clean(affiliate?.first_name), clean(affiliate?.last_name)].filter(Boolean).join(' ') || undefined;
  const email = checkEmail(affiliate?.email, warnings);
  const name = clean(affiliate?.company_name) || person || email;

  const updateFields = compact({
    Primary_Provider_Name__c: text(person, 120),
    Primary_Email__c: email,
    Phone: text(affiliate?.phone, 40),
    BillingStreet: text(affiliate?.address_1, 255),
    BillingCity: text(affiliate?.city, 40),
    BillingState: text(affiliate?.state, 80),
    BillingPostalCode: text(affiliate?.zip, 20),
    BillingCountry: text(affiliate?.country, 80),
    Referral_Code__c: text(affiliate?.ref_code, 50),
  });

  const blockers = [];
  if (!providerId) blockers.push('Affiliate has no GoAffPro ID');
  if (providerId && providerId.length > 30) blockers.push(`GoAffPro ID ${providerId} is longer than Provider_ID__c allows (30)`);
  if (!name) blockers.push('Affiliate has no company, name or email for the Account Name');

  return {
    providerId,
    parentId: affiliate?.parent?.id != null ? String(affiliate.parent.id) : null,
    // Name is set when the Account is created, like practices.
    createFields: { Name: text(name, 255), ...updateFields },
    updateFields,
    warnings,
    blockers,
  };
}

// Shopify customer id -> GoAffPro affiliate id of their earliest counted order.
export function firstAffiliateByCustomer(orders) {
  const first = new Map();
  for (const order of orders) {
    const customerId = order?.customer?.id;
    const affiliateId = order?.affiliate_id;
    if (customerId == null || affiliateId == null) continue;
    if (VOID_ORDER.has(String(order.status ?? '').toLowerCase())) continue;
    const key = String(customerId);
    const at = String(order.created_at ?? '');
    const prev = first.get(key);
    if (!prev || at < prev.at) first.set(key, { affiliateId: String(affiliateId), at });
  }
  return new Map([...first].map(([customerId, { affiliateId }]) => [customerId, affiliateId]));
}
