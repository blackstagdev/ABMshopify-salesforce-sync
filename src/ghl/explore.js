// Turns GHL opportunities + contacts into a field inventory: which fields
// exist, how often they're filled, and a short example. Pure, for testing.

// Values that identify a person are shortened unless full output is asked
// for. These carry no personal data and are always shown in full.
const SAFE_FIELDS = /(^|\.)(source|tags|type|state|country|status|medium|utm\w*|campaign\w*|adSource|sessionSource|pipeline\w*|dataType)$/i;

export function flattenRecord(opportunity, contact, customFieldNames = {}) {
  const out = {};
  const put = (key, value) => {
    if (value === null || value === undefined || value === '') return;
    if (Array.isArray(value)) {
      if (value.length === 0) return;
      out[key] = value.map((v) => (typeof v === 'object' ? JSON.stringify(v) : String(v))).join(', ');
      return;
    }
    if (typeof value === 'object') {
      for (const [k, v] of Object.entries(value)) put(`${key}.${k}`, v);
      return;
    }
    out[key] = String(value);
  };

  for (const [k, v] of Object.entries(opportunity ?? {})) {
    if (['contact', 'customFields', 'id', 'locationId', 'contactId'].includes(k)) continue;
    put(`opportunity.${k}`, v);
  }
  for (const cf of opportunity?.customFields ?? []) {
    put(`opportunity.custom: ${customFieldNames[cf.id] ?? cf.id}`, cf.fieldValue ?? cf.value ?? cf.fieldValueString);
  }
  for (const [k, v] of Object.entries(contact ?? {})) {
    if (['customFields', 'customField', 'id', 'locationId'].includes(k)) continue;
    put(`contact.${k}`, v);
  }
  for (const cf of contact?.customFields ?? contact?.customField ?? []) {
    put(`contact.custom: ${customFieldNames[cf.id] ?? cf.id}`, cf.value ?? cf.fieldValue);
  }
  return out;
}

export function inventory(records, { full = false } = {}) {
  const fields = new Map();
  for (const rec of records) {
    for (const [key, value] of Object.entries(rec)) {
      if (!fields.has(key)) fields.set(key, { filled: 0, examples: new Set() });
      const f = fields.get(key);
      f.filled++;
      if (f.examples.size < 3) f.examples.add(full || SAFE_FIELDS.test(key) ? clip(value, 80) : mask(value));
    }
  }
  return [...fields.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([field, f]) => ({ Field: field, Filled: `${f.filled}/${records.length}`, Examples: [...f.examples].join(' | ') }));
}

export function mask(value) {
  const s = String(value);
  if (s.length <= 4) return s;
  return `${s.slice(0, 3)}…(${s.length})`;
}

function clip(value, max) {
  const s = String(value);
  return s.length > max ? `${s.slice(0, max)}…` : s;
}
