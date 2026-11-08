# TypeScript modular monolith migration

Request: migrate the complete runtime and demos to Node 22, TypeScript and
Preact, preserving public behavior. Baseline `f3c9b3d` on
`codex/proactive-fulfillment`; Node 22.22.3, npm 10.9.8, Python 3.13.13.
Ponytail Full. No push, deploy, reseed, worktree, changes to the running demo,
or edits to the original hackathon scripts and seeders.

Engine, provider and Lumen are independent processes with isolated databases;
the engine is a modular monolith. TypeScript SDK replaces Python SDK for new
integrations; old Python remains an oracle until parity. New storage does not
silently reuse old databases. Node 22 `node:sqlite` is experimental and
synchronous; engine database access and export formatting use workers.

Current implementation: workspace under `apps/` and `packages/`, runnable
isolated three-process TypeScript demo, signed durable collector/outbox, source
cooldown, fulfillment monitor, immutable evidence, approved guarded recovery,
gate verification, reporting, Preact views, and partial legacy demo ports.
The provider can add explicitly synthetic active entitlement overlays in its
isolated demo only; original seed files and lifecycle records remain unchanged.
Read-only CLI catalog inspection is separate from runtime profile reads.

Independent recovery review led to fixes for scope reuse, transaction races,
ownership, unknown outcomes, receipt backpressure, external healing, renewals
and coverage. Recent reporting/event-order and simulator changes need final
integrated verification and review. The previous clean baseline passed 253
tests; logs are `/tmp/reconcile-typescript-baseline-*`. Original ignored stress
artifacts were restored from `/tmp/reconcile-typescript-existing-stress-artifacts.tar`.

The isolated SDK benchmark accepted 1,000 events with and without trace,
with zero retries or drops. Enqueue p50/p95 were 0.91/1.10 ms without trace and
1.09/1.89 ms with trace; event-loop delay p95 was 88/100 ms on this machine.
These numbers are local, not production guarantees. Preact build and 16 web
tests passed after the latest UI changes. A server run against stale dist had
58 passes, one intentional oracle skip and one missing newly-added CLI module;
the full suite must be rerun after the coordinated build.

The TypeScript demo launcher now has an explicit live read-only config option,
which still requires verification. It does not run or modify original seeders.
Synthetic simulation is being wired only for the mock provider; it must not be
enabled against the live source. The SDK documentation calls out its loopback
transport limit and experimental synchronous SQLite behavior.
An initial HTTP smoke passed with the synthetic runner connected. A review of
the still-in-progress runner found that pre-injection healthy observations could
be mistaken for a post-repair result; its owner is correcting that before the
black-box 100-account test can establish a valid result.
Simulation wakeups now request local monitoring instead of forcing a complete
provider scan every polling interval; the scheduler regression is pending the
next shared build. Lumen/provider builds and their eight tests passed.
The integrated build, scheduler/HTTP smoke and independent black-box
100-account replay now pass: 24 affected, 23 verified gates, one unknown and
unchanged transaction references. An initial failed replay exposed the owned
unknown outcome and a missing public Lumen gate; both were corrected and the
same test rerun. A separate monitor change lets other targets resume while an
ambiguous write remains excluded from new plans; its focused regression passed
and independent safety review is pending.

An isolated live seeded read-only startup succeeded against the existing
Adapty configuration: all 100 registered profiles were read and 100 local
gates were verified, with simulation disabled. This was not an incident replay
or evidence of real charges. The process was stopped; original seeders and
existing demo state were not changed.
The read-only TypeScript CLI catalog adapter also returned six products using
the installed Adapty CLI 0.18.0; no catalog mutations were performed.

Browser replay ran one synthetic incident, opened its trace, checked a 390px
viewport and keyboard navigation, and downloaded CSV/JSON containing 24/23.
The viewport was reset and the QA processes stopped. Error-state and sustained
polling-focus checks still need final validation. A screen-reader ambiguity in
the account result and the displayed default export range were corrected after
this replay and need the next web build.

The legacy activation port remains incomplete: the TypeScript provider lacks
mutation, catalog-repair and fixture routes required to implement it safely.
A stub-only adapter was discarded because it could not provide those routes;
the legacy UI must not fabricate a verified result. The stress harness is being
developed separately; the SDK benchmark is not a substitute for 1,000 cycles.
The standalone incident assessment module is tested but is not yet wired
into the automatic monitor's cohort grouping; correlation-window behavior and
the complete blast-radius API still require parity work.
The collector trace/export receipt join now passes scoped/window and field
minimization tests; UI truncation is explicit. Recognizable credential patterns
are rejected by the event validator. Raw stack frames and arbitrary
transaction/trace identifiers are excluded from exported receipts. Independent
Sol Max review found and rechecked fixes for historical outcomes, retry-plan
churn, stop races and report event ordering. A multi-process restart plus late
commit remains untested.

Outstanding: legacy activation/API and blast-radius parity, the running 1,000
cycle and 100-cycle export stress checks, final browser error/focus checks,
multi-process restart/late-commit coverage and full regression suites. The existing `npm start`
and test scripts still point to Python deliberately; `start:ts` and `test:ts`
are provisional, not evidence of parity. Never claim full migration until these
checks and all demo endpoints are complete.

Next: finish the isolated provider activation contracts and stress harness,
then close remaining public-contract gaps and verify the integrated runtime.
Existing server on port 8765 and all existing user data must remain untouched.

Checkpoint publication: user explicitly requested commit and push of all current
work. Workers paused their edits. This is an incomplete migration checkpoint,
not a completed release. ActivationProvider now has seven passing focused tests
including offline import, but its signed HTTP wiring and engine activation flow
remain unfinished. `activation-worker-client.ts` is an untested partial slice
whose worker entry is not yet present; nothing imports it at runtime.

The first unindexed integration stress was intentionally stopped after 701
successful cycles because history lookups became slow; cycle 702 failed on the
intentional service shutdown. Indexes were added and focused regressions passed.
The indexed 1,000+100 run remains active (300/1,000 at the publication request),
so no full stress success is claimed. That harness has a disconnected collector
and does not establish telemetry delivery/backpressure. No original hackathon
scripts, seeders, fixtures or existing databases were changed.
