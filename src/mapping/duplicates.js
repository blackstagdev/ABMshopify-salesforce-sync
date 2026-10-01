// Explains a DUPLICATES_DETECTED failure: what in Salesforce the record
// collided with, and who can fix it. Pure, so it can be tested.
//
// customer:   { providerId, email, name, company }
// kind:       'account' | 'contact'
// candidates: { accounts: [{ Id, Name, Provider_ID__c, Primary_Email__c, ownerName }],
//               contacts: [{ Id, Name, Email, accountName, accountProviderId }],
//               leads:    [{ Id, Name, Company, Status }] }
export function explainDuplicate(kind, customer, candidates) {
  if (kind === 'account') {
    const accounts = candidates.accounts;
    if (accounts.length === 0) {
      return {
        action: 'CHECK',
        detail: 'No Account found with the same name or email. The duplicate rule matched on something else (e.g. phone or address); try saving a new Account with these details in Salesforce to see its matches.',
      };
    }
    const blank = accounts.filter((a) => !a.Provider_ID__c);
    const other = accounts.filter((a) => a.Provider_ID__c && a.Provider_ID__c.toUpperCase() !== customer.providerId?.toUpperCase());
    if (accounts.length === 1 && blank.length === 1) {
      return {
        action: 'YOU CAN FIX',
        detail: `Salesforce Account "${blank[0].Name}" (${blank[0].Id}) has no Provider ID. If it is the same practice, set its Provider ID to ${customer.providerId}.`,
      };
    }
    if (other.length > 0) {
      return {
        action: 'ASK TEAM',
        detail: `Salesforce Account "${other[0].Name}" (${other[0].Id}) already has Provider ID ${other[0].Provider_ID__c}, but Shopify has ${customer.providerId}. Agree which one is right before changing either.`,
      };
    }
    return {
      action: 'ASK TEAM',
      detail: `${accounts.length} possible matches: ${accounts.map((a) => `"${a.Name}" (${a.Provider_ID__c || 'no Provider ID'})`).join(', ')}. Decide which one is this practice.`,
    };
  }

  // Contact: the Account was synced, but the person already exists.
  const parts = [];
  for (const c of candidates.contacts) {
    const same = c.accountProviderId && c.accountProviderId.toUpperCase() === customer.providerId?.toUpperCase();
    parts.push(same
      ? `Contact "${c.Name}" is already on this practice but with a different email spelling`
      : `Contact "${c.Name}" exists on another practice: "${c.accountName || 'no Account'}" (${c.accountProviderId || 'no Provider ID'})`);
  }
  for (const l of candidates.leads) {
    parts.push(`Lead "${l.Name}" (${l.Company || 'no company'}, status ${l.Status}) has this email`);
  }
  if (parts.length === 0) {
    return {
      action: 'CHECK',
      detail: 'No Contact or Lead found with this email. The rule matched on name or phone; search the person in Salesforce.',
    };
  }
  return {
    action: candidates.leads.length > 0 ? 'ASK TEAM (lead)' : 'ASK TEAM',
    detail: `${parts.join('; ')}. Converting Leads or moving people between practices is the sales team's call.`,
  };
}

// SOSL treats these as operators, so they must be escaped in a search term.
export function soslEscape(term) {
  return String(term).replace(/[?&|!{}[\]()^~*:\\"'+-]/g, (c) => `\\${c}`);
}
