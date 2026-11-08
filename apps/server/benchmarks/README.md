# Recovery-cycle stress harness

Run this separately from `sdk-overhead.mjs` after building the TypeScript workspaces:

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
