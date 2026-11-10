# Reconcile Payment Activation Recovery

_This is the original research specification, kept for design background; it does not describe a live connector._

This pivot proposal is based on a review of public documentation on
November 7, 2026. The local mock implementation and its actual results are
described in the [verification report](VERIFICATION.md); the current contracts
are in the [recovery API document](RECOVERY_API.md).

Reconcile finds confirmed purchases for which the expected activation is missing,
groups the affected users, carries out an approved recovery through supported
Adapty operations and verifies the outcome in the application. The target user is a team
that uses Adapty alongside web/mobile purchases and its own backend. The product
consists of a server connector, an engine and a UI; optional mobile
instrumentation supplements the evidence.

## Why this pivot

The code that existed before this pivot (the cancellation demo) demonstrates an
active source entitlement, an incorrect client projection, an approved resync
and the actual Lumen gate. That is the last leg of recovery. It does not
demonstrate independent confirmation of a charge, nor a purchase that is
missing in Adapty. The existing
collector HMAC confirms that a message originates from our connector; it does not
confirm that the payment provider charged for the purchase.

A documented example for the new main scenario: a new Stripe `price_id` has no
matching `product_id` + `price_id` pair in the Adapty catalog. Stripe can report
a delivered webhook while the transaction is missing. [Adapty store sync](https://adapty.io/docs/store-sync).

That is the basis for a product hypothesis, not proof of how often the incident
occurs. The proposed value for Adapty: unified diagnostics, incident scope and
verifiable recovery through their existing mechanisms. We need to confirm with
their team what already exists internally and how much support effort such cases
consume.

## Three independent states

1. **Provider evidence:** purchase, identity, product, period, status and source
   of confirmation; current refund/revocation data when the adapter supports it.
2. **Adapty state:** the known profile, the purchase and the corresponding current entitlement.
3. **Client state:** the local projection/cache and the decision of the actual feature gate.

A profile is read for a known customer/profile ID; Get profile alone is not an
inventory of all purchases. [Adapty Get profile](https://adapty.io/docs/api-adapty/operations/getProfile).
The scan scope is the union of known client accounts and available provider records.
A provider purchase without a known owner remains orphan evidence; it is never
automatically attributed to an account because of a similar email. The UI shows
coverage and gaps in the sources.

Minimal normalized evidence:

```text
tenant/app/environment/provider
transaction_id/original_transaction_id/subscription_id
provider_customer_id/app_user_id/identity_status/identity_evidence_ref
product_id/price_or_base_plan_id
payment_state/access_basis/period_start/period_end
amount_minor/currency/refund_or_revocation_state
occurred_at/observed_at/evidence_ref/evidence_hash
```

`access_basis` distinguishes a paid period, trial, grace and a manual grant. An
unsupported state remains unknown. Do not reduce every provider to `paid=true`.
Do not present an invoice without a positive amount, or evidence that comes only
from the application, as a new charge.
For the standard subscription flow, Stripe describes `invoice.paid` together
with an active subscription; the current period and the policy are checked in addition.
[Stripe subscription webhooks](https://docs.stripe.com/billing/subscriptions/webhooks).

## Integration and boundaries

The server connector keeps provider credentials and purchase tokens out of the
browser and the mobile SDK. It does not collect PAN/CVV or checkout forms. The UI
receives references and redacted evidence, not authentication secrets. The event
journal is an additional trail; independent provider readback/backfill is also
needed so that a missed webhook does not hide exactly the purchase we are looking
for. Renewals are checked even while the application is not running.

The client implements a small explicit contract:

```text
listAccounts(cursor)
readAccess(account, feature)
probeAccess(account, feature)
resyncAccess(account, expectedRevision, desiredEntitlementHash, operationKey)
```

The probe goes through the same authorization path as the user, in the user's
context, without spending credits or executing an expensive function. It confirms
access to that feature; it does not guarantee the quality or success of the whole
service. If the application has no backend gate, a confirmation from the device
is used with a clearly separate status; the server does not impersonate device evidence.

The mobile layer can report transaction references, a profile change and denied
access. Its `purchase_succeeded` event is a prompt to verify, not a financial
confirmation.
Apple requires a known transaction identifier, and Google a purchase token, for
an individual read. That is why the promise "we see all purchases in every
application without integration" cannot be kept. [Apple API](https://developer.apple.com/documentation/appstoreserverapi),
[Google lifecycle](https://developer.android.com/google/play/billing/lifecycle/subscriptions).

## Capabilities by provider

| Provider | Evidence | Supported recovery path | MVP demonstration |
| --- | --- | --- | --- |
| Stripe | Linked paid invoice/subscription and current state | Correct configuration, Validate Stripe purchase, fresh profile | Complete mock flow for 100 accounts |
| Paddle | Confirmed transaction/subscription and current state | Validate Paddle purchase once the prerequisites are correct | Small complete mock scenario |
| Apple | Verified transaction/status for a known ID | Configuration fix, documented SDK retry/restore when applicable | Diagnosis and explicit waiting for the required app/operator step |
| Google Play | Token + subscriptionsv2 readback | The appropriate SDK restore/sync flow for an identified profile | Diagnosis and waiting for the required app/operator step |
| Custom store | Provider-verified record with documented lifecycle rules | Set transaction for the configured custom store | One limited mock contract, with no claim about all providers |

Stripe validation uses `POST /api/v1/sdk/purchase/stripe/token/validate/`,
with `customer_user_id` and a `sub_...` or `pi_...` token. A valid purchase can
import history and create a profile; the import generates events and counts
toward MTR, so it is not a harmless GET. [Validate Stripe purchase](https://adapty.io/docs/api-adapty/operations/validateStripePurchase).

Paddle has a separate v2 endpoint and a different payload; it accepts a
transaction or subscription token. [Validate Paddle purchase](https://adapty.io/docs/api-adapty/operations/validatePaddlePurchase).
The custom-store Set transaction call records an already confirmed purchase; it
is not an independent verification of a charge. Do not use it as a shortcut for
Apple/Google.
[Custom stores](https://adapty.io/docs/custom-store).

Apple documents lost access caused by credentials/product configuration, and
SDK retries. [App Store troubleshooting](https://adapty.io/docs/troubleshoot-app-store-integration).
A restore can change ownership/sharing of access; confirm the profile and the
sharing policy first, and do not run it blindly for the whole cohort.
[Access sharing](https://adapty.io/docs/sharing-paid-access-between-user-accounts/).

## Detection rules

| Observed state | Classification and action |
| --- | --- |
| Confirmed valid paid period, identity reliable, expected Adapty entitlement absent | ACTIVATION_MISSING; look for configuration evidence and a supported recovery |
| Current Adapty entitlement exists, client gate denies because of subscription/cache state | ACCESS_NOT_DELIVERED; use the existing approved resync |
| Unreliable identity, source unavailable/stale, incomplete backfill | INCONCLUSIVE; no writes |
| Change occurred only recently, within the configured propagation time | AWAITING_SYNC; re-check, no premature incident |
| Pending payment, inactive paid period, another access restriction | No automatic activation; exact reason and policy |
| Trial/grace/manual grant with legitimate access | Not evidence of a charge and not automatically an incident |

A purchase missing on one profile is not by itself proof that it is missing
globally: check identity, transfer/sharing and the references available to the
adapter. A shared product/price, period and configuration version group the
suspected scope; each account is then checked individually. A "confirmed cause"
requires catalog/config evidence; without it the UI says "possible cause". The
catalog is read or imported together with a date/version.

## Plan and execution

Steps: detect → preview → approve → preflight → config prerequisite → provider
validation → Adapty readback → client resync → client gate verification.

A configuration change is a separate operation: it can also affect future
purchases outside the selected accounts. The current CLI documents that the
store/price ID of an existing product cannot be changed; a new product is created
for a different ID. Do not invent an `updatePriceId` API. In the MVP the operator
approves a simulated catalog change; a future live version chooses a confirmed
CLI/dashboard workflow with a separate scope and credentials.
[Adapty products CLI](https://adapty.io/docs/developer-cli-products).

The plan contains the exact cohort, the evidence/config hash, identity, period,
the selected operation, policy, TTL and the expected local revision. Preflight
reads the source again. A timeout of an external operation means an unknown
outcome: readback first, then a decision about a retry. A local operation key is
not a promise that the provider supports exactly-once execution.
Store results per step; a successful validation is not undone because the client
cache failed. A retry performs only the remaining required step.

Separate results: `activation_verified`, `client_access_verified`,
`awaiting_client_action`, `blocked_configuration`, `inconclusive`, `unresolved`.
An HTTP 200 from validation is not enough for a green status. A manual grant is
not a reconstruction of a paid purchase and must not close an activation incident
as a recovered payment.
[Manual access grants](https://adapty.io/docs/server-side-api-with-ai).

## Main hackathon demo

Everything stays local and synthetic. This is a new scenario; the existing
cancellation scenario remains as a regression control.

1. The mock provider processes the purchases of 100 accounts through the
   lifecycle; 24 active paid accounts use the new unmapped price, 60 are healthy,
   6 expired, 4 policy denial, 3 identity unknown, 3 stale/unavailable evidence.
2. The mock Adapty consumer does not activate the entitlement for the new price.
   Lumen returns 403 for the customer.
3. Reconcile finds 24 candidates from the independent provider registry and
   checks each account's evidence individually: 100 in scope / 94 evaluated /
   24 affected / 6 inconclusive.
4. The UI shows the paid purchase, the absent Adapty entitlement, the absent
   catalog mapping and the denied client gate, with linked evidence.
5. The operator approves the catalog prerequisite and the validation of exactly
   24 purchases. Mock validation follows the documented prerequisites and
   creates the corresponding state.
6. A fresh Adapty readback confirms 24 activations. The client resync and gate
   verify only 23: one account is left with a genuinely stale cache.
7. A new approval for the remaining cache resync finishes at 24/24. Re-executing
   the previous plan introduces no new transactions or licences. The same Lumen
   customer gets 200.

The 24 activations and the 23 verified gates must be separate counters. Do not
use "recovered revenue": the money has already been charged. Measure restored
activations/accesses, time to recovery, manual steps, false positives and
evidence coverage.

## Changes to the existing project (original plan)

_This section is the work plan as written before implementation, kept for
reference. It is a completed to-do list, not a description of current status;
the test count and file names are those of the project at that time. For what
was built and verified, see the [verification report](VERIFICATION.md) and the
[recovery API document](RECOVERY_API.md)._

| Package | Concrete work | Acceptance condition |
| --- | --- | --- |
| Models and simulators | Add an independent provider ledger, a mock Adapty catalog/profile/validation and a provider capability map | The fault is produced through the lifecycle; the detector does not read the oracle/fault label |
| Engine | Extend paid_access orchestration with upstream rules and plan steps | Configuration/identity/period checked before writes; unknown stays unknown |
| Adapter and collector | Keep collector_sdk/lumen_app; add evidence references, provider readback and step receipts | A client signal is not sufficient payment evidence; secrets stay out of exported data |
| UI | access-app gets three evidence columns, capability/status and separate counters | An unactivated purchase can be seen even before an Adapty event exists |
| Verification | Keep the existing 75 tests and add new acceptance scenarios | The new 100-account replay plus all negative tests pass |

Negative cases the plan required: paid but wrong user; manual grant without a
charge; refund/revocation before apply; pending/zero-value invoice; trial/grace;
duplicate and out-of-order events; validation timeout after a successful write;
self-heal before apply; stale catalog; source 429/outage; Apple/Google restore
waiting for the device; gate probe disabled; purchase missing from both the
Adapty and client registries but present in the provider backfill. An alternative
seed changes the IDs/cohort. For negative controls, expect 0 disallowed writes,
not an artificially identical number of recovered accounts.

Planned priority: first the complete upstream Stripe scenario and the existing Lumen
final leg; then the small Paddle/custom flows and the Apple/Google diagnostic
controls through the same engine. All of these are mock adapters. Live provider
integration and mobile SDK ports come only after sandbox validation of the
contracts and a conversation with the Adapty team.

## Confirming the value with the Adapty team

Three concrete questions: which paid-but-not-activated incidents does support
resolve, which existing internal tools already detect them, and which recovery
operations may be run in bulk with approval? Ask for anonymized case patterns,
not real user payment data. Pilot proposal: first a read-only comparison of
confirmed cases against support's conclusion, then an approved recovery in a
sandbox. Criteria: detection accuracy, no unapproved grant and measurably fewer
manual steps.
The frequency of the problem, commercial demand and a partnership have not yet
been confirmed.
