// One Provider ID per practice ("Never reuse a Provider ID across two
// practices"), but one practice can have several Shopify logins. Before
// generating IDs, flag customers that look like the same practice as
// another customer, so a person decides whether they should share an ID.

const FREE_MAIL = new Set([
  'gmail.com', 'googlemail.com', 'yahoo.com', 'hotmail.com', 'outlook.com', 'live.com',
  'msn.com', 'icloud.com', 'me.com', 'mac.com', 'aol.com', 'proton.me', 'protonmail.com',
  'comcast.net', 'att.net', 'verizon.net', 'sbcglobal.net', 'ymail.com',
]);

// customers: [{ id, name, email, company, providerId }]
// Returns Map(candidate id -> note) for candidates that match someone else.
export function flagSamePractice(candidates, allCustomers) {
  const byCompany = groupBy(allCustomers, (c) => normalizeCompany(c.company));
  const byDomain = groupBy(allCustomers, (c) => practiceDomain(c.email));
  const notes = new Map();

  for (const c of candidates) {
    const others = new Map();
    for (const o of byCompany.get(normalizeCompany(c.company)) ?? []) if (o.id !== c.id) others.set(o.id, o);
    for (const o of byDomain.get(practiceDomain(c.email)) ?? []) if (o.id !== c.id) others.set(o.id, o);
    if (others.size === 0) continue;

    const list = [...others.values()];
    const withId = list.find((o) => o.providerId);
    notes.set(c.id, withId
      ? `same company/email domain as ${withId.name || withId.email}, who already has Provider ID ${withId.providerId}`
      : `same company/email domain as ${list.slice(0, 3).map((o) => o.name || o.email).join(', ')}${list.length > 3 ? ` +${list.length - 3} more` : ''}`);
  }
  return notes;
}

function normalizeCompany(company) {
  const s = String(company ?? '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  return s || null;
}

function practiceDomain(email) {
  const domain = String(email ?? '').toLowerCase().split('@')[1]?.trim();
  return domain && !FREE_MAIL.has(domain) ? domain : null;
}

function groupBy(items, keyFn) {
  const map = new Map();
  for (const item of items) {
    const key = keyFn(item);
    if (!key) continue;
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(item);
  }
  return map;
}
