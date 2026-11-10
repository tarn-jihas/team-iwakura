# TypeScript server SDK

`@reconcile/server-sdk` is the SDK an application backend uses to report signed
access events (for example a Premium gate decision) to the Reconcile collector.
It is the supported SDK for the TypeScript runtime and a breaking change for
integrations using the Python SDK (`reconcile-mock-first-kit/recovery_sdk.py`);
their existing outbox databases are not imported or reset. Use a new, private outbox file and
configure the same app, environment, run ID and signing key as the collector.

Create a `CollectorSDK` with `key`, `runId`, `app`, `environment`, `outboxPath`
and either `collectorUrl` or a custom `transport`. The built-in HTTP transport
currently accepts only a loopback collector URL. `emit(kind, userId, occurredAt,
details, options)` validates and persists an event without making a network
request. Supply a stable `eventId` when replaying a durable application receipt.
Run `flush()` from a background worker and observe `coverage()` for queued,
failed, retried and dropped events. A successful emit does not prove a purchase,
grant access, or establish that a premium operation succeeded.

The SDK supports version 1 events and bounded version 2 traces through the
types in `@reconcile/contracts`. Do not include tokens, receipts, request bodies
or arbitrary exception text. Validate any application-specific identifiers before
emission and keep telemetry failures from breaking purchase or gate handling.
The local Lumen service demonstrates durable receipts committed with projection
updates and forwarded after restart.

The outbox has bounded capacity and retries. Enqueue performs synchronous
`node:sqlite` operations; Node 22 marks this API experimental. Measure latency
and consider a worker-thread integration for a latency-sensitive application.
The [SDK benchmark](../../apps/server/benchmarks/README.md) measures the local
collector only.

From the repository root, after `npm ci`:

```sh
npm run build --workspace @reconcile/server-sdk
npm test --workspace @reconcile/server-sdk
```
