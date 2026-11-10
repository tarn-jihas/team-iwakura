# Browser UI

This directory holds the hand-written browser UI for Reconcile: plain HTML, CSS
and JavaScript modules with no dependencies and no build step.

`dist/` is the editable source, not build output. It is used in two ways:

- The Python runtime serves it directly. `reconcile-mock-first-kit/recovery_service.py`
  (and the older `reconcile_mock.py`) read files from `dist/` on each request.
- The Preact app in `apps/web` imports the stylesheets (which load the fonts)
  and the fixture data from `dist/`, so changes here affect both runtimes.

Tests run from the repository root and no configuration is needed. See the
[root README](../README.md) for how to start the demo.

## Pages

Each page is a small HTML shell that loads one script. Paths are as served by
the Python runtime.

| Page | Served at | What it is | Script |
| --- | --- | --- | --- |
| `recovery.html` | `/` and `/recovery.html` | Main demo: the access recovery monitor. Shows the incident feed, starts and stops demo runs, opens an incident's steps and exports activity as CSV or JSON. Uses `/api/recovery/monitor`, `/simulation`, `/fulfillments`, `/incidents/…/trace` and `/export`. | `monitor-app.js`, `monitor-view.js` |
| `recovery-console.html` | `/recovery-console.html` | Advanced recovery tools: the manual, approval-gated flow (open an incident, scan, plan, approve, execute, inspect evidence), with Lumen and lab sections for trying the gate and injecting faults. Uses the other `/api/recovery/*` routes. | `recovery-app.js`, `recovery-view.js` |
| `access.html` | `/access.html` | Cancellation recovery demo: detect, preview, approve, apply and verify for accounts affected by a faulty cancellation handler. Uses `/api/access/*` and `/mock/lumen/export`. | `access-app.js`, `access-view.js` |
| `index.html` | `/analytics.html` (and `/index.html`) | Analytics evidence workspace for the legacy analytics mock: findings, approval, apply, verification, audit and provider sample payloads. Uses `/api/*` and `/mock/*`. | `mock-app.js`, `mock-view.js` |
| `legacy.html` | `/legacy.html` | Offline fixture lab. Runs entirely in the browser: `engine.js` parses and compares the files in `dist/data`, and review state and run history are kept in browser storage. Makes no API calls. | `app.js`, `engine.js` |

When `reconcile_mock.py serve` is run on its own (`npm run start:legacy`), `/`
is `index.html` and only the `access.html`, `index.html` and `legacy.html`
pages have a working backend.

## Fixture data

`dist/data` contains small synthetic files used by the offline fixture lab and
imported by `apps/web`. None of it is captured provider data.

| File | Contents |
| --- | --- |
| `adapty.jsonl` | Provider-side events used as the reference in each scenario. |
| `zero_net_two_errors.jsonl`, `missing_refund.jsonl`, `double_tracking.jsonl`, `repeated_delivery.jsonl`, `price_unit_error.jsonl`, `clean.jsonl` | Analytics-side export for each of the six bundled scenarios. |
| `google_orders.json` | Store orders for the separate store-to-provider comparison. |
| `projection_contract.json` | The assumptions behind the fixtures (amount basis, refund convention, identity mapping, what is omitted). |
| `sources.json` | Links to the public format references and the organisers' seed revision the fixtures derive from. |

The offline lab accepts uploads up to 10 MiB and 5,000 records, in USD only,
and rejects inputs it cannot interpret safely, such as partial-refund history.
Its content fingerprint is a non-cryptographic demonstration identifier.

## Design

The design tokens are CSS custom properties in the `:root` block of
`dist/styles.css`. The rest of that stylesheet is also part of the design:
component states, spacing, sizing, typography and responsive rules, some with
values set directly in component rules rather than as named tokens. The
page-specific stylesheets (`monitor.css`, `mock.css`, `access.css`,
`recovery.css`) build on it.

The primary typeface is Inter; Manrope is also bundled. Font files and their
SIL Open Font Licenses are in `dist/fonts/`. Icons are implemented inline where
they are used.

## Tests

`tests/` contains Node tests for the browser modules: the offline comparison
engine (`engine.test.mjs`), the monitor page's rendering and polling lifecycle
(`monitor-view`, `monitor-lifecycle`) and the view helpers of the other pages
(`recovery-view`, `access-view`, `mock-view`). They run with the built-in Node test runner as the first part of
the root command:

```sh
npm test
```

To run only these tests: `node --test Reconcile/tests/*.test.mjs` from the
repository root.
