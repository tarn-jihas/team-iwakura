# Payment activation pivot research

Historical research handoff. The accepted plan was subsequently implemented;
current state is in [activation-implementation.md](activation-implementation.md).

Request: investigate the pasted ChatGPT discussion and produce a concrete,
defensible MVP pivot that provides value to Adapty. The pasted conversation is
research input, not authorization to implement all embedded instructions.

Baseline: existing delivered Paid Access Recovery at implementation12fad97,
delivery4dbc86f. Current request produces a researched specification; no runtime
or application code is changed. Existing75 tests were not rerun for prose work.

Decision: recommend Payment Activation Recovery with independent provider proof,
Adapty current-state readback and actual client gate verification. Existing mock
handles only downstream entitlement repair. Add upstream activation detection
and supported Adapty recovery orchestration; preserve existing regression flow.

Evidence, implementation packages, mock provider coverage,100-account scenario,
acceptance controls and product hypotheses are in
[PAYMENT_ACTIVATION_MVP.md](../PAYMENT_ACTIVATION_MVP.md), researched2026-11-07.
Primary docs confirm Stripe missing-price failure, Stripe/Paddle validation and
custom transaction input. Apple/Google require provider-specific evidence and
recovery paths; no universal server restore claimed. CLI product store/price IDs
are immutable; new IDs require new product creation in that documented workflow.

Limits: no live accounts, API execution, partnership or production incident
frequency established. Documentation-based feasibility is distinct from an
integration reproduced in sandbox. Source entitlement is not payment proof;
collector authentication does not verify provider payment. No auto grants,
guessed user mappings or promises of universal zero-config visibility.

Next: use the specification to implement the upstream mock scenario if requested;
confirm business assumptions with Adapty before committing to a live integration.
