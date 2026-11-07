# Reconcile · local hackathon demo

A stateful, **FULL MOCK / SYNTHETIC DATA** Adapty add-on demo: independent payment
evidence → Adapty activation → actual Lumen access. Three local HTTP processes
demonstrate incident diagnosis, a confirmed account cohort, approved repair and
gate verification. The Python server SDK is executable; the mobile integration
is a contract and simulator, not a native library. No live credentials or new
dependencies are needed. Commercial value remains a [pilot hypothesis](docs/PILOT_BRIEF.md).

## Run

The implementation toolchain is Python 3.13.13 and Node 22.22.3. Python uses only
the standard library; Node runs the JavaScript tests.

```sh
cd /Users/strahinja/Documents/personal/reconcile
npm start -- --port 8875
```

Open [http://127.0.0.1:8875](http://127.0.0.1:8875). Stop with Ctrl+C. The launcher
starts provider/Adapty, Lumen and engine processes with separate SQLite state.
Startup preserves existing recovery state. **Demo Lab → Reset** explicitly resets
only this new scenario. Use `--runtime /tmp/reconcile-demo-example` for an isolated
run. The example port leaves an existing demo on 8765 untouched.

Analytics and cancellation regression demos remain in Demo Lab. The standalone
legacy server is available through `npm run start:legacy`. `npm run seed` resets
only the legacy fixtures; it is not required for the new recovery demo.

## Payment activation recovery

The main flow is **Incident → Evidence and scope → Plan → Approve and run →
Verified result**. Payment confirmation, Adapty activation and client access are
separate facts. An incomplete or unknown source blocks automatic repair.

The synthetic Stripe scenario contains 100 accounts: 94 evaluable, 24 with a
confirmed activation discrepancy and six inconclusive. The verified first
recovery verifies 24 activations and 23 gates; a new, narrowly approved retry
verifies the remaining gate. These are recovery counts, not new revenue.

See the [demo walkthrough and final verification](docs/ACTIVATION_VERIFICATION.md),
[recovery API and responsibilities](docs/RECOVERY_API.md),
[mobile boundary](docs/MOBILE_CONTRACT.md),
[product rationale](docs/PAYMENT_ACTIVATION_MVP.md) and
[pilot criteria](docs/PILOT_BRIEF.md). Native SDKs and live provider behavior are
outside this iteration.

## Retained cancellation recovery demo

Open **Cancellation recovery**, or `/access.html`. Demonstrate the Lumen
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
Classification and repair are deterministic; no AI chat or model key is needed.

## Check

```sh
npm test
npm run test:integration
npm run test:acceptance
npm run check:offline
npm run check:access
python3 reconcile-mock-first-kit/reconcile_mock.py check
```

The test suites use isolated temporary state and loopback HTTP servers. Recovery
acceptance starts three subprocesses and checks only public HTTP outputs, audit
and the Lumen gate. It does not import the engine or inspect its database.
`check:offline` verifies pinned official fixture checksums, streams all 50,000
accounts and 29,794 transaction rows, and checks pagination invariance. Those
records are synthetic history, not proof of real payment.

The analytics `reconcile_mock.py check` command intentionally reseeds
the demo and leaves it repaired; run `npm run seed`
afterwards to prepare a fresh presentation. Stop the server before running CLI
`seed` or `check`; use the UI's Reset action while the server is running.
The old engine's six control datasets
and Google reference comparison remain at **Demo Lab → Open legacy fixture lab**;
that separate browser lab is read-only with respect to the Python repair state.

## Layout and limits

- `Reconcile/dist/`: editable frontend source, original design system and fonts.
  `recovery-app.js` is the main incident flow; `mock-app.js` retains analytics;
  `app.js` / `engine.js` retain the old fixture lab.
- `reconcile-mock-first-kit/recovery_service.py`, `recovery_domain.py`:
  separate HTTP roles, durable recovery state and isolated simulator stores.
- `reconcile-mock-first-kit/recovery_sdk.py`: signed, versioned metadata and
  durable bounded outbox; no payment or repair decision logic.
- `reconcile-mock-first-kit/hackathon_data.py`, `fixtures/hackathon/`:
  pinned provenance, checksums and streaming official synthetic data import.
- `reconcile-mock-first-kit/reconcile_mock.py`: Decimal engine, mock providers,
  approval/apply/readback state and loopback HTTP server.
- `reconcile-mock-first-kit/paid_access.py`, `lumen_app.py`, `collector_sdk.py`:
  access recovery, actual client gate and signed metadata collection.
- `reconcile-mock-first-kit/runtime/state.json`: local mutable demo state, ignored
  by Git; generated with `seed`. The server serves no runtime or evaluation files.
- `reconcile-mock-first-kit/reference/`: static synthetic provider-shaped samples.
- `docs/handoffs/`: implementation and verification context for each request.

Current iteration: **141 automated tests passed** (33 JavaScript, 79 Python,
6 HTTP integration and 23 black-box acceptance), including the 50k HTTP scan.
See [final results and limits](docs/ACTIVATION_VERIFICATION.md).

Previous delivery baseline: **75 automated tests passed** (26 JavaScript,
49 Python), including the original 42 analytics/legacy tests. The previous access
CLI replay and browser walkthrough passed. See [analytics verification](docs/VERIFICATION.md),
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
