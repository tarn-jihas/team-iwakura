# Python runtime

This directory is the complete Python runtime behind the main Reconcile demo.
`npm start` at the repository root launches it: three local processes (a
subscription provider, the sample app "Lumen", and the Reconcile engine), each
with its own SQLite database, plus the browser UI served from
[`../Reconcile/dist`](../Reconcile/README.md).

It needs Python 3.13.13 and uses only the standard library. Every service binds
`127.0.0.1`. In mock mode nothing leaves the machine. In live mode the provider
process reads profiles from the Adapty API (`api.adapty.io`) and never writes to
it; recovery only changes local Lumen state. See the
[root README](../README.md) for the product overview and
[the live setup guide](../docs/LIVE_ADAPTY_DEMO.md) for the connected demo.

The directory name is historical: it began as a mock of an analytics
reconciliation flow. That first mock is still here and still served; see
[Legacy analytics mock](#legacy-analytics-mock).

## How it is started

All commands run from the repository root. Arguments after `--` are passed to
the Python script.

| Command | Runs | Notes |
| --- | --- | --- |
| `npm start` | `recovery_demo.py` | Main demo on port 8875. `--mock` forces synthetic data, `--manual` keeps approval-gated recovery, `--port` and `--runtime` choose the port and state directory. Without `--mock` or `--manual` it switches to the live demo if `runtime/live-adapty/live-config.json` exists. |
| `npm run start:live` | `recovery_live_demo.py` | Live Adapty demo on port 8876. Requires the private live config. |
| `npm run start:legacy` | `reconcile_mock.py serve --port 8765` | Only the legacy analytics and cancellation pages. Run `npm run seed` first. |
| `npm run seed` | `reconcile_mock.py seed`, `paid_access.py seed` | Resets the two legacy JSON state files. |
| `npm run check:access` | `paid_access.py check` | Self-check of the cancellation recovery flow in a temporary directory. |
| `npm run check:offline` | `hackathon_data.py check` | Verifies fixture checksums and scans the offline dataset. |
| `npm run benchmark:sdk` | `benchmark_sdk.py` | Measures the Python SDK against a local collector. |

Example: `npm start -- --mock --port 8875`, then open `http://127.0.0.1:8875`.

## Modules

Launchers and services:

| File | What it is |
| --- | --- |
| `recovery_demo.py` | Launcher for the main demo. Starts the provider, Lumen and engine as child processes of `recovery_service.py`, creates their shared signing key, waits for each health check and stops them all on exit. |
| `recovery_live_demo.py` | Launcher for the same three processes using a live Adapty configuration as the read-only source of entitlements. |
| `recovery_service.py` | The service itself, started once per role (`--role provider`, `lumen` or `engine`). The engine exposes the `/api/recovery/*` API, receives signed SDK events, scans accounts, plans and executes recovery, verifies the result, exports CSV/JSON, and serves the browser UI and the legacy routes. Provider and Lumen expose HMAC-signed `/internal/*` routes; Lumen also exposes the Premium gate (`POST /premium/export`). |
| `recovery_monitor.py` | Builds the incident feed returned by `GET /api/recovery/monitor`: summary, incident list, causes and per-incident timeline. |
| `recovery_domain.py` | SQLite schemas and decision rules for the provider, the Adapty-shaped profile store and Lumen: account pages, the Premium gate decision, resync, clock control and demo fault injection. |
| `recovery_live.py` | Read-only Adapty integration: loads and validates the live config, reads profiles over HTTPS with retry and cooldown handling, and normalises them into entitlements. |
| `recovery_scenarios.py` | Builds the deterministic synthetic 100-account scenario (24 accounts with missing activation, 60 healthy, the rest expired, policy-denied, unknown identity, stale or unavailable) and the manifest describing the offline fixture. |
| `recovery_contracts.py` | Request shapes for Adapty's Stripe and Paddle purchase-validation endpoints, built and checked locally with synthetic references. Makes no network requests. |

SDKs and the sample app:

| File | What it is |
| --- | --- |
| `recovery_sdk.py` | Server SDK used by Lumen in the main demo. Validates, signs and stores events in a durable SQLite outbox, then delivers them to the engine's collector with bounded retries. |
| `collector_sdk.py` | Earlier, simpler SDK used by the cancellation demo. Validates and signs an event and delivers it synchronously; also contains the matching collector-side verification. |
| `lumen_app.py` | In-memory model of the Lumen app for the cancellation demo: subscription projection, cache, the Premium gate, a cancellation handler with a faulty and a fixed version, and resync. |
| `paid_access.py` | Cancellation recovery demo behind `/api/access/*`: detect affected accounts, preview a plan, approve, apply and verify. Also a CLI (`seed`, `check`, `report`). |
| `access_fixtures.py` | Synthetic 100-account population for the cancellation demo, with 24 affected accounts and a separate answer key used only by checks. |

Legacy mock, data and tooling:

| File | What it is |
| --- | --- |
| `reconcile_mock.py` | The original analytics reconciliation mock and its HTTP handler. `recovery_service.py` reuses this handler for static files and the `/api/*` and `/mock/*` routes. |
| `hackathon_data.py` | Verifies the checksums of `fixtures/hackathon`, imports the offline CSV files into a temporary SQLite database and scans every account's subscription lifecycle. |
| `adapty_seed_setup.py` | One-time setup for the live demo. Runs the organisers' pinned seed script against an existing Adapty app through the Adapty CLI, then writes the private live config. This is the only script here that writes to Adapty; no npm script runs it and the mock demo does not need it. |
| `benchmark_sdk.py` | Measures `recovery_sdk.py` enqueue latency, payload size and behaviour during a collector outage, on loopback only. |
| `live_acceptance.py` | Acceptance check against an already running live demo, over public HTTP only. Requires its address: `npm run test:live -- --url http://127.0.0.1:8876`. |
| `automatic_acceptance.py` | Acceptance check of automatic recovery over public HTTP (`npm run test:auto`). Without `--url` it starts its own isolated local fixture. |

## Data directories

| Path | Contents |
| --- | --- |
| `fixtures/hackathon/` | The organisers' synthetic Lumen dataset: `lumen_dataset.json.gz`, `users.csv.gz`, `transactions.csv.gz`. `manifest.json` pins the source revision and a SHA-256 checksum per file; `hackathon_data.py` and the TypeScript provider simulator refuse files that do not match. |
| `reference/` | 20 sample payloads shaped like other providers' APIs (Google Play, Apple, Stripe, Amplitude, AppsFlyer, PostHog and four subscription platforms). The analytics page lists and displays them through `/api/samples` and `/api/sample`. Do not add or remove files here: tests assert the count. Sources are indexed in [`docs/API_SOURCES.md`](docs/API_SOURCES.md). |
| `runtime/` | Generated at run time and ignored by Git: SQLite databases, logs and the signing key for each demo, the legacy JSON state, and the private live config under `runtime/live-adapty/`. Safe to delete when no demo is running, except `runtime/live-adapty/`, which holds the live setup. |
| `_evaluation/` | Generated and ignored by Git: expected-result files written by `seed` for the self-checks. The servers never read them. |

## Tests

| Directory | Scope | Root command |
| --- | --- | --- |
| `tests/` | Unit and focused regression tests for each module. | `npm test` (also runs the browser tests in `Reconcile/tests`) |
| `integration/` | HTTP flows across the three services, started as local processes. | `npm run test:integration` |
| `acceptance/` | Black-box checks using subprocesses and public HTTP only; includes a long stress run. `acceptance/support/` holds its local source fixture and launcher. | `npm run test:acceptance` |

Tests use temporary databases and loopback services. Results and measurements
are recorded in [`docs/VERIFICATION.md`](../docs/VERIFICATION.md).

## Legacy analytics mock

`reconcile_mock.py` is a deterministic, stateful mock of a different problem:
revenue events in the subscription provider that are missing, duplicated or
wrong in an analytics destination (modelled on Adapty and Mixpanel). It contacts
no external service; the provider-style routes under `/mock/` are local.

It is reachable in two ways:

- inside the main demo at `/analytics.html`, with its state kept under the
  demo's runtime directory;
- on its own with `npm run seed && npm run start:legacy`, at
  `http://127.0.0.1:8765`.

Command line, from this directory:

```sh
python3 reconcile_mock.py seed     # write the starting state
python3 reconcile_mock.py report   # print the current findings
python3 reconcile_mock.py check    # reseed, run the whole flow, assert the results
```

`seed` overwrites only `runtime/state.json` and `_evaluation/oracle.json`.
`check` leaves the final state behind; run `seed` again to restore the start.

### Scenario

The seed uses run ID `mock-run-20261107`, a fixed clock, app `mock-lumen` and
deterministic event IDs.

| User | Situation | Finding |
| --- | --- | --- |
| `u00001` | USD purchase 9.99 missing from analytics | `MISSING_IN_MIXPANEL` |
| `u00002` | USD refund 6.99 missing; purchase present | `MISSING_IN_MIXPANEL` |
| `u00003` | USD purchase 12.99 recorded twice with different insert IDs | `DUPLICATE_IN_MIXPANEL` |
| `u00004` | EUR 9.99 recorded as 999.00 | `PRICE_MISMATCH` |
| `u00005` | EUR 14.99 recorded under the unknown event name `premium_paid_v2` | `UNMAPPED_EVENT_NAME` |
| `u00006`, `u00007` | Matching USD and EUR records | none |
| `u00008` | Sandbox purchase, absent from production analytics | `SANDBOX_EXPECTED`, no repair |
| `u00009` | USD 11.98 purchase present only in analytics | `EXTRA_IN_MIXPANEL`, manual investigation |

The gap is reported per currency as destination minus source. It starts at
`{"USD":"21.97","EUR":"989.01"}` with six finding groups and seven findings.

The flow is: approve the three repairable groups, map `premium_paid_v2` to
`purchase`, apply, advance the mock clock one tick, verify. Apply produces four
writes (the missing group has two findings). Price and duplicate fixes are
separate signed `reconcile_correction` events; original events are never
changed. New writes become visible only after the clock advances, so the report
is unchanged immediately after apply. Afterwards the gap is
`{"USD":"11.98","EUR":"0.00"}`: only the extra and sandbox findings remain.
Applying again writes nothing.

### Routes

| Route | Purpose |
| --- | --- |
| `GET /api/report`, `GET /api/preview` | Current findings by group; the repair plan with expected effects. |
| `POST /api/detect`, `POST /api/verify` | Re-run detection (and read back applied actions) and record the run in history. |
| `POST /api/approve`, `POST /api/apply` | Approval is a separate, required step. Apply re-runs detection, rejects stale approvals and writes only outstanding approved findings. |
| `POST /api/map`, `POST /api/reset-mappings` | Set or reset the event-name mapping. |
| `POST /api/advance-clock` | Advance the mock clock so pending writes become visible. |
| `GET /api/verify`, `GET /api/evidence?txn=…`, `GET /api/audit` | Read-back status, raw records for one transaction, approvals and action records. |
| `GET /api/manifest`, `GET /api/history`, `GET /api/operations` | Scenario description, the last 20 recorded runs, per-transaction status. |
| `GET /api/samples`, `GET /api/sample?path=…` | List and read the files in `reference/`. |
| `POST /api/reset` | Reseed the scenario. |
| `GET /mock/adapty/api/v2/server-side-api/profile/?customer_user_id=…` | Synthetic profile. It has no per-transaction prices. |
| `GET /mock/adapty/events/export` | Synthetic source events, one JSON object per line. This is the price ledger the mock compares against. |
| `GET /mock/mixpanel/api/2.0/export`, `GET /mock/mixpanel/query` | Visible destination events; effective totals including corrections. |
| `POST /mock/mixpanel/import?region=eu` | Stores events, visible one tick later. With `region=us` the request succeeds but stores nothing, to model delivery to the wrong region. |

Write requests must be JSON, at most 1 MiB, and come from the same loopback
origin. The same handler also serves the cancellation demo routes
(`/api/access/*`, `/api/collector/events`, `/mock/lumen/export`) from
`paid_access.py`.

The mock models field names and the behaviour needed for this scenario. It does
not reproduce the real services' rate limits, permissions or query semantics.
