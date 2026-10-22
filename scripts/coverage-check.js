// Read-only: how much of Shopify (and the affiliate relationships) is in
// Salesforce. Compares counts and date ranges; writes nothing anywhere.
//
//   npm run -s coverage-check
import { config } from '../src/config.js';
import { createSalesforceClient } from '../src/salesforce/client.js';
import { createShopifyAdmin } from '../src/shopify/admin.js';

const sf = createSalesforceClient(config.salesforce);
const shopify = createShopifyAdmin(config.shopify);
const soql = async (q) => (await sf.request('GET', `/query?q=${encodeURIComponent(q)}`)).data;
const count = async (q) => (await soql(q)).totalSize;
const shopifyValue = async (path, key) => {
  for await (const v of shopify.paginate(path, key)) return v;
  return null;
};
const ABM = "Line_of_Business__c = 'Alpha BioMed'";

// --- Sales ---
const [orders] = (await soql(`SELECT COUNT(Id) n, MIN(Order_Date__c) first, MAX(Order_Date__c) last, SUM(Order_Amount__c) amount FROM Provider_Order__c WHERE ${ABM}`)).records;
const unlinked = await count(`SELECT COUNT() FROM Provider_Order__c WHERE ${ABM} AND Account__c = null`);
const shopifyOrders = await shopifyValue('/orders/count.json?status=any', 'count');
const [oldestShopify] = (await shopifyValue('/orders.json?status=any&limit=1&order=created_at%20asc&fields=name,created_at', 'orders')) ?? [];

console.log('\nSALES (Alpha BioMed orders)');
console.table([
  { where: 'Salesforce', orders: orders.n, earliest: orders.first, latest: orders.last, amount: Math.round(orders.amount ?? 0) },
  { where: 'Shopify (visible to the app)', orders: shopifyOrders, earliest: oldestShopify?.created_at?.slice(0, 10) ?? '?', latest: '', amount: '' },
]);
console.log(`Orders in Salesforce not linked to a practice: ${unlinked}`);
console.log('Note: without the read_all_orders scope Shopify only shows the app the last 60 days, so its count and earliest date stop there too.');

console.log('\nOrders per month in Salesforce:');
const months = (await soql(`SELECT CALENDAR_YEAR(Order_Date__c) y, CALENDAR_MONTH(Order_Date__c) m, COUNT(Id) n, SUM(Order_Amount__c) amount FROM Provider_Order__c WHERE ${ABM} GROUP BY CALENDAR_YEAR(Order_Date__c), CALENDAR_MONTH(Order_Date__c) ORDER BY CALENDAR_YEAR(Order_Date__c), CALENDAR_MONTH(Order_Date__c)`)).records;
console.table(months.map((r) => ({ month: `${r.y}-${String(r.m).padStart(2, '0')}`, orders: r.n, amount: Math.round(r.amount ?? 0) })));

// --- Customers ---
const shopifyCustomers = await shopifyValue('/customers/count.json', 'count');
console.log('\nCUSTOMERS');
console.table([
  { what: 'Shopify customers', count: shopifyCustomers },
  { what: 'Salesforce practices from Shopify (Accounts with Shopify ID)', count: await count('SELECT COUNT() FROM Account WHERE Shopify_ID__c != null') },
  { what: 'Salesforce Contacts (all)', count: await count('SELECT COUNT() FROM Contact') },
]);
console.log('Shopify customers without a Provider ID are not synced (see npm run check-provider-ids).');

// --- Partner / affiliate relationships ---
console.log('\nPARTNER / AFFILIATE RELATIONSHIPS');
console.table([
  { what: 'Affiliate Accounts (record type Affiliate)', count: await count("SELECT COUNT() FROM Account WHERE RecordType.DeveloperName = 'Affiliate'") },
  { what: 'Practices linked to an affiliate (Affiliate__c set)', count: await count("SELECT COUNT() FROM Account WHERE Affiliate__c != null AND RecordType.DeveloperName = 'Customer'") },
  { what: 'Affiliates linked to an upline (Affiliate__c set)', count: await count("SELECT COUNT() FROM Account WHERE Affiliate__c != null AND RecordType.DeveloperName = 'Affiliate'") },
]);
console.log('The sync does not create affiliates or links yet (no GoAffPro sync has been built).');
