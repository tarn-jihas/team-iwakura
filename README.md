# Reconcile

**Reconcile finds users who are entitled to Premium but are still locked out, restores their existing access, and proves the app now lets them in.**

A subscription provider such as Adapty can record that a user has Premium while
the app's own backend never applied it. A webhook handler failed, a cache went
stale, or an update arrived out of order. The user is entitled but gets denied.
Reconcile reads the provider's entitlements on its own, compares them with what
the app stored and with the answer of the app's real authorization gate, re-syncs
existing rights where the evidence is clear, and then re-checks the same gate the
customer hits.

It never charges, refunds or grants anything new. Unclear cases stay visible as
unresolved or inconclusive and are never repaired automatically. This is an
Adapty hackathon prototype; the demo app is called **Lumen**.

## Watch the demo

[![Watch the Reconcile demo on YouTube](https://img.youtube.com/vi/ONXDinNiiZw/maxresdefault.jpg)](https://youtu.be/ONXDinNiiZw)

A walkthrough of the demo: <https://youtu.be/ONXDinNiiZw>

## Quick start

You need **Git, Node.js 22.22.3 with npm, and Python 3.13.13**. This mode uses
only the Python standard library. It needs no credentials, no database
installation, no AI key and no `npm install`.

```sh
git clone https://github.com/tarn-jihas/team-iwakura.git
cd team-iwakura
npm start -- --mock --port 8875
```

Open **<http://127.0.0.1:8875>** and click **Run once**. You will see:

- 100 accounts checked.
- 24 discrepancies confirmed: the provider says Premium, Lumen denies access.
- All 24 repaired and all 24 gates verified, after one bounded retry.
- 6 inconclusive accounts excluded from repair.

Open an incident to see its steps, or download the activity as CSV or JSON.

Good to know:

- **Demo traffic.** While the monitor is open, a new synthetic scenario starts
  about every six seconds, once the previous recovery has settled. **Stop demo
  traffic** pauses it. It also pauses in hidden tabs and while you browse
  filters or history.
- **History.** Each run keeps its incidents. **Needs attention** keeps
  unsuccessful verifications visible.
- **Isolated run.** Reusing a runtime directory keeps its state. For a clean
  run, pick a new directory and a free port:

  ```sh
  npm start -- --mock --port 0 --runtime /tmp/reconcile-demo-example
  ```

- **Stop.** Ctrl+C stops all three local services.
- **`--mock`** selects synthetic evidence. Without it, `npm start` uses the
  private live Adapty configuration if one is present. Neither mode creates a
  real charge, and no Adapty reseed is needed.

## How it works

**Observe → Compare → Authorize → Resync → Verify → Report**

1. **Observe.** Read the provider's current entitlements independently, and
   receive signed events from the app's server SDK.
2. **Compare.** Check each entitlement against the app's stored state and its
   real gate answer.
3. **Authorize.** Record the evidence and approve an exact repair plan under a
   bounded policy. Unknown source, identity conflicts and expired access are
   left unresolved.
4. **Resync.** Lumen re-applies the existing right, after checking identity,
   policy and revision.
5. **Verify.** Read the state back and probe the same gate again. A timeout
   stays unknown until its outcome can be established.
6. **Report.** Show each incident with its affected accounts, steps and result.
   Export as CSV or JSON.

The demo runs three local processes, each with its own SQLite database:

| Process | Role |
| --- | --- |
| Provider simulator | Stands in for Adapty and serves entitlements |
| Lumen | The demo app: webhook handler, stored access state and Premium gate |
| Reconcile engine + UI | Detects discrepancies, plans repairs, verifies gates and serves the browser UI |

App events only transport observations. They cannot prove a payment or
authorize a repair.

## Run modes

| Mode | Command | Opens at | Expected result |
| --- | --- | --- | --- |
| Mock (Python, main demo) | `npm start -- --mock` | <http://127.0.0.1:8875> | 100 checked, 24 affected, 24/24 gates verified, 6 inconclusive excluded |
| Connected Adapty | `npm run start:live` with private config, see [the live guide](docs/LIVE_ADAPTY_DEMO.md) | URL printed by the launcher | 100 rights read, 76 applied normally, 24 fail locally, 23 gates verified, 1 unresolved |
| TypeScript runtime | `npm ci && npm run build:ts && npm run start:ts` | <http://127.0.0.1:8768> | 100 accounts, 24 affected, 23 gates verified, 1 unresolved |
| Legacy analytics lab | `npm run start:legacy` | <http://127.0.0.1:8765> | The earlier revenue-reconciliation lab, kept for reference; not the access-recovery flow |

**Why the results differ.** The mock scenario injects 24 failures that can all
be repaired; one of them has a stale cache on the first attempt, which is why
one retry is needed. The connected Adapty and TypeScript scenarios give one of
the 24 accounts a handler failure that never succeeds. Its repair cannot be
applied, so it stays unresolved on purpose. This shows that Reconcile reports a
failed recovery instead of hiding it.

Notes:

- **Connected Adapty.** A prototype add-on, not an officially supported Adapty
  CLI plugin. Adapty reads are real; the seed purchases are synthetic. Recovery
  writes only to local Lumen state.
- **TypeScript runtime.** Wait for source readiness, then click **Run once**.
  `ENGINE_PORT=0 npm run start:ts` picks a free port. Each launch creates fresh
  state under `runtime/typescript/demo-*`.
- **TypeScript migration status.** The main automatic flow, analytics,
  cancellation and the browser fixture lab run in TypeScript. The advanced
  activation API and full blast-radius parity are incomplete, and
  `/recovery-console.html` returns an explicit unsupported result there. Use the
  Python mode for that flow. Node 22's built-in `node:sqlite` is synchronous and
  experimental; the engine runs it behind a worker.
- **SDKs.** The [TypeScript server SDK](packages/server-sdk/README.md) is the
  intended successor to the Python SDK, with a breaking migration for consumers.
  Its built-in HTTP transport currently supports loopback collectors only.

## Tests

```sh
npm test
npm run test:integration
npm run test:acceptance
npm run test:ts
npm run check:offline
```

| Command | What it does |
| --- | --- |
| `npm test` | JavaScript unit tests for the browser assets and Python unit tests for the runtime |
| `npm run test:integration` | Python HTTP integration tests against local services |
| `npm run test:acceptance` | Black-box acceptance over public HTTP, including a long stress run (about 15 minutes) |
| `npm run test:ts` | Builds the TypeScript workspaces and runs their tests |
| `npm run check:offline` | Read-only check of the pinned hackathon fixtures: verifies checksums and streams 50,000 accounts and 29,794 transaction rows of synthetic history |

Tests use temporary databases and loopback services only. Results and
measurements are in [docs/VERIFICATION.md](docs/VERIFICATION.md).

## Repository layout

| Path | Responsibility |
| --- | --- |
| `reconcile-mock-first-kit/` | The Python runtime that powers the main demo: engine, Lumen, provider simulator, SDK, tests and seed tools |
| `Reconcile/dist/` | The hand-written browser UI served by the Python runtime. These are source files, not build output |
| `Reconcile/tests/` | JavaScript tests for that UI |
| `apps/server/` | TypeScript engine, HTTP API and reporting |
| `apps/lumen/`, `apps/provider-simulator/` | TypeScript versions of the demo app and the provider simulator |
| `apps/web/` | Preact frontend for the TypeScript runtime (Vite build) |
| `packages/server-sdk/`, `packages/contracts/` | TypeScript server SDK and shared, versioned data types |
| `docs/` | Design, API contracts, verification and limits |

## Documentation

- [docs/AUTOMATIC_RECOVERY.md](docs/AUTOMATIC_RECOVERY.md): design and evidence model.
- [docs/LIVE_ADAPTY_DEMO.md](docs/LIVE_ADAPTY_DEMO.md): how to run the demo against live Adapty reads.
- [docs/RECOVERY_API.md](docs/RECOVERY_API.md): the local HTTP API and who owns each part.
- [docs/MOBILE_CONTRACT.md](docs/MOBILE_CONTRACT.md): the mobile telemetry contract and simulator.
- [docs/PAID_ACCESS_RECOVERY.md](docs/PAID_ACCESS_RECOVERY.md): the earlier cancellation and paid-access demo.
- [docs/PAYMENT_ACTIVATION_MVP.md](docs/PAYMENT_ACTIVATION_MVP.md): the original research spec.
- [docs/VERIFICATION.md](docs/VERIFICATION.md): test results, measurements and known limits.
- [docs/PILOT_BRIEF.md](docs/PILOT_BRIEF.md): the proposed pilot and what it would measure.
- [docs/AI_USAGE_DEVELOPMENT_LOG.md](docs/AI_USAGE_DEVELOPMENT_LOG.md): tools, agent orchestration, automation and human review.
- [packages/server-sdk/README.md](packages/server-sdk/README.md): the TypeScript server SDK.
- [apps/server/benchmarks/README.md](apps/server/benchmarks/README.md): how to run the TypeScript benchmarks.

## Scope and limits

- Purchase data is synthetic. No real charge, refund or external licence grant
  happens in any mode, and no synthetic amount is reported as recovered revenue.
- Current profiles and the known-account registry are not a complete payment
  ledger.
- A verified gate proves backend authorization. It does not prove mobile UI
  rendering or the quality of the Premium service.
- There is no native mobile SDK. The mobile integration is a contract and a
  simulator.
- No production deployment is configured.
- There is no runtime LLM or AI chat.
- Commercial value is a [pilot hypothesis](docs/PILOT_BRIEF.md), not a
  validated result.

Fixture provenance: the official fixtures are pinned to
[Adapty's seed repository at `77d39ed`](https://github.com/kpotehin/adapty-seed-data-hack/tree/77d39ed807a66bbebcf24fe67c42be4fc9ef4c82).
