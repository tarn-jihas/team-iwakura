# Mobile telemetry contract

This iteration ships a contract and simulator, not native iOS/Android libraries.
The executable Python server SDK belongs on the application's backend. Provider
credentials, collector signing keys, validation and repair operations never run
on a device.

## Responsibility

The mobile application reports three kinds of observations to **its own
authenticated backend**:

- A purchase reference became available; this is a request for server verification.
- The observed Adapty profile changed.
- The application allowed or denied a feature.

The backend resolves the authenticated account, validates the metadata, removes
unsupported fields and passes a versioned event to the collector through the
server SDK. Device-supplied account IDs are not proof of identity. Production
integration must bind them to the app's session before using this contract.

No device message is independent evidence of payment. The engine must obtain
current provider evidence and an explicit identity mapping before it can make
a paid-access recovery plan. A forged `purchase_succeeded` observation cannot
create a paid period or authorize a repair.

## Data minimization

Send an event ID, app/environment, account reference, timestamp, event kind,
feature/product references and the observed decision. A purchase reference is
an opaque identifier to be resolved server-side. Do not send PAN, CVV, payment
forms, provider secrets, raw receipts, bearer tokens or customer contact data.
The collector accepts an allowlist, not arbitrary application payloads.

Offline delivery can be delayed, duplicated or reordered. An event ID identifies
the immutable observation; reusing it with different content is rejected. Event
time and collection time remain separate. Late events may produce a new
assessment but cannot alter a snapshot already authorized by policy or operator.

The SDK's outbox is bounded and durable. `emit()` only enqueues; it performs no
network I/O. A background worker calls `flush()`, with network requests outside
the SDK state lock. Collection failure must not fail the purchase or feature
request. Missing delivery remains a coverage gap rather than being silently
interpreted as evidence that nothing happened.

## Recovery boundary

The client backend exposes account enumeration, read access, a side-effect-free
gate probe and a revision-bound resync. Probe and premium execution share the
same authorization decision. The probe does not consume credits or execute an
expensive premium operation; it proves permission, not the quality of the whole
premium service.

Only a fresh plan authorized by the automatic policy or an operator may request
resync. Lumen reads current Adapty
state and checks the expected revision and entitlement hash. It cannot change
the source payment record or fall back to a generic premium grant.

Apple/Google cases that need a device or operator action remain
`awaiting_client_action`. A server response cannot stand in for a device restore
or a verified gate result.

## Production work intentionally deferred

Native transport, device offline storage, authenticated mobile sessions, store
receipt/token handling and platform restore integrations require a subsequent
sandbox iteration. This local simulator does not claim those integrations.
