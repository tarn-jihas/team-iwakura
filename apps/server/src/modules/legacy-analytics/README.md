# Legacy analytics demo adapter

`AnalyticsDemo.create({ databasePath, referenceDirectory? })` creates or reopens a dedicated, scope-marked SQLite demo database. `handle(method, url, parsedBody?)` returns `{ status, contentType, body }`; JSON endpoints return an object and export endpoints return NDJSON text. `close()` releases the SQLite worker.

The adapter handles `/api/report`, `/api/preview`, `/api/verify`, `/api/evidence`, `/api/audit`, `/api/manifest`, `/api/history`, `/api/operations`, `/api/samples`, `/api/sample`, `/api/detect`, `/api/approve`, `/api/apply`, `/api/map`, `/api/reset-mappings`, `/api/reset`, `/api/advance-clock`, `/mock/adapty/*`, and `/mock/mixpanel/*`. State writes are serialized and committed as a single SQLite transaction. There are no provider/network calls.

The monolith HTTP layer must keep its loopback same-origin write guard, JSON content-type check and bounded body parser. This adapter receives an already parsed body and does not start an HTTP server. `/api/access/*`, `/api/collector/events`, `/mock/lumen/export`, and static web assets were owned by separate legacy/backend paths and are not implemented here.

The seed amounts and import validation use exact decimal arithmetic rounded half-even to match Python `Decimal.quantize(Decimal('0.01'))`; imported `price_local` is limited to values exactly representable in cents. The fixtures use bounded values. This does not claim parity for arbitrary Python `Decimal` inputs outside that domain.
