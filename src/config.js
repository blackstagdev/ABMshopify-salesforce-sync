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
    // Object API names from the Provider Order / Order Product tabs. Check
    // them with `npm run sf-describe -- --list`.
    orderObject: env.SF_ORDER_OBJECT || 'Provider_Order__c',
    orderLineObject: env.SF_ORDER_LINE_OBJECT || 'Order_Product__c',
  },

  mapping: {
    // How a Shopify customer gets its Provider_ID__c. Undecided, so "none"
    // by default: events are held as blocked instead of guessing.
    providerIdStrategy: env.PROVIDER_ID_STRATEGY || 'none',
    providerIdTagPrefix: env.PROVIDER_ID_TAG_PREFIX || 'provider:',
    providerIdPrefix: env.PROVIDER_ID_PREFIX || 'SHOPIFY-',
    // "namespace.key" of the customer metafield holding the Provider ID,
    // used by the customer_metafield strategy.
    providerIdMetafield: env.PROVIDER_ID_METAFIELD || '',
    lineOfBusiness: env.SHOPIFY_LINE_OF_BUSINESS || 'Alpha BioMed',
    // Switch for sending Provider Orders, so providers can be loaded first.
    orderSyncEnabled: bool(env.ORDER_SYNC_ENABLED),
  },

  // GoHighLevel leads -> Salesforce Lead. Pipeline/stage ids come from
  // `npm run ghl-explore`; override with env if the pipelines change.
  ghl: {
    // Shared secret on the GHL Workflow webhook URL (?secret=...).
    webhookSecret: env.GHL_WEBHOOK_SECRET,
    leadSyncEnabled: bool(env.LEAD_SYNC_ENABLED),
    // Contacts with exactly this tag get LeadSource "Black Stag".
    adLeadTag: env.GHL_AD_LEAD_TAG || 'bsd-lead',
    accounts: {
      abm: {
        token: env.GHL_ABM_TOKEN,
        locationId: env.GHL_ABM_LOCATION_ID,
        // "1. Providers (RK)" / "New Providers"
        pipelineId: env.GHL_ABM_PIPELINE_ID || 'xzG1wOpYZyN99Vx90r8y',
        stageId: env.GHL_ABM_STAGE_ID || '249396ff-9b90-4680-8d1c-54d6fffd4c50',
        lineOfBusiness: 'Alpha BioMed',
      },
      sync: {
        token: env.GHL_SYNC_TOKEN,
        locationId: env.GHL_SYNC_LOCATION_ID,
        // "Alpha Sync" / "New Leads"
        pipelineId: env.GHL_SYNC_PIPELINE_ID || 'PIcnQ1WBD42DuTbQDfgx',
        stageId: env.GHL_SYNC_STAGE_ID || 'c0647486-8964-46e9-8df0-a194c911b98b',
        lineOfBusiness: 'AlphaSync',
      },
    },
  },

  worker: {
    enabled: bool(env.WORKER_ENABLED, true),
    intervalMs: int(env.WORKER_INTERVAL_MS, 5000),
    batchSize: int(env.WORKER_BATCH_SIZE, 10),
    maxAttempts: int(env.WORKER_MAX_ATTEMPTS, 8),
  },
};
