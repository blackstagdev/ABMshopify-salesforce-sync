import { config } from './config.js';
import { createDb } from './db.js';
import { createApp } from './server.js';
import { startWorker } from './worker.js';
import { processEvent } from './processor.js';
import { createSalesforceClient } from './salesforce/client.js';

const db = createDb(config);
await db.migrate();

const sf = config.salesforce.mode === 'live' ? createSalesforceClient(config.salesforce) : null;
console.info(`[startup] Salesforce mode: ${config.salesforce.mode}, provider ID strategy: ${config.mapping.providerIdStrategy}`);

const server = createApp({ db, config }).listen(config.port, () => {
  console.info(`[startup] listening on port ${config.port}`);
});

const worker = config.worker.enabled
  ? startWorker({
      db,
      handle: (event) => processEvent(event, {
        mode: config.salesforce.mode,
        mapping: config.mapping,
        salesforce: config.salesforce,
        sf,
      }),
      ...config.worker,
    })
  : null;

// Render sends SIGTERM on deploys; finish the current event first.
async function shutdown(signal) {
  console.info(`[shutdown] ${signal}`);
  server.close();
  await worker?.stop();
  await db.pool.end();
  process.exit(0);
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
