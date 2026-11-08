# Reconcile: automatic access recovery

The product promise is **connect an Adapty-recorded purchase to application
state, find access that was not delivered, restore the existing entitlement,
and verify the result**. Reconcile compares independently obtained source
evidence with the backend projection and its actual authorization gate.

The Adapty CLI supplies setup and catalog inspection. The server SDK observes
application events. The engine compares independently read Adapty state with
Lumen state. The Lumen adapter applies a revision-bound resync and probes the
actual authorization gate. Keeping these responsibilities separate lets the SDK
remain small and keeps network recovery out of the customer request path.

## Why these failure examples

Adapty recommends acknowledging a webhook quickly and doing heavy work
asynchronously. Delivery success therefore does not establish that the receiving
application committed the access projection or refreshed its cache.
[Webhook processing](https://adapty.io/docs/handle-webhooks-with-ai).

Adapty documents asynchronous webhook delivery, retries, duplicate delivery,
out-of-order events and delivery pauses after endpoint failures. A backend can
therefore miss or misapply an update even while the authoritative entitlement is
valid. These are documented mechanisms; we do not have incident-frequency data
showing which is most common. [Webhook delivery](https://adapty.io/docs/set-up-webhook-integration).

The fulfillment iteration replays existing source updates through the local
Lumen handler. It exercises a handler/write failure, stale cache, delayed old
update and lost resync response. Each affects actual local processing and
produces observed receipts and gate results. It does not claim that a real
Adapty webhook failed or that a payment was made during the demo. Adapty's
`access_level_updated` event is intended to keep backend access synchronized.
[Event contract](https://adapty.io/docs/webhook-event-types-and-fields).

Automatic recovery is limited to current, unambiguous, individually verified
entitlements. It retains snapshots, exact plans, policy decisions, preflight,
idempotency, readback and gate verification. The policy replaces the operator's
routine approval; it does not replace evidence checks. Unknown source, identity
conflicts, expired access and policy denial remain unresolved. No automatic
payment, refund, catalog mutation or new external licence grant is allowed.

## Evidence and responsibility

| Component | Evidence it owns | Meaning |
| --- | --- | --- |
| Adapty source adapter | Current profile, transaction references and access period | Adapty recognizes the right; synthetic seed records do not prove money received |
| Reconcile engine | Versioned expectation, assessment and exact recovery plan | Independently compares source, identity and application state |
| Lumen handler | Durable projection receipt, cache outcome and application revision | Records the steps that actually ran |
| Server SDK | Signed, bounded event delivery and visible delivery gaps | Transport only; cannot authorize a payment or repair |
| Lumen gate | Current authorization decision | Proves backend permission, not mobile UI rendering or premium service quality |

Purchase identity includes the app, source environment, store, transaction ID,
customer and access level. Original transaction IDs link subscriptions but do
not deduplicate separate renewals. Changed periods or source fingerprints create
new expectation versions. A missing transaction reference remains an
entitlement-only observation. The known account registry and current-profile
API do not constitute a complete payment ledger.
[Profile API](https://adapty.io/docs/api-adapty/operations/getProfile).

The engine checks newly observed rights proactively and allows 30 seconds for
normal processing. A missing receipt triggers readback first. Correct projection
and gate state require no repair; missing telemetry remains visible. An old
local expiry is a discrepancy even while the gate still allows access.

Confirmed affected accounts each require their own evidence. The incident time
window and real handler/configuration versions help investigate a common cause;
time proximity alone does not prove one. Simulation seeds, fault recipes and
expected account lists are test inputs, never detector authority.

The v2 recovery contract binds the expected customer mapping, identity revision,
policy revision and projection revision. Lumen checks these in the transaction
that applies the entitlement and records the receipt. A source Retry-After
deadline is durable and shared by source reads, polling and repair validation.
Unavailable fresh source evidence blocks new repair writes.

Routine recovery uses a durable policy decision for an exact plan, whole-plan
preflight, idempotent operations and readback after an ambiguous outcome. One
bounded automatic retry does not reset when an unresolved account is scanned
again. A later failure after a verified recovery becomes another incident
episode for the same observed purchase.

## SDK overhead

Reproduce from the repository root:

```sh
python3 reconcile-mock-first-kit/benchmark_sdk.py --events 500 \
  --output .artifacts/sdk-overhead.json
```

Measured on macOS arm64 with Python 3.13.13 on 2026-11-08, using 500 schema-v2
processing receipts per profile and the real durable SQLite outbox. The paired
payloads differ only by an empty trace versus one projection-commit step:

| Measurement | Result |
| --- | ---: |
| Trace off, enqueue p50 / p95 | 0.8560 / 1.0230 ms |
| Trace on, enqueue p50 / p95 | 0.8605 / 1.0413 ms |
| Collector unavailable, enqueue p95 | 1.0387 ms |
| Network requests during enqueue | 0 |
| JSON request body, trace off / on | 997 / 1,096 bytes |
| Successful local deliveries per profile | 500/500 |
| HTTP delivery requests per profile | 500 |
| Pending outbox after delivery / dropped | 0 / 0 |

For the trace-on payload, 10,000 events produce 10.96 MB of JSON; 1,000,000 produce 1.096 GB.
Those figures exclude HTTP/TCP/TLS overhead, retries and source API reads.
Projection-change events can be larger. This is a local measurement of SDK
enqueue cost, not a production throughput or total application latency guarantee.
The outage sample uses an injected failing transport; enqueue never invokes it.
The delivery measurement uses actual loopback HTTP with signed events and checked
acknowledgement hashes.
The outage check retains all 500 events after 25 bounded failed delivery attempts.
Machine-readable evidence: `.artifacts/fulfillment-sdk-benchmark.json`.
SQLite contention can increase enqueue latency; the SDK has a 200 ms DB timeout
and records dropped telemetry instead of failing a purchase/gate.

The outbox holds up to 1,000 pending events, retains at most 2,000 records and
limits an event to 16 KiB. Delivery attempts are bounded and honor Retry-After.
The Lumen background worker selects up to 25 events, then sleeps one second;
it sends **one HTTP request per event**. Its sustained delivery ceiling is below
25 events/second per worker, depending on HTTP latency. The benchmark drains
manually without that sleep, so its delivery time is not the background rate.
For high-volume deployment, the next optimization is a versioned
batch transport plus deliberate coalescing of repeated successful observations;
denials, source changes and repair evidence must remain visible. This iteration
does not claim that batching or production HTTPS delivery is implemented.

Adapty's API limit is assigned per app/key, rather than one universal public
number. Keep reads bounded, refresh evidence when needed and honor 429/backoff.
[API limits](https://adapty.io/docs/ss-authorization).

## Demo and report contract

The main screen separates Needs attention from Activity. Each incident shows
what happened, the affected accounts, what was done and remaining work. Details
follow Adapty recorded → application applied → access verified. Trace steps have
an owner, observed time, result and next action; missing steps remain gaps.

CSV and JSON exports select activity in a UTC interval `[from, to)`: detection,
repair attempts or material diagnosis/status changes, not polling. The default
is the last 24 hours. Each selected incident includes its history through one
export cutoff, regardless of the current UI page. Reports never trigger Adapty
reads. A repaired historical incident stays repaired when the same account
later suffers a new incident.

Simulation is local and server-driven: once, short sequence or continuous. Stop
prevents new faults while monitoring and recovery continue. Continuous episodes
exclude accounts in open incidents, wait for source/backpressure/capacity, and
leave unresolved cases visible while continuing on healthy accounts. The source
app and synthetic transactions are not modified. Repeating an incident does not
create another purchase.
The pending-demo generator stores a seed derived from the operation key and
chooses a supported mechanism and healthy account deterministically per cycle.
Reusing that key in a fresh equivalent fixture reproduces the sequence; repeating
it in the same runtime returns the existing job. Explicit `fault_mode` remains
available to the local test harness. A timeout may need readback only, with no
repair write when the original commit already succeeded.

## Verification and operating limits

Final suites pass **253 tests: 52 JavaScript, 163 Python, 9 HTTP integration and
29 black-box acceptance**, including a fresh source read paused for seven
seconds. Acceptance completed in 984.409 seconds. The harness uses public HTTP
and independent fixtures; it does not import the engine or read its database.

The final stress run completed **1,001 continuous recovery cycles in 50 isolated
20-cycle batches** (one batch completed an extra in-flight cycle before Stop):

| Measurement | Result |
| --- | ---: |
| Stress elapsed time | 905.778 seconds |
| New incidents, including 50 one-shot controls | 1,051 |
| Maximum sampled runtime storage | 63.77 MiB |
| Maximum sampled engine RSS | 355.89 MiB |
| Maximum sampled collector backlog / dropped events | 0 / 0 |
| Synthetic fixture source reads | 99,036 |

Each batch retained its original partial incident and retry budget, kept its
100 transaction references unchanged, and matched the completed cycle count to
distinct repaired incidents in the complete export. Restart, actual gates and
cross-page exports were checked through public HTTP. These accelerated local
fixture measurements do not establish production throughput or Adapty HTTP cost.

The independent Sol Max review closed episode-ownership races, restart/preflight,
immutable receipt association, bounded simulation resume and nullable-v2 DTO
issues. Snapshot-backed traces also preserve fast failure/recovery evidence
before an audit tick; late receipts use exact processing identity and gate
observations use exact local revision tuples. Collector and
audit ownership is claimed with incident creation in one
SQLite transaction. The confirmed cohort is bound with its snapshot before a
restart can resume an approved execution. Concurrent scans recheck ownership
before committing their immutable hash and selected accounts. A partial incident
keeps its remaining account and retry budget when other healthy accounts enter
new episodes. The retained standalone automatic harness also passed the original
24/24 downstream recovery and three additional randomized incidents.

Actual Adapty replay verified 100 current seeded rights, 76 normal handler
applications and 24 actual local failures in one incident: 23 gates restored and
one unresolved. Restart preserved that result; two later incidents on other
accounts also recovered. Desktop at 1280px and 390px, keyboard Start/Stop, trace
details and both downloaded exports passed. The `[2026-11-08, 2026-11-09)` UTC
export contains all three
incidents while the UI shows only the one needing attention. See
[the connected demo guide](LIVE_ADAPTY_DEMO.md).

Full immutable evidence has a cost: a separate earlier 100-cycle isolated checkpoint
used 275 MiB of runtime storage and about 778 MiB engine RSS after full export,
in 482 seconds. Generation stops at the 512 MiB engine DB/WAL threshold;
history is never automatically erased. The final 1,000-cycle test uses fifty
isolated 20-cycle batches with at most four concurrent, preserving history and
measuring each runtime independently. The separate long-history checkpoint
retains its complete assertions and artifact. This does not prove 1,000 incidents
fit in one DB. Five-millisecond test polling was reduced to 50 ms to avoid
overloading the local HTTP monitor.
The four-runtime limit follows the measured 10-core host and roughly 300 MiB
combined RSS per completed 20-cycle runtime; source fixtures remain isolated.
Source cooldown and the 60-second full-source cadence remain unscaled.

Evidence: `.artifacts/fulfillment-{regression,integration,acceptance}-final.log`,
`fulfillment-live-tip.json` (current replay), `fulfillment-live-final.json`
(earlier restart/browser proof), `fulfillment-stress.json`, the paired SDK benchmark,
and browser CSV/JSON/screenshots. Stress source counters belong to local synthetic
fixtures. The real replay observed 299 physical Adapty requests during its interval,
including background passes; that is not a universal marginal cost per incident.

## Next improvements, ranked

1. Confirm real provider/store sandbox behavior and receive authenticated source
   updates, with targeted verification and backfill. Current-profile polling of
   a known registry cannot establish complete payment history.
2. Deliver and test the thin native adapter, authenticated account binding and
   device/UI observations alongside the existing backend gate.
3. Deduplicate immutable evidence, stream large exports and define retention
   before production volume. Keep explicit coverage when source or telemetry
   budgets are exhausted.
4. Run the Adapty pilot: measure diagnosis/recovery time, manual steps and false
   conclusions, then validate pricing and operational ownership.

The live demo continues to use official synthetic purchase records. It verifies
entitlement delivery and local access, not independently verified money. Native
mobile integration, real store checkout, production transport and customer
willingness to pay remain outside the demonstrated result.
