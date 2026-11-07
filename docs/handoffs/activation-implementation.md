# Activation recovery implementation

Request: implement the accepted Adapty add-on plan with three HTTP processes,
Python server SDK, mobile contract/simulator, immutable incident snapshots,
same-app blast radius, approved recovery, simple UI without AI chat, and layered
black-box acceptance/integration/unit testing. No live providers or deployment.

Baseline: delivery `4dbc86f`; 75 tests passed during planning on Node 22.22.3 and
Python 3.13.13. Prior research documents are untracked and preserved. Existing
8765 analytics server/state must not be reset. All new state/QA is isolated.

Root owns contracts, importer/provenance, launcher/integration, docs and final
verification. Luna Max backend worker owns new engine, service and simulator
modules plus focused tests. A second Luna Max worker owns the isolated durable
SDK slice; the Luna Medium UI slice is complete and now integrated by root.
Ponytail Full; standard library and existing visual system, no worktrees.

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
45.95 MiB local process peak RSS; this is not yet an engine HTTP benchmark.
No official seed script was executed. Mobile remains metadata-only; no secrets
or live credentials are required.

Public `/api/recovery/` contract is frozen; root's independent acceptance harness
owns subprocess orchestration and uses only HTTP outputs. New launcher preserves
existing legacy state and 8765. SDK envelope/event both require schema_version 1;
HMAC authenticates metadata delivery, never payment. Preview expiry checks both
wall time and scenario time. Source initialization must be transactional and
restart-safe; Lumen independently reads Adapty before accepting a resync hash.

UI helper suite passes 6 tests after root's report correction: verified actions
are not listed as unresolved, and activation/access totals remain distinct. Full
JS suite passes 32 tests. SDK passes 7 tests after root removed network I/O from
emit and separated delivery/state locks; blocked delivery does not block enqueue
or coverage. Retry-After rounds up, never schedules an early retry.
Browser verification is pending
the first executable three-service runtime. README/package commands now target
the new launcher; legacy commands remain available. No completed-engine claim yet.

Next: integrate three services, run the black-box suite (including 50k HTTP),
review critical changes independently, perform desktop/mobile browser replay,
then a clean final test pass and local commits. No push or deployment.
