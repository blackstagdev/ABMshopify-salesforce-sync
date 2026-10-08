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
- `src/mapping/samePractice.js`: flags customers that look like the same practice (company / non-free email domain)
- `src/db.js`: `shopify_events` queue (also holds GHL events), plus the `salesforce_orders` and `salesforce_leads` link tables
- `src/ghl/`: GHL client, lead mapping (`leads.js`), sub-account config (`accounts.js`)
- `scripts/`:
  - register-webhooks
  - backfill (`--limit`)
  - requeue (`--latest`: newest event per customer/order only)
  - sf-describe
  - ghl-explore, ghl-backfill
  - report-duplicates
  - check-provider-ids
  - assign-provider-ids: generates random IDs. Provider IDs are actually the GHL contact IDs, so don't `--apply` it.

## Salesforce rules (from the field reference workbook)

The current workbook is "Alpha BioMed - Salesforce Field Reference (Lead, Account, Contact).xlsx" (it also has Provider Order and Order Product tabs). All `*.xlsx` files are gitignored. The Shopify sync is Alpha BioMed only: never write AlphaSync fields from Shopify data. The GHL lead sync covers both lines (Lead.Line_of_Business__c). These rules must hold:

- Accounts are created and updated only through `Provider_ID__c` (Text 30, unique external ID). Never match on NPI__c, Primary_Email__c or name.
- Never invent a Provider ID rule. The strategy is configuration, and the default `none` blocks events. The chosen source is the Shopify customer metafield "Provider ID" (`PROVIDER_ID_STRATEGY=customer_metafield`, `PROVIDER_ID_METAFIELD=namespace.key`). The processor looks it up through the Shopify Admin API, because webhooks don't carry metafields.
- `Shopify_ID__c` on Account was added by the project owner for this integration; it isn't in the workbook. It holds the Shopify customer id for reference only and is never used for matching.
- Never write Salesforce-maintained fields (order counts, revenue, order dates, trends) or formula fields.
- `ABM_Status__c`: the Salesforce team asked on 2026-10-02 for it to be set. A customer with no orders gets Prospect; one with orders gets Active. It's set on create. On update, never when `ABM_Owner__c` is set (the Account trigger rejects the integration user), and only moving forward (Not a customer → Prospect → Active). Lapsed is replaced only by a new order.
- Don't write `AlphaSync_Status__c`, `ABM_Owner__c`, `Sync_Owner__c` or `OwnerId`. Owner changes need a custom permission.
- De-duplication happens here (Contact is matched on AccountId + Email). Since about 2026-10-01 the org's duplicate rules **block** (the workbook says Allow), so a practice whose Salesforce Provider ID differs from Shopify's fails with DUPLICATES_DETECTED. Never bypass the rules. `npm run report-duplicates` explains each failure.
- Resolve record types by DeveloperName at runtime (`Customer`, `Affiliate`), never by hard-coded Id. Send address components, not compound address fields.
- Truncate text to the field lengths in the workbook. Omit blank values rather than sending empties.
- **Provider Order / Order Product:**
  - Neither object has an external ID. The `salesforce_orders` table maps each Shopify order (and line) to its Salesforce Id. The link is saved straight after the create, so retries never duplicate.
  - Required order fields: Line_of_Business__c = Alpha BioMed, Order_Amount__c = Shopify current total (0 once cancelled), Order_Date__c = local date from created_at.
  - Order_Type__c: New for the customer's first order, Reorder for later ones.
  - Paid__c: true when paid, partially refunded or refunded.
  - Never send Fulfilment_Status__c (DO NOT SEND), Order_For__c or OwnerId. Product_Category__c is blank because there's no source.
  - Orders from customers without a Provider ID go out unlinked, and are linked when the Account is next upserted.
  - Gated by `ORDER_SYNC_ENABLED`.
- **GHL leads → Salesforce Lead** (src/ghl/, topic `ghl/opportunity`):
  - Source: open opportunities in one stage per sub-account. Alpha BioMed: "1. Providers (RK)" / "New Providers" → Line of Business Alpha BioMed. Alpha Sync: "Alpha Sync" / "New Leads" → AlphaSync. The ids are in config.js and can be overridden by env.
  - A GHL Workflow webhook (`/webhooks/ghl/:account?secret=GHL_WEBHOOK_SECRET`) sends ids only. The worker re-reads the opportunity and contact from GHL. `npm run ghl-backfill` queues what's already in the stage.
  - Company = companyName, or else the "Clinic Name" custom field (contact.clinic_name). The exact tag `bsd-lead` → LeadSource "Black Stag".
  - Never send OwnerId (Salesforce routes by State) or Self_Sourced__c, nor NPI, EIN or reseller data.
  - One Lead per GHL contact per sub-account (`salesforce_leads` table). It's created once, never updated.
  - Gated by `LEAD_SYNC_ENABLED`.

## Conventions

- Mapping stays pure and testable. Add a test in `test/plan.test.js` for every mapping change.
- Keep dry-run behaviour: building a plan must never call Salesforce.
- Secrets only come from environment variables. Never commit `.env`.
