# Reconcile: automatic access recovery

The product promise is small: **notice a mismatch, restore access already
supported by Adapty, and show the verified result with its time**. Reconcile adds
the application side of that comparison: what the backend stored and what the
customer's premium gate actually allowed.

The Adapty CLI supplies setup and catalog inspection. The server SDK observes
application events. The engine compares independently read Adapty state with
Lumen state. The Lumen adapter applies a revision-bound resync and probes the
actual authorization gate. Keeping these responsibilities separate lets the SDK
remain small and keeps network recovery out of the customer request path.

## Why these failure examples

Adapty documents asynchronous webhook delivery, retries, duplicate delivery,
out-of-order events and delivery pauses after endpoint failures. A backend can
therefore miss or misapply an update even while the authoritative entitlement is
valid. These are documented mechanisms; we do not have incident-frequency data
showing which is most common. [Webhook delivery](https://adapty.io/docs/set-up-webhook-integration).

The demo emulates three local consequences: a stale cache, an unapplied access
projection, and old expiry data overwriting current access. Each changes actual
Lumen state and produces actual SDK/gate output. It does not claim that a real
Adapty webhook failed or that a payment was made during the demo. Adapty's
`access_level_updated` event is intended to keep backend access synchronized.
[Event contract](https://adapty.io/docs/webhook-event-types-and-fields).

Automatic recovery is limited to current, unambiguous, individually verified
entitlements. It retains snapshots, exact plans, policy decisions, preflight,
idempotency, readback and gate verification. The policy replaces the operator's
routine approval; it does not replace evidence checks. Unknown source, identity
conflicts, expired access and policy denial remain unresolved. No automatic
payment, refund, catalog mutation or new external licence grant is allowed.

## Measured SDK overhead

Reproduce from the repository root:

```sh
python3 reconcile-mock-first-kit/benchmark_sdk.py --events 500 \
  --output .artifacts/sdk-overhead.json
```

Measured on this Mac with Python 3.13.13 on 2026-11-07, using 500 representative
`feature_access_decided` events and the real durable SQLite outbox:

| Measurement | Result |
| --- | ---: |
| Enqueue p50 | 0.4136 ms |
| Enqueue p95 | 0.5414 ms |
| Collector unavailable, enqueue p95 | 0.6500 ms |
| Network requests during enqueue | 0 |
| JSON request body per gate event | 651 bytes |
| Successful local deliveries | 500/500 |
| HTTP delivery requests | 500 |

For this exact payload, 10,000 events produce 6.51 MB of JSON; 1,000,000 produce 651 MB.
Those figures exclude HTTP/TCP/TLS overhead, retries and source API reads.
Projection-change events can be larger. This is a local measurement of SDK
enqueue cost, not a production throughput or total application latency guarantee.
The outage sample uses an injected failing transport; enqueue never invokes it.
The delivery measurement uses actual loopback HTTP with signed events and checked
acknowledgement hashes.
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

The main screen is an incident feed: what happened, affected accounts, current
result, detection time and recovery duration. Details explain the actual repair
and any remaining work. CSV and JSON exports retain the incident identifiers,
timestamps, counts and evidence provenance. A repaired historical incident must
stay repaired in history if the same account later suffers a new incident.

Simulation is local, bounded and server-driven. It can run one random example
or a short sequence; stopping it prevents new faults while an in-flight recovery
finishes. The source app and synthetic transactions are not modified.

## Verification

The final local suites pass **182 tests**: 42 JavaScript, 109 Python, 8 HTTP
integration and 23 black-box acceptance tests. The automatic policy has twelve
focused cases, including source/identity changes before writes, restart without
duplicate actions, safe-subset retry remaining partial, Stop during source
refresh, late events, repeated faults and immutable completed history.

The independent review found and closed false-success, retry-budget, Stop and
history edge cases. A successful retry of one account cannot mark an incident
fully repaired if another account remains unresolved. Later diagnostic scans
cannot erase an earlier completed recovery or its completion time.

Evidence logs are `.artifacts/automatic-regression-final.log`,
`.artifacts/automatic-integration-final.log` and
`.artifacts/automatic-acceptance-final.log`. The live public-HTTP harness and
browser replay are documented in [the connected demo guide](LIVE_ADAPTY_DEMO.md).

The live demo continues to use official synthetic purchase records. It verifies
entitlement delivery and local access, not independently verified money. Native
mobile integration, real store checkout, production transport and customer
willingness to pay remain outside the demonstrated result.
