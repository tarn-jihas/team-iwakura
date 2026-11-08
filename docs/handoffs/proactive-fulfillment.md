# Proactive payment-to-access fulfillment

Request: implement the accepted replacement plan,2026-11-07/08. Baseline
`f0967ed`; branch `codex/proactive-fulfillment`. Local checkpoints: SDK`ef1bde3`,
engine`a509c4f`, UI`984bebd`, fast trace/receipt fix`be546f4`,
late-denial/atomic cohort fixes`8757a30`.
Test harness checkpoint:`30a394a`; contract/live guide checkpoint:`c78de7d`.
Final verification and pilot documents are ready for the closing local commit.
Node22.22.3/Python3.13.13/CLI0.18.0.
Ponytail Full; no new dependencies, worktrees, remote writes, reseeding, push or
deployment. User runtimes8765/56302/8876 and their history remain untouched.

The engine observes versioned Adapty rights independently; SDK events cannot
authorize payments or grants. Lumen records transactional action receipts and
checks identity/policy/projection CAS. Routine source polling is telemetry-only.
Fresh source, durable global Retry-After, exact policy plans, bounded retry and
real gate verification remain mandatory. Current profiles are not a complete
ledger; official seed records are synthetic, not proof of received money. Mobile
integration is a contract/simulator. All writes are local existing-right resyncs.

Completed implementation: proactive expectations/audit, real normal handler,
v2 signed processing receipts, immutable snapshot/trace/export, durable episode
ownership, random reproducible simulation, simple paginated monitor and UTC export.
Root owns final integration/docs/commits. A and B are handed back. C
`/root/fulfillment_acceptance_finish` completed final acceptance, session10905
exit0,50×20 batches with four isolated workers. All acceptance/fixture processes
are stopped. Earlier partial evidence is separately archived and not counted.
Sol reviewer`/root/fulfillment_safety_review` closed all critical findings.
Final serviceSHA:c875d1f4 at8757a30; independently6ownership+3revision/SDK
regressions pass. Final harness export/count assertions also reviewed clean.

Critical fixes include atomic creation+claim of episodes, binding the full
confirmed cohort with its snapshot before restart, preserving different existing
owners/immutable receipt links, exact-version grace, truthful source-unavailable
receipts, and bounded sourceGET60s/resync65s/bulk120s waits. No HTTP runs inside a
DB transaction. Default full-source cadence stays60s; only demo local timers scale.

Current verification:
- Baseline182 passed (42JS/109Python/8integration/23acceptance).
- Latest full regression163Python and52JS pass (including all ownership fixes);
  integration9 pass, including a7s paused fresh-source read. Logs:
  `.artifacts/fulfillment-{regression,integration,ui}-final.log`.
- Final acceptance29 pass in984.409s:253automated tests total. Stress proves
  1001continuous cycles/1051newincidents across50isolated runtimes in905.778s,
  unchanged100transaction references per fixture, retained partial/retry history,
  maxsampled63.77MiB runtime storage/355.89MiB engineRSS,0drops/backlog.
  99,036source reads are fixture transport counts, not actual AdaptyHTTP.
- Root17 episode tests plus12 automatic/restart tests pass; export/monitor5 pass.
- Actual Adapty replay proved100rights→76normal handler successes/24failures→
  ONE24-account incident,23 verified gates/1unresolved, no customer denial/manual
  incident before detection. Repeated denial stays in the original incident.
- Restart retained that history; two later healthy-account incidents repaired
  outside all24 original accounts. Final browser export has3 incidents, summaries
  24/23/1 and1/1/0 twice. Real CLI6products. This earlier browser/restart proof
  predates the final projection-receipt fix; current SDK evidence is below.
- Desktop1280/390px, keyboard Start/Stop, report/trace/filter, focus during polling,
  actual CSV/JSON downloads with UTCNov8→Nov9 and matching3 IDs passed;0overflow/
  console errors. Evidence `.artifacts/fulfillment-live-final.json`, browser-export
  CSV/JSON and recovery-desktop/mobile PNG. CUA completion summary issued; viewport
  reset. All root-owned live QA launchers01–06 are stopped, preserving storage.
- SDK paired500 schema2 receipts: off p50/p95 .856/1.023ms, on .8605/1.0413ms;
  997/1096JSON bytes,0emit network/0drops,500delivered per profile. Local loopback
  only: `.artifacts/fulfillment-sdk-benchmark.json`.

Final acceptance is complete; earlier failed/interrupted runs are not final proof.
See`docs/AUTOMATIC_RECOVERY.md` for stable behavior and resolved race invariants.
Actual-source runtime06 passed the final replay at8757a30:100/76/24/23/1,
oneincident,24real customer gates23HTTP200/1HTTP403,47processing receipts
(24handler+23repair),346SDK events/0drops/errors/backlog. Evidence:
`.artifacts/fulfillment-live-tip.json`;299source requests in replay interval.
Root stopped launcher06 after proof; all root QA launchers01–06 are stopped.
Earlier04 restart/browser proof remains in`fulfillment-live-final.json`.
Standalone`npm run test:auto` passes initial24/24+48actions and3random incidents;
regression163Python/52JS and HTTPintegration9 pass on frozen product8757a30.
C's ONE100 checkpoint passed:482.144s,100continuous+1control incidents,
275MiB storage,~778MiB engineRSS after export,100transaction IDs unchanged,
0drops/backlog; artifact`fulfillment-stress-100-cycle-checkpoint.json`.
Final acceptance now uses50×20 isolated batches(max4) to reduce quadratic
history/export overhead, still proving>=1000distinct public repaired incidents;
50ms polling replaces5ms. Final4-worker run follows measured10CPUs
and early~300MiB totalRSS per20-cycle fixture. The final aggregate is
`fulfillment-stress.json`. No cadence or storage guard was relaxed.
Keep512MiB guard and source cadence unchanged. The aggregate does not prove
1000incidents fit one runtime.

Implementation and required verification are complete. Root reviewed the remaining
test and documentation diffs. Closing local documentation commit remains; no push
or deployment. Ranked next work is in`docs/AUTOMATIC_RECOVERY.md`: authenticated
source updates/backfill, native/store sandbox integration, evidence deduplication
and streaming exports, then pilot metrics/pricing.
Private Adapty config remains ignored; never print keys. Known limits: real store
checkout, native SDK, production operations and commercial willingness to pay.
