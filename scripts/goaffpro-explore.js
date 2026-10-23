// Read-only look at GoAffPro data, to decide how affiliates map to
// Salesforce. Shows which fields GoAffPro returns for affiliates and for
// affiliate orders, how often each is filled, and short examples (personal
// values shortened, safe to paste).
//
//   npm run -s goaffpro-explore                    affiliates + orders, 20 each
//   npm run -s goaffpro-explore -- --sample=50
//   npm run -s goaffpro-explore -- --raw           also print the first affiliate as JSON (don't paste)
//
// Needs GOAFFPRO_ACCESS_TOKEN.
import { createGoAffProClient } from '../src/goaffpro/client.js';
import { inventory } from '../src/ghl/explore.js';

const arg = (name) => process.argv.find((a) => a.startsWith(`--${name}=`))?.split('=').slice(1).join('=');
const sample = Number(arg('sample') ?? 20);
const raw = process.argv.includes('--raw');
const gap = createGoAffProClient({ accessToken: process.env.GOAFFPRO_ACCESS_TOKEN });

// A wide net of field names: GoAffPro only returns the ones that exist.
const AFFILIATE_FIELDS = (arg('affiliate-fields') ?? [
  'id', 'name', 'first_name', 'last_name', 'email', 'phone', 'company_name', 'website',
  'address_1', 'address_2', 'city', 'state', 'zip', 'country', 'address',
  'ref_code', 'ref_codes', 'coupon', 'coupons', 'status', 'group_id', 'group_name',
  'parent_id', 'parent', 'mlm_parent_id', 'upline', 'customer_id', 'shopify_customer_id',
  'total_sales', 'total_revenue', 'sales', 'revenue', 'orders_count', 'total_orders',
  'total_commission', 'commission', 'commission_earned', 'balance', 'amount_paid', 'amount_pending',
  'created_at', 'updated_at', 'extra_1', 'extra_2', 'extra_3', 'tags', 'notes',
].join(',')).split(',');

const ORDER_FIELDS = (arg('order-fields') ?? [
  'id', 'number', 'order_id', 'order_number', 'affiliate_id', 'customer', 'customer_id', 'customer_email',
  'customer_name', 'total', 'subtotal', 'amount', 'commission', 'status', 'created_at', 'ref_code', 'coupon',
].join(',')).split(',');

function flatten(obj, prefix = '', out = {}) {
  for (const [k, v] of Object.entries(obj ?? {})) {
    const key = prefix ? `${prefix}.${k}` : k;
    if (v === null || v === undefined || v === '') continue;
    if (Array.isArray(v)) {
      if (v.length) out[key] = v.map((x) => (typeof x === 'object' ? JSON.stringify(x) : String(x))).join(', ');
    } else if (typeof v === 'object') {
      flatten(v, key, out);
    } else {
      out[key] = String(v);
    }
  }
  return out;
}

async function explore(label, path, key, fields) {
  const rows = [];
  try {
    for await (const row of gap.list(path, key, fields, { max: sample })) rows.push(row);
  } catch (err) {
    console.log(`\n${label}: ${err.message}`);
    return [];
  }
  console.log(`\n${label}: ${rows.length} sampled (field names prefixed with the object name)`);
  if (rows.length) console.table(inventory(rows.map((r) => flatten(r, key.replace(/s$/, '')))));
  return rows;
}

const affiliates = await explore('AFFILIATES', '/affiliates', 'affiliates', AFFILIATE_FIELDS);
await explore('AFFILIATE ORDERS', '/orders', 'orders', ORDER_FIELDS);

try {
  const totals = await gap.get('/affiliates', { fields: 'id', limit: 1, offset: 0 });
  if (totals.count ?? totals.total) console.log(`\nTotal affiliates: ${totals.count ?? totals.total}`);
} catch { /* count is optional */ }

if (raw && affiliates[0]) {
  console.log('\nFirst affiliate (raw, do not paste):');
  console.log(JSON.stringify(affiliates[0], null, 2));
}
console.log('\nPersonal values are shortened. Codes, statuses and amounts in fields named like source/tags/status are shown in full.');
