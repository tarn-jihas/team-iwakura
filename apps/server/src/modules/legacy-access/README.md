# Legacy access Demo Lab adapter

`AccessDemo.create({ databasePath })` opens a dedicated marked SQLite database, and
`handle(method, url, parsedBody, headers)` serves the retained `/api/access/*`,
`/api/collector/events`, and `/mock/lumen/export` routes. JSON responses include
`status`, `contentType`, and `body`. The adapter does not start an HTTP server or
call a provider; the monolith remains responsible for same-origin loopback checks,
JSON parsing/content-type, and request-size limits.

The module stores the complete demo snapshot and its integrity digest in its own
SQLite state row. Mutations use a revision compare-and-swap inside the storage
worker's short transaction, so a preflight and its projection, cache, journal,
receipt, and audit updates commit as one durable change. No network call runs in a
transaction. Existing database files must carry the access marker; unmarked files
are rejected without initialization.
