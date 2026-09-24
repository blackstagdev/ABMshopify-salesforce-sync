// All runtime settings come from environment variables. See .env.example.
const env = process.env;

function bool(value, fallback = false) {
  if (value === undefined || value === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(String(value).toLowerCase());
}

function int(value, fallback) {
  const n = Number.parseInt(value, 10);
  return Number.isFinite(n) ? n : fallback;
}

export const config = {
  port: int(env.PORT, 3000),
  // Render sets RENDER_EXTERNAL_URL automatically on web services.
  publicUrl: env.PUBLIC_URL || env.RENDER_EXTERNAL_URL,
  databaseUrl: env.DATABASE_URL,
  databaseSsl: bool(env.DATABASE_SSL),
  adminToken: env.ADMIN_TOKEN,

  shopify: {
    // The *.myshopify.com domain, not alphabiomedlabs.com.
    shopDomain: env.SHOPIFY_SHOP_DOMAIN,
    // Webhooks are signed with the app's client secret (API secret key).
    webhookSecret: env.SHOPIFY_WEBHOOK_SECRET || env.SHOPIFY_CLIENT_SECRET,
    // Either a static Admin API token (shpat_...) or client id + secret.
    accessToken: env.SHOPIFY_ADMIN_ACCESS_TOKEN,
    clientId: env.SHOPIFY_CLIENT_ID,
    clientSecret: env.SHOPIFY_CLIENT_SECRET,
    apiVersion: env.SHOPIFY_API_VERSION || '2026-07',
    lineOfBusiness: env.SHOPIFY_LINE_OF_BUSINESS || 'Alpha BioMed',
  },

  salesforce: {
    // dry_run: record what would be sent. live: call Salesforce.
    mode: env.SALESFORCE_MODE === 'live' ? 'live' : 'dry_run',
    // My Domain URL, e.g. https://alphabiomed.my.salesforce.com
    loginUrl: env.SF_LOGIN_URL,
    clientId: env.SF_CLIENT_ID,
    clientSecret: env.SF_CLIENT_SECRET,
    apiVersion: env.SF_API_VERSION || 'v67.0',
    accountRecordType: env.SF_ACCOUNT_RECORD_TYPE || 'Customer',
  },

  mapping: {
    // How a Shopify customer gets its Provider_ID__c. Undecided, so "none"
    // by default: events are held as blocked instead of guessing.
    providerIdStrategy: env.PROVIDER_ID_STRATEGY || 'none',
    providerIdTagPrefix: env.PROVIDER_ID_TAG_PREFIX || 'provider:',
    providerIdPrefix: env.PROVIDER_ID_PREFIX || 'SHOPIFY-',
    lineOfBusiness: env.SHOPIFY_LINE_OF_BUSINESS || 'Alpha BioMed',
    // Provider_Order__c fields are not documented yet.
    orderSyncEnabled: bool(env.ORDER_SYNC_ENABLED),
  },

  worker: {
    enabled: bool(env.WORKER_ENABLED, true),
    intervalMs: int(env.WORKER_INTERVAL_MS, 5000),
    batchSize: int(env.WORKER_BATCH_SIZE, 10),
    maxAttempts: int(env.WORKER_MAX_ATTEMPTS, 8),
  },
};
