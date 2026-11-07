# Activation recovery implementation

Request: implement the accepted Adapty add-on plan with three HTTP processes,
Python server SDK, mobile contract/simulator, immutable incident snapshots,
same-app blast radius, approved recovery, simple UI without AI chat, and layered
black-box acceptance/integration/unit testing. No live providers or deployment.

Baseline: delivery `4dbc86f`; 75 tests passed during planning on Node 22.22.3 and
Python 3.13.13. Prior research documents are untracked and preserved. Existing
8765 analytics server/state must not be reset. All new state/QA is isolated.

Implementation is complete locally at `0897b85` (2026-11-07); final documentation
and evidence accompany this handoff. All worker scopes are finished. Root owns
the integrated code, docs and verification. Ponytail Full; standard library and
existing visual system, no added dependencies or worktrees. No push/deployment.

Decisions: independent provider/Adapty and Lumen SQLite state; no detector access
to fault labels or fixture oracle. Runtime app/environment/key isolation.
Snapshot is historical evidence plus current observations, not historical state
reconstruction. Every repair requires approval and current evidence. Unknown
outcomes require readback. Mobile remains a contract/simulator, not native SDK.

Source fixture revision `77d39ed807a66bbebcf24fe67c42be4fc9ef4c82` from
https://github.com/kpotehin/adapty-seed-data-hack. Dataset checksums and provenance
accompany imported fixtures. Synthetic activation cases are labelled as
extensions and never presented as provider-confirmed real payments.

Verified checkpoint `754ba37` (2026-11-07): importer validates all checksums and streams
50,000 accounts / 29,794 transactions; 500- and 731-account pages give the same
assessment hash. Four focused tests pass. Source-only scan took 0.662 seconds /
45.95 MiB local process peak RSS; this is a source-only import benchmark.
No official seed script was executed. Mobile remains metadata-only; no secrets
or live credentials are required.

Public `/api/recovery/` contract is frozen; root's independent acceptance harness
owns subprocess orchestration and uses only HTTP outputs. New launcher preserves
existing legacy state and 8765. SDK envelope/event both require schema_version 1;
HMAC authenticates metadata delivery, never payment. Preview expiry checks both
wall time and scenario time. Source initialization must be transactional and
restart-safe; Lumen independently reads Adapty before accepting a resync hash.

Checkpoint `7ab7a15` stores the SDK and mobile contract. SDK now passes 8 tests:
queue-only emit, independent delivery lock, strict mobile metadata, bounded
outbox and Retry-After. Lumen forwards mobile observations through this SDK.
Early browser QA found and fixed modal stacking and premature retry UI. Final
desktop and 390px replay passed; earlier QA processes are stopped.

Final clean checks (2026-11-07): 33 JS + 79 Python tests passed (Python 4.412s),
6 isolated HTTP integration tests passed (0.949s), 23 subprocess acceptance
scenarios passed (19.669s). Total 141 including the original 75-test baseline.
Source-only import and retained cancellation CLI checks also passed. Acceptance
imports only launcher orchestration, not engine code, and never reads its DB.

Final browser replay: actual 403 -> 100/94/24/6 -> exact approval -> 24 activations/
23 gates/one unresolved -> fresh two-step retry -> 24/24/zero -> actual 200.
Desktop 1280px and mobile 390px, no page overflow, modal focus trap/Escape/return
focus, reload persistence and both exports passed. No console errors. The saved
audit has two approvals and 75 action records; six inconclusive accounts remain
excluded. Artifacts and measurements are in
[ACTIVATION_VERIFICATION.md](../ACTIVATION_VERIFICATION.md).

Root reviewed complete online service/domain and substantive frontend changes.
Independent Sol Max review found refund-between-steps, collector crash-window,
and unexecuted-preview reporting problems; all fixed with focused regressions
and reviewer rechecks. No remaining must-fix online or offline/reset finding.
Integration fixture order dependence was removed using per-test processes.
Resume only reads back already-started actions; unstarted writes need
a new plan. Future races are not claimed to be distributed atomic transactions.
Initial cohort signature stays fixed; late assessments append snapshots. Public
report supports incident_id selection and exposes current source/SDK coverage.

Backend offline slice is integrated: reset scenario=offline, unique reset run ID,
50,000 original account IDs, 29,794 paginated source-only history records, zero
fabricated Adapty/client/payment observations. Snapshot/report coverage includes
source_history count/hash. Full HTTP acceptance checked exact original IDs,
all rows, immutable hashes, zero plans/actions and 50,000 inconclusive outcomes.
Reset/outbox isolation also passed. Measured 4.082s assertion sequence and sampled
engine peak RSS 456.8MiB (provider 45.95MiB, Lumen 39.59MiB). Sandbox denied ps;
a separate read-only test run measured RSS successfully. Source-only check was
0.707s/45.95MiB. No official seed script was executed against Adapty.

Limits: commercial willingness to pay, live providers and native mobile remain
unverified. Local approval actor is a demo label, not authenticated operator
identity. Full snapshots/report JSON materialize the cohort in memory; reduce
that footprint before a larger pilot. No distributed atomicity claim; current
evidence rechecks cannot lock independent live services. Production credentials,
RBAC, TLS, retention and operational protections remain future work.

Next: review [PILOT_BRIEF.md](../PILOT_BRIEF.md) with Adapty, confirm sandbox
validation/catalog contracts, then validate incident frequency and business
value. Current API/ownership is in [RECOVERY_API.md](../RECOVERY_API.md).
Final QA runtime remains at
`/private/tmp/reconcile-activation-final-browser-verified-20261107`, port 56302.
`npm start` now defaults to 8875 to leave the existing 8765 demo untouched.
