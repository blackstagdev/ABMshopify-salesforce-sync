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
    `);
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

  async function ping() {
    await pool.query('SELECT 1');
  }

  return { pool, migrate, insertEvent, claimEvents, finishEvent, retryEvent, listEvents, getEvent, countByStatus, requeue, ping };
}
