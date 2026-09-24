import { SalesforceError } from '../errors.js';

// REST client using the OAuth 2.0 client credentials flow of a Connected App
// (or External Client App) that runs as the integration user.
export function createSalesforceClient(cfg, fetchImpl = fetch) {
  let session = null;

  async function authenticate() {
    if (!cfg.loginUrl || !cfg.clientId || !cfg.clientSecret) {
      throw new SalesforceError('SF_LOGIN_URL, SF_CLIENT_ID and SF_CLIENT_SECRET must be set for live mode', 0);
    }
    const res = await fetchImpl(`${cfg.loginUrl.replace(/\/$/, '')}/services/oauth2/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'client_credentials',
        client_id: cfg.clientId,
        client_secret: cfg.clientSecret,
      }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      throw new SalesforceError(`Salesforce login failed: ${res.status} ${data.error_description || data.error || ''}`, res.status, data);
    }
    session = { accessToken: data.access_token, instanceUrl: data.instance_url };
  }

  async function request(method, path, body, { retryAuth = true } = {}) {
    if (!session) await authenticate();
    const res = await fetchImpl(`${session.instanceUrl}/services/data/${cfg.apiVersion}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${session.accessToken}`,
        'Content-Type': 'application/json',
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });

    if (res.status === 401 && retryAuth) {
      session = null;
      return request(method, path, body, { retryAuth: false });
    }

    const raw = await res.text();
    let data = null;
    try {
      data = raw ? JSON.parse(raw) : null;
    } catch {
      data = raw;
    }
    if (!res.ok) {
      const detail = Array.isArray(data) ? data.map((e) => `${e.errorCode}: ${e.message}`).join('; ') : raw;
      throw new SalesforceError(`${method} ${path} -> ${res.status} ${detail}`, res.status, data);
    }
    return { status: res.status, data };
  }

  async function query(soql) {
    const { data } = await request('GET', `/query?q=${encodeURIComponent(soql)}`);
    return data.records;
  }

  return { request, query };
}

// Escape a value for use inside single quotes in SOQL.
export function soqlString(value) {
  return `'${String(value).replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
}
