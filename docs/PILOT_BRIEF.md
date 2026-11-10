# Pilot: verifiable recovery of paid access

Reconcile is a proposed add-on for the Adapty support/integration team and for
developers of applications that use Adapty. The demo proves a local technical
path; customer willingness to pay has not yet been confirmed. There is no agreed
partnership and no access to internal Adapty tools.

## The problem we are testing

Adapty can record a valid entitlement while the application backend fails to
apply the projection or refresh its cache. A quickly acknowledged webhook and
its successful delivery do not prove that the subsequent asynchronous processing
succeeded:
[webhook processing](https://adapty.io/docs/handle-webhooks-with-ai),
[Event Feed](https://adapty.io/docs/event-feed).
Support then has to connect the Adapty state with the actual application state.
Upstream purchase validation remains a separate regression scenario in the
Demo Lab.

We are testing whether unified diagnostics, an individually confirmed blast
radius, a durable policy decision for an exact plan and verification at the
actual gate shorten that work. Automatic resync restores only an existing,
independently confirmed entitlement. We are not selling a new charge, and we do
not describe an amount that was already charged as recovered revenue. Generic
outage protection is not enough of a differentiator:
[RevenueCat reliability](https://www.revenuecat.com/feature/reliability)
already describes temporary entitlements and later reconciliation.

## First conversation with the Adapty team

1. Which kinds of recorded-but-not-fulfilled incidents recur, and how much
   investigation do they require? We are asking for anonymized examples and
   aggregates, without payment secrets.
2. What do internal tools already detect? Where does manual work actually
   remain between purchase references, the Adapty profile and the client
   backend?
3. Which recovery operations may be executed in bulk, who approves them, and how
   should identity, refunds, period validity and changed configuration be
   checked?
4. Who would own the integration, and who would be the buyer: Adapty, the
   application developer, or both? Are they willing to invest time in a pilot,
   and what measurable outcome would make them buy?

## Proposed pilot and metrics

The first phase is a read-only replay of historical, anonymized cases. The team
records the expected scope and conclusion in advance; Reconcile receives only
the operational sources. The comparison with support's conclusions separates
confirmed cases, false alarms and cases with insufficient evidence. Only then
does sandbox recovery follow, with explicit approval and an actual client gate
probe.

| Metric | How we record it | Proposed pilot criterion |
| --- | --- | --- |
| Unapproved or incorrect grants | Compare every action with the identity, period and approved plan | Zero; any finding stops the write phase |
| Accuracy of the confirmed scope | Independently labelled cases versus confirmed accounts | Agree on a target before the pilot; also report missed cases |
| Incomplete evidence | Number of inconclusive accounts and missing sources, with the reason for each | No such account receives an automatic repair |
| Time to diagnosis | From the first signal to an explanation and an individually confirmed scope | Compare the median and the slowest cases with the manual procedure |
| Time to recovery | From the policy decision to a fresh Adapty readback and client gate probe | Measure access delivery, with no claim of a new charge |
| Manual steps | Operator actions per incident and per account | A measurable reduction without removing necessary controls |
| Integration effort | Hours for sources, identity, adapter and gate probe | Agree on an acceptable budget with the developer |
| Willingness to pay | A named budget owner and a concrete next commercial step | A commitment to a paid pilot or a clear condition for one |

These are proposed metrics, not business results already achieved. We do not
adjust thresholds after the fact to make the demo look successful.

## Responsibility and limits

The payment provider confirms the charge; Adapty manages its own profile and
entitlement; the developer owns identity, the client projection and the gate.
Reconcile keeps the evidence, classifies accounts, proposes a plan, executes
only the approved scope and verifies the outcome. A narrow approved policy can
automatically authorize a specific plan; the operator determines the permitted
scope. Unclear transaction ownership blocks writes.

Before a live phase, we need to confirm sandbox contracts, credential
isolation, retention, rate limits, network timeouts, operational monitoring and
on-call responsibility. Native mobile libraries come after that. The current iteration
uses real Adapty reads of official synthetic seed records, a separate local
Lumen backend, an executable Python server SDK and a mobile contract/simulator.
It does not prove money received, mobile UI rendering or market uniqueness.
