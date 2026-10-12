// Read-only answers to data questions from the Salesforce team, using the
// latest stored Shopify event per order / customer. Writes nothing.
//
//   npm run -s data-check
import { config } from '../src/config.js';
import { createDb } from '../src/db.js';

const db = createDb(config);
const q = async (sql, params = []) => (await db.pool.query(sql, params)).rows;

const ORDERS = `SELECT DISTINCT ON (payload->>'id') payload AS o
  FROM shopify_events WHERE topic LIKE 'orders/%' ORDER BY payload->>'id', id DESC`;
const CUSTOMERS = `SELECT DISTINCT ON (payload->>'id') payload AS c, status
  FROM shopify_events WHERE topic LIKE 'customers/%' ORDER BY payload->>'id', id DESC`;
const num = (path) => `COALESCE((${path})::numeric, 0)`;

// 1. What makes up the gap between the order amount we send and its lines.
console.log('\n1. ORDER AMOUNT: current total vs subtotal, shipping and tax');
console.table(await q(`
  WITH x AS (
    SELECT ${num("o->>'current_total_price'")} AS total,
           ${num("o->>'current_subtotal_price'")} AS subtotal,
           ${num("o->'total_shipping_price_set'->'shop_money'->>'amount'")} AS shipping,
           ${num("o->>'current_total_tax'")} AS tax
    FROM (${ORDERS}) l
  )
  SELECT count(*)::int AS orders,
         count(*) FILTER (WHERE total <> subtotal)::int AS total_differs_from_subtotal,
         count(*) FILTER (WHERE total <> subtotal AND abs(total - subtotal - shipping - tax) < 0.02)::int AS gap_is_shipping_plus_tax,
         count(*) FILTER (WHERE shipping > 0)::int AS orders_with_shipping
  FROM x`));
console.log('Most common gaps (total - subtotal) and the shipping charged:');
console.table(await q(`
  SELECT ${num("o->>'current_total_price'")} - ${num("o->>'current_subtotal_price'")} AS gap,
         ${num("o->'total_shipping_price_set'->'shop_money'->>'amount'")} AS shipping,
         count(*)::int AS orders
  FROM (${ORDERS}) l GROUP BY 1, 2 ORDER BY 3 DESC LIMIT 8`));

// 2. Free lines: what they have in common.
const FREE_LINES = `
  SELECT l.o, li FROM (${ORDERS}) l, jsonb_array_elements(l.o->'line_items') li
  WHERE ${num("li->>'price'")} * ${num("li->>'quantity'")}
        - COALESCE((SELECT sum((a->>'amount')::numeric) FROM jsonb_array_elements(li->'discount_allocations') a), 0) <= 0`;
console.log('\n2. SAMPLES: $0 lines by product (title / SKU / vendor)');
console.table(await q(`
  SELECT left(li->>'title', 45) AS title, li->>'sku' AS sku, li->>'vendor' AS vendor,
         CASE WHEN ${num("li->>'price'")} = 0 THEN 'priced $0' ELSE 'discounted to $0' END AS how,
         count(*)::int AS lines
  FROM (${FREE_LINES}) f GROUP BY 1, 2, 3, 4 ORDER BY 5 DESC LIMIT 15`));
console.log('Orders with a $0 line, by order tags and discount codes:');
console.table(await q(`
  SELECT left(COALESCE(NULLIF(f.o->>'tags', ''), '(no tags)'), 50) AS order_tags,
         COALESCE((SELECT string_agg(d->>'code', ', ') FROM jsonb_array_elements(f.o->'discount_codes') d), '(none)') AS discount_codes,
         count(DISTINCT f.o->>'id')::int AS orders
  FROM (${FREE_LINES}) f GROUP BY 1, 2 ORDER BY 3 DESC LIMIT 10`));

// 3. Where the company name is (or isn't) in Shopify.
console.log('\n3. NAMES: synced customers and where Shopify has a company');
console.table(await q(`
  SELECT count(*)::int AS synced_customers,
         count(*) FILTER (WHERE COALESCE(trim(c->'default_address'->>'company'), '') <> '')::int AS company_on_default_address,
         count(*) FILTER (WHERE COALESCE(trim(c->'default_address'->>'company'), '') = ''
           AND EXISTS (SELECT 1 FROM jsonb_array_elements(c->'addresses') a WHERE COALESCE(trim(a->>'company'), '') <> ''))::int AS company_only_on_another_address,
         count(*) FILTER (WHERE NOT EXISTS (SELECT 1 FROM jsonb_array_elements(c->'addresses') a WHERE COALESCE(trim(a->>'company'), '') <> ''))::int AS no_company_anywhere
  FROM (${CUSTOMERS}) l WHERE status = 'synced'`));

// 4. Internal-looking accounts.
console.log('\n4. TESTS: synced customers with internal email domains');
console.table(await q(`
  SELECT split_part(lower(c->>'email'), '@', 2) AS domain, c->>'email' AS email,
         trim(concat(c->>'first_name', ' ', c->>'last_name')) AS name,
         left(COALESCE(c->'default_address'->>'company', ''), 30) AS company,
         left(COALESCE(c->>'tags', ''), 30) AS tags
  FROM (${CUSTOMERS}) l
  WHERE status = 'synced' AND split_part(lower(c->>'email'), '@', 2) IN ('blackstag.us', 'alphabiomedlabs.com')
  ORDER BY 1, 2`));

await db.pool.end();
