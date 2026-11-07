# Reconcile mock-first hackathon demo

Historical delivery snapshot. The subsequent explicit Paid Access Recovery
request supersedes the access-deferred scope below; see
[the current recovery context](paid-access-recovery.md). The repository was also
subsequently pushed to `tarn-jihas/team-iwakura` at revision `933c122`.

Task: integrate the two supplied archives into a complete local hackathon demo.
Authoritative scope: supplied research Markdown, first tab “MOCK-FIRST”, sections
0–14 (7 November 2026). Later live and access-recovery instructions are historical.
Source: `/Users/strahinja/Downloads/Adapty Reconcile — комплетно истраживање, интеграције, подаци и MVP.md`, lines1–244.

## Decisions and invariants

- Retain `Reconcile/dist` design/fonts and original engine/fixtures/tests.
- Serve new main UI and Python mock API together on `127.0.0.1:8765`.
- Python stdlib is already sufficient; no installs, credentials or live providers.
- Match operation identity, retain raw events, calculate money with Decimal per
  currency. Signed correction events affect only the explicit effective metric.
- Preview, human approval, append-only apply, delayed visibility, fresh verify and
  audit are separate steps. Ghost is manual; sandbox is expected; mapping is local.
- Root owns frontend, integration and this context. Luna Max worker owns only
  `reconcile-mock-first-kit/reconcile_mock.py` and its new tests (Ponytail full).
- Third Revenue Bridge archive and access-recovery backend are not supplied;
  do not fabricate their outputs or describe reference samples as active adapters.

## Evidence and baseline

- Empty workspace on entry, no Git repository or pre-existing user changes.
- Archives extracted unchanged into `Reconcile/` and `reconcile-mock-first-kit/`.
- Node 22.22.3, npm 10.9.8, Python 3.13.13; no pinned alternative toolchain.
- Baseline: Node engine 19/19 PASS; Python `check` PASS.
- jCodeMunch indexing rejected this path because it is outside trusted folders;
  use bounded native reads until trusted indexing is available.
- Seed acceptance: 6 groups / 7 findings; initial USD +21.97 and EUR +989.01;
  three repair groups / four writes; after tick USD +11.98 and EUR 0.00.

## Verified delivery state

Implementation revision: `411fa64` (initial local project commit).

Integrated main UI, backend, Sources, Demo Lab, history, operations and audit are
complete for the authoritative P0. Final `npm test`:42 PASS (23JS/19Python); CLI
`check`:PASS. Actual browser replay confirmed approval3/apply4, pending readback,
retry0, tick1 USD11.98/EUR0 and four verified receipts; exported audit is saved in
`reconcile-mock-first-kit/samples/after_audit.json`. Initial/before/after reports
were regenerated from the engine. See `docs/VERIFICATION.md` for evidence/limits.

Independent Sol review found and rechecked fixes for full-scope IDs, unknown-name
events alongside known events, repeat equal-delta correction versions, and planned
event-name mapping staleness. Final verdict has no remaining substantive findings.
Root inspected substantive implementation/test changes and verified integration.

Final backend SHA-256:
`b6d68ba4937f8fb919254ad05e1d1da5bed3f9f37b4531193064cd79fe935d04`.
Demo reset to tick0; QA server/tabs stopped. `npm start` serves127.0.0.1:8765.
Git repository was initialized locally; no remote, push or deployment.

Remaining limits: fixed synthetic one-app USD/EUR population; no live providers,
real LLM, production scale or screen-reader audit. Revenue Bridge/access recovery
remain outside this delivered P0 as explicitly specified in the first tab.
Next step: user runs the README walkthrough; no required implementation remains.
