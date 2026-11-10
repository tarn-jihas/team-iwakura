# Benchmarks

Local measurements for the TypeScript runtime. Build first (`npm ci && npm run build:ts`
at the repository root) and run the scripts from the root. Each prints a JSON report,
uses fresh temporary SQLite databases and loopback ports, and contacts no remote endpoint.

| Script | Purpose |
| --- | --- |
| `sdk-overhead.mjs` | SDK and collector overhead only. |
| `recovery-cycle-stress.mjs` | End-to-end recovery cycles across the provider, Lumen and engine modules. |
| `rss-probe.mjs` | Helper, not run directly. The stress harness preloads it into the provider and Lumen processes so they report their memory use. |

Recorded results are in [`docs/VERIFICATION.md`](../../../docs/VERIFICATION.md).

## SDK overhead

```sh
node apps/server/benchmarks/sdk-overhead.mjs [--events 1000]
```

Emits events through `@reconcile/server-sdk` to a local collector, once with plain events
and once with traces enabled. `--events` accepts 1,000 to 10,000. The report covers payload
and HTTP body sizes, accepted, queued, dropped and retried counts, flush time, event-loop
delay, process memory and SQLite storage size. It is not a production performance guarantee.

## Recovery-cycle stress

```sh
node apps/server/benchmarks/recovery-cycle-stress.mjs
```

The script runs 1,000 real, two-account recovery cycles and then a second isolated 100-cycle
history/export checkpoint. Each suite starts the TypeScript provider and Lumen services as
independent local processes with fresh temporary SQLite databases. It injects faults through
Lumen's signed demo route, detects them with the source-backed fulfillment scanner, executes
approved recovery actions through the signed Lumen adapter, and verifies each resulting gate.
The fixtures use an explicitly unverified synthetic active overlay; the output preserves that
payment-provenance limitation.

The report includes cycle latency, sampled peak RSS for the harness and both services, per-database
and WAL growth, signed provider profile reads observed at the local transport proxy, source-read
failures, and event-loop delay. The separate history checkpoint checks all 100 exported incidents,
verifies their gate outcomes, rejects an update to immutable fulfillment history, and compares a
second export against the first. No remote endpoint or shared demo database is used.

`RECOVERY_STRESS_CYCLES` may increase the stress-suite count; values below 1,000 are rejected so
the required full-run size cannot be silently lowered. The report labels this as an integration
stress because it imports engine modules; it is not a black-box UAT.

For a three-cycle end-to-end check, use `node apps/server/benchmarks/recovery-cycle-stress.mjs --smoke`.
For a 100-cycle measured sample before the full run, use `node apps/server/benchmarks/recovery-cycle-stress.mjs --sample`;
its output is labeled `measured_sample` and it does not satisfy the 1,000-cycle stress requirement.
