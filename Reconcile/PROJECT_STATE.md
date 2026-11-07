# Adapty Reconcile — prototype checkpoint

Status: interactive browser prototype has public Site access. The compact application UI is implemented and verified for publication; it supersedes the Adapty marketing-site composition below.

Implemented: six synthetic Adapty/Mixpanel scenarios; separate Google/Adapty lane; deterministic exact-money comparison; file import; case and source lists; evidence; local run snapshots and review states; JSON export; explicitly simulated AI/tool flow.

Architecture boundary: browser-only prototype. Production Node/Fastify + React/Vite glorious monolith, same-process MCP, server storage and model integration are documented proposals, not active runtime features.

Invariants: no third-party MCP or provider credentials; no oracle in dist; transaction and delivery identities differ; minor-unit strings/BigInt; raw JSONL preserved; original source bytes exported; incomplete coverage is inconclusive; review status does not change result.

Validation: 19 node:test checks passed. Browser QA covered default zero-net, evidence, explanation simulation, retry dedup, new case with unknown coverage, reload persistence, actual JSONL file chooser/import, downloaded JSON report contents, Google reference case, and a 390px iframe responsive layout including evidence.

Changes after review: block conflicting delivery IDs and partial-refund histories; identity conflicts before financial findings; exact money token scanning; strict numeric types; invalid leading-zero JSON rejected; raw display formats whitespace without re-parsing money.

Limits: USD, Google Play namespace, 10 MiB/5,000 records per upload; 20 browser-local runs/case; demo non-cryptographic fingerprint; no shared backend/MCP/model.

Next: publish the verified visual update through the existing public Site release workflow. A later implementation should port contracts/core to the documented monolith and replace browser persistence and simulated AI with real service calls.


## State checkpoint — Adapty visual overhaul, 6 November 2026

Task/status: implementation and focused desktop/mobile verification complete; ready for the public Site release. The user expanded the request from a palette update to a full match of Adapty’s shapes, colours, typography and public-site composition.

Verified source: live https://adapty.io/ CSSOM/computed styles and reference screenshot captured on 6 November 2026. The implementation uses actual first-party Inter and Manrope WOFF2 files, their OFL licences and source fallback metrics. Body/UI uses Inter; headings use Manrope 600. Only these two used font assets are preloaded.

Visual changes: replaced the vertical sidebar with a light 64px horizontal header; centred content at 1080px; introduced the source’s two-column 48px hero with exact purple text gradient; reused the observed aurora gradient and curved notch SVG geometry; framed the functioning workspace with 20px corners and neutral surfaces. The desktop Investigation panel uses the observed #242320 dark agent surface with #efede7 foreground. Cases, Sources, Method, evidence, imports, report dialogs, controls, badges and toasts use the same semantic system.

Exact base colours: canvas #fafaf9, cards #fff, foreground #363630, muted #64645d, border #e5e5df and primary #6f50fa. Primary controls use the live source sheen, shadows, actual modern hover colour mix, focus ring, 36px medium height and 10px radius. Source success #12640b, destructive #dc3847, red-700 and yellow-500 remain semantic; light status fills and the warning text tone are explicitly derived from source primitives. Dense evidence text, the responsive workspace arrangement and status tint recipes are local product adaptations.

Files changed: dist/styles.css (consolidated semantic rules and full composition), dist/index.html (theme colour and font preloads), dist/app.js (presentation-only header/hero/workspace/footer helpers, navigation markup, two named type utilities), dist/fonts/ (Inter/Manrope assets and licences), this checkpoint.

Decisions and invariants: exact comparison engine, fixtures, input/output schemas, localStorage, review and report semantics are untouched. Every prior data-action and data-bind value remains present. Source provenance, synthetic evidence and simulated AI/tool labels remain visible. Production monolith, model and MCP transport are still proposed work, not active runtime capabilities. Overlay pointer-event forwarding, focus outlines/trap hooks, z-index hierarchy, scroll containment and reduced-motion handling remain intact.

Validation: node --check dist/app.js → passed; git diff --check → passed; static declaration inspection → no undefined CSS custom properties; action/binding inventory comparison → no missing values. Root independently ran the existing engine gate (19 tests passed) and confirmed the real font assets load in the browser. Root’s first desktop screenshot of the full overhaul matched the reference composition; a mobile-toggle cascade issue was corrected with a header-qualified selector. Root verified the desktop case, evidence drawer, close behaviour, Sources navigation, import mode and disabled Continue state. A 390px iframe check verified the responsive hero, navigation open/close through destination selection, Method page and contained import modal. Page width equals document scroll width at desktop and mobile sizes. The desktop mobile-menu toggle is confirmed hidden. Independent diff review found no functional blockers; all domain handlers and engine/data remain unchanged.

Scope notes: exact source hover colours were retained to satisfy the requested visual fidelity; this is not an accessibility conformance claim. No live provider/model/MCP integration was introduced. Publication uses the existing public audience and URL.

## State checkpoint — compact application UX, 6 November 2026

Task/status: requested UX simplification is implemented, reviewed and visually verified, ready for the existing public Site release.

Decision: Reconcile is a working reconciliation interface. The previous oversized hero, gradient stage, curved notch, nested app frame and marketing footer are removed. The existing font assets and restrained purple accent remain within a neutral, compact application shell.

Files changed: dist/app.js, dist/styles.css, this checkpoint. No dependencies, reconciliation engine, fixture files or hosting audience changes.

Behaviour: initial load opens Cases while retaining the selected case and its active run. A 204px sidebar provides Cases, Sources, the Google Play reference check, Method & scope and the specification. Compact case headers expose review/run/export controls; findings have an explicit Evidence action. The simulated assistant is a secondary light panel. Sources → Import source opens upload mode with unknown coverage; Cases → New case retains the demo default. At 620px and below, Cases and Findings become stacked rows with visible outcome/impact and actions; detailed operation tables retain contained scrolling.

Invariants: engine arithmetic, parsing, evidence provenance, saved runs, review semantics, export formats and browser persistence schema remain intact. All existing action and binding names are retained. Synthetic/local-file and no-model labels remain visible; this is still the browser-only prototype.

Validation: independent read-only diff review passed; node --check dist/app.js and git diff --check passed. Browser QA confirmed Cases-first entry, case search, case detail, explicit Evidence action, drawer Escape close, simulated explanation, and 390px sidebar navigation to Sources. The narrow Cases layout has no page overflow. Mobile evidence drawer and import dialog are contained; Import source opens file-upload mode with Continue disabled before a file is chosen. Existing browser-local cases, review status and run counts were visibly retained. The temporary iframe QA harness was removed before packaging. No broad engine test suite was rerun for this presentation change.

Open risks/blockers: none observed in the changed UI. Full file parsing and provider integrations were outside this presentation change.

Next exact action and owner: root packages and publishes the verified source to the existing public Site and URL.
