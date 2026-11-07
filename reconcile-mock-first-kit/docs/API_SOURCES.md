# Verified provider schemas and official examples (7 November 2026)

This index is **documentation-only**. The mock harness never makes third-party API requests, and each provider-shaped reference file is an authored **synthetic, partial projection**, not a downloaded receipt or complete contract test. All runtime connections are forbidden except `127.0.0.1`.

| Provider/API | Official source with example/schema | Important fields and mock rule |
| --- | --- | --- |
| Adapty S2S Get profile | https://adapty.io/docs/api-adapty/operations/getProfile | `GET /api/v2/server-side-api/profile/`, `data` envelope with `subscriptions`, `access_levels`, `total_revenue_usd`; **does not expose a row-by-row price ledger**. Local GET mock. |
| Adapty Set transaction | https://adapty.io/docs/api-adapty/operations/setTransaction | `POST /api/v2/server-side-api/purchase/set/transaction/`; `purchase_type`, store IDs, `price.country/currency/value`, expiry; the organiser's script is NOT called. |
| Adapty webhook examples | https://adapty.io/docs/webhook-event-types-and-fields | `event_type`, `event_datetime`, `event_properties.transaction_id`, `profile_event_id`, `price_local`, `price_usd`, `environment`, `original_transaction_id`. Local webhook-shape JSONL used as authoritative synthetic ledger. |
| Adapty to Mixpanel event mapping | https://adapty.io/docs/mixpanel | `event`, `properties.time`, `$insert_id`, `currency`, `store`, `environment`, `original_transaction_id`. EU project needs Europe residency. Mock uses local event store. |
| Adapty Developer CLI reference | https://adapty.io/docs/developer-cli-reference | CLI config and analytics commands are not an app-wide transaction enumeration API. No CLI command executed. |
| Adapty S3 exports | https://adapty.io/docs/s3-exports | Daily CSV exports; mock may model a file drop, but no S3 used. |
| Adapty analytics FX conventions | https://adapty.io/docs/analytics-integration | Currencylayer, refreshed every eight hours, conversion fixed at transaction time. Mock stores synthetic local and USD side by side; it does not call FX API. |
| Mixpanel Import Events (examples and responses) | https://docs.mixpanel.com/reference/import-events | `POST /import?strict=1&project_id=...` with event array, `distinct_id`, `time`, `$insert_id`; **partial validation failures can still ingest valid rows**. Mock uses local endpoint. |
| Mixpanel Raw Event Export (JSONL example) | https://docs.mixpanel.com/reference/raw-event-export | `GET /api/2.0/export?from_date=...&to_date=...`; JSONL, not JSON array; date ranges inclusive. Mock local export; project date policies documented. |
| Mixpanel Dedup + compaction | https://docs.mixpanel.com/reference/event-deduplication | Four-tuple `event, distinct_id, time, $insert_id` at query time. Official docs say **most recent** event in reports but do not guarantee upsert; raw export can preserve duplicates. Teammate's 'first event' observation does not trump docs. Mock policy explicit `query_latest`. |
| Mixpanel Track Events | https://docs.mixpanel.com/reference/track-event | `/track` is distinct from historical `/import`. Not needed for P0. |
| Google Play Orders GET | https://developers.google.com/android-publisher/api-ref/rest/v3/orders/get | Known `packageName/orderId`; `Money.units` string + `nanos`. No Google API accessed. |
| Google Play Orders batchget | https://developers.google.com/android-publisher/api-ref/rest/v3/orders/batchget | 1–1,000 known order IDs, not `orders.list`. |
| Google Play Money | https://developers.google.com/android-publisher/api-ref/rest/v3/Money | `{currencyCode,units,nanos}` exact decimal handling. |
| Google Play subscriptions v2 GET | https://developers.google.com/android-publisher/api-ref/rest/v3/purchases.subscriptionsv2/get | `lineItems.latestSuccessfulOrderId`, `expiryTime`, `testPurchase`; purchase token is not a single renewal order ID. |
| Google Play RTDN Pub/Sub notification | https://developer.android.com/google/play/billing/rtdn-reference | base64 `message.data`, decoded `subscriptionNotification`; requires follow-up read for full state. |
| Google Play Earnings and Estimated sales CSV | https://support.google.com/googleplay/android-developer/answer/6135870?hl=en | Earnings includes Charge, Charge refund, Google fee, Tax, buyer/merchant currency and FX; month/report basis differs. Offline files only. |
| Apple Get Transaction Info | https://developer.apple.com/documentation/appstoreserverapi/get-transaction-info | `GET /inApps/v1/transactions/{transactionId}`, signed transaction info; our decoded JSON is unsigned synthetic subset. |
| Apple JWS transaction fields | https://developer.apple.com/documentation/appstoreserverapi/jwstransactiondecodedpayload | `transactionId`, `originalTransactionId`, `appAccountToken`, `purchaseDate` ms, `price` in milliunits; not financial-report authority. |
| Apple Transaction History | https://developer.apple.com/documentation/appstoreserverapi/get-transaction-history | Known transaction cursor, not public all-users list. |
| Apple finance reports API | https://developer.apple.com/documentation/appstoreconnectapi/get-v1-financereports | `GET /v1/financeReports`, required report filters; gzip finance TSV. Apple API docs are JS rendered; check live SDK schemas before production integrations. |
| Apple Financial report fields | https://developer.apple.com/help/app-store-connect/reference/reporting/financial-report-fields/ | `Quantity`, `Partner Share`, `Extended Partner Share`, `Customer Price`, fiscal basis; aggregate no per-user transaction ID. |
| Apple finance report download guide | https://developer.apple.com/help/app-store-connect/getting-paid/download-financial-reports | GZIP TSV, fiscal month, proceeds. Reference-only fixture. |
| Stripe Charge schema | https://docs.stripe.com/api/charges/object | `amount` minor units, `amount_refunded` snapshot, `balance_transaction` link, `livemode`, timestamps seconds. |
| Stripe Refund schema | https://docs.stripe.com/api/refunds/object | Positive refund `amount` minor units, linked charge and balance transaction; signed canonical ledger must subtract it once. |
| Stripe Balance transaction schema | https://docs.stripe.com/api/balance_transactions/object | `amount`, `fee`, `net`, currency, `exchange_rate`; `net = amount-fee`, zero-decimal currency handling. |
| Stripe zero-decimal currencies | https://docs.stripe.com/currencies | Do not assume every integer amount is cents. |
| Amplitude HTTP V2 API | https://www.amplitude.com/docs/apis/analytics/http-v2 | `POST /2/httpapi`, `api_key`, `events`, `user_id/device_id`, `event_type`, `time` ms, `insert_id`. EU host differs. |
| Amplitude HTTP quickstart (payload example) | https://amplitude.com/docs/apis/analytics/http-api-quickstart | Simple JSON request, EU endpoint sample. |
| Amplitude Export API (sample) | https://amplitude.com/docs/apis/analytics/export | `GET /api/2/export?start=YYYYMMDDTHH&end=...`; ZIP JSONL, window is server upload time. |
| AppsFlyer S2S Events API | https://dev.appsflyer.com/hc/reference/s2s-events-api3-overview | `POST /inappevent/{app_id}`; `appsflyer_id`, `eventName`, `eventTime`, `eventValue` object/string; `af_revenue` decimal. Wrong iOS app ID can still 200. |
| AppsFlyer In-App Events report v5 | https://dev.appsflyer.com/hc/reference/get_app-id-in-app-events-report-v5 | CSV raw-data endpoint and timezone/currency filters. |
| Adapty AppsFlyer mapping | https://adapty.io/docs/appsflyer | Provider-specific transaction/revenue mapping and delivery caveats. |
| PostHog Capture examples | https://posthog.com/docs/api/capture | `POST /i/v0/e`, `api_key`, `distinct_id`, `event`, `properties`, ISO timestamp, US/EU host. |
| PostHog Query docs | https://posthog.com/docs/api/queries | Ad hoc read, **not supported for bulk/recurring third-party exports**. |
| PostHog S3 Batch Export | https://posthog.com/docs/data-pipelines/batch-exports/s3 | JSONL or Parquet, batch export with added schema fields possible. |
| RevenueCat webhook fields | https://www.revenuecat.com/docs/integrations/webhooks/event-types-and-fields | `event.type`, `event.id`, `transaction_id`, ms, USD/local price, store/environment. |
| RevenueCat full sample payloads | https://www.revenuecat.com/docs/integrations/webhooks/sample-events | Initial purchase, renewal, cancellation, etc. Our reference JSON is an authored subset. |
| Superwall V2 webhook, schema and examples | https://superwall.com/docs/integrations/webhooks/v2 | Distinguish immutable `event_data` from `subscription` snapshot, price/proceeds/currency. |
| Apphud S2S Webhook with example | https://docs.apphud.com/docs/webhook | `app`, `event`, `user`, event `receipt`, nested price/proceeds; `X-Apphud-Token` optional. |
| Qonversion Webhooks with body example | https://documentation.qonversion.io/docs/webhooks | `event_name`, `user_id`, `revenue.is_proceed`, `proceeds_rate`, `transaction.transaction_id`, epoch seconds. |

## Local mapping conventions

- Only the first three provider families (**Adapty**, **Mixpanel**, our **Reconcile** service) are **active stateful local API mocks** in `reconcile_mock.py`.
- Google, Apple, Stripe, Amplitude, AppsFlyer, PostHog, RevenueCat, Superwall, Apphud and Qonversion are **reference payloads** in `reference/`. They document future parser contracts but are **not** active server adapters and should not be shown as if they were.
- For provider samples, preserve original field names inside provider-shaped JSON. `manifest`/`metadata` annotate our fixture provenance separately; never inject fake `is_mock` keys into provider payloads and call the result native.
- Distinguish `store_transaction_id` (Adapty S2S), `event_properties.transaction_id` (Adapty webhook), Google `orderId`, Apple `transactionId`, Stripe `ch_*`, Mixpanel `$insert_id` (delivery dedup identity), and `original_transaction_id` (subscription chain). Do not alias these without explicit mapping.
- `profile.total_revenue_usd` is an aggregate. It is **not** a transaction-level price authority; the mock event log is the synthetic source ledger.
- Keep purchase/refund and delivery identities different; a repeated HTTP request is not necessarily a duplicate economic event.
- Dollar and euro aggregates remain separate in P0. No invented FX conversion of the headline `+21.97 USD / +989.01 EUR`.
- We do **not** call any real provider or service from the mock code; full local read/write roundtrip is at `127.0.0.1:8765` only.
