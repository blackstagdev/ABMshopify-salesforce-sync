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
    // Create new orders by upserting on Shopify_Order_ID__c instead of a
    // plain insert. Switch on only after every existing order and line has
    // its Shopify ID filled in (Salesforce team's instruction).
    orderUpsertByShopifyId: bool(env.ORDER_UPSERT_BY_SHOPIFY_ID),
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
    // Set to the Lead field holding the GHL contact ID once the Salesforce
    // team has added it (e.g. GHL_Contact_ID__c): it is then sent on every
    // lead, and new leads are upserted on it.
    leadIdField: env.LEAD_GHL_ID_FIELD || '',
    accounts: {
      abm: {
        token: env.GHL_ABM_TOKEN,
        locationId: env.GHL_ABM_LOCATION_ID,
        // "1. Providers (RK)"
        pipelineId: env.GHL_ABM_PIPELINE_ID || 'xzG1wOpYZyN99Vx90r8y',
        // GHL stage id -> Salesforce Lead Status, confirmed by Alpha BioMed
        // (Oct 2026). Stages not listed are not sent: GPO & Partners,
        // 30/60/90-day-risk, Abandoned (legacy), Archive (120 days).
        stageStatus: {
          '249396ff-9b90-4680-8d1c-54d6fffd4c50': 'New', // New Providers
          '54dd431b-62e6-4edd-b988-e51e5fb60007': 'Contacted', // NPI For Review
          '7ae94ed2-a545-49e1-bd99-4515ed140e55': 'Contacted', // In Communication with CS
          '278eae1c-08be-4674-a63c-a47e3879d2a4': 'Contacted', // Escalate to Sales
          '9d4e66a2-8081-4ec7-ab92-57a844c547f1': 'Contacted', // In Communication with Sales
          'a19201db-0cc2-4b90-b4e1-5e873d942d06': 'Qualified', // Send Document
          'bd825aaf-429e-4178-9b1f-01de76a7915c': 'Contacted', // Duplicate NPI
          'a3bbd48b-b59a-48a0-8814-56fe6fc5a356': 'Disqualified', // Declined
          '3ee61973-f406-4ca9-82f5-c18bdffcc56d': 'Qualified', // Referred - Approved
          '7448b37d-9797-43b1-b072-9aed7b34201d': 'Qualified', // Unassigned - Approved
          '869b73ff-e891-4d98-928c-8f870e70ee09': 'Unresponsive', // Dormant
          '66fa7cf2-2174-41cd-874f-eaea5b57ea5a': 'Qualified', // For Reactivation
        },
        lineOfBusiness: 'Alpha BioMed',
      },
      sync: {
        token: env.GHL_SYNC_TOKEN,
        locationId: env.GHL_SYNC_LOCATION_ID,
        // "Alpha Sync"
        pipelineId: env.GHL_SYNC_PIPELINE_ID || 'PIcnQ1WBD42DuTbQDfgx',
        // Only the first stage for now (no AlphaSync mapping agreed yet).
        stageStatus: {
          'c0647486-8964-46e9-8df0-a194c911b98b': 'New', // New Leads
        },
        lineOfBusiness: 'AlphaSync',
      },
    },
  },

  worker: {
    enabled: bool(env.WORKER_ENABLED, true),
    intervalMs: int(env.WORKER_INTERVAL_MS, 5000),
    batchSize: int(env.WORKER_BATCH_SIZE, 10),
    maxAttempts: int(env.WORKER_MAX_ATTEMPTS, 8),
    // Backfill events wait while less than this % of the org's daily
    // Salesforce API allowance is left (live mode only; 0 turns it off).
    apiReservePercent: int(env.SALESFORCE_API_RESERVE_PERCENT, 30),
  },
};
