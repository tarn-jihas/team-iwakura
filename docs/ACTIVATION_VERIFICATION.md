# Payment Activation Recovery — verified local MVP

Verified 7 November 2026 using Node 22.22.3 and Python 3.13.13. Everything below
uses local synthetic services. No Adapty account, live provider, deployment or
native mobile library was used. Commercial value remains a
[pilot hypothesis](PILOT_BRIEF.md).

## Run and present

```sh
npm start -- --port 8875
```

Open `http://127.0.0.1:8875`. The launcher starts three processes: provider/Adapty,
Lumen, and Reconcile. Each owns its SQLite state; requests cross HTTP boundaries.
Restart preserves state. For a clean isolated presentation, add
`--runtime /tmp/reconcile-presentation`. The existing 8765 demo is untouched.

1. In **Lumen Demo**, choose `u00000` and **Try premium export**: HTTP 403.
2. **Investigate this account**: 100 in scope, 94 evaluated, 24 confirmed and six
   inconclusive. A customer denial also schedules diagnosis through the SDK.
3. **Select all eligible (24)** → **Preview selected plan**. Review catalog
   repair, purchase validation, Lumen resync and gate verification. Catalog
   repair explicitly affects future purchases using that price.
4. Check the exact-plan approval, enter an actor, and **Approve & run**. The
   durable approval is separate from execution. Result: 24 activations verified,
   23 accesses verified, one unresolved. The incident remains **Partial recovery**.
5. **Preview retry (1)** creates a new plan containing only resync and gate
   verification. Approve it: 24 activations, 24 accesses, zero unresolved.
6. Repeat the Lumen export: HTTP 200. Download the HTML report and JSON audit.
   The six inconclusive accounts remain excluded from repair.

**Demo Lab** holds reset, clock and fault controls, plus the retained analytics,
cancellation and legacy labs. `offline` loads the official 50k source-only data;
it deliberately produces no eligible payment repairs. Apple and Google controls
wait for client/operator action. Paddle and custom have separate mock contracts.

## Results and artifacts

| Check | Final result |
| --- | --- |
| `npm test` | 33 JavaScript + 79 Python tests passed |
| `npm run test:integration` | 6 isolated HTTP boundary tests passed |
| `npm run test:acceptance` | 23 black-box subprocess scenarios passed |
| `npm run check:offline` | Checksums, 50k/29,794 rows and pagination invariance passed |
| `npm run check:access` | Retained cancellation recovery reached 24/24 gates |
| Browser replay | 403 → 100/94/24/6 → 24/23/1 → limited retry → 24/24/0 → 200 |
| Responsive / keyboard | 1280px and 390px; no page overflow, modal focus loop, Escape and return focus |
| Export / persistence | Both downloads matched 24/24/0; reload retained results; no browser console errors |

The 141 automated tests include the prior 75-test regression baseline. Acceptance
uses HTTP reports, audit and actual Lumen responses; it does not import engine
logic, inspect its database or obtain expected cohorts from the detector.
Expected counts and alternate-ID membership live in the harness. Every test
gets isolated temporary state and OS-assigned ports.

Evidence from the final browser run:

- [Partial recovery](evidence/activation/partial-recovery.jpg)
- [Desktop result](evidence/activation/recovered-desktop.jpg)
- [390px result](evidence/activation/recovered-mobile-390.jpg)
- [Lumen HTTP 200](evidence/activation/lumen-gate-200.jpg)
- [Readable HTML report](evidence/activation/recovery-report.html)
- [Detailed JSON audit](evidence/activation/recovery-audit.json)

The audit contains two approvals and 75 action records: the initial 73 steps
(one catalog repair, 24 validations, 24 resyncs and 24 probes), followed by two
retry steps. Historical failed steps remain recorded after successful recovery.
Coverage remains incomplete; a restored account does not fill missing historical
telemetry or prove that every external cause is permanently removed.

## Negative controls and review

Acceptance covers lifecycle exclusions, uncertain identity, a different price
in the same time window, source changes/self-heal before apply, provider 429,
commit timeout/readback, probe outage, collector outage/outbox delivery, reset
scope isolation, wrong signatures/app/environment, mobile-only purchase claims,
late/duplicate/out-of-order events, alternate IDs, per-incident reports,
restart/concurrent apply and probe-only retry. Apple/Google never become falsely
verified. Paddle/custom validation reaches an actual gate through HTTP.

Unit regressions additionally cover invalid money/UTC/freshness, snapshot and
cohort immutability, TTL, evidence binding, refund between validation and resync,
collector crash replay, unfinished work after restart and queued job draining.
Independent Sol Max review identified refund rechecks, a collector crash window,
and preview/report accounting defects. They were fixed, regression-tested and
rechecked. A subsequent offline/reset review found no remaining must-fix issue.
This is evidence for the tested cases, not a claim that the system has no bugs.

## 50,000-account measurement

Pinned source revision:
`77d39ed807a66bbebcf24fe67c42be4fc9ef4c82`. The manifest/checksums are in
`reconcile-mock-first-kit/fixtures/hackathon/manifest.json`. Original IDs and
lifecycle rows are preserved. The official seed script was never run against
Adapty. Synthetic Stripe/Paddle scenarios are separate extensions.

The full subprocess HTTP test loaded 50,000 accounts and all 29,794 transaction
history rows without truncation. It asserted all IDs, the immutable snapshot
hash, source provenance and zero provider-confirmed payments, Adapty profiles,
observed client gates, plans or repair actions. All 50,000 remained inconclusive.

| Local measurement | Observed |
| --- | --- |
| Reset/import | 1.054 s |
| Incident scan + report | 1.519 s |
| Snapshot fetch | 0.224 s |
| Complete assertion sequence | 4.082 s |
| Sampled peak engine RSS | 467,776 KiB (456.8 MiB) |
| Sampled peak provider / Lumen RSS | 47,056 / 40,544 KiB |

RSS was sampled every 30ms using `ps` on only the three test child PIDs. The
sandbox run denied `ps`; a separate read-only run measured it successfully.
These are local observations, not throughput guarantees or exact allocation
peaks. Source-only streaming import separately took 0.707s and 45.95MiB.

## Limits and next improvements, in order

1. **Confirm the live recovery contract and business need with Adapty.** Validate
   Stripe/Paddle payloads and permitted catalog workflow in sandbox, then replay
   independently labelled real incident patterns. The mock catalog endpoint is
   not a claim that a matching live Adapty mutation exists. Confirm the buyer,
   incident frequency, existing tooling and paid-pilot success criteria.
2. **Reduce full-scan memory before a larger pilot.** Adapter reads are paginated,
   but snapshots and report JSON currently materialize the cohort in memory.
   The measured 457MiB engine peak warrants chunked snapshot persistence and
   server-paginated report retrieval beyond this verified 50k workload.
3. **Add production integration boundaries.** Native mobile SDKs, authenticated
   app sessions, tenant credentials/RBAC, operator identity, TLS, retention,
   operational alerts and provider-specific retry limits remain future work.
   The current local approval actor is a demo label, not authenticated identity.

The SDK queues metadata without network I/O on the purchase/gate path. Its
bounded outbox can exhaust delivery attempts; dropped or missing telemetry stays
visible. HMAC authenticates delivery, not payment. A gate probe proves permission
for the feature, not the success or quality of its expensive operation.

Recovery has durable per-step outcomes, not a distributed transaction. Unknown
outcomes require readback. Restart reads back started actions; unstarted writes
need a new preview/approval. Current evidence is rechecked before resync, but no
claim is made that independent live providers can be locked atomically.
