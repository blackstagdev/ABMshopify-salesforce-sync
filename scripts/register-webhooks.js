// Subscribes the Shopify app to the webhook topics this service handles.
// Safe to re-run: existing subscriptions to the same URL are kept.
//
//   npm run register-webhooks            create missing subscriptions
//   npm run register-webhooks -- --list  only show current subscriptions
import { config } from '../src/config.js';
import { createShopifyAdmin } from '../src/shopify/admin.js';

const TOPICS = ['CUSTOMERS_CREATE', 'CUSTOMERS_UPDATE', 'ORDERS_CREATE', 'ORDERS_UPDATED'];

const shopify = createShopifyAdmin(config.shopify);

const { webhookSubscriptions } = await shopify.graphql(`{
  webhookSubscriptions(first: 100) { nodes { id topic uri } }
}`);
const existing = webhookSubscriptions.nodes;

console.log('Current subscriptions:');
for (const s of existing) console.log(`  ${s.topic.padEnd(20)} ${s.uri}`);
if (existing.length === 0) console.log('  (none)');

if (process.argv.includes('--list')) process.exit(0);

if (!config.publicUrl) {
  console.error('Set PUBLIC_URL (Render sets RENDER_EXTERNAL_URL automatically).');
  process.exit(1);
}
const uri = `${config.publicUrl.replace(/\/$/, '')}/webhooks/shopify`;

for (const topic of TOPICS) {
  if (existing.some((s) => s.topic === topic && s.uri === uri)) {
    console.log(`= ${topic} already subscribed`);
    continue;
  }
  const data = await shopify.graphql(
    `mutation ($topic: WebhookSubscriptionTopic!, $sub: WebhookSubscriptionInput!) {
      webhookSubscriptionCreate(topic: $topic, webhookSubscription: $sub) {
        webhookSubscription { id }
        userErrors { field message }
      }
    }`,
    { topic, sub: { uri, format: 'JSON' } },
  );
  const { userErrors } = data.webhookSubscriptionCreate;
  if (userErrors.length) {
    console.error(`! ${topic}: ${userErrors.map((e) => e.message).join('; ')}`);
    process.exitCode = 1;
  } else {
    console.log(`+ ${topic} -> ${uri}`);
  }
}
