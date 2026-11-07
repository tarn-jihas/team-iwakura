# Paid Access Recovery verification

Verified locally on 7 November 2026 with Node22.22.3 and Python3.13.13.
No dependencies were installed. This extends the original analytics delivery;
its42 tests remain part of the full75-test suite.

## Results

| Check | Result |
| --- | --- |
| `npm test` | PASS:26 JavaScript +49 Python |
| `npm run check:access` | PASS: isolated end-to-end replay |
| Final journal-limit HTTP regression | PASS:3 HTTP integration tests |
| Independent Sol Max source review | No remaining substantive findings for mock-only scope |
| Browser replay, actual loopback server | PASS: approval/apply/partial verification/retry/customer gate |

The automated tests cover SDK signatures, freshness, scope, event acknowledgement,
immutable/idempotent ingestion, actual HTTP SDK delivery, forbidden fields and
loopback-only transport. Domain checks cover both100-account seeds, complete
registry scanning without oracle reads, causal evidence, UTC windows, incomplete
processing, identity collisions, revoked/expired sources, policy exclusions,
unchanged source expiry, approval, stale plan/mapping/policy/revision rejection,
idempotent writes, real gate verification, retry and invalidated verification
context. HTTP checks verify protected routes, private-file exclusion, exported
evidence and preservation of analytics state.

## Actual browser acceptance

The replay used port8766 so the user's existing8765 analytics server and pending
repair state remained untouched.

| Stage | Observed result |
| --- | --- |
| Lumen premium export before repair | HTTP403, `subscription_inactive`; SDK customer event recorded |
| Default incident scan |100 registry /94 evaluated /24 confirmed /6 inconclusive |
| Preview and approval |24 exact entries; Apply disabled until explicit approval |
| Apply |24 accepted,0 gate-verified |
| Verify |23 verified /1 unresolved from actual stale cache |
| Repeat approved Apply |0 new writes; failure remains |
| New bounded retry |1 entry, new plan/hash, new approval |
| Final Verify |24 verified /0 unresolved;6 inconclusive still excluded |
| Same Lumen customer export |HTTP200, premium preview allowed |

Checked all6 inconclusive account checkboxes are disabled. At390×844 the page
width and scroll width were both390px, and navigation opened/closed. Modal focus
remains inside when tabbing backwards and Escape closes it. Fixed-v2 selection
persists across reload; a new cancellation preserves access for an active mapped
account. A00:00–00:01UTC control window confirms0 affected and leaves unexplained
active denials inconclusive. Browser datetime-local filling was unsupported, so
that control used the real HTTP API and the browser verified the result.

## Saved evidence

- [Before repair](../reconcile-mock-first-kit/samples/access_before_report.json)
- [Partial verification](../reconcile-mock-first-kit/samples/access_partial_report.json)
- [Final verification](../reconcile-mock-first-kit/samples/access_after_report.json)
- [Downloaded audit bundle](../reconcile-mock-first-kit/samples/access_after_audit.json)

The audit contains source observations, identity mapping, exact plans, approvals,
before/after state, action receipts and collector-linked gate verification. It
excludes the signing key, private fault controls and evaluation oracle. Synthetic
business timestamps use the documented replay clock; collection times are actual
wall-clock timestamps. Later handler/window/reset checks occurred after these
snapshots. Access state was reset for the next demo.

No live provider integration, external licence write, card collection, production
load test or full screen-reader audit was performed. The SDK authenticates local
app metadata; it does not validate payment-provider receipts. The current source
entitlements are a clearly labelled synthetic reconstruction of the supplied
scenario. See the [demo/contract guide](PAID_ACCESS_RECOVERY.md).
