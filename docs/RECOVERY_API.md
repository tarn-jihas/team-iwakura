# Local recovery API and ownership

All endpoints below belong to the local demo, not Adapty's public API. The
engine listens on loopback, rejects cross-origin mutations and serves only
allowlisted frontend assets. Internal adapter calls and collector delivery use
HMAC. Runtime databases and signing material are not exposed through static URLs.

## Automatic monitor API

The live launcher enables policy `local-entitlement-resync-v1`. A signed customer
denial triggers diagnosis and an exact policy-authorized resync/probe plan. The
policy never authorizes provider writes or grants; evidence checks and durable
action receipts remain mandatory. The manual API below stays available for
regression scenarios and advanced investigation.

| Method / path under `/api/recovery` | Input or meaning |
| --- | --- |
| `GET /monitor` | Compact connection, automation, incident summary, SDK coverage, simulation progress and complete incident history; no external Adapty request per UI poll |
| `POST /simulation` | `{action: "once" or "start", operation_key: "unique-id"}`; runs one random local incident or three sequential examples; duplicate keys reuse the job |
| `POST /simulation` | `{action: "stop"}`; prevents further injections while current recovery finishes |

Monitor incidents use `detecting`, `repairing`, `repaired` or `unresolved` and
include `detected_at`, `repair_started_at`, `repaired_at`, `duration_ms`, affected
and repaired account counts, a description, repair summary and next step.
Terminal history comes from durable results; a later failure for the same
account does not rewrite an earlier successful recovery. CSV/JSON export uses
these incident rows. UTC timestamps remain exact in exports.

```text
SDK event → scan → policy check → resync → gate verification → incident result
```

## Advanced operator API

The base path is `/api/recovery`. Requests and responses are JSON. Invalid input
is rejected; changed evidence/plan/scope returns a conflict rather than a repair.

| Method / path | Input or meaning |
| --- | --- |
| `GET /report` | Current incident summary, accounts, coverage, plans, actions and jobs; optional `incident_id` selects one incident |
| `POST /incidents` | `user_id`; optional UTC `occurred_at`, `window_start`, `window_end`, and matching `app`, `environment`, `run_id`; returns 202 with `incident_id`, `job_id` |
| `POST /scans` | `incident_id`; returns 202 with a new scan job |
| `GET /jobs/{id}` | `queued`, `running`, `completed` or `failed`, with result/error |
| `GET /snapshots/{id}` | Immutable evidence, collection times, source versions, coverage and snapshot hash |
| `GET /evidence?user={id}` | Account evidence and source-only history when available |
| `POST /plans` | Exact `ids` and `incident_id`; returns entries, human steps, preconditions, TTL and `plan_hash` |
| `POST /approvals` | `plan_id`, `plan_hash`, `actor`; durably records approval without executing writes |
| `POST /executions` | `plan_id`, `plan_hash`; whole-plan preflight, then 202 with job ID |
| `GET /audit` | Detailed report and action receipts; optional `incident_id` scopes that report, while snapshots, approvals and journal retain complete run history |
| `GET /journal` | Latest 500 orchestration journal entries |
| `POST /lumen/export` | `user_id`, optional `feature`; proxies the actual Lumen premium gate (200/403) |
| `POST /collector` | Versioned SDK envelope plus `X-Reconcile-Signature` |
| `POST /demo` | Explicit local reset/clock/fault controls, enabled only in demo mode |

Typical operator sequence:

```text
incidents → poll jobs → report → plans → approvals → executions → poll jobs → report
```

Diagnostic scans run without repair approval. An execution job completing means
all attempted steps have recorded outcomes; it does not mean every access was
restored. Use `recovery.activation_verified`, `access_verified`, `unresolved`
and action statuses. Previewing a retry does not erase earlier verified results.

Action statuses distinguish `accepted`, `verified`, `failed`, `unknown_outcome`,
`blocked` and `awaiting_client_action`. Each action identifies owner, account,
target, preconditions, start/finish time, evidence reference, result and next step.
An unknown gate is represented by `null`, never inferred as a deny or allow.

## Service responsibilities

| Owner | Contract and responsibility |
| --- | --- |
| Provider/Adapty simulator | Independent account/payment evidence, paginated historical observations, catalog/profile reads and simulated validation; owns provider and Adapty stores |
| Engine | Snapshot/classification/cohort, immutable plan, approval, preflight, durable intent, readback and verified report; owns engine store |
| Lumen | Account registry, projection/cache, idempotent revision-bound resync and the shared premium/probe authorization decision; owns Lumen store/outbox |
| Automatic policy / operator | Authorizes the exact supported local plan automatically in live mode; operator review remains required for manual regression flows |
| Mobile simulator | Untrusted observation references forwarded to its backend; cannot confirm payment or repair licences |

The Lumen adapter implements `listAccounts(cursor)` as
`GET /internal/lumen/accounts?cursor=...&limit=...`, `readAccess` as
`GET /internal/lumen/access?user=...`, `probeAccess` as
`POST /internal/lumen/probe`, and `resyncAccess` as
`POST /internal/lumen/resync`. Resync requires `user_id`, `expected_revision`,
`entitlement` (including its hash) and `operation_key`. Lumen independently reads
Adapty before applying it. `GET /internal/lumen/action?operation_key=...` supports
readback after an ambiguous result. All these adapter calls are signed.

The executable Python SDK lives in `recovery_sdk.py`: schema v1 validation,
canonical signing, HTTP transport and bounded durable outbox. `emit()` only
enqueues; a background worker calls `flush()`. See the
[mobile contract](MOBILE_CONTRACT.md) for the thin device boundary.

The local mobile simulator accepts `POST /mobile/events` on Lumen with
`event_id`, `user_id`, `kind`, `occurred_at`, and allowlisted `details`.
Kinds are `purchase_succeeded`, `subscription_profile_updated`, and
`access_denied`. Production must derive the account from an authenticated session;
this unauthenticated loopback simulator is not deployable as a public endpoint.

Stripe and Paddle validation have distinct request serializers in
`recovery_contracts.py`. Custom validation is an explicitly local contract.
Apple/Google device-required cases remain blocked on the required client action.
There is no generic grant-premium fallback.
