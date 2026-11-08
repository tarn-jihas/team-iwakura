# Reconcile

**Connect an Adapty entitlement to verified Premium access in the application.**

Reconcile is an Adapty hackathon prototype for subscriptions that are recorded
but not fulfilled by the application's backend. It compares source entitlements
with application state, finds missing or stale access, resyncs supported existing
rights, and checks the same authorization decision as the Premium endpoint.

The local **Lumen** application demonstrates processing, projection and cache
failures. Reconcile shows what happened, affected accounts, recovery steps and
the verified result. Export incident activity as CSV or JSON for a UTC period.

## Quick start — complete hackathon demo

Requires **Git, Node.js 22.22.3/npm and Python 3.13.13**. The Python runtime uses
only its standard library. No credentials, database installation, AI key or
dependency installation is needed for this mode.

```sh
git clone https://github.com/tarn-jihas/team-iwakura.git reconcile
cd reconcile
npm start -- --mock --port 8875
```

Open **[http://127.0.0.1:8875](http://127.0.0.1:8875)** and click **Run once**. A real
local gate denial sends a signed SDK event. The engine checks 100 accounts,
confirms 24 activation discrepancies, automatically repairs supported rights,
and verifies all 24 gates after one bounded retry. Six inconclusive accounts
remain excluded. Open an incident for the steps, or download CSV/JSON.

In automatic mock mode, synthetic demo traffic starts while the monitor is open.
It requests another scenario about every six seconds once the previous recovery
settles. **Stop demo traffic** pauses new scenarios; **Run once** requests one
scenario. Traffic pauses in hidden tabs and while browsing filters or history.
**Observed access updates** shows current synthetic source rights, application
state and gate results; these observations do not establish real charges.

Each Run preserves incident history. **Needs attention** keeps unsuccessful
verification visible; filters and pagination reach older incidents. Ctrl+C
stops all three child services. Provider, Lumen and engine use separate SQLite
databases. Reusing a runtime preserves its state; use a new directory and a free
port for an isolated presentation:

```sh
npm start -- --mock --port 0 --runtime /tmp/reconcile-demo-example
```

`--mock` explicitly selects synthetic evidence. Without it, `npm start` selects
the private live Adapty configuration when available. Neither mode creates a
real charge. Original hackathon scripts, seeders and existing databases are
preserved; no Adapty reseed is required to run or reset this demo.

## Connected Adapty demo

The [live setup guide](docs/LIVE_ADAPTY_DEMO.md) uses the existing private
configuration and authenticated Adapty CLI. The API reads 100 known seeded
profiles; the CLI inspects the catalog. Local handler replay succeeds for 76
accounts and fails for 24. Reconcile detects those failures proactively,
verifies 23 recovered gates, and leaves one unresolved. Later healthy-account
incidents can recover while that unresolved incident stays visible.

This is a prototype add-on, not an officially supported CLI plugin. Adapty
reads are real; seed purchases are synthetic. Recovery writes only to local
Lumen state, without charging, refunding or granting external licences.

## TypeScript / Preact runtime

The npm workspace contains the modular-monolith engine, independent Lumen and
provider processes, Preact frontend, contracts and TypeScript server SDK.

```sh
npm ci
npm run build:ts
npm run start:ts
```

Open **[http://127.0.0.1:8768](http://127.0.0.1:8768)**, wait for source readiness,
then use **Run once**. The 100-account acceptance scenario verifies 23 gates and
keeps one unresolved. **Run continuously** and **Stop simulation** control local
fault injection. `ENGINE_PORT=0 npm run start:ts` chooses a free port. Each launch
creates fresh isolated state under `runtime/typescript/demo-*`.

**Migration status:** the main automatic flow, analytics, cancellation and
browser fixture lab run in TypeScript. The advanced activation API and complete
blast-radius parity remain incomplete; `/recovery-console.html` returns an
explicit unsupported result in this runtime. Use the Python mode for that flow.
Node 22's built-in `node:sqlite` is synchronous and experimental; the engine uses
a worker boundary, while SDK enqueue latency must be measured by integrators.

The [TypeScript SDK](packages/server-sdk/README.md) is the intended successor to
the retained Python SDK, with a breaking consumer migration. Its built-in HTTP
transport currently supports loopback collectors. A native mobile SDK is not
included; the mobile integration is a contract and simulator.

## How it works

**Observe → Compare → Authorize → Resync → Verify → Report**

- The SDK transports signed, bounded observations through a durable outbox.
  Application events cannot establish payment or authorize repair.
- The engine checks source rights, identity and current application state,
  records immutable evidence and authorizes an exact plan under a bounded policy.
- Lumen checks identity, policy and projection revisions before committing.
  Recovery requires readback and a fresh gate probe; a timeout stays unknown
  until its outcome can be established.

Current profiles and the known-account registry are not a complete payment
ledger. A gate proves backend authorization, not mobile UI rendering or Premium
service quality. No synthetic amount is reported as recovered revenue. There is
no runtime LLM or AI chat. Commercial value remains a
[pilot hypothesis](docs/PILOT_BRIEF.md).

## Retained demos and verification

In Python mode: [activation console](http://127.0.0.1:8875/recovery-console.html),
[Demo Lab](http://127.0.0.1:8875/recovery-console.html#lab),
[cancellation recovery](http://127.0.0.1:8875/access.html),
[analytics](http://127.0.0.1:8875/analytics.html), and
[browser fixture lab](http://127.0.0.1:8875/legacy.html).
Their original walkthroughs are in [activation](docs/ACTIVATION_VERIFICATION.md),
[access](docs/PAID_ACCESS_VERIFICATION.md) and [analytics](docs/VERIFICATION.md).

```sh
npm test
npm run test:integration
npm run test:acceptance
npm run test:ts
npm run check:offline
```

Tests use temporary databases and loopback services. Acceptance includes a long
local stress run; the separate TypeScript stress is an integration benchmark,
not black-box UAT. See [benchmark instructions](apps/server/benchmarks/README.md)
and [the final audit](docs/FINAL_HACKATHON_REVIEW.md) for results, scope and limits.
The read-only offline check verifies pinned checksums and streams 50,000 accounts
and 29,794 transaction rows. Those records are synthetic history.

## Repository

| Path | Responsibility |
| --- | --- |
| `apps/web` | Preact screens and Vite build |
| `apps/server` | Modular-monolith engine, HTTP API and reporting |
| `apps/lumen`, `apps/provider-simulator` | Independent client and source services |
| `packages/server-sdk`, `packages/contracts` | TypeScript SDK and versioned DTOs |
| `reconcile-mock-first-kit` | Complete retained Python runtime and seed/replay toolkit |
| `Reconcile` | Original frontend assets and fixture lab |
| `docs` | Contracts, verification, limitations and development record |

[AI Usage & Development Log](docs/AI_USAGE_DEVELOPMENT_LOG.md) explains the tools,
agent orchestration, automation and human review. Official fixture provenance is
pinned to [Adapty's seed repository at `77d39ed`](https://github.com/kpotehin/adapty-seed-data-hack/tree/77d39ed807a66bbebcf24fe67c42be4fc9ef4c82).
No production deployment is configured. Real store payments, native mobile
integration and commercial validation remain outside this hackathon prototype.
