# Automatic recovery and simple incident feed

Request: 2026-11-07. Remove routine human approval, simplify the UI, generate
realistic random local faults, and export incidents/repairs with timestamps.
Implemented and verified locally. Delivery revision is the commit containing
this handoff, following baseline `8c4bf07` ([live checkpoint](live-adapty-lumen.md)).
No push, deployment, new dependencies or worktrees. Ponytail Full.

The SDK remains a thin signed-event/outbox layer. The engine independently reads
Adapty evidence, then applies exact plans, preflight, idempotency, readback and
real gate verification. Policy `local-entitlement-resync-v1` authorizes existing
local Lumen access resync/probe only; unclear evidence stays unresolved. This
supersedes the earlier routine operator-approval requirement, not evidence checks.
The official seeded purchases remain synthetic and are never payment proof.

Lasting behavior, research and measurement limits live in
[AUTOMATIC_RECOVERY.md](../AUTOMATIC_RECOVERY.md),
[RECOVERY_API.md](../RECOVERY_API.md) and
[LIVE_ADAPTY_DEMO.md](../LIVE_ADAPTY_DEMO.md). Relevant implementation:
`recovery_service.py`, `recovery_monitor.py`, `recovery_domain.py`, live launcher,
`monitor-app.js` / `monitor-view.js` / `monitor.css`, automatic tests and
`automatic_acceptance.py`. Existing manual APIs/console remain under Advanced
tools for mock regression cases.

Key invariants: one bounded safe retry; an unsafe remainder stays unresolved
after a successful subset retry. Only fully recovered episodes roll over.
Precise live event/completion times distinguish late events from new failures.
Completed history survives later diagnostic scans and repeated account failures.
Stop synchronizes with fault injection after source preparation. UI polling
performs no external Adapty reads and cannot swallow user actions.

Final verification on Node 22.22.3, Python 3.13.13, Adapty CLI 0.18.0:

- **182 tests passed**: 42 JavaScript, 109 Python, 8 HTTP integration, 23
  black-box acceptance. Includes twelve automatic-policy regressions. Logs:
  `.artifacts/automatic-{regression,integration,acceptance}-final.log`.
- Actual-source public HTTP: 100 accounts → 24 affected → 48 verified actions →
  24 real gates; then three random incidents (7, 5, 4 accounts). All 100 final
  gates healthy, immutable snapshot/history, duplicate job reuse, zero operator
  approval calls, 1,248 SDK events accepted with zero drops/errors. Evidence:
  `.artifacts/automatic-recovery-final.json` and matching log.
- Final browser: desktop 1440px and 390px, keyboard Start/Stop and details,
  stable focus during polling, no overflow/console errors. Stop before injection
  added no incident; Simulate once repaired two more accounts. CSV/JSON agree
  on five repaired incidents and preserve all four prior results. Screenshots
  `.artifacts/automatic-recovery-{desktop,mobile}.jpg`; exports
  `.artifacts/automatic-incidents.{csv,json}`. Thirty intended files/exports
  scanned against actual credentials: zero matches.
- SDK benchmark: 500 events, enqueue p50 0.4136 ms / p95 0.5414 ms; outage p95
  0.6500 ms; 651 JSON body bytes/event; zero network calls in emit, 500/500
  loopback deliveries. `.artifacts/sdk-overhead.json`. The current background
  worker sends one request/event and sleeps after each group of up to 25.
- Root reviewed every substantive changed file. Independent Sol Max review
  closed all P1/P2 findings at service SHA prefix `cea8888e86d1`, monitor
  `b9651c00c690`, domain `89a32a6f4bf0`. Final CSS spacing was visually checked;
  acceptance timestamp comparison handles mixed ISO precision correctly.

Fresh demo: http://127.0.0.1:8876, verified automatic policy enabled, 100 current
accounts, six CLI products, zero incidents and idle simulator. Owned launcher
session `68450`; runtime
`reconcile-mock-first-kit/runtime/live-adapty/automatic-demo-ready.cn9dAE`.
Other owned QA launchers stopped. Existing user servers on 8765 and 56302 remain
listening and were not reset. Private key/config and runtime data stay ignored.

Remaining limits: no real store checkout/payment attestation, native mobile SDK,
production HTTPS collector, production load test or validated willingness to pay.
Next improvements: batch transport/backpressure and deliberate coalescing,
provider sandbox validation, then pilot metrics. No required implementation work
remains in this iteration.
