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

- an **Account** upserted on `Provider_ID__c` with Name (set on create only), `Shopify_ID__c` (the Shopify customer id), phone, `Primary_Email__c` and billing address, and
- a **Contact** on that Account, matched on Account + Email.

**Alpha BioMed Status** (`ABM_Status__c`) is **Prospect** for a customer with no Shopify orders and **Active** once they have one. It's set when the Account is created. Later it's updated only if no Alpha BioMed Owner is assigned, and only forward: it never goes back from Active, and a rep's Lapsed is kept until a new order arrives.

An **order** (when `ORDER_SYNC_ENABLED=true`) syncs its customer the same way, then becomes a **Provider Order** with one **Order Product** per line:

| Provider Order field | From Shopify |
|---|---|
| `Line_of_Business__c` | `Alpha BioMed` |
| `Order_Amount__c` | current total (tax and shipping included, after edits and refunds); `0` once cancelled |
| `Order_Date__c` | order date (store time zone) |
| `Order_Type__c` | `New` for the customer's first order, `Reorder` after |
| `Paid__c` | paid, partially refunded or refunded |
| `Account__c` | the practice, or blank (unlinked) when the customer has no Provider ID; linked automatically later |

| Order Product field | From Shopify |
|---|---|
| `Quantity__c` | current quantity. Lines at 0 are deleted. |
| `Unit_Price__c` | unit price after that line's discounts |
| `Product_Name__c` | product title, plus the variant |

Neither object has an external ID, so the `salesforce_orders` table remembers which Salesforce records each Shopify order became. Re-sent orders are updated, not duplicated. An order cancelled before it was ever synced is skipped.

The service never sends:

- Salesforce-maintained fields (revenue, order counts, order dates on Account; Total Price on lines)
- `AlphaSync_Status__c`, `ABM_Owner__c`, `Sync_Owner__c`, `OwnerId`, or any AlphaSync data
- `Fulfilment_Status__c` (DO NOT SEND), `Order_For__c`, `Product_Category__c` (no source in Shopify yet)

## GHL leads → Salesforce Lead

Open opportunities in a GoHighLevel lead stage become Salesforce **Leads**. This runs when `LEAD_SYNC_ENABLED=true`, and follows `SALESFORCE_MODE` like everything else.

| Sub-account | Pipeline / stage | Line of Business |
|---|---|---|
| Alpha BioMed | 1. Providers (RK) / New Providers | Alpha BioMed |
| Alpha Sync | Alpha Sync / New Leads | AlphaSync |

- **Webhook:** a GHL Workflow (trigger: opportunity enters the stage; action: Webhook) POSTs to `/webhooks/ghl/abm?secret=<GHL_WEBHOOK_SECRET>` (or `/sync`). Add custom data `contact_id` = `{{contact.id}}` and `opportunity_id` = `{{opportunity.id}}`. The app re-reads both records from GHL, and only sends opportunities that are still **open** in that stage.
- **Existing leads:** `npm run ghl-backfill -- --account=abm` (or `sync`).
- **Fields:**
  - Name, email, phone, address, website, title and suffix
  - Company = company name, or else the "Clinic Name" custom field
  - `Line_of_Business__c` as in the table above
  - `Entered_Salesforce__c` = when the opportunity was created in GHL
  - Contacts tagged exactly `bsd-lead` get `LeadSource = Black Stag`, so they're round-robined
- **Owner:** Salesforce assigns it by State, and the app never sends one.
- **No duplicates:** one Lead per GHL contact per sub-account. It's created once, then left to the sales team.

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

## Provider ID and open items

- **Provider ID** is the practice's GHL contact ID, stored in the Shopify customer metafield `custom.provider_id` (`PROVIDER_ID_STRATEGY=customer_metafield`, `PROVIDER_ID_METAFIELD=custom.provider_id`). Customers without one are blocked; their orders go out unlinked. Check with `npm run check-provider-ids`.
- **Product Category:** Shopify has no source for the Salesforce category names, so it's left blank, and "Most Recent Category" on the provider stays empty.
- **Returns:** none are sent separately. Refunds lower `Order_Amount__c`, because it's the current total. The workbook says the Return sign isn't agreed yet.

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
npm run backfill -- --orders --since=2026-01-01 --limit=100
npm run requeue -- --ids=12,13             # replay specific events
npm run requeue -- --status=synced --latest  # re-send the newest event per customer/order (e.g. to fill in a new field)
npm run check-provider-ids                 # who has a Provider ID, issues, and latest sync status
npm run report-duplicates                  # explain DUPLICATES_DETECTED failures
npm run ghl-explore -- --account=abm       # GHL pipelines, stage counts, field inventory (read-only)
npm run ghl-backfill -- --account=abm      # queue the open opportunities already in the lead stage
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
