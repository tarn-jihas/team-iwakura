# Hackathon demo verification · 7 November 2026

Verified against the supplied research document's current first tab, MOCK-FIRST
sections0–14. Runtime is entirely local and synthetic. No provider request,
credentials, dependency install, push or deployment was used.

## Automated checks

`npm test`: **42 PASS** (23 JavaScript + 19 Python), no failures.
`python3 reconcile-mock-first-kit/reconcile_mock.py check`: **PASS**.
JavaScript syntax checks and Python compilation also passed.
Authored code/docs pass the staged whitespace check. The supplied font-license
spacing and native CRLF reference CSV/TSV files were preserved unchanged.

Coverage includes six original browser control datasets; exact Decimal-string
display; source/destination evidence; six finding classes/seven initial findings;
approval without writes; stale evidence/mapping/plan rejection; atomic batch
validation; user/environment/currency identity; same-tuple latest delivery dedup;
four delayed repairs; repeat no-op; a fresh equal-value discrepancy; renamed
purchase/refund handling; sandbox exclusion; ghost investigation; failed readback;
local HTTP origin/static-path protection; concurrent mutations; bounded history;
and all 20 reference samples. Tests use temporary state and ephemeral loopback ports.

## Actual browser replay

The integrated UI was exercised through real controls, with the final backend
source SHA-256 `b6d68ba4937f8fb919254ad05e1d1da5bed3f9f37b4531193064cd79fe935d04`.

| Observation | Result |
| --- | --- |
| Initial scan | 6 groups / 7 findings; USD+21.97, EUR+989.01 |
| Accept local rename mapping | No destination event created |
| Check groups and human approval | 3 approvals; no destination writes |
| Apply | 4 accepted events; 4 pending; original visible gap unchanged |
| Verify before clock advancement | Pending visibility, not verified |
| Retry approved apply | 0 additional writes |
| Advance one tick and fresh Verify | USD+11.98, EUR0.00; four receipts verified |
| Operations | 10 rows, including signed refund, healthy controls, ghost and sandbox |
| Ghost / sandbox | Manual+11.98 / expected zero production impact |
| Export audit | Actual browser download; saved as `samples/after_audit.json` |
| Source/history/profile UI | Raw export, profile boundary, immutable old snapshot inspected |
| Wrong-region control | HTTP200, zero imports, unchanged raw count and gap |
| Legacy zero-net control | 0.00 total difference with two unresolved findings |
| Legacy Google control | 8 orders produce 9 matched operations |
| Mobile390px | No page overflow; menu navigation and evidence layout checked |
| Keyboard | Checkboxes, Enter, Escape, dialog focus and focus return checked |

The supplied original raw price999.00 and two duplicate purchase rows remain;
the corrected effective transaction value is9.99. Case receipts are based on exact
payload readback, not transport acceptance. The initial/before report and after
report/audit sample files were regenerated from the integrated engine and UI run.

An independent read-only Sol review found four defects in intermediate versions.
All were fixed, independently reproduced as passing, and covered by regressions.
Final verdict: no remaining substantive findings for the documented mock scenario.

## Delivery state and limits

The demo is reset to tick0 with no approvals, corrections or saved runs. The QA
server and browser tabs are stopped; `npm start` launches it without installation.
The verified after-state report/audit remain as sample evidence.

No live providers, actual LLM, real store accounting, general multi-app import,
production load or screen-reader audit was tested. The separate 937-order Revenue
Bridge package and Paid Access Recovery server were not supplied. Reference-only
payloads are inspectable samples, not active adapters.
