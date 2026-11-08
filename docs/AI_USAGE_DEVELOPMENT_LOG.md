# AI Usage & Development Log

**Reconcile — Adapty Hackathon · October 28 – November 8, 2026**

We used AI to research, build and check Reconcile: a prototype that detects
unapplied Adapty entitlements, restores supported local access and verifies the
Premium gate. Our team owned product decisions, review and acceptance.

## What we used AI for

| Tool / role | Purpose |
|---|---|
| ChatGPT | Research documentation, compare ideas and draft specifications. |
| Codex lead agent | Delegate tasks, integrate changes and coordinate builds and checks. |
| Implementation agents | Develop the SDK, engine, simulators, UI and tests within assigned scopes. |
| Independent AI reviewer | Inspect recovery safety, identify defects and recheck fixes. |
| Automated tools | Run unit, HTTP integration, black-box acceptance, browser and performance checks. |
| Claude Code (Vuk, Nov 8) | Review the checkpoint, add automatic recovery to the demo, fix event-chain gaps and run browser walkthroughs. |

## When and how we worked

We moved from analytics discrepancies to a specific problem: a recorded purchase
does not guarantee applied access. Documentation checks and team decisions narrowed
the scope to source-backed recovery and controlled Lumen failure simulations.

Our workflow was **team direction → agent task → implementation → tests → review
→ correction → re-test**. Tasks specified responsibility, file scope, acceptance
criteria and blockers. Agents coordinated builds in one workspace; tests used
isolated databases and ports. Python remained a comparison baseline during migration.

## What the team controlled

We supervised orchestration, reviewed plans and evidence, challenged unsupported
claims and decided what was ready to present. We required fresh source checks
and actual gate verification before reporting recovery.

**The running engine uses deterministic rules; an LLM does not decide
entitlement eligibility or repairs.**
Unknown outcomes remain unresolved until readback establishes what happened.

## Evidence and limits

The isolated 100-account black-box scenario detected 24 affected accounts,
verified 23 restored gates and left one unresolved. Browser checks covered the
main flow, a 390 px viewport and CSV/JSON exports. Independent review led to fixes
for historical unknown writes, retry-plan growth, stop races and report ordering.

These are synthetic-scenario results, not proof of real charges. TypeScript parity,
legacy activation integration, the complete blast-radius flow and final load/restart
checks remained open at the published checkpoint. Original seeders and fixtures
were preserved.

Sources: [Adapty webhook handling](https://adapty.io/docs/handle-webhooks-with-ai),
[Event Feed](https://adapty.io/docs/event-feed) and
[Get Profile API](https://adapty.io/docs/api-adapty/operations/getProfile).
