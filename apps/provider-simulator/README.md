# Provider simulator

`@reconcile/provider-simulator` is an independent loopback HTTP process with its own SQLite file. It uses the server package's signed HTTP verification, SQLite worker, Adapty normalizer, and persisted source cooldown reader.

## Mock mode

Mock mode is the default. It verifies and reads the pinned `reconcile-mock-first-kit/fixtures/hackathon/lumen_dataset.json.gz` fixture, then persists the first 100 fixture IDs as a reproducible sample. Internal IDs use `lumen_<run>_<source index>`; each record keeps the official source ID in `source_user_id` and in the normalized raw profile. Current entitlements are derived through `normalizeProfile`, not from a cohort label. The fixture provenance and `unverified_synthetic_history` payment status remain visible in the manifest and profile.

The local demo launcher sets `PROVIDER_ACTIVE_OVERLAY=true` to append one explicitly synthetic active entitlement per account; original fixture transactions remain intact. These generated references do not prove real charges. The default provider mode leaves the original lifecycle unchanged.

## Live mode

Set `PROVIDER_MODE=live` and `PROVIDER_LIVE_CONFIG` to a private-scope config containing the fixed Lumen app identity, a `seed` with `revision` and `run_prefix`, exactly 100 unique `customer_user_ids`, and an absolute `secret_key_file`. The private Adapty API key is loaded with the existing no-follow, permission-checked reader. The provider does not write to Adapty. Every profile read uses one `AdaptyReader` over the provider's SQLite database, so its persisted Retry-After deadline applies across profile routes and process restarts. Cooldown and source failures return unavailable responses; profile data is never substituted from cache.

## HTTP contract

All routes require `recovery-internal-v1` HMAC headers and accept loopback traffic only:

- `GET /internal/manifest`
- `GET /internal/provider/accounts?cursor=&limit=500`
- `GET /internal/adapty/profiles?cursor=&limit=500`
- `GET /internal/adapty/profile?user=<customer-id>`

The pages return `items`, `next_cursor`, and `total`; limits are bounded to 1–1000. Profile reads are scoped to the account/customer registry. The service has no provider write routes.

## Run

Build the shared server package first so its exported NodeNext files exist, then build or test this workspace:

```sh
npm run build --workspace @reconcile/server
npm run build --workspace @reconcile/provider-simulator
npm test --workspace @reconcile/provider-simulator
```

Provide `RECOVERY_KEY_FILE` and optionally `PROVIDER_PORT`, `PROVIDER_DB`. Mock-specific settings are `PROVIDER_RUN_ID`, `PROVIDER_SAMPLE_SIZE`, and `PROVIDER_FIXTURE_DIR`. Live mode additionally needs `PROVIDER_LIVE_CONFIG`. The default bind is `127.0.0.1:8767`; the default database is `runtime/provider-simulator.sqlite3`. Reusing a database with a different run or scope fails closed; create a separate database for a new scope.

This slice does not port catalog/action/validation writes, provider evidence/history, demo reset/fault routes, or the legacy Stripe/Paddle provider endpoints.
