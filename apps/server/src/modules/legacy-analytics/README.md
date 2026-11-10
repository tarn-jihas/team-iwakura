# Legacy analytics demo adapter

This module is the TypeScript port of the analytics reconciliation mock (`reconcile-mock-first-kit/reconcile_mock.py` in the Python runtime; the scenario is described in that directory's [README](../../../../../reconcile-mock-first-kit/README.md#legacy-analytics-mock)). It backs the `/analytics.html` page. `referenceDirectory` is the folder of sample payloads listed by `/api/samples`; by default `reconcile-mock-first-kit/reference` under the process working directory.

`AnalyticsDemo.create({ databasePath, referenceDirectory? })` creates or reopens a dedicated, scope-marked SQLite demo database. `handle(method, url, parsedBody?)` returns `{ status, contentType, body }`; JSON endpoints return an object and export endpoints return NDJSON text. `close()` releases the SQLite worker.

The adapter handles `/api/report`, `/api/preview`, `/api/verify`, `/api/evidence`, `/api/audit`, `/api/manifest`, `/api/history`, `/api/operations`, `/api/samples`, `/api/sample`, `/api/detect`, `/api/approve`, `/api/apply`, `/api/map`, `/api/reset-mappings`, `/api/reset`, `/api/advance-clock`, `/mock/adapty/*`, and `/mock/mixpanel/*`. State writes are serialized and committed as a single SQLite transaction. There are no provider/network calls.

The monolith HTTP layer must keep its loopback same-origin write guard, JSON content-type check and bounded body parser. This adapter receives an already parsed body and does not start an HTTP server. `/api/access/*`, `/api/collector/events` and `/mock/lumen/export` belong to the [legacy access adapter](../legacy-access/README.md); static web assets are served elsewhere.

The seed amounts and import validation use exact decimal arithmetic rounded half-even to match Python `Decimal.quantize(Decimal('0.01'))`; imported `price_local` is limited to values exactly representable in cents. The fixtures use bounded values. This does not claim parity for arbitrary Python `Decimal` inputs outside that domain.
