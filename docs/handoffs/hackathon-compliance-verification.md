# Hackathon requirements verification

Request: verify Reconcile against the linked Adapty Belgrade before-you-start
page. Reviewed 2026-11-08 at `e688ed2`; Ponytail Full. Verification only: no app
changes, reseeding, remote writes, deployment or submission.

Sources: [organizer rules](https://app.notion.com/p/adapty/Adapty-Hackathon-Belgrade-Before-you-start-4101ca4355c381e2ae2df84ce84b37fc),
read through the browser including rules 1–8 and FAQ;
[organizer event listing](https://luma.com/6n5z66cr) dates the event November 7–8.

Findings:

- Meaningful Adapty use is supported by the read-only source adapters and the
  actual seeded replay in `.artifacts/fulfillment-live-tip.json`: 100 source
  accounts, 24 failures, 23 restored gates, one unresolved, zero remote writes.
  This is historical replay evidence, not a fresh live test or payment proof.
- Official synthetic fixture provenance is pinned in
  `reconcile-mock-first-kit/fixtures/hackathon/manifest.json`. Private seed status
  records completion with 6,000 created profiles and zero profile/transaction
  failures. No seed was rerun. Dashboard population was not checked directly.
- CLI 0.18.0 is installed. Node 22.22.3, npm 10.9.8 and Python 3.13.13 match the
  project toolchain and exceed the organizer prerequisites.
- GitHub metadata confirms `tarn-jihas/team-iwakura` is public. The user's `y`
  reply to the bundled eligibility question is interpreted as confirmation of
  check-in, at most four members, and both archives created during this event.
  This interpretation was stated in chat; these are user-attested facts.
- All local commits are dated November 7–8, beginning November 7 at 15:45 CET.
  Commit dates cannot prove code creation time. The initial handoff says two
  supplied archives were integrated. README references original assets but does
  not clearly identify their pre-kickoff status and reused scope. Based on the
  user's confirmation they are event-created work, so no pre-existing-core
  violation is established. If that interpretation is wrong, rule 1 requires
  explicit README disclosure of the reused material.
- The known Adapty key/config are ignored and the key was absent from every
  reachable local Git revision. A current tracked-file credential-pattern scan
  matched only a deliberately fake key in a validator test. This is a targeted
  check, not an exhaustive audit of every possible secret or remote ref.
- Adapters use bounded reads, timeouts and persisted 429 cooldown. Historical
  stress evidence uses local fixtures; no remote load test was run here. This
  does not certify all past traffic or an organizer-approved polling budget.
- AI and mobile/store integration are optional under these rules. The current
  demo is deterministic; do not present simulated explanations as actual AI.
- `npm start` is the retained Python demo. The TypeScript runtime is explicitly
  provisional; its incomplete parity is documented in README and the migration
  handoff. Hackathon eligibility does not require production completeness.

Verification: unit suite passed (52 JavaScript, 163 Python), HTTP integration
passed (9), offline integrity passed (50,000 accounts, 29,794 transactions and
pagination invariance), TypeScript build/suite passed (114 passed, one optional
Python oracle test skipped). All 28 focused acceptance tests passed. Logs use
`/tmp/reconcile-hackathon-{unit,integration,acceptance-focused,offline,ts}.log`.

The broad acceptance command was interrupted when it launched the 1,000-cycle
local stress test (historical duration about 15 minutes). No fresh stress pass
is claimed. Interruption diagnostics are retained in
`/tmp/reconcile-hackathon-interrupted-stress/`; the three overwritten historical
failure artifacts were restored from the existing pre-task backup, and the
new fourth interruption artifact was removed from the workspace. The historical
successful aggregate was unchanged. Focused acceptance covers all other cases.

Verdict: no blocking violation found against the linked rules, relying on the
user's eligibility confirmation. Prefer the documented Python runtime for the
complete retained demo; do not claim TypeScript parity or actual payments.
No application source/configuration changed. Next: present the verified demo.
No jCodeMunch
index exists for this workspace; used bounded native reads after checking its
repository inventory.
