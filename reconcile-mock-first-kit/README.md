# Reconcile: FULL MOCK FIRST seed and replay

**No Adapty, Mixpanel, Apple, Google Play, Stripe, Amplitude, AppsFlyer, PostHog, RevenueCat, Superwall, Apphud or Qonversion service is contacted, even in test or sandbox.** Zero third-party credentials required. Python 3.9+ standard library only. Optional HTTP binds `127.0.0.1` and uses native-looking mock paths, never provider domains.

This package is a standalone proof-of-behaviour and mock data source for the Reconcile website UI. It **does not modify the supplied static website** and it does not claim that Vuk's unshared `flow.py` or existing browser UI has been integrated. The mock contract can be used by an agent wiring the UI.

## Exact fast-start

```sh
cd reconcile-mock-first-kit
python3 reconcile_mock.py seed
python3 reconcile_mock.py report
python3 reconcile_mock.py check
```

`check` starts a clean seed, tests the entire flow, and leaves the final mock state. Run `python3 reconcile_mock.py seed` again to restore the before state.

To run the stateful **mock** API for the UI:

```sh
python3 reconcile_mock.py seed
python3 reconcile_mock.py serve --port 8765
# Open a second terminal; every URL below is 127.0.0.1, no remote service:
curl -sS 'http://127.0.0.1:8765/api/report?run=mock-run-20261107'
curl -sS 'http://127.0.0.1:8765/api/preview'
curl -sS -H 'Content-Type: application/json' -d '{"run":"mock-run-20261107","ids":["MISSING_IN_MIXPANEL","PRICE_MISMATCH","DUPLICATE_IN_MIXPANEL"],"actor":"demo-operator"}' 'http://127.0.0.1:8765/api/approve'
curl -sS -H 'Content-Type: application/json' -d '{"event":"premium_paid_v2","cls":"purchase","actor":"demo-operator"}' 'http://127.0.0.1:8765/api/map'
curl -sS -H 'Content-Type: application/json' -d '{"run":"mock-run-20261107","ids":["MISSING_IN_MIXPANEL","PRICE_MISMATCH","DUPLICATE_IN_MIXPANEL"]}' 'http://127.0.0.1:8765/api/apply'
# The mock export deliberately lags one deterministic tick:
curl -sS -H 'Content-Type: application/json' -d '{"ticks":1}' 'http://127.0.0.1:8765/api/advance-clock'
curl -sS 'http://127.0.0.1:8765/api/verify'
curl -sS 'http://127.0.0.1:8765/api/audit'
```

The GET `/api/report` JSON contains groups and findings, `delta` as decimal strings, evidence, group hashes and per-currency gap. `POST /api/approve` is a **separate required step** before `POST /api/apply`. The server re-runs detection, checks the stored approval hash, creates an event only for outstanding approved findings, and records a receipt. `GET /api/verify` reads the resulting mock destination after `POST /api/advance-clock`. A repeated `apply` is a no-op.

**No API URL from `docs/API_SOURCES.md` should ever be pasted into runnable code in this mock environment.** That file is a documentation index.

## Deterministic seed and expected findings

The command `python3 reconcile_mock.py seed` overwrites only `runtime/state.json` and `_evaluation/oracle.json` under this unpacked package. No internet, API key, .env or external subprocess is involved. It uses run ID `mock-run-20261107`, fixed UTC `2026-11-07T09:00:00Z`, synthetic app `mock-lumen`, synthetic EU project `mock-mixpanel-eu` and predictable `uuid5` event IDs. The server **never reads the `_evaluation` oracle**. It operates on the state and raw events only.

- `u00001` missing USD purchase `+9.99`: source positive, destination absent -> gap contribution **-9.99 USD**.
- `u00002` missing USD full refund `-6.99`: source has purchase and refund; destination only purchase -> **+6.99 USD**.
- `u00003` duplicate USD `+12.99`: destination has two **distinct** `$insert_id`s -> **+12.99 USD**.
- `u00004` wrong EUR price: source `9.99 EUR`, destination `999 EUR` -> **+989.01 EUR**.
- `u00005` renamed purchase: source `14.99 EUR`, destination `premium_paid_v2`; unknown mapping -> **UNMAPPED_EVENT_NAME**, no missing backfill.
- `u00006/u00007` healthy USD/EUR controls, no findings.
- `u00008` source Sandbox purchase `4.99 USD`, deliberately absent from production analytics -> **SANDBOX_EXPECTED**, no repair.
- `u00009` ghost purchase `11.98 USD` only in destination -> **EXTRA_IN_MIXPANEL**, manual investigation only.

**Before:** `gap = {"USD":"21.97", "EUR":"989.01"}`, six finding groups, seven individual findings. Source total/destination total are separate by currency. Here `gap = destination - source` under our explicit revenue definition.

**Actions:** approve 3 write groups (`MISSING_IN_MIXPANEL`, `PRICE_MISMATCH`, `DUPLICATE_IN_MIXPANEL`) plus accept one local mapping (`premium_paid_v2 -> purchase`). These produce **4 synthetic destination writes** because MISSING has two individual findings. PRICE and DUPLICATE each add a **separate signed** `reconcile_correction`; neither mutates the original event. Both corrections are included in the **explicit mock effective revenue metric**. Mapping does not write a provider event.

**Immediately after accepted import:** the report is unchanged (mock destination visibility delay). After advancing one mock tick: **`gap = {"USD":"11.98", "EUR":"0.00"}`**. Only ghost (unresolved) and sandbox (expected) remain. A second `POST /api/apply` has zero writes. To restart the demonstration, run `seed` again.

## Local API routes (all mocks)

| Local route | Purpose | What it resembles |
| --- | --- | --- |
| `GET /mock/adapty/api/v2/server-side-api/profile/?customer_user_id=u00004` | Current synthetic profile/entitlement, **not per-transaction price** | Adapty S2S GET profile |
| `GET /mock/adapty/events/export` | Newline-delimited synthetic webhook events, the true local price ledger | Adapty webhook/S3 event projection |
| `GET /mock/mixpanel/api/2.0/export` | Synthetic raw destination JSONL, including physical duplicates | Mixpanel raw export |
| `POST /mock/mixpanel/import?region=eu` | Stores synthetic event array, visible one tick later | Mixpanel import API |
| `POST /mock/mixpanel/import?region=us` | Artificial transport 200 but zero persistence, **negative test** | Model of wrong-residency delivery |
| `GET /mock/mixpanel/query` | Our explicit effective metric, including signed correction events | Hypothetical Mixpanel query/dashboard contract |
| `GET /api/report?run=mock-run-20261107` | Deterministic scan/group, no change | Vuk-style report |
| `GET /api/preview` | Existing finding plan and expected signed effects | Read-only repair preview |
| `POST /api/approve` | Human selection with group hash and actor | Human approval |
| `POST /api/apply` | Revalidate approval, append permitted synthetic fixes | Limited repair |
| `POST /api/map` | Apply event-name mapping as approved local config | Renamed-event resolution |
| `POST /api/reset-mappings` | Reset local event-name rules | Demo control |
| `POST /api/advance-clock` | Advance simulated ingest visibility | Deterministic time control |
| `GET /api/verify` | Read report after simulated ingestion | Post-fix verification |
| `GET /api/evidence?txn=txn_price` | Raw source, destination, corrections for a transaction | Evidence drawer |
| `GET /api/audit` | Approval records, immutable action hashes and payloads | Case audit receipt |
| `GET /api/manifest` | Source mode, fixed time, store, tenancy, currency rules | Provenance |

The importer deliberately has a simplified, documented contract. It models the field names and the needed behaviour rather than pretending to implement every rate limit, internal queuing condition, project permission or transport status of real Mixpanel.

## Two different notions of correct data

1. **Per-transaction reconciliation:** join by transaction ID **and event class**, compare normalized signed amounts per currency. Renamed events found under a known transaction suppress false missing findings.
2. **Effective destination metric:** query-time-deduped stored events **plus** an explicitly configured `reconcile_correction` event; raw source events are never rewritten. Adding a correction to Mixpanel does **not** automatically adjust every existing dashboard or its built-in revenue metric. A real implementation would require a dashboard/query definition. The mock's `/mock/mixpanel/query` models that explicit definition; it does not claim to reproduce every Mixpanel query semantics.

Native-looking fields retain provider naming. Synthetic `price_local` is deliberately stored as decimal **strings** on Mixpanel events and as numeric JSON floats on Adapty webhook projections. All calculations use `Decimal`; currency-specific minor-unit rules are out of scope of the six-class main loop and treated separately in `reference/stripe`, `reference/google` and `docs/API_SOURCES.md`.

## Other mock providers, not active adapters

The `reference/` tree contains **20 synthetic examples** for Google Play (order, subscription, RTDN, fractional Money), Apple (decoded unsigned JWS and financial TSV), Stripe (charge/refund/balance), Amplitude (HTTP V2/export), AppsFlyer (S2S/CSV), PostHog (capture/S3), and RevenueCat/Superwall/Apphud/Qonversion webhook formats. These are static **reference fixtures**, *not* wire-tested provider emulators and not part of the six-class detect/apply loop.

For the **937-order revenue bridge** with FX/refund/time waterfall and 71 checks, use the separate `reconcile-revenue-bridge-pack.zip` from the project Library. It is fully offline and remains a secondary demo, not a real Google Play import.

For the organisers' Lumen dataset, use their `data/offline/*.csv.gz` or `data/lumen_dataset.json.gz` **as read-only source fixtures** and persist the chosen sample IDs. Do **not** run `python3 seed_adapty.py` or any `adapty auth`/S2S commands for mock mode, since those really write to Adapty. Their README explicitly says fake store product IDs, timestamp shifting at replay, and a separate `lumen_<run>_...` generated customer-ID scheme. Do not confuse offline `seq` with store order ID.

## Validation and handoff

Run `python3 reconcile_mock.py check`. It checks starting gaps, six classes/seven findings, three approved groups/four writes, local mapping, invisibility before tick, exact remaining ghost after tick, repeat no-op. It can run without internet.

`docs/API_SOURCES.md` contains official references and where provider examples come from. The browser UI `Reconcile-komplet.zip` is **not wired to this kit yet**; to integrate it, use the mock `/api/*` endpoints instead of any provider or Vuk live endpoint, and label every screen `FULL MOCK / SYNTHETIC DATA`. Future live integration can swap adapters after the hackathon, but no mode switch is implemented here.
