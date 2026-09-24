// Prints the fields of Salesforce objects, straight from the org's describe
// API: the same information as the field reference workbook, for objects
// the workbook does not cover (Provider_Order__c first of all).
//
//   npm run sf-describe                          Provider_Order__c + order-like objects
//   npm run sf-describe -- Provider_Order__c Account
//   npm run sf-describe -- --list                every object with a custom (__c) name
//   npm run sf-describe -- Provider_Order__c --json > provider-order.json
//
// Needs SF_LOGIN_URL, SF_CLIENT_ID and SF_CLIENT_SECRET.
import { config } from '../src/config.js';
import { createSalesforceClient } from '../src/salesforce/client.js';

const args = process.argv.slice(2);
const asJson = args.includes('--json');
const listOnly = args.includes('--list');
const requested = args.filter((a) => !a.startsWith('--'));

const sf = createSalesforceClient(config.salesforce);
const { data: global } = await sf.request('GET', '/sobjects');

if (listOnly) {
  for (const o of global.sobjects.filter((s) => s.custom)) console.log(`${o.name.padEnd(45)} ${o.label}`);
  process.exit(0);
}

// With no arguments, show Provider_Order__c plus any custom object that
// looks order-related (line items, products) so nothing is missed.
const names = requested.length
  ? requested
  : global.sobjects.filter((s) => s.custom && /order|product|line/i.test(s.name)).map((s) => s.name);

if (names.length === 0) {
  console.error('No order-related custom objects found. Try --list.');
  process.exit(1);
}

const output = [];
for (const name of names) {
  const { data } = await sf.request('GET', `/sobjects/${encodeURIComponent(name)}/describe`);
  const fields = data.fields.map((f) => ({
    label: f.label,
    name: f.name,
    type: f.type + (f.referenceTo?.length ? ` -> ${f.referenceTo.join(', ')}` : ''),
    length: f.type === 'double' || f.type === 'currency' || f.type === 'percent' ? `${f.precision},${f.scale}` : f.length || '',
    // Same definition the workbook uses: the platform rejects an insert without it.
    requiredOnCreate: f.createable && !f.nillable && !f.defaultedOnCreate,
    access: f.createable && f.updateable ? 'Create & Update' : f.createable ? 'Create only' : f.updateable ? 'Update only' : 'Read only',
    unique: f.unique,
    externalId: f.externalId,
    custom: f.custom,
    formula: Boolean(f.calculated),
    picklist: f.picklistValues?.filter((p) => p.active).map((p) => p.value) ?? [],
    help: f.inlineHelpText || '',
  }));
  output.push({ object: name, label: data.label, recordTypes: data.recordTypeInfos.filter((r) => !r.master).map((r) => r.developerName), fields });
}

if (asJson) {
  console.log(JSON.stringify(output, null, 2));
  process.exit(0);
}

for (const obj of output) {
  console.log(`\n=== ${obj.object} (${obj.label}) - ${obj.fields.length} fields`);
  if (obj.recordTypes.length) console.log(`Record types: ${obj.recordTypes.join(', ')}`);

  const keys = obj.fields.filter((f) => f.externalId || f.unique).map((f) => f.name);
  console.log(`External ID / unique fields (possible upsert keys): ${keys.join(', ') || 'none'}`);
  console.log(`Required on create: ${obj.fields.filter((f) => f.requiredOnCreate).map((f) => f.name).join(', ') || 'none'}\n`);

  console.table(obj.fields.map((f) => ({
    'API Name': f.name,
    Label: f.label,
    Type: f.type,
    Length: f.length,
    Required: f.requiredOnCreate ? 'Yes' : '',
    Access: f.formula ? 'Read only (formula)' : f.access,
    Key: [f.externalId && 'External ID', f.unique && 'Unique'].filter(Boolean).join(', '),
    Picklist: f.picklist.length > 8 ? `${f.picklist.length} values` : f.picklist.join(' | '),
  })));
}
