// Small helpers shared by the mappers: Salesforce field lengths, blank
// handling and money.

export function clean(value) {
  if (value === null || value === undefined) return undefined;
  const s = String(value).trim();
  return s === '' ? undefined : s;
}

export function text(value, max) {
  const s = clean(value);
  return s && s.length > max ? s.slice(0, max) : s;
}

// Drop empty values so a blank in the source never wipes data in Salesforce.
export function compact(obj) {
  return Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== undefined && v !== null && v !== ''));
}

export function money(value) {
  const n = Number(value);
  return value === null || value === undefined || value === '' || !Number.isFinite(n) ? undefined : Math.round(n * 100) / 100;
}

// Salesforce Email fields hold 80 characters; truncating would corrupt it.
export function checkEmail(email, warnings) {
  const value = clean(email)?.toLowerCase();
  if (!value) return undefined;
  if (value.length > 80 || !value.includes('@')) {
    warnings.push(`Email "${value}" is not usable in Salesforce and was skipped`);
    return undefined;
  }
  return value;
}
