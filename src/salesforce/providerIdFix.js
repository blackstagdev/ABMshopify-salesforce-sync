// Decides which Accounts get their old UUID Provider ID replaced by the GHL
// contact ID that Shopify now holds for the same customer (the
// DUPLICATE_VALUE on Shopify_ID__c failures). Pure, so it can be tested; the
// script fix-uuid-provider-ids does the reading and writing.
//
// An Account is changed only when all of these hold, checked live:
// - it still holds that Shopify customer (Shopify_ID__c),
// - its Provider ID is still an old UUID,
// - Shopify has a Provider ID (the GHL ID) for that customer, and
// - no other Account, and no other row in this run, uses that GHL ID.
// Only Provider_ID__c changes. Shopify_ID__c is only a safety check here,
// never used to match a practice in the sync.

export const isUuid = (v) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(v ?? '').trim());

// candidates: [{ accountId, shopifyCustomerId, failedEvents }]
// accounts:   Map(Account Id -> { Id, Name, Provider_ID__c, Shopify_ID__c })
// shopifyIds: Map(Shopify customer id -> Provider ID in Shopify, or null)
// takenBy:    Map(Provider ID (upper case) -> Account Id holding it)
// Returns one row per candidate: { ...candidate, name, oldProviderId, newProviderId, action: 'update' | 'skip', reason }
export function planProviderIdFixes(candidates, accounts, shopifyIds, takenBy) {
  const rows = candidates.map((c) => {
    const a = accounts.get(c.accountId);
    const newProviderId = shopifyIds.get(String(c.shopifyCustomerId)) ?? null;
    const row = { ...c, name: a?.Name ?? '', oldProviderId: a?.Provider_ID__c ?? '', newProviderId: newProviderId ?? '' };
    const skip = (reason) => ({ ...row, action: 'skip', reason });

    if (!a) return skip('Account not found (deleted or merged)');
    if (String(a.Shopify_ID__c ?? '') !== String(c.shopifyCustomerId)) return skip('Account no longer holds this Shopify customer');
    if (newProviderId && a.Provider_ID__c === newProviderId) return skip('Already fixed');
    if (!isUuid(a.Provider_ID__c)) return skip('Provider ID in Salesforce is not an old UUID; needs a person to decide');
    if (!newProviderId) return skip('No Provider ID (GHL ID) in Shopify yet');
    if (isUuid(newProviderId)) return skip('Shopify also has a UUID, not a GHL ID');
    const holder = takenBy.get(newProviderId.toUpperCase());
    if (holder && holder !== a.Id) return skip(`GHL ID already used by Account ${holder}`);
    return { ...row, action: 'update', reason: '' };
  });

  // Two Accounts heading for the same GHL ID: neither is changed.
  const counts = new Map();
  for (const r of rows) if (r.action === 'update') counts.set(r.newProviderId.toUpperCase(), (counts.get(r.newProviderId.toUpperCase()) ?? 0) + 1);
  return rows.map((r) => (r.action === 'update' && counts.get(r.newProviderId.toUpperCase()) > 1
    ? { ...r, action: 'skip', reason: 'Another Account in this list would get the same GHL ID' }
    : r));
}
