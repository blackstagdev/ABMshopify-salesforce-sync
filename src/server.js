import crypto from 'node:crypto';
import express from 'express';
import { verifyShopifyHmac } from './shopify/verify.js';

export function createApp({ db, config, log = console }) {
  const app = express();
  app.disable('x-powered-by');

  app.get('/health', async (req, res) => {
    try {
      await db.ping();
      res.json({ ok: true, mode: config.salesforce.mode });
    } catch {
      res.status(503).json({ ok: false });
    }
  });

  // The raw body is needed to check the signature, so this route must not
  // go through a JSON parser. Reply fast: Shopify times out after 5 seconds
  // and deletes subscriptions that keep failing.
  app.post('/webhooks/shopify', express.raw({ type: () => true, limit: '5mb' }), async (req, res) => {
    if (!verifyShopifyHmac(req.body, req.get('X-Shopify-Hmac-Sha256'), config.shopify.webhookSecret)) {
      return res.status(401).send('Invalid signature');
    }

    const shopDomain = req.get('X-Shopify-Shop-Domain');
    if (config.shopify.shopDomain && shopDomain !== config.shopify.shopDomain) {
      return res.status(401).send('Unknown shop');
    }

    let payload;
    try {
      payload = JSON.parse(req.body.toString('utf8'));
    } catch {
      return res.status(400).send('Invalid JSON');
    }

    const topic = req.get('X-Shopify-Topic');
    const webhookId = req.get('X-Shopify-Webhook-Id') || req.get('X-Shopify-Event-Id') || crypto.randomUUID();

    try {
      const inserted = await db.insertEvent({ webhookId, topic, shopDomain, payload });
      log.info(`[webhook] ${topic} ${webhookId}${inserted ? '' : ' (duplicate)'}`);
      res.status(200).send('OK');
    } catch (err) {
      log.error('[webhook] could not store event:', err.message);
      res.status(500).send('Could not store event');
    }
  });

  app.use('/admin', express.json(), requireAdmin(config.adminToken), adminRoutes(db));

  return app;
}

// Admin endpoints show customer data, so they are off unless ADMIN_TOKEN
// is set, and every call needs "Authorization: Bearer <ADMIN_TOKEN>".
function requireAdmin(token) {
  const expected = token ? Buffer.from(`Bearer ${token}`) : null;
  return (req, res, next) => {
    if (!expected) return res.status(404).end();
    const given = Buffer.from(req.get('Authorization') || '');
    if (given.length !== expected.length || !crypto.timingSafeEqual(given, expected)) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
    next();
  };
}

function adminRoutes(db) {
  const router = express.Router();

  router.get('/stats', async (req, res) => {
    res.json(await db.countByStatus());
  });

  router.get('/events', async (req, res) => {
    const limit = Number.parseInt(req.query.limit, 10) || 50;
    res.json(await db.listEvents({ status: req.query.status, limit }));
  });

  router.get('/events/:id', async (req, res) => {
    const event = await db.getEvent(req.params.id);
    if (!event) return res.status(404).json({ error: 'Not found' });
    res.json(event);
  });

  // Body: { "status": "blocked" } or { "ids": [12, 13] }
  router.post('/requeue', async (req, res) => {
    const { status, ids } = req.body || {};
    if (!status && !Array.isArray(ids)) return res.status(400).json({ error: 'Send a status or an ids array' });
    res.json({ requeued: await db.requeue({ status, ids }) });
  });

  return router;
}
