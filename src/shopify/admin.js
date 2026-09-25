// Minimal Shopify Admin API client, used by the backfill and webhook
// registration scripts. The webhook receiver does not need it.

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function nextPageUrl(linkHeader) {
  if (!linkHeader) return null;
  for (const part of linkHeader.split(',')) {
    const match = part.match(/<([^>]+)>;\s*rel="next"/);
    if (match) return match[1];
  }
  return null;
}

// Shopify answers some errors with a full HTML page; keep only the
// "What happened?" text so the message fits on one line.
function summarize(body) {
  if (!body.trimStart().startsWith('<')) return body;
  const detail = body.match(/What happened\?<\/h3>\s*<div[^>]*>\s*([^<]+)/)?.[1] || body.match(/<title>([^<]+)<\/title>/)?.[1];
  return detail ? detail.trim() : 'HTML error page';
}

export function createShopifyAdmin(cfg, fetchImpl = fetch) {
  if (!cfg.shopDomain) throw new Error('SHOPIFY_SHOP_DOMAIN is not set');
  const base = `https://${cfg.shopDomain}/admin/api/${cfg.apiVersion}`;
  let token = cfg.accessToken || null;
  let expiresAt = cfg.accessToken ? Infinity : 0;

  // Apps from the Dev Dashboard get a short-lived token through the client
  // credentials grant; legacy admin-created apps have a static shpat_ token.
  async function getToken() {
    if (token && Date.now() < expiresAt - 60_000) return token;
    if (!cfg.clientId || !cfg.clientSecret) {
      throw new Error('Set SHOPIFY_ADMIN_ACCESS_TOKEN, or SHOPIFY_CLIENT_ID and SHOPIFY_CLIENT_SECRET');
    }
    const res = await fetchImpl(`https://${cfg.shopDomain}/admin/oauth/access_token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        grant_type: 'client_credentials',
        client_id: cfg.clientId,
        client_secret: cfg.clientSecret,
      }),
    });
    if (!res.ok) throw new Error(`Shopify token request failed: ${res.status} ${summarize(await res.text())}`);
    const data = await res.json();
    token = data.access_token;
    expiresAt = data.expires_in ? Date.now() + data.expires_in * 1000 : Infinity;
    return token;
  }

  async function call(url, init = {}) {
    for (let attempt = 0; ; attempt++) {
      const res = await fetchImpl(url, {
        ...init,
        headers: {
          'Content-Type': 'application/json',
          'X-Shopify-Access-Token': await getToken(),
          ...init.headers,
        },
      });
      if (res.status === 429 && attempt < 5) {
        await sleep(Number(res.headers.get('Retry-After') || 2) * 1000);
        continue;
      }
      if (!res.ok) throw new Error(`Shopify ${init.method || 'GET'} ${url} failed: ${res.status} ${summarize(await res.text())}`);
      return res;
    }
  }

  // REST is used for reads because it returns the same JSON shape as the
  // webhooks, so backfilled records go through the same mapping code.
  async function* paginate(path, key) {
    let url = `${base}${path}`;
    while (url) {
      const res = await call(url);
      const data = await res.json();
      yield data[key] || [];
      url = nextPageUrl(res.headers.get('Link'));
      if (url) await sleep(500);
    }
  }

  async function graphql(query, variables = {}) {
    const res = await call(`${base}/graphql.json`, {
      method: 'POST',
      body: JSON.stringify({ query, variables }),
    });
    const data = await res.json();
    if (data.errors) throw new Error(`Shopify GraphQL error: ${JSON.stringify(data.errors)}`);
    return data.data;
  }

  return { paginate, graphql };
}
