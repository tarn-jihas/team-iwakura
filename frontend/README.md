# Reconcile frontend · React + TypeScript modular monolith

A port of the original string-template UI (`Reconcile/dist/*.js`) to React 18 + TypeScript (strict),
built with Vite. **Same look, same behaviour:** it imports the original `styles.css`, `mock.css`,
`access.css` and fonts unchanged and renders the same markup and class names. The Python server and
its HTTP API are unchanged; the legacy fixture lab is shipped as-is.

## Run

```sh
npm install --prefix frontend          # once
npm run seed                           # fresh demo state (server stopped)
npm run build:web                      # builds into Reconcile/web/
npm run start:web                      # serves the React build on http://127.0.0.1:8765
```

`npm start` still serves the original UI from `Reconcile/dist/`. Development with hot reload:
`npm start` in one terminal, `npm --prefix frontend run dev` in another (http://127.0.0.1:5173,
API calls proxied to 8765).

## Structure

```
frontend/src/
  shared/                 shared kernel: API client, money format, icons, Badge/Button/Heading,
                          Drawer (modal: inert app, focus trap, Escape), toast, download, async runner
  modules/analytics/      RCN-001 workspace: Cases, case page (findings, operations, receipt,
                          review panel), Sources, Demo Lab, Evidence / Runs, all dialogs
  modules/access/         ACCESS-001 Paid Access Recovery: incident, accounts, repair & verify,
                          scope, Lumen client simulator, sources / collector, history, dialogs
  entries/                workspace.tsx (index.html) and access.tsx (access.html)
```

Rules (enforced by `tests/unit/architecture.test.ts`):
- a feature module never imports another feature module;
- `shared` never imports a feature module;
- code outside a module imports only its public `index.ts`.

Each module owns its own API client with an allow-list of routes
(`analytics`: `/api/`, `/mock/`; `access`: `/api/access/`, `/mock/lumen/`).

## Tests

| Command | What it covers |
|---|---|
| `npm run test:web` | Vitest: ported view/domain tests, architecture rules, component tests on captured API fixtures (approval gating, dialog, markup) |
| `npm run test:e2e` | Playwright (local Chrome): both README walkthroughs against the real server on port 8767 |
| `E2E_UI=dist npm run test:e2e` | The same walkthroughs against the original UI: parity check |
| `npm test` | Unchanged repo suite (JS view tests + Python tests) |

The e2e tests reset the demo through the UI first and leave it in its repaired end state.
Run `npm run seed` (server stopped) before presenting.

## Server changes

- `RECONCILE_STATIC=web` selects `Reconcile/web/` as the static folder (default stays `Reconcile/dist/`).
- Listen backlog raised to 64. Each UI action fires ~7 parallel reads; with the stdlib default of 5,
  macOS intermittently reset a connection and the browser showed "Failed to fetch" (reproduced on
  both the original and the React UI in ~25% of e2e runs; 0 of 16 after the fix).
