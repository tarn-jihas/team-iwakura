import assert from "node:assert/strict";
import test from "node:test";
import { canonical, validateEvent } from "../src/index.ts";

const eventV1 = {
  schema_version: 1,
  event_id: "event-v1",
  run_id: "run-1",
  app: "app-1",
  environment: "Production",
  app_user_id: "user-1",
  kind: "feature_access_decided",
  occurred_at: "2026-11-07T12:00:00Z",
  correlation_id: "event-v1",
  source_event_id: "source-1",
  details: {
    feature: "premium_export",
    decision: "deny",
    reason_code: "subscription_inactive",
    projection_version: "projection-v1",
    cache_version: "cache-v1",
    policy_version: "policy-v1",
    adapter_version: "adapter-v1",
    initiator: "customer_demo",
  },
};

const eventV2 = {
  ...eventV1,
  schema_version: 2,
  event_id: "event-v2",
  kind: "access_projection_changed",
  details: {
    action_id: "action-1",
    source_hash: "a".repeat(64),
    expected_revision: 1,
    policy_version: "policy-v2",
    adapter_version: "adapter-v2",
    projection_version: "projection-v2",
    cache_version: "cache-v2",
    outcome: "projection_updated",
    before: { active: false, projection_revision: 1 },
    after: { active: true, projection_revision: 2 },
    cache_invalidated: false,
    processing_id: "processing-1",
    trace_id: "trace-1",
    transaction_id: "transaction-1",
    steps: [{ name: "projection_commit", status: "completed", owner: "lumen", result: "committed", revision: 2 }],
    revisions: { identity: 1, policy: 1, projection: 2, cache: 2 },
  },
};

test("validates v1 and v2 events and binds scoped fields", () => {
  assert.doesNotThrow(() => validateEvent(eventV1, { runId: "run-1", app: "app-1", environment: "Production" }));
  assert.doesNotThrow(() => validateEvent(eventV2));
  assert.throws(() => validateEvent(eventV1, { app: "different-app" }), /scope mismatch/u);
  assert.throws(() => validateEvent({ ...eventV2,details:{ ...eventV2.details,
    trace_id:'sk-proj-abcdefghijklmnopqrstuv' } }), /Invalid collector/u);
  assert.throws(() => validateEvent({ ...eventV1, schema_version: 2 }), /processing receipt/u);
});

test("rejects non-UTC timestamps, unsupported metadata, and malformed v2 receipts", () => {
  assert.throws(() => validateEvent({ ...eventV1, occurred_at: "2026-11-07T13:00:00+01:00" }), /UTC/u);
  assert.throws(() => validateEvent({ ...eventV1, occurred_at: "2026-02-30T12:00:00Z" }), /occurred_at/u);
  assert.throws(() => validateEvent({ ...eventV1, details: { ...eventV1.details, purchase_token: "secret" } }), /metadata contract/u);
  assert.throws(() => validateEvent({ ...eventV2, details: { ...eventV2.details, revisions: { identity: true } } }), /trace revision/u);
});

test("canonical serialization matches Python key order, UTF-8, and integer JSON", () => {
  const astral = "\u{10000}";
  const privateUse = "\uE000";
  assert.equal(
    canonical({ [astral]: "astral", [privateUse]: "bmp", a: "café" }),
    "{\"a\":\"café\",\"\":\"bmp\",\"𐀀\":\"astral\"}",
  );
  assert.equal(canonical({ count: 1n, enabled: true, none: null }), "{\"count\":1,\"enabled\":true,\"none\":null}");
  assert.throws(() => canonical({ price: 1.25 }), /integer numbers/u);
  assert.throws(() => canonical({ count: Number.MAX_SAFE_INTEGER + 1 }), /bigint/u);
});
