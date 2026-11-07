# Lumen with live Adapty reads

This demo connects Reconcile to the isolated **Lumen - AI Photo Editor
(Hackathon)** app, created by the official Adapty hackathon seed. Adapty API
responses, local Lumen gate decisions, SDK delivery, incident detection,
approval and client repair actually execute. The purchase records are synthetic.
They do not prove that a card or app-store account was charged.

## Setup already performed

- App ID: `46a573aa-8c90-4b4b-ba72-2349ae9fb030`.
- Official source: [adapty-seed-data-hack at 77d39ed](https://github.com/kpotehin/adapty-seed-data-hack/tree/77d39ed807a66bbebcf24fe67c42be4fc9ef4c82).
- The authenticated Adapty CLI created the separate app, products, flows,
  placements and experiments. The original `Test` app was preserved.
- The official script sends profiles and synthetic transactions through Adapty's
  server API. It preserves its original attribution wait and request budget.
- Completed on 2026-11-07: **6,000 profiles, 3,123 synthetic transactions,
  1,000 flow views; zero failures**. Customer prefix: `lumen_916965_`.
- Credentials and seed status live in ignored, private
  `reconcile-mock-first-kit/runtime/live-adapty/`; no key belongs in Git,
  screenshots, exported reports or frontend code.

The official script labels store transactions `Production`. That value is
retained as source metadata; it does not turn synthetic seed transactions into
real payments. Our local environment is `hackathon_seed`.

`adapty_seed_setup.py` checks the reviewed script checksum and exact app identity,
captures the app key without printing it, and refuses to start twice in the same
runtime. Do not rerun the seed to reset an incident. A partial seed requires
inspection of its private status and log, not a blind replay.

## Run the connected demo

From the repository root:

```sh
npm run start:live -- \
  --config reconcile-mock-first-kit/runtime/live-adapty/live-config.json \
  --runtime /tmp/reconcile-live-demo \
  --port 8876
```

The launcher prints the Reconcile and Lumen URLs. It starts three isolated local
processes; the source adapter performs read-only Adapty requests. It never grants
access or changes a purchase at Adapty. The selected registry contains 100 exact
customer IDs from the official seed; the adapter verifies their current source
state independently.

The CLI also reads all six catalog products at startup. Public status and audit
include its version, observation time and a catalog checksum. Account reads use
the server API; CLI commands are not run for every gate request. Keep the existing
CLI session authenticated and the private key file available.

1. Open Reconcile and confirm **LIVE ADAPTY · SEEDED DATA**.
2. In **Lumen Demo**, try a premium export for a healthy account.
3. Choose **Simulate local access incident**. A controlled local projection bug
   blocks 24 currently active accounts; Adapty is unchanged.
4. One actual rejected customer request sends signed SDK telemetry. Reconcile
   automatically opens the incident and checks the other registered accounts.
5. Review the independently confirmed cohort and exact repair plan. Enter the
   operator name, acknowledge the scope, then approve and run.
6. Each repair rechecks the Adapty entitlement, resynchronizes Lumen and probes
   the same authorization decision used by the customer endpoint.
7. Try premium export again and download the HTML report or JSON audit.

The live plan contains client resync and gate verification only. The existing
mock payment-activation scenarios still exercise provider validation and catalog
repair separately. A missing, changed, expired or ambiguous live source blocks
repair; a source entitlement is never reported as independently verified money.

## Public HTTP acceptance

Use a fresh local runtime, because this test intentionally injects an incident
and approves its repair. It does not reseed or mutate the remote app:

```sh
npm run test:live -- --url http://127.0.0.1:8876 \
  --output .artifacts/live-adapty-acceptance.json
```

The harness uses public HTTP only. It checks the 100-account scope, automatic
24-account detection, blocked unapproved writes, exact 48-step plan, duplicate
execution, immutable approved snapshot, 24 actual successful customer gates,
and absence of credentials and fabricated payment proof in the audit.

Verified on 2026-11-07 against the real seeded Adapty app:
**100 accounts → 24 confirmed discrepancies → 48 verified actions → 24 successful
customer gates, zero unresolved**. The public-HTTP acceptance run recorded 517
SDK events, tied the incident to the actual rejected customer request, drained
the outbox, reused a duplicate execution and preserved the approved snapshot.
Its local evidence is `.artifacts/live-adapty-acceptance.json`.

A separate browser replay passed on desktop and 390px: healthy gate200,
incident gate403, automatic detection, keyboard approval, recovery24/24 and
post-repair gate200. Both downloaded HTML and JSON reports contain the same
result and synthetic purchase provenance. Evidence screenshots are
`.artifacts/live-recovery-desktop.jpg` and `.artifacts/live-recovery-mobile.jpg`.

Historical telemetry before startup and the future portion of an incident window
remain incomplete coverage. That does not prevent individually supported repairs,
and the report keeps those gaps visible after recovery.

For another demonstration, stop the launcher and choose a **new local runtime
directory**. This resets only the local incident scenario; it does not rerun the
official seed. The seeded subscriptions have real expiry timestamps, so readiness
can change over time. Source reads and repair preflight must remain fresh.

## What the SDK monitors

The server SDK records allowlisted application observations: source entitlement
reads, handler/projection changes and actual gate decisions, with account,
configuration version, timestamps and correlation IDs. Its signed durable outbox
delivers these asynchronously; collector failure must not block the customer.
The engine combines those observations with its own source reads to decide
whether an account is affected. SDK messages alone do not verify payments.

This integration uses Adapty's [Get profile API](https://adapty.io/docs/api-adapty/operations/getProfile)
as an entitlement source. Renewal cancellation and access expiry are separate
facts; [Adapty's webhook contract](https://adapty.io/docs/webhook-event-types-and-fields)
describes that distinction. No webhook was received from a real store in this demo.

Limits: no real store checkout, native mobile SDK, production deployment or
payment-provider attestation. The premium gate proves authorization, not a full
photo-editing service. Commercial value still requires the
[Adapty pilot](PILOT_BRIEF.md).
