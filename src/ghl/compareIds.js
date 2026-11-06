// Suggests which of two GHL contact IDs is a practice's real Provider ID when
// Salesforce and Shopify disagree (the "two GHL IDs" duplicate cases). Pure;
// scripts/compare-ghl-ids.js reads GHL. Only a suggestion: a person confirms
// before either ID is changed.
//
// side: { exists, email, approved } for the Salesforce ID and the Shopify ID
// shopifyEmail: the Shopify customer's email
// Returns { suggestion: 'Salesforce' | 'Shopify' | 'ASK', why }
export function suggestProviderId(sfSide, shopifySide, shopifyEmail) {
  if (!sfSide.exists && !shopifySide.exists) return { suggestion: 'ASK', why: 'Neither GHL contact exists any more' };
  if (sfSide.exists !== shopifySide.exists) {
    const winner = sfSide.exists ? 'Salesforce' : 'Shopify';
    return { suggestion: winner, why: `Only the ${winner} GHL contact still exists (the other was deleted or merged)` };
  }
  if (sfSide.approved !== shopifySide.approved) {
    const winner = sfSide.approved ? 'Salesforce' : 'Shopify';
    return { suggestion: winner, why: `Only the ${winner} GHL contact is in an Approved stage` };
  }
  const email = String(shopifyEmail ?? '').trim().toLowerCase();
  const sfMatch = !!email && String(sfSide.email ?? '').trim().toLowerCase() === email;
  const shMatch = !!email && String(shopifySide.email ?? '').trim().toLowerCase() === email;
  if (sfMatch !== shMatch) {
    const winner = sfMatch ? 'Salesforce' : 'Shopify';
    return { suggestion: winner, why: `Only the ${winner} GHL contact has the Shopify customer's email` };
  }
  return { suggestion: 'ASK', why: 'Both GHL contacts look equally valid; likely two people at the practice' };
}
