# Reconcile — interactive product prototype

A browser-only subscription reconciliation workspace built from synthetic Google Orders, Adapty projection and Mixpanel fixtures. No provider credentials, external MCP servers or model API are used.

## What runs

- A deterministic browser engine parses supported files, preserves USD numeric lexemes, uses BigInt minor units, distinguishes delivery retries from duplicate economic events and returns raw evidence.
- Six bundled scenarios and a separate Google Orders ↔ Adapty reference comparison.
- Cases, source inventory, three-step import, findings, operations, evidence drawers, local run history and report/evidence downloads.
- Browser-local review states and saved cases, with a 20-run history limit per case.
- Clearly labelled simulated AI explanations/tool traces derived from calculated findings.

## Scope

Google Play, USD, one explicitly chosen app namespace, documented cash-event subset and full-refund fixture convention. Inputs are capped at 10 MiB and 5,000 source records. Unsupported partial-refund history, conflicting delivery identities, malformed money, currencies and scope mixtures are rejected. Uploaded files are labelled user supplied and default to unknown coverage.

The browser fingerprint is an FNV demonstration identifier, not a cryptographic digest. The planned Node/TypeScript glorious monolith, durable server manifests, SHA-256 evidence, real MCP transport and model adapter are specified in the linked Google Doc and are not implemented by this static prototype.

## Development

Static assets are under `dist/`. No dependency installation or build is needed. Serve that directory with the Sites preview workflow or any standard static server.

Run `node --test tests/engine.test.mjs` for 19 focused financial/format checks. The expectation values in tests do not ship in the browser runtime.

Source provenance: organisers' seed commit `77d39ed807a66bbebcf24fe67c42be4fc9ef4c82`. `dist/data/projection_contract.json` records fixture assumptions and `dist/data/sources.json` links the official format references.
