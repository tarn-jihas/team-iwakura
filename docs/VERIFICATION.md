# Verification

This is the single record of what has been tested in Reconcile and what the
results were. The prototype has several demo modes that use different evidence
and different failure scenarios, so their numbers differ. Every figure below is
labelled with the mode it was measured in and the date. Figures from 7–8
November 2026 are historical and were not re-measured unless stated.

Everything runs on local, loopback services. Purchase records are synthetic in
every mode, including the connected Adapty mode; no result here shows that money
was charged. See the [README](../README.md) for what the product does.

## Current test suites

Measured on 10 November 2026 on this checkout with Node 24.22.2 and Python
3.9.6. The pinned versions are Node 22.22.3 and Python 3.13.13, so these runs
were not on the pinned toolchain.

| Command | What it covers | Result on 10 November 2026 |
| --- | --- | --- |
| `npm test` | Browser-side JavaScript tests in `Reconcile/tests` and Python unit tests in `reconcile-mock-first-kit/tests` | 68 JavaScript + 173 Python tests pass |
| `npm run test:integration` | Python runtime over real loopback HTTP between provider, Lumen and engine | 14 pass |
| `npm run test:acceptance` | Black-box scenarios against subprocesses through public HTTP, including a long local stress run | 29 pass in about 15 minutes |
| `npm run test:ts` | Builds the TypeScript workspaces, then runs contracts, SDK, server, provider, Lumen and web tests | Passes; 1 test skipped (the Python-oracle comparison, which runs only when `RECONCILE_PYTHON_ORACLE=1`) |
| `npm run check:offline` | Read-only check of the pinned offline dataset: checksums, row counts, pagination | Exits 0 |
| `npm run test:auto` | Automatic-recovery acceptance harness (isolated fixture, or a running demo via `--url`) | Not re-run; last recorded pass 7–8 November |
| `npm run test:live` | Manual-approval acceptance harness against a running connected demo (`--url` required) | Not re-run; last recorded pass 7 November |
| `npm run benchmark:sdk` | Python SDK enqueue and delivery overhead | Not re-run; see [Measurements](#measurements) |
| `npm run check:access` | End-to-end replay of the cancellation demo | Not re-run; last recorded pass 7 November (24 of 24 gates) |

Tests use temporary databases and operating-system-assigned ports. The
acceptance suite does not import engine code or read its database; expected
results live in the test harness.

Test counts grew with each iteration: 42, then 75, then 141, then 253 (on 8
November). Those totals are historical; the table above is current.

## Results by mode

| Mode | How to run it | Evidence source |
| --- | --- | --- |
| Mock automatic | `npm start -- --mock`, port 8875 | Synthetic provider |
| Manual activation flow | `npm start -- --manual`, then `/recovery-console.html` | Synthetic provider |
| Cancellation demo | `/access.html` on port 8875 | Synthetic provider |
| Connected Adapty | `npm run start:live`, port 8876 by default | Read-only Adapty API, seeded synthetic purchases |
| TypeScript runtime | `npm run build:ts && npm run start:ts`, port 8768 | Synthetic provider |
| Legacy analytics lab | `npm run start:legacy`, port 8765 (also `/analytics.html` on 8875) | Synthetic fixtures |

Without `--mock` or `--manual`, `npm start` uses the private live Adapty
configuration when one is present. Add `--runtime <new directory>` for a clean
state; reusing a runtime keeps its history.

### Why the numbers differ

Most modes start from the same picture: 100 registered accounts, of which 24
have access that should be active but is not. What differs is who authorises
the repair and which failures are exercised.

- **24 of 24** appears where a retry is available: the automatic policy allows
  one bounded retry, and the manual flows let an operator approve a second,
  smaller plan.
- **23 of 24 with one unresolved** appears in the connected Adapty replay of 8
  November and in the TypeScript acceptance scenario. In the TypeScript runtime
  the remaining account is an ambiguous write whose outcome is unknown, and it
  is deliberately excluded from new plans. The connected-mode documents report
  the unresolved account without stating its cause.
- **100 / 94 / 24 / 6** (registered / evaluated / confirmed / inconclusive)
  is the scan result in the manual and cancellation flows. The six inconclusive
  accounts are never repaired in any mode.

### Mock automatic (current default demo)

A real local gate denial sends a signed SDK event. The engine checks 100
accounts, confirms 24 discrepancies, repairs them without operator approval and
verifies all 24 gates after one bounded retry. Six inconclusive accounts stay
excluded.

The access overview for all 100 accounts, measured in this mode on 8 November
2026: **84 verified, 6 expired, 4 policy-restricted, 6 blocked by evidence**
(three unmapped identities, one stale source, two unavailable sources).

A *policy restriction* is an intentional denial by the application's own rules:
the gate checks the customer mapping, then the app's policy and feature rule,
then cache and subscription period. It is not a failed payment and is not a
repair target. Expired access is likewise a normal denial.

### Manual activation flow

Measured 7 November 2026 in a browser, Python runtime, synthetic provider. An
operator previews an exact plan, approves it, and the engine executes it.

| Step | Result |
| --- | --- |
| Premium export before repair | HTTP 403 |
| Investigation | 100 in scope, 94 evaluated, 24 confirmed, 6 inconclusive |
| First approved plan | 24 activations verified, 23 gates verified, 1 unresolved |
| Approved retry (resync and gate check for 1 account) | 24 activations, 24 gates, 0 unresolved |
| Premium export after repair | HTTP 200 |

The run recorded two approvals and 75 actions: 73 in the first plan (one
catalog repair, 24 validations, 24 resyncs, 24 probes) and two in the retry.
Checked at 1280px and 390px with keyboard navigation; reload kept the results.

### Cancellation / paid-access demo

Measured 7 November 2026 in a browser, Python runtime, synthetic provider. The
scenario is paid access wrongly removed after a cancellation.

| Step | Result |
| --- | --- |
| Premium export before repair | HTTP 403, `subscription_inactive` |
| Scan | 100 registered, 94 evaluated, 24 confirmed, 6 inconclusive |
| Apply after explicit approval | 24 accepted, 0 gate-verified yet |
| Verify | 23 verified, 1 unresolved (a stale cache) |
| Repeat the same approved apply | 0 new writes |
| New one-account retry plan, newly approved, then verify | 24 verified, 0 unresolved |
| Same customer export | HTTP 200 |

A control window of one minute confirmed 0 affected accounts and left
unexplained denials inconclusive.

### Connected Adapty

Adapty reads are real and read-only; the 100 accounts come from the official
hackathon seed. Three runs were recorded, each a different scenario. Details
and setup are in the [connected demo guide](LIVE_ADAPTY_DEMO.md).

| Run | Date | Result |
| --- | --- | --- |
| Manual approval, fixed 24-account fault | 7 November 2026 | 24 confirmed, 48 verified actions, 24 gates, 0 unresolved; 517 SDK events |
| Automatic, same fault, then three random incidents (7, 5 and 4 accounts) | 7 November 2026 | 24 of 24 gates without approval; all 100 gates healthy at the end; 1,248 SDK events, none dropped |
| Proactive replay through the local handler | 8 November 2026 | 76 normal, 24 failures, one incident: 23 gates restored, 1 unresolved; 346 SDK events, none dropped; 299 Adapty requests in the interval |

In the 8 November run detection came before any customer denial. Customer
requests afterwards returned 23 HTTP 200 and one HTTP 403. Two later incidents
on other accounts recovered while the unresolved one stayed visible.

### TypeScript runtime

Recorded during the migration on 8 November 2026, synthetic provider: the
100-account scenario gave 24 affected, 23 gates verified, 1 unknown, with
transaction references unchanged. A separate read-only start against Adapty
read all 100 profiles and verified 100 gates with fault simulation off; that
was not an incident replay. The suite on that date was 114 passing with one
skipped; see the table above for the current run.

### Legacy analytics lab

Measured 7 November 2026, the first iteration: a revenue-analytics
reconciliation mock, unrelated to access recovery.

| Step | Result |
| --- | --- |
| Initial scan | 6 groups, 7 findings; difference USD +21.97, EUR +989.01 |
| Approve and apply | 3 approvals, 4 accepted events, shown as pending |
| Retry the approved apply | 0 additional writes |
| Advance one tick, verify | USD +11.98, EUR 0.00; four receipts verified |

The remaining USD 11.98 is a case left for manual investigation. At the time of
that iteration the suite was 42 tests.

### Offline dataset check

`npm run check:offline` verifies pinned checksums and streams 50,000 accounts
and 29,794 transaction rows. The dataset is source history only: loading it on
7 November 2026 produced no confirmed payments, plans or repairs, and all
50,000 accounts stayed inconclusive. That is the intended result.

## Measurements

All figures are single local runs on one development machine. They are not
throughput guarantees.

| What | Runtime | Payload | Date | Result |
| --- | --- | --- | --- | --- |
| Continuous recovery stress | Python | 1,001 cycles in 50 isolated 20-cycle batches, at most four at once | 8 November 2026 | 905.8 s; 1,051 incidents; peak 63.77 MiB storage and 355.89 MiB engine memory per runtime; no dropped events |
| Long-history checkpoint | Python | 100 cycles in one runtime, full export | 8 November 2026 or earlier | 482 s; 275 MiB storage; about 778 MiB engine memory |
| Acceptance suite duration | Python | 29 scenarios including the stress run | 8 November 2026 | 984.4 s |
| Recovery-cycle stress | TypeScript | 1,000 two-account cycles plus 100-cycle export check | 8 November 2026 | **Not completed.** Runs were stopped at 701 and at 500 cycles (420.9 s) to fix slow history queries |
| SDK enqueue, p50 / p95 | Python | 500 events, about 1 KB each | 8 November 2026 | Trace off 0.856 / 1.023 ms; trace on 0.861 / 1.041 ms; no network calls during enqueue |
| SDK enqueue, p50 / p95 | TypeScript | 1,000 events | Date not recorded | Trace off 0.91 / 1.10 ms; trace on 1.09 / 1.89 ms; no retries or drops |
| Full 50,000-account load over HTTP | Python | 50,000 accounts, 29,794 rows | 7 November 2026 | Import 1.05 s; scan and report 1.52 s; whole sequence 4.08 s; peak engine memory 456.8 MiB |
| Offline streaming check only | Python | Same dataset | 7 November 2026 | 0.707 s, 45.95 MiB |
| Offline streaming check only | Python | Same dataset | 8 November 2026 | 1.777 s, 46.03 MiB |

Notes on reading the table:

- The two SDK rows measure different SDKs with different event counts; they are
  not a before-and-after comparison.
- The Python stress run does not show that 1,000 incidents fit in one database.
  It used fifty separate runtimes; the 100-cycle checkpoint is the only
  single-runtime history measurement.
- The two offline timings are separate runs of the same check. The sources do
  not explain the difference.

Method, limits and further SDK figures are in
[automatic recovery](AUTOMATIC_RECOVERY.md#sdk-overhead). The TypeScript stress
harness is described in the
[benchmark instructions](../apps/server/benchmarks/README.md). The Python
benchmark writes to `.artifacts/` only when you run `npm run benchmark:sdk`
with `--output`; that output is local, git-ignored and not in the repository.

## TypeScript migration status

`npm start` and the Python test commands remain the reference. The TypeScript
runtime runs the main automatic flow, analytics, cancellation and the browser
fixture lab. It does not yet do the following:

- The manual activation flow. Its provider lacks the mutation, catalog-repair
  and fixture routes the flow needs, so `/recovery-console.html` returns an
  explicit "unsupported" result instead of a simulated success.
- Complete affected-account grouping. The incident assessment module is tested
  on its own but is not wired into the automatic monitor, and time-window
  correlation is not at parity with Python.
- A completed 1,000-cycle stress run and 100-cycle export check.
- Coverage of a multi-process restart combined with a late commit.
- Final browser checks of error states and focus during sustained polling.
- Remote delivery: the SDK's built-in HTTP transport supports loopback
  collectors only.

The stress harness runs with the collector disconnected, so it says nothing
about telemetry delivery or backpressure. Node's built-in SQLite module is
synchronous and experimental; the engine isolates it in a worker.

## Known issues and open findings

- **Continuous connected run, 8 November 2026.** A continuous run of 7 episodes
  against live Adapty reads produced 5 repaired incidents and 2 unresolved
  incidents with zero target accounts. The cause was not established. Single
  runs are verified; continuous connected operation is not.
- **TypeScript stress.** Not recorded as completed (see Measurements).
- **Memory at scale.** Snapshots and reports are held in memory; the 50,000
  account load peaked at 457 MiB, and a 100-incident history at about 778 MiB.
- **Resource warning.** The Python suite reported an unclosed SQLite connection
  warning in the connected-recovery code on 8 November. No test failed.
- **Not tested anywhere.** Real store checkout, a native mobile SDK, production
  load, a complete screen-reader audit, and real webhooks from a store.
- **Toolchain.** The 10 November results were obtained on Node 24 and Python
  3.9, not the pinned versions.

**Hackathon rules.** The project was checked against the organiser's rules on 8
November 2026 and no blocking violation was found. Adapty use is demonstrated
by the read-only adapters and the seeded replay; credentials are git-ignored,
and a targeted scan of tracked files found only a deliberately fake key in a
test. The check relied on the team's own confirmation of eligibility and was
not an exhaustive secret audit.

## Evidence files

From the manual activation browser run of 7 November 2026:

- [Partial recovery, 23 of 24](evidence/activation/partial-recovery.jpg)
- [Recovered, desktop](evidence/activation/recovered-desktop.jpg)
- [Recovered, 390px mobile](evidence/activation/recovered-mobile-390.jpg)
- [Lumen premium export returning HTTP 200](evidence/activation/lumen-gate-200.jpg)
- [Recovery report (HTML)](evidence/activation/recovery-report.html)

Evidence for the connected and automatic runs is written to `.artifacts/` when
you run `npm run test:auto`, `npm run test:live` or `npm run benchmark:sdk`
with `--output`. Those files are produced locally and are not in the repository.
