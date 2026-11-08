# Reconcile · local hackathon demo

A stateful, **FULL MOCK / SYNTHETIC DATA** subscription reconciliation workspace.
The supplied visual prototype is connected to the Python mock provider. Two cases
are available: analytics reconciliation and **Paid Access Recovery** with a working
mock Lumen app, collector SDK,100-account incident, approved resync and actual gate
verification.
All runtime reads and writes stay on `127.0.0.1`; no API keys or installs are needed.

## Run

Requires Python 3.9+. Node 18+ is used only for the retained JavaScript tests.

```sh
cd /Users/strahinja/Documents/personal/reconcile
python3 reconcile-mock-first-kit/reconcile_mock.py seed
python3 reconcile-mock-first-kit/reconcile_mock.py serve --port 8765
```

Open [http://127.0.0.1:8765](http://127.0.0.1:8765).
`npm run seed` and `npm start` are equivalent shortcuts. Stop with Ctrl+C.
Startup does not reseed an existing state. Restarting preserves repairs and audit.
Use **Demo Lab → Reset demo** to deliberately return to the initial state.
Access recovery seeds itself on first server startup and has a separate reset.
For an explicit clean seed of both flows, stop the server and run `npm run seed`.

## React UI (branch `react-migration`)

The same UI is also available as a React + TypeScript modular monolith in `frontend/`
(same CSS, markup and behaviour). `npm install --prefix frontend`, `npm run build:web`,
then `npm run start:web`. See [frontend/README.md](frontend/README.md) for structure and tests.

## Paid Access Recovery

Open **Cases → Open access incident**, or `/access.html`. Demonstrate the Lumen
premium-export denial, then Detect →100/94/24/6 → Preview → Approve → Apply →
Verify23/1 → Fresh retry → Verify24/0 → successful Lumen export. The source expiry
stays unchanged; six inconclusive accounts remain excluded; root cause is separate.

See the [full access demo and API/SDK contracts](docs/PAID_ACCESS_RECOVERY.md) and
[tested recovery evidence](docs/PAID_ACCESS_VERIFICATION.md).

## Demo walkthrough

1. Open the analytics case and click **Detect** to save a scan.
2. Confirm separate initial gaps: **USD +21.97**, **EUR +989.01**.
3. Inspect **Evidence** on missing purchase/refund, duplicate and price mismatch.
   The source price is 9.99 EUR; the raw destination price is 999.00 EUR.
4. Under the unmapped group, review evidence and **Accept local mapping** for
   `premium_paid_v2 → purchase`. It creates zero destination events.
5. Click **Review & preview**. Review exact payloads, row counts, signed effects
   and SHA-256 hashes. Check the three repair groups and explicit approval box.
6. Click **Approve selected groups**. This writes an approval, not destination data.
7. Click **Apply approved selection**. Four events are accepted and initially
   pending. The visible destination totals remain unchanged until the next tick.
8. Click **Advance mock clock**, then **Fresh read / Verify**. Mapping changes
   and new approvals are blocked while imported events are pending visibility.
9. Confirm **USD +11.98**, **EUR 0.00**. The ghost remains a manual investigation;
   the sandbox exclusion remains expected. No “all resolved” claim is made.
10. Inspect **Case receipt**, **Operations**, raw source exports and run snapshots.
    **Export audit receipt** includes approvals, action IDs and payload hashes.

**Effective metric contract:** query-time-deduped production events plus signed
`reconcile_correction` events, separately per currency. Corrections append events;
they never overwrite the wrong 999 EUR price or delete raw duplicate events.
This is analytical consistency, not recovered revenue or a real store refund.
The review assistant is a deterministic explanation and never uses a model key.

## Check

```sh
npm test
npm run check:access
python3 reconcile-mock-first-kit/reconcile_mock.py check
```

The test suite and `check:access` use isolated temporary state and loopback HTTP
servers. The analytics `reconcile_mock.py check` command intentionally reseeds
the demo and leaves it repaired; run `npm run seed`
afterwards to prepare a fresh presentation. Stop the server before running CLI
`seed` or `check`; use the UI's Reset action while the server is running.
The old engine's six control datasets
and Google reference comparison remain at **Demo Lab → Open legacy fixture lab**;
that separate browser lab is read-only with respect to the Python repair state.

## Layout and limits

- `Reconcile/dist/`: editable frontend source, original design system and fonts.
  `mock-app.js` is the API-backed main app; `app.js` / `engine.js` retain the old lab.
- `reconcile-mock-first-kit/reconcile_mock.py`: Decimal engine, mock providers,
  approval/apply/readback state and loopback HTTP server.
- `reconcile-mock-first-kit/paid_access.py`, `lumen_app.py`, `collector_sdk.py`:
  access recovery, actual client gate and signed metadata collection.
- `reconcile-mock-first-kit/runtime/state.json`: local mutable demo state, ignored
  by Git; generated with `seed`. The server serves no runtime or evaluation files.
- `reconcile-mock-first-kit/reference/`: static synthetic provider-shaped samples.
- `docs/handoffs/`: implementation and verification context for each request.

Final validation: **75 automated tests pass** (26 JavaScript, 49 Python), including
the original 42 analytics/legacy tests. The access CLI replay and actual browser
walkthrough pass. See [analytics verification](docs/VERIFICATION.md),
[access verification](docs/PAID_ACCESS_VERIFICATION.md), and generated evidence in
`reconcile-mock-first-kit/samples/`.

Analytics supports the fixed nine-account, one-app USD/EUR scenario. Google, Apple, Stripe,
Amplitude, AppsFlyer, PostHog and competitor webhook examples are reference samples,
not active connectors. Access recovery changes only our mock Lumen projection and
cache after fresh entitlement checks; it never grants external licences. No real
provider integration, real AI, FX conversion or production accounting is implied.
The separate937-order Revenue Bridge archive was not supplied. Original archive
README files describe their original standalone
versions; this README describes the integrated project.

Source is maintained in `tarn-jihas/team-iwakura`; no deployment is configured.
The retained `Reconcile/.openai` hosting metadata
belongs to the original visual archive and is not used by this local application.
