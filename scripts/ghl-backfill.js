// Queues the opportunities already in the lead pipeline's mapped stages
// (any status: lost/abandoned ones become "Unresponsive"), so they go
// through exactly the same path as the Workflow webhook.
//
//   npm run ghl-backfill -- --account=abm --limit=10    a first batch of 10
//   npm run ghl-backfill -- --account=abm               everything
//
// Safe to re-run: a contact that already has a Salesforce Lead only gets its
// Status updated. Contacts already queued in this run are not queued twice.
import crypto from 'node:crypto';
import { config } from '../src/config.js';
import { createDb } from '../src/db.js';
import { createGhlAccounts } from '../src/ghl/accounts.js';

const arg = (name) => process.argv.find((a) => a.startsWith(`--${name}=`))?.split('=')[1];
const name = arg('account');
const limit = Number(arg('limit') ?? Infinity);

const account = createGhlAccounts(config.ghl)[name];
if (!account) {
  console.error('Pass --account=abm or --account=sync (and set its GHL token and location id).');
  process.exit(1);
}

const db = createDb(config);
await db.migrate();

let queued = 0;
const seen = new Set();
for (const stageId of Object.keys(account.cfg.stageStatus)) {
  let startAfter;
  let startAfterId;
  do {
    const { opportunities, meta } = await account.client.searchOpportunities({
      pipelineId: account.cfg.pipelineId, stageId, status: 'all', limit: 100, startAfter, startAfterId,
    });
    for (const opp of opportunities) {
      if (queued >= limit) break;
      const contactId = opp.contactId ?? opp.contact?.id;
      if (!contactId || seen.has(contactId)) continue;
      seen.add(contactId);
      await db.insertEvent({
        webhookId: `ghl-backfill:${name}:${opp.id}:${crypto.randomUUID()}`,
        topic: 'ghl/opportunity',
        shopDomain: null,
        // Contact only: the worker looks up the contact's latest opportunity.
        payload: { id: `${name}:${contactId}`, account: name, contactId },
      });
      queued++;
    }
    const more = opportunities.length > 0 && meta.startAfterId && meta.startAfterId !== startAfterId;
    startAfter = more ? meta.startAfter : undefined;
    startAfterId = more ? meta.startAfterId : undefined;
  } while (startAfterId && queued < limit);
  if (queued >= limit) break;
}

console.log(`Queued ${queued} ${account.cfg.lineOfBusiness} lead(s) from GHL.`);
await db.pool.end();
