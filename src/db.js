import pg from 'pg';

// Every webhook is stored before it is processed, so nothing is lost if
// Salesforce is down or misconfigured, and events can be replayed.
//
// status: pending -> processing -> synced | dry_run | blocked | ignored | failed
export function createDb({ databaseUrl, databaseSsl }) {
  if (!databaseUrl) throw new Error('DATABASE_URL is not set');
  const pool = new pg.Pool({
    connectionString: databaseUrl,
    ssl: databaseSsl ? { rejectUnauthorized: false } : false,
    max: 5,
  });
  // An idle connection dropped by the server (restart, maintenance) must
  // not crash the process; the pool reconnects on the next query.
  pool.on('error', (err) => console.error('[db] idle connection error:', err.message));

  async function migrate() {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS shopify_events (
        id              BIGSERIAL PRIMARY KEY,
        webhook_id      TEXT UNIQUE,
        topic           TEXT NOT NULL,
        shop_domain     TEXT,
        payload         JSONB NOT NULL,
        received_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
        status          TEXT NOT NULL DEFAULT 'pending',
        attempts        INTEGER NOT NULL DEFAULT 0,
        next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        locked_at       TIMESTAMPTZ,
        last_error      TEXT,
        result          JSONB,
        processed_at    TIMESTAMPTZ
      );
      CREATE INDEX IF NOT EXISTS shopify_events_queue_idx ON shopify_events (status, next_attempt_at);

      -- Provider Order and Order Product have no external ID in Salesforce,
      -- so this is how a Shopify order is found again to update it rather
      -- than create a duplicate. lines maps Shopify line id -> Salesforce Id.
      CREATE TABLE IF NOT EXISTS salesforce_orders (
        shopify_order_id    TEXT PRIMARY KEY,
        salesforce_id       TEXT NOT NULL,
        shopify_customer_id TEXT,
        account_id          TEXT,
        lines               JSONB NOT NULL DEFAULT '{}',
        synced_at           TIMESTAMPTZ NOT NULL DEFAULT now()
      );
      CREATE INDEX IF NOT EXISTS salesforce_orders_unlinked_idx
        ON salesforce_orders (shopify_customer_id) WHERE account_id IS NULL;

      -- One Salesforce Lead per GHL contact per sub-account (Lead has no
      -- external ID either).
      CREATE TABLE IF NOT EXISTS salesforce_leads (
        account            TEXT NOT NULL,
        ghl_contact_id     TEXT NOT NULL,
        ghl_opportunity_id TEXT,
        salesforce_id      TEXT NOT NULL,
        created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
        PRIMARY KEY (account, ghl_contact_id)
      );
    `);
  }

  async function getLeadLink(account, ghlContactId) {
    const { rows } = await pool.query(
      'SELECT * FROM salesforce_leads WHERE account = $1 AND ghl_contact_id = $2',
      [account, ghlContactId],
    );
    return rows[0] ?? null;
  }

  async function saveLeadLink({ account, ghlContactId, ghlOpportunityId, salesforceId }) {
    await pool.query(
      `INSERT INTO salesforce_leads (account, ghl_contact_id, ghl_opportunity_id, salesforce_id)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (account, ghl_contact_id) DO NOTHING`,
      [account, ghlContactId, ghlOpportunityId, salesforceId],
    );
  }

  async function getOrderLink(shopifyOrderId) {
    const { rows } = await pool.query('SELECT * FROM salesforce_orders WHERE shopify_order_id = $1', [shopifyOrderId]);
    return rows[0] ?? null;
  }

  async function saveOrderLink({ shopifyOrderId, salesforceId, shopifyCustomerId, accountId, lines }) {
    await pool.query(
      `INSERT INTO salesforce_orders (shopify_order_id, salesforce_id, shopify_customer_id, account_id, lines, synced_at)
       VALUES ($1, $2, $3, $4, $5, now())
       ON CONFLICT (shopify_order_id) DO UPDATE
       SET salesforce_id = $2, shopify_customer_id = $3, account_id = $4, lines = $5, synced_at = now()`,
      [shopifyOrderId, salesforceId, shopifyCustomerId, accountId, lines],
    );
  }

  // Orders sent before their customer had a Provider ID.
  async function unlinkedOrdersForCustomer(shopifyCustomerId) {
    const { rows } = await pool.query(
      'SELECT * FROM salesforce_orders WHERE shopify_customer_id = $1 AND account_id IS NULL',
      [shopifyCustomerId],
    );
    return rows;
  }

  // Requeues only the newest event per customer / per order with this
  // status, so replaying never applies older data over newer data.
  async function requeueLatest(status) {
    const { rowCount } = await pool.query(
      `UPDATE shopify_events
       SET status = 'pending', attempts = 0, next_attempt_at = now(), last_error = NULL, locked_at = NULL
       WHERE id IN (
         SELECT id FROM (
           SELECT DISTINCT ON (split_part(topic, '/', 1), payload->>'id') id, status
           FROM shopify_events
           ORDER BY split_part(topic, '/', 1), payload->>'id', id DESC
         ) latest
         WHERE status = $1
       )`,
      [status],
    );
    return rowCount;
  }

  // Shopify retries deliveries, so the webhook id makes inserts idempotent.
  async function insertEvent({ webhookId, topic, shopDomain, payload }) {
    const { rowCount } = await pool.query(
      `INSERT INTO shopify_events (webhook_id, topic, shop_domain, payload)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (webhook_id) DO NOTHING`,
      [webhookId, topic, shopDomain, payload],
    );
    return rowCount === 1;
  }

  // Also reclaims events left in "processing" by a crashed instance.
  async function claimEvents(limit) {
    const { rows } = await pool.query(
      `WITH picked AS (
         SELECT id FROM shopify_events
         WHERE (status = 'pending' AND next_attempt_at <= now())
            OR (status = 'processing' AND locked_at < now() - interval '10 minutes')
         ORDER BY id
         LIMIT $1
         FOR UPDATE SKIP LOCKED
       )
       UPDATE shopify_events e
       SET status = 'processing', locked_at = now(), attempts = e.attempts + 1
       FROM picked WHERE e.id = picked.id
       RETURNING e.*`,
      [limit],
    );
    return rows.sort((a, b) => Number(a.id) - Number(b.id));
  }

  async function finishEvent(id, status, result, error = null) {
    await pool.query(
      `UPDATE shopify_events
       SET status = $2, result = $3, last_error = $4, locked_at = NULL, processed_at = now()
       WHERE id = $1`,
      [id, status, result ?? null, error],
    );
  }

  async function retryEvent(id, error, delaySeconds) {
    await pool.query(
      `UPDATE shopify_events
       SET status = 'pending', last_error = $2, locked_at = NULL,
           next_attempt_at = now() + make_interval(secs => $3)
       WHERE id = $1`,
      [id, error, delaySeconds],
    );
  }

  async function listEvents({ status, limit = 50 }) {
    const { rows } = await pool.query(
      `SELECT id, webhook_id, topic, status, attempts, received_at, processed_at, last_error
       FROM shopify_events
       WHERE ($1::text IS NULL OR status = $1)
       ORDER BY id DESC LIMIT $2`,
      [status ?? null, Math.min(limit, 500)],
    );
    return rows;
  }

  async function getEvent(id) {
    const { rows } = await pool.query('SELECT * FROM shopify_events WHERE id = $1', [id]);
    return rows[0] ?? null;
  }

  async function countByStatus() {
    const { rows } = await pool.query('SELECT status, count(*)::int AS count FROM shopify_events GROUP BY status');
    return Object.fromEntries(rows.map((r) => [r.status, r.count]));
  }

  // Puts events back in the queue, e.g. dry_run or blocked events once
  // Salesforce is connected or a mapping decision has been made.
  async function requeue({ status, ids }) {
    if (!status && !ids?.length) throw new Error('requeue needs a status or ids');
    const { rowCount } = await pool.query(
      `UPDATE shopify_events
       SET status = 'pending', attempts = 0, next_attempt_at = now(), last_error = NULL, locked_at = NULL
       WHERE status <> 'processing'
         AND ($1::text IS NULL OR status = $1)
         AND ($2::bigint[] IS NULL OR id = ANY($2))`,
      [status ?? null, ids?.length ? ids : null],
    );
    return rowCount;
  }

  // The most recent customer event per Shopify customer id.
  async function latestCustomerEvents(customerIds) {
    if (customerIds.length === 0) return new Map();
    const { rows } = await pool.query(
      `SELECT DISTINCT ON (payload->>'id') payload->>'id' AS customer_id, id, status, processed_at, last_error
       FROM shopify_events
       WHERE topic LIKE 'customers/%' AND payload->>'id' = ANY($1)
       ORDER BY payload->>'id', id DESC`,
      [customerIds.map(String)],
    );
    return new Map(rows.map((r) => [r.customer_id, r]));
  }

  async function ping() {
    await pool.query('SELECT 1');
  }

  return {
    pool, migrate, insertEvent, claimEvents, finishEvent, retryEvent, listEvents, getEvent, countByStatus,
    requeue, requeueLatest, latestCustomerEvents, getOrderLink, saveOrderLink, unlinkedOrdersForCustomer,
    getLeadLink, saveLeadLink, ping,
  };
}
