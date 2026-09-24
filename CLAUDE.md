# CLAUDE.md

Node.js (ESM, Node 22+) service that pushes Shopify customers and orders from alphabiomedlabs.com into Salesforce. Hosted on Render (see render.yaml). README.md has the architecture and commands.

## Commands

- `npm test`: node:test unit tests; no network or database needed
- `npm start`: runs server and worker; needs `DATABASE_URL`

## Layout

- `src/server.js`: webhook receiver (HMAC check, store, fast 200) and `/admin` routes
- `src/worker.js`: polls `shopify_events`, retries with backoff
- `src/mapping/plan.js`: Shopify payload → plan of Salesforce operations (pure, no I/O)
- `src/mapping/providerId.js`: Provider_ID__c resolution strategies
- `src/salesforce/executor.js`: runs a plan against Salesforce
- `scripts/`: register-webhooks, backfill, requeue

## Salesforce rules (from the field reference workbook, prod org, 18 Sep 2026)

The workbook (`*.xlsx` in the project root) is gitignored. These rules must hold:

- Accounts are created and updated only through `Provider_ID__c` (Text 30, unique external ID). Never match on NPI__c, Primary_Email__c or name.
- Never invent a Provider ID rule. The strategy is configuration, and the default `none` blocks events.
- Never write Salesforce-maintained fields (order counts, revenue, order dates, trends) or formula fields.
- Don't write `ABM_Status__c`, `AlphaSync_Status__c`, `ABM_Owner__c`, `Sync_Owner__c` or `OwnerId`. The Account trigger rejects the integration user on the status fields, and owner changes need a custom permission.
- Salesforce has no duplicate blocking or validation rules, so de-duplication happens here (Contact is matched on AccountId + Email).
- Resolve record types by DeveloperName at runtime (`Customer`, `Affiliate`), never by hard-coded Id. Send address components, not compound address fields.
- Truncate text to the field lengths in the workbook. Omit blank values rather than sending empties.
- `Provider_Order__c` isn't documented yet. `upsertOrder` stays blocked until its fields are confirmed.

## Conventions

- Mapping stays pure and testable. Add a test in `test/plan.test.js` for every mapping change.
- Keep dry-run behaviour: building a plan must never call Salesforce.
- Secrets only come from environment variables. Never commit `.env`.
