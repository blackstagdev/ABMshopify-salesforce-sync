# Shopify → Salesforce sync

Pushes customers and orders from the **alphabiomedlabs.com** Shopify store into Alpha BioMed's Salesforce org, following the rules in the Salesforce field reference workbook (Lead, Account, Contact; extracted 18 Sep 2026).

## How it works

```
Shopify ──webhook──▶ POST /webhooks/shopify ──▶ Postgres (shopify_events) ──▶ worker ──▶ Salesforce REST API
          (signed)     verify HMAC, store, 200      one row per event          map + send
```

1. Shopify sends a webhook for `customers/create`, `customers/update`, `orders/create` and `orders/updated`.
2. The service checks the HMAC signature, stores the raw event and replies `200` immediately.
3. A worker in the same process picks up stored events in order, builds a **plan** (the Salesforce operations to run) and either records it (`dry_run`) or runs it (`live`).

A customer becomes:

- an **Account** upserted on `Provider_ID__c` with Name (set on create only), phone, `Primary_Email__c` and billing address, and
- a **Contact** on that Account, matched on Account + Email.

An order syncs its customer the same way. The order itself is only previewed until `Provider_Order__c` is mapped.

The service never sends:

- Salesforce-maintained fields (revenue, order counts, order dates)
- guarded status and owner fields (`ABM_Status__c`, `AlphaSync_Status__c`, `ABM_Owner__c`, `Sync_Owner__c`)
- `OwnerId`

## Event statuses

| Status | Meaning |
|---|---|
| `pending` | Waiting for the worker, or waiting for a retry |
| `dry_run` | Plan built and stored in `result`; nothing sent (`SALESFORCE_MODE=dry_run`) |
| `synced` | Sent to Salesforce; `result.outcome` has the record Ids |
| `blocked` | Needs a decision or config change (see `last_error`); not retried |
| `failed` | Salesforce rejected it (4xx) or it ran out of retries |
| `ignored` | Topic not synced |

Salesforce 429 and 5xx errors and network errors are retried with backoff (30 s doubling to 1 h, up to `WORKER_MAX_ATTEMPTS`).

## Open decisions (blocking live sync)

1. **Provider ID rule.** How a Shopify customer gets its `Provider_ID__c`. The field reference says this is undecided, so `PROVIDER_ID_STRATEGY=none` blocks every event instead of guessing. The alternatives, `customer_tag` (a tag like `provider:ABM-00123`) and `shopify_customer_id`, must be agreed with the Salesforce team first.
2. **`Provider_Order__c` fields.** These aren't in the workbook. Once they are, implement `upsertOrder` in [src/salesforce/executor.js](src/salesforce/executor.js) and set `ORDER_SYNC_ENABLED=true`.
3. **Lead or Account?** The service creates Accounts and Contacts, not Leads. Confirm that this is what the Salesforce team wants for Shopify customers.
4. **Integration user.** It needs a dedicated user and Connected App (client credentials flow), not a person's login.

## Configuration

All settings are environment variables; see [.env.example](.env.example).

## Commands

```bash
npm install
npm test                                   # unit tests, no network or database
npm start                                  # needs DATABASE_URL
npm run register-webhooks                  # subscribe the Shopify app to the topics
npm run register-webhooks -- --list        # show current subscriptions
npm run backfill -- --customers            # queue existing customers
npm run backfill -- --orders --since=2026-01-01
npm run requeue -- --status=dry_run        # replay after switching to live
npm run sf-describe                        # print Provider_Order__c and other order objects' fields
npm run sf-describe -- Account --json      # any object, as JSON
npm run sf-describe -- --list              # every custom object in the org
```

## Admin endpoints

These are enabled when `ADMIN_TOKEN` is set. Send `Authorization: Bearer <ADMIN_TOKEN>` with every request.

- `GET /admin/stats`: event counts by status
- `GET /admin/events?status=blocked&limit=50`: recent events
- `GET /admin/events/:id`: one event, with its payload and plan
- `POST /admin/requeue` with `{"status":"blocked"}` or `{"ids":[1,2]}`: replay events

## Deploying

The service runs on Render using [render.yaml](render.yaml): a Starter web service plus a Postgres database that accepts internal connections only.
