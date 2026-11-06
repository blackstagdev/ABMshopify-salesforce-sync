// Explains why the Lead duplicate rule blocked a GHL contact: which existing
// Salesforce Account, Contact or Lead it most likely matched. Pure, so it can
// be tested. The rule's own match isn't returned by the API, so this looks
// for the same signals locally: the GHL contact ID as an Account's Provider
// ID, email, phone, and company name.

export const normEmail = (v) => (v ? String(v).trim().toLowerCase() || null : null);

// Last 10 digits, so "+1 (555) 010-2000" and "5550102000" match.
export function normPhone(v) {
  const digits = String(v ?? '').replace(/\D/g, '');
  return digits.length >= 10 ? digits.slice(-10) : null;
}

// Lowercase, no punctuation or common suffixes ("LLC", "PLLC", "Inc").
export function normCompany(v) {
  const s = String(v ?? '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9 ]+/g, ' ')
    .replace(/\b(llc|pllc|pc|inc|corp|co|ltd|the)\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return s.length >= 3 ? s : null;
}

// accounts: [{ Id, Name, Provider_ID__c, Primary_Email__c, Phone }]
// contacts: [{ Id, Name, Email, Phone, accountName, accountId, accountProviderId }]
// leads:    [{ Id, Name, Company, Email, Phone, Status, ghlContactId? }]
export function buildIndex({ accounts = [], contacts = [], leads = [] }) {
  const idx = { providerId: new Map(), email: new Map(), phone: new Map(), company: new Map() };
  const add = (map, key, rec) => {
    if (!key) return;
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(rec);
  };
  for (const a of accounts) {
    const rec = { type: 'Account', id: a.Id, name: a.Name, accountName: a.Name, accountId: a.Id, providerId: a.Provider_ID__c };
    if (a.Provider_ID__c) add(idx.providerId, String(a.Provider_ID__c).toUpperCase(), rec);
    add(idx.email, normEmail(a.Primary_Email__c), rec);
    add(idx.phone, normPhone(a.Phone), rec);
    add(idx.company, normCompany(a.Name), rec);
  }
  for (const c of contacts) {
    const rec = { type: 'Contact', id: c.Id, name: c.Name, accountName: c.accountName, accountId: c.accountId, providerId: c.accountProviderId };
    add(idx.email, normEmail(c.Email), rec);
    add(idx.phone, normPhone(c.Phone), rec);
  }
  for (const l of leads) {
    const rec = { type: 'Lead', id: l.Id, name: l.Name, company: l.Company, status: l.Status, ghlContactId: l.ghlContactId };
    add(idx.email, normEmail(l.Email), rec);
    add(idx.phone, normPhone(l.Phone), rec);
    add(idx.company, normCompany(l.Company), rec);
  }
  return idx;
}

// Strongest signal first. Accounts/Contacts before Leads at the same signal:
// an existing customer is the more useful answer.
const order = { Account: 0, Contact: 1, Lead: 2 };
const sortByType = (recs) => [...recs].sort((a, b) => order[a.type] - order[b.type]);

// contact: { id, email, phone, company }
// Returns { matchedOn, match, others, category, action }
export function explainLeadDuplicate(contact, idx) {
  const tries = [
    ['GHL contact ID = Account Provider ID', idx.providerId.get(String(contact.id ?? '').toUpperCase())],
    ['Email', idx.email.get(normEmail(contact.email))],
    ['Phone', idx.phone.get(normPhone(contact.phone))],
    ['Company name', idx.company.get(normCompany(contact.company))],
  ];
  for (const [matchedOn, recs] of tries) {
    // Skip the Lead the sync made for this same contact (shouldn't block, but be safe).
    const found = sortByType((recs ?? []).filter((r) => !(r.type === 'Lead' && r.ghlContactId && r.ghlContactId === contact.id)));
    if (found.length === 0) continue;
    const [match, ...others] = found;
    return { matchedOn, match, others: others.length, ...categorize(match) };
  }
  return {
    matchedOn: '',
    match: null,
    others: 0,
    category: 'No visible match',
    action: 'CHECK: the rule matched on something we can\'t see (e.g. name or address). Search the person in Salesforce.',
  };
}

function categorize(match) {
  if (match.type === 'Account' || match.type === 'Contact') {
    return {
      category: 'Already a customer',
      action: `Already in Salesforce as ${match.type === 'Account' ? 'the practice' : 'a contact on'} "${match.accountName}". No Lead needed, unless sales wants one anyway.`,
    };
  }
  if (match.ghlContactId) {
    return {
      category: 'Another GHL contact at the same practice',
      action: 'The sync already made a Lead for another GHL contact at this practice. Usually fine to leave; merge the GHL contacts if they are the same person.',
    };
  }
  return {
    category: 'Lead already exists',
    action: 'A Lead made outside the sync (e.g. by hand or another source) already exists. Usually fine to leave; the sales team can decide.',
  };
}
