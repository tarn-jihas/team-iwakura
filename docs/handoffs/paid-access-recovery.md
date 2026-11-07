# Paid Access Recovery

Request: implement mock Lumen, our collector SDK, incident windows, blast-radius
detection, approved local licence/cache repair and actual gate verification; test
the 100-account scenario and push to `tarn-jihas/team-iwakura`.

## Decisions and scope

- Extends the existing Python/stdlb server and supplied UI; no stack replacement,
  dependencies, external providers, payment credentials or live entitlement writes.
- Current user request explicitly promotes the previously deferred recovery flow.
  Source: supplied research Markdown sections5–10,13,17 (lines533–741,767–810,897–920).
- Separate access runtime state preserves analytics state and its42 passing tests.
- Distinct source entitlement, client projection, cache and actual premium gate.
  Collector SDK signs and validates allowlisted subscription/access metadata; no
  card data. The detector never reads evaluation/fault-oracle data.
- Default fixed scenario2026-11-03T00:12:04Z:100 accounts,24 broken cancellation
  projections,60 healthy,6 legitimately expired,4 policy denials,6 inconclusive.
  Synthetic reconstruction from the document, not a claimed downloaded/live ledger.
- Incident window and handler filter select candidates; scan the full registry to
  establish the actual supported blast radius. Customer denials and probes differ.
- Exact plans bind source/hash, scope, mapping, policy/adapter versions, revision
  and validity window. Human approval, fresh preflight and idempotent receipts.
- Inject one cache-invalidation failure through the mock app; initial verify23/1,
  a fresh bounded retry24/0. Root cause remains pending while faulty consumer exists.
- Root owns SDK, frontend, server integration, docs, final verification and push.
  One Luna Max worker implemented the access engine/simulator/fixtures and tests;
  Sol Max independently reviewed the final substantive changes without findings.

## Baseline and constraints

Baseline HEAD933c122; clean main tracking origin/main on entry. Node22.22.3,
Python3.13.13; no dependencies. Existing toolchain/scripts remain appropriate.
Previous jCodeMunch indexing rejected this workspace as untrusted; targeted native
reads suffice for known files. No worktrees, external task records or production data.

## Verified checkpoint · 2026-11-07

Implementation revision: `12fad97` (parent `933c122`). Final source cleanup only
removed redundant trailing blank lines after the reviewed/tested checkpoint.

Implemented in `collector_sdk.py`, `paid_access.py`, `lumen_app.py`,
`access_fixtures.py`, the existing server router and `Reconcile/dist/access*`.
Cases links both independent flows. Public reports/audit exclude signing keys and
private fault controls; runtime is owner-only and ignored. UI preserves the old
analytics server with an explicit restart message when access routes return404.

`npm test`:75 PASS (26JS/49Python); `npm run check:access`:PASS in temporary state.
The final journal-limit router conversion also passed the focused3 HTTP tests.
Root inspected substantive changes; independent Sol Max review has no remaining
substantive findings for the mock-only scope. No new dependencies.

Browser replay on isolated port8766: actual customer403, scan100/94/24/6,
approval with Apply disabled beforehand, apply24 with0 verified, verify23/1,
repeat0, new approved retry1, verify24/0, actual customer200 and audit download.
All6 inconclusive rows disabled; fixed handler persists across reload and preserves
active account access on a new cancellation. Out-of-window scan confirms0 affected
(30 inconclusive). Keyboard focus traps/Escape and390px navigation/layout checked.
The browser's datetime-local fill was unsupported; negative window was submitted
through the actual HTTP API and the rendered result checked; UTC helper/domain
validation is automated. No production, load or full screen-reader testing.

Generated before/partial/after reports and downloaded sanitized audit are in
`reconcile-mock-first-kit/samples/access_*`; walkthrough and validation details:
[recovery guide](../PAID_ACCESS_RECOVERY.md),
[verification](../PAID_ACCESS_VERIFICATION.md).
Access runtime reset to the initial default after QA. User's older analytics
server on8765 and its pending-ingestion state were preserved; restart it to load
new Python routes. Temporary QA server/browser closed and viewport override reset.
Staged diff checks passed; runtime and signing keys were excluded from the commit.

Next user step: restart the older8765 server with `npm start`, open
`/access.html#lumen` and follow the recovery guide. Required implementation and
verification are complete. Delivery uses a normal push to the explicitly
authorized `tarn-jihas/team-iwakura` remote; no deployment or history rewrite.
