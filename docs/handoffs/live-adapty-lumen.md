# Live Adapty Lumen integration

Request (2026-11-07): create the official hackathon Lumen app in the user's
Adapty account, connect Reconcile, generate actual local application telemetry,
simulate a controlled client incident and verify approved recovery end to end.
User explicitly authorizes the new test app and official seed writes. This
supersedes the prior mock-only boundary for this isolated demo app; it does not
authorize modifications to other apps, real charges, public deployment or push.

Baseline: `f469b17`, clean working tree; seed setup checkpoint `0add2da`.
Node 22.22.3, Python 3.13.13,
Adapty CLI 0.18.0. Prior 141 tests passed. Current baseline npm test passed
(33 JS + 79 Python); seed/CLI setup now has five focused passing checks.
Existing app `Test` and local port 8765 are preserved. Old mock QA 56302 is also
preserved. Ponytail Full, standard library, no extra project worktrees.

Evidence: CLI is authenticated; original app listing showed only Test. Official seed
revision `77d39ed807a66bbebcf24fe67c42be4fc9ef4c82` downloaded to
`/private/tmp/reconcile-adapty-official-seed/`. Root reviewed all executable seed
code; dry-run passed. Seed creates app/catalog via CLI and
profiles/synthetic transactions via Adapty server API. No stores are charged.

Invariants: real Adapty responses are evidence of Adapty state, not independent
proof of a real payment. Keep seeded purchase provenance explicit. The local
Lumen gate, event processing, collector transport, detection and resync must
actually execute. No fabricated source responses, no generic premium grants,
no secret in UI/logs/Git. Repair is local client resync after a fresh approved
plan and fresh Adapty readback. Account scope must map exact seed IDs.

Created isolated app `46a573aa-8c90-4b4b-ba72-2349ae9fb030`, official Lumen
catalog complete. Pinned script SHA256:
`9477a90e19d8a8e4c85a68dac0ab58bed2a75bb1f8af2aed9ab34cb8a991a156`.
`adapty_seed_setup.py` captures the app key privately from authenticated CLI,
verifies identity/script, stores mode-0600 files in ignored `runtime/live-adapty`,
and refuses a second seed run. Seed completed at 2026-11-07 19:26:20 UTC,
prefix `lumen_916965_`: 6,000 profiles, 3,123 transactions, 1,000 flow views,
zero failures. The official four-minute attribution wait was preserved.
Dataset SHA256 matches the existing fixture manifest (`9943d29d…50acb9dd`).
The private generated `live-config.json` selects 100 finite premium candidates.
Store environment in official seed
is Production, despite synthetic transactions: our local scope is
`hackathon_seed`, and reports must retain that distinction.

Design: explicit `LIVE_ADAPTY_SEEDED` / `adapty_entitlement_delivery` basis.
No fabricated paid provider evidence. Repair uses current Adapty entitlement
and only local Lumen resync/probe. Controlled local projection fault affects
24 independently verified active accounts; one real customer denial triggers
SDK detection. Standard mock activation contracts remain intact.

Root owns account/seed setup, architecture, integration, docs and final review.
Luna Max (`live_recovery_backend`) owns live backend/adapter/launcher and focused
tests; Luna Medium (`live_recovery_ui`) finished live UI/report labels and async
SDK-triggered incident polling (35 JS tests passing). Sol Max
(`live_integration_review`) reviewed setup/UI; its account/gate identity P2 was
fixed by root and preserved by UI worker. Backend review remains outstanding.
Actual API GET is header-based (`adapty-customer-user-id`) and wraps profile in
`data`; `starts_at` may be null and renewal cancellation preserves future expiry.
The first profile is an annual premium with cancellation and expiry in August 2027.
Root's initial live adapter smoke caught and fixed a stale variable before
network access. The subsequent actual API smoke passed: 100 active profiles,
100 matching app/customer identities, no independent-payment claims, 8.03s with
two concurrent readers. No live source writes after the seed.

The inject endpoint must return pending immediately after the real Lumen denial;
waiting under the engine mutation lock would prevent SDK collector ingestion.
UI polls for the new incident/scan, then uses the existing approval flow.
Root owns `recovery_live_demo.py` and the backward-compatible optional
`Demo(..., live_config=...)` launcher support. First actual subprocess run
(`/private/tmp/reconcile-live-http-20261107`, port 63637) caught an accidental
app_store-only restriction; fixed to include play_store. Second run
(`/private/tmp/reconcile-live-http-v2-20261107`, port 64006) successfully detected
24/100 through the SDK, approved 48 local actions, and verified all 24 gates.
The black-box harness still failed because execution finalization indexed an
observation-only field in an immutable snapshot; worker fixed this KeyError.
Both owned launchers are stopped. No live run is currently active.

Sol review found/fixed lifecycle contradictions, account/gate identity UI,
live entitlement count field (`entitlement_verified`), restart readback ordering,
source refresh on startup and unresolved-row retry eligibility. Final Sol closure
found no remaining P1/P2 in backend, CLI, launcher and harness. Injection refreshes
all selected source profiles before changing local state, including after idle TTL.

Root added `read_cli_catalog(app_id)` in `adapty_seed_setup.py`: real, paginated,
sanitized CLI product read with count/hash/version/observed_at. Actual read passed
at 19:49:19 UTC: 6 products, CLI0.18.0, hash
`383cd6920969b085de652e25a67c50c5b336e3fb4b642a459f69bc7f84c03a45`.
It is integrated once per provider startup into public status/report.
No CLI call per account. No CLI secrets in its result.

Root's public-HTTP-only `live_acceptance.py` passed at 19:58:17 UTC, runtime
`/private/tmp/reconcile-live-http-v3-20261107`: 100 accounts, 24 confirmed, 48
verified actions, 24 actual customer gates, zero unresolved, 517 SDK events,
SDK trigger linkage, drained outbox, immutable snapshot, duplicate execution
reuse and CLI catalog receipt. Evidence: `.artifacts/live-adapty-acceptance.json`.
The full browser replay in separate `/private/tmp/reconcile-live-browser-20261107`
also passed: healthy alternate account 200, injected account 403, automatic
24-account scan, keyboard approval, 24/24 recovery, post-repair gate200, desktop
1440px and390px without document overflow, HTML and JSON download contents checked.
No browser console errors. Screenshots: `.artifacts/live-recovery-{desktop,mobile}.jpg`.
CUA completion recorded. Both owned QA launchers are stopped; preserved servers
8765 and56302 are untouched. Incomplete historical/future window coverage remains
visible; successful recovery does not erase these gaps.

Focused worker regressions finished:6 state+1 HTTP passed, root reviewed all468
lines and froze the fake subscription period anchor (previously changed each
second), then reran both successfully. Broad results:35 JS+91 Python,6 HTTP,
23 acceptance; with7 new focused checks total162. Offline50k HTTP4.095s;
RSS unavailable due environment permission. Credential scan20 files/exports:0
matches. Root reviewed substantive changes; no remaining review blocker.

Fresh manual-policy demo is running on8876 (launcher session75963, ignored
runtime/live-adapty/demo-ready),100healthy, noincident,6CLIproducts. Keep it
isolated until the next iteration replaces it deliberately. User's next request
supersedes routine manual approval and asks for KISS automatic repair, random
local incidents, simple UI and exports with times. Continue in
`docs/handoffs/automatic-recovery-kiss.md`; this live integration is the verified
baseline. No push/deployment.
