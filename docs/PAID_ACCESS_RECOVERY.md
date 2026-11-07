# Paid Access Recovery · local Lumen demo

This is a working client-app simulator and recovery flow, using synthetic current
entitlements. It runs inside the existing Python standard-library server. It does
not charge/refund customers or write licences to an external provider.

## Present the scenario

Start the project with `npm start` and open **Cases → Open access incident**.
On a fresh clone, run `npm run seed` first; stop the server before a CLI seed.
Restart an already-running server after pulling code to load the new routes.

1. Open **Lumen app**. Keep the first account selected and click **Export premium
   preview**. The actual HTTP gate returns403 while the source entitlement remains
   active. This records a customer-attempt event through the collector SDK.
2. Return to the incident. Leave the default UTC window and faulty-v1 filter, then
   click **Detect blast radius**.
3. Confirm **100 in scope / 94 evaluated / 24 affected / 6 inconclusive**. Inspect
   account evidence: current source, identity mapping, processed cancellation,
   before/after projection, cache and gate decisions.
4. Select all24 eligible accounts, **Preview selected repair**, and inspect the
   exact diff and unchanged source expiry. Check the approval box and approve.
5. **Apply approved repair** accepts24 local resync actions. No account is declared
   restored until the real gate has been checked.
6. **Verify actual gates** returns **23 verified / 1 unresolved**. The injected
   one-shot cache refresh failure leaves the actual app gate denying that account.
7. **Repeat approved apply** returns zero new writes and the same saved receipts;
   it does not hide or fix the failed cache refresh.
8. **Preview fresh retry (1)**, approve the new plan, apply and verify again. The
   final result is **24 verified / 0 unresolved**. Six unknown accounts remain
   excluded, and the faulty consumer's root cause remains pending.
9. Return to Lumen and export with the previously denied account. The same premium
   endpoint now returns200. Export the audit bundle to reconstruct the result.

The Demo Lab can switch future events between faulty-v1 and fixed-v2 behavior and
send a new cancellation. Fixing this demo handler is separate from restoring
current access. The alternate100-account seed changes registry IDs and the affected
selection; the detector uses the same rules.

## Population and evidence

| Account group | Count | Result before repair |
| --- | --- | --- |
| Active annual entitlement, faulty cancellation projection | 24 | Confirmed; eligible |
| Correct access | 60 | Healthy; no write |
| Expired entitlement | 6 | Legitimate denial; no write |
| Other app policy restriction | 4 | Policy denial; no subscription repair |
| Ambiguous identity mapping | 3 | Inconclusive; no write |
| Missing or stale source | 3 | Inconclusive; no write |

These are synthetic reconstructions of the supplied document's scenario. The24
default IDs follow its listed cohort, but no downloaded/live Adapty ledger is
claimed. Our source observation schema describes a supported current annual
entitlement. Unsupported lifecycle/policy combinations abstain.

The initial incident is `subscription_renewal_cancelled` under `cancel-handler-v1`.
The faulty consumer actually turns off the local projection and updates the cache.
Disabling renewal does not end the already-paid annual period. The protected gate
uses client cache, projection revisions, expiry and feature policy; it does not
simply return the source adapter's answer.

Candidate grouping uses event time, handler and event class. Detection probes the
whole known registry and can reconstruct completed causal transitions even when
an initial webhook receipt is missing. Customer denials and reconciliation probes
are recorded separately. No fixture-oracle membership is supplied to the detector.

## Collector SDK

`reconcile-mock-first-kit/collector_sdk.py` is a reusable server-side Python SDK.
`CollectorSDK.emit()` validates allowlisted subscription/access metadata, signs an
envelope with HMAC-SHA256, sends it through a configured transport, and checks that
the collector acknowledged that exact event ID and payload hash.

The mock Lumen consumer, state writer, gate and resync handler use this SDK. Their
in-process transport calls the same authenticated ingestion function as the real
HTTP collector route. `http_transport()` supports actual HTTP delivery exclusively
to `http://127.0.0.1:<port>/api/collector/events`, with no redirects or provider calls.
This avoids a nested HTTP request deadlocking the single-process demo's state lock.

Supported kinds: `webhook_received`, `handler_completed`,
`access_projection_changed`, `feature_access_decided`, `resync_requested`,
`resync_completed`, `verification_completed`, `source_entitlement_observed`.
Metadata includes identity/correlation IDs, business timestamps, source hashes,
expiry, handler/state versions, state diffs and gate decisions. Unknown fields,
nested arbitrary payloads and card/credential fields are rejected. This is an
allowlisted metadata contract, not a general-purpose sensitive-text redactor.

The local generated signing key stays in ignored runtime state and is excluded
from HTTP reports and exported evidence. Signatures expire after300 real seconds;
same-event/same-payload retries are idempotent, conflicting payloads are rejected.
This authenticates our local app journal, not a store payment or provider signature.

## Repair and clock contracts

Preview binds exact accounts, source hashes, identity mapping, policy/adapter
versions, projection/cache revisions, unchanged entitlement expiry and the active
incident. Human approval does not change client access. Apply performs a fresh
preflight of the whole selected plan before any resync write; changed or expired
preconditions require a new assessment and approval.

Source freshness is900 scenario seconds; plan validity is300 scenario seconds.
The fixed anchor is `2026-11-03T00:12:04Z`. These are explicit replay-clock limits,
separate from actual SDK authentication and wall-clock collection timestamps.
`POST /api/access/demo` with `{"action":"advance","seconds":301}` demonstrates
expiry without a real-time wait. Reads do not magically refresh a stale fixture.

Each accepted action has a durable ID for run+plan+account+action type. Verification
calls the same function as the customer's premium-export endpoint and links its
actual gate event/response to the applicable resync action. Context changes cannot
retain an old restored status. A fresh retry gets a new plan and action ID.

## Local routes and files

| Route | Purpose |
| --- | --- |
| `GET /api/access/report` | Current assessed accounts, scope, repair and collector summary |
| `POST /api/access/detect` | Scan a UTC window / consumer version and probe the registry |
| `POST /api/access/preview` | Persist an exact plan for chosen eligible IDs |
| `POST /api/access/approve` | Approve plan ID/hash with an actor |
| `POST /api/access/apply` | Preflight and resync the approved local plan |
| `POST /api/access/verify` | Verify actual app gates and retain failures |
| `GET /api/access/evidence?user=<id>` | Raw observations and account-level proof |
| `GET /api/access/audit` | Sanitized portable evidence bundle |
| `GET /api/access/registry` | Known client accounts and mappings |
| `GET /api/access/journal` | Signed collector metadata journal |
| `POST /api/collector/events` | SDK ingestion with `X-Reconcile-Signature` |
| `POST /mock/lumen/export` | Actual premium gate:200 allowed /403 denied |
| `POST /api/access/demo` | Explicit reset, alternate seed, handler, cancel and clock controls |

The interface is at `/access.html`; `/access.html#lumen` opens the client simulator.
`paid_access.py` owns orchestration, plans and evidence; `lumen_app.py` owns actual
client behavior; `access_fixtures.py` owns synthetic construction and evaluation
expectations. Private runtime is separate from the analytics state.

Run `npm test` for isolated SDK/domain/HTTP/UI-helper tests. `npm run check:access`
executes the acceptance replay in temporary storage. Neither needs live accounts.
