// Queues the open opportunities already sitting in a GHL lead stage, so
// they go through exactly the same path as the Workflow webhook.
//
//   npm run ghl-backfill -- --account=abm
//   npm run ghl-backfill -- --account=sync --limit=50
//
// Safe to re-run: a contact that already has a Salesforce Lead is skipped
// when processed.
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
let startAfter;
let startAfterId;
do {
  const { opportunities, meta } = await account.client.searchOpportunities({
    pipelineId: account.cfg.pipelineId, stageId: account.cfg.stageId, status: 'open', limit: 100, startAfter, startAfterId,
  });
  for (const opp of opportunities) {
    if (queued >= limit) break;
    const contactId = opp.contactId ?? opp.contact?.id;
    await db.insertEvent({
      webhookId: `ghl-backfill:${name}:${opp.id}:${crypto.randomUUID()}`,
      topic: 'ghl/opportunity',
      shopDomain: null,
      payload: { id: `${name}:${contactId ?? opp.id}`, account: name, contactId, opportunityId: opp.id },
    });
    queued++;
  }
  const more = opportunities.length > 0 && meta.startAfterId && meta.startAfterId !== startAfterId;
  startAfter = more ? meta.startAfter : undefined;
  startAfterId = more ? meta.startAfterId : undefined;
} while (startAfterId && queued < limit);

console.log(`Queued ${queued} ${account.cfg.lineOfBusiness} lead(s) from GHL.`);
await db.pool.end();
