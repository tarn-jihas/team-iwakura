import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import {
  CollectorHTTPError,
  CollectorSDK,
  canonical,
  digest,
  sign,
  type CollectorEnvelope,
  type CollectorSDKOptions,
} from "../src/index.ts";

const KEY = "local-recovery-test-key-0123456789abcdef";
const DETAILS = {
  feature: "premium_export",
  decision: "deny",
  reason_code: "subscription_inactive",
  projection_version: "projection-v1",
  cache_version: "cache-v1",
  policy_version: "policy-v1",
  adapter_version: "adapter-v1",
  initiator: "customer_demo",
};

function setup(): { directory: string; outbox: string; sdk: (transport: CollectorSDKOptions["transport"]) => CollectorSDK } {
  const directory = mkdtempSync(join(tmpdir(), "reconcile-server-sdk-"));
  const outbox = join(directory, "outbox.sqlite3");
  return {
    directory,
    outbox,
    sdk: (transport) => new CollectorSDK({
      key: KEY,
      runId: "activation-run-v1",
      app: "mock-app",
      outboxPath: outbox,
      transport,
    }),
  };
}

function acknowledgement(envelope: CollectorEnvelope) {
  return {
    accepted: true,
    event_id: envelope.event.event_id,
    event_hash: digest(envelope.event),
    duplicate: false,
  } as const;
}

test("emit durably queues without network, then preserves event identity across restart", async (t) => {
  const context = setup();
  t.after(() => rmSync(context.directory, { recursive: true, force: true }));
  let firstCalls = 0;
  const first = context.sdk(() => {
    firstCalls += 1;
    throw new Error("offline");
  });
  const receipt = first.emit("feature_access_decided", "user-1", "2026-11-07T12:00:00Z", DETAILS, { eventId: "stable-event" });
  assert.equal(receipt.queued, true);
  assert.equal(firstCalls, 0);
  assert.equal(first.coverage().queued, 1);

  const second = context.sdk((envelope, signature) => {
    assert.equal(signature, sign(envelope, KEY));
    assert.equal(envelope.schema_version, envelope.event.schema_version);
    return acknowledgement(envelope);
  });
  assert.equal((await second.flush()).accepted, 1);
  assert.equal(second.coverage().queued, 0);
  const replay = second.emit("feature_access_decided", "user-1", "2026-11-07T12:00:00Z", DETAILS, { eventId: "stable-event" });
  assert.equal(replay.accepted, true);
  assert.equal(replay.event_hash, receipt.event_hash);
  assert.throws(() => second.emit("feature_access_decided", "user-1", "2026-11-07T12:00:00Z", {
    ...DETAILS,
    decision: "allow",
  }, { eventId: "stable-event" }), /different payload/u);
});

test("matches the Python canonical fingerprint vector for non-BMP object keys", () => {
  const value = { ["\u{10000}"]: "astral", ["\uE000"]: "bmp", a: "café" };
  assert.equal(canonical(value), "{\"a\":\"café\",\"\":\"bmp\",\"𐀀\":\"astral\"}");
  assert.equal(digest(value), "ce5ec93bc2b9b4e8e906b0302799f13f2eaff516d9f6c90b0e57a0e27ab47266");
});

test("keeps Python-sized integer revisions exact through durable delivery", async (t) => {
  const context = setup();
  t.after(() => rmSync(context.directory, { recursive: true, force: true }));
  const largeRevision = 9_007_199_254_740_993n;
  const sdk = context.sdk((envelope) => {
    assert.equal(envelope.event.details.revisions && (envelope.event.details.revisions as { projection: bigint }).projection, largeRevision);
    return acknowledgement(envelope);
  });
  sdk.emit("feature_access_decided", "user-1", "2026-11-07T12:00:00Z", {
    ...DETAILS,
    revisions: { projection: largeRevision },
  }, { eventId: "large-revision" });
  assert.equal((await sdk.flush()).accepted, 1);
});

test("429 Retry-After is deferred and the persisted attempt budget ends in a drop", async (t) => {
  const context = setup();
  t.after(() => rmSync(context.directory, { recursive: true, force: true }));
  let calls = 0;
  const sdk = context.sdk((envelope) => {
    calls += 1;
    if (calls === 1) throw new CollectorHTTPError(429, "60");
    throw new Error("offline");
  });
  sdk.emit("feature_access_decided", "user-1", "2026-11-07T12:00:00Z", DETAILS, { eventId: "retry-event" });
  assert.deepEqual(await sdk.flush(), { accepted: 0, dropped: 0, failed: 1, retries: 1 });
  assert.equal((await sdk.flush()).failed, 0);
  assert.equal(calls, 1);

  const db = new DatabaseSync(context.outbox);
  db.prepare("UPDATE sdk_events SET next_attempt_at=0 WHERE event_id='retry-event'").run();
  db.close();
  for (let attempt = 0; attempt < 4; attempt += 1) {
    await sdk.flush();
    const update = new DatabaseSync(context.outbox);
    update.prepare("UPDATE sdk_events SET next_attempt_at=0 WHERE event_id='retry-event'").run();
    update.close();
  }
  const coverage = sdk.coverage();
  assert.equal(calls, 5);
  assert.equal(coverage.queued, 0);
  assert.equal(coverage.dropped, 1);
  assert.equal(coverage.failed, 5);
  assert.equal(coverage.retries, 4);
});

test("very long Retry-After remains deferred", async (t) => {
  const context = setup();
  t.after(() => rmSync(context.directory, { recursive: true, force: true }));
  let calls = 0;
  const sdk = context.sdk(() => { calls++; throw new CollectorHTTPError(429, "9999999999999999999999999999999999999999"); });
  sdk.emit("feature_access_decided", "user-1", "2026-11-07T12:00:00Z", DETAILS, { eventId: "long-retry" });
  await sdk.flush();
  await sdk.flush();
  assert.equal(calls, 1);
  const db = new DatabaseSync(context.outbox, { readOnly:true });
  const row = db.prepare("SELECT next_attempt_at FROM sdk_events WHERE event_id='long-retry'").get();
  assert.ok(Number(row?.next_attempt_at) > Math.floor(Date.now() / 1000) + 1_000_000);
  db.close();
});

test("an existing non-TypeScript outbox remains untouched", (t) => {
  const context = setup();
  t.after(() => rmSync(context.directory, { recursive: true, force: true }));
  const existing = new DatabaseSync(context.outbox);
  existing.exec("CREATE TABLE sentinel(value TEXT); INSERT INTO sentinel VALUES ('untouched')");
  existing.close();
  const sdk = context.sdk(() => assert.fail("must not deliver"));
  const receipt = sdk.emit("feature_access_decided", "user-1", "2026-11-07T12:00:00Z", DETAILS);
  assert.equal(receipt.queued, false);
  assert.equal(sdk.coverage().last_error, "outbox_unavailable");
  const check = new DatabaseSync(context.outbox, { readOnly:true });
  assert.equal(check.prepare("SELECT value FROM sentinel").get()?.value, "untouched");
  assert.equal(check.prepare("SELECT count(*) AS n FROM sqlite_master WHERE name='sdk_events'").get()?.n, 0);
  check.close();
});

test("the durable pending queue is capped and reports overflow", (t) => {
  const context = setup();
  t.after(() => rmSync(context.directory, { recursive: true, force: true }));
  const sdk = context.sdk(() => assert.fail("emit must not deliver"));
  const now = Math.floor(Date.now() / 1000);
  const insert = new DatabaseSync(context.outbox);
  const statement = insert.prepare("INSERT INTO sdk_events(event_id,event_hash,event_json,state,created_at) VALUES(?,?,?,'queued',?)");
  insert.exec("BEGIN");
  for (let index = 0; index < 1000; index += 1) {
    const event = {
      schema_version: 1,
      event_id: `filler-${index}`,
      run_id: "activation-run-v1",
      app: "mock-app",
      environment: "Production",
      app_user_id: "user-1",
      kind: "feature_access_decided",
      occurred_at: "2026-11-07T12:00:00Z",
      correlation_id: `filler-${index}`,
      source_event_id: `filler-${index}`,
      details: DETAILS,
    };
    const payload = canonical(event);
    statement.run(event.event_id, digest(event), payload, now);
  }
  insert.exec("COMMIT");
  insert.close();

  const overflow = sdk.emit("feature_access_decided", "user-1", "2026-11-07T12:00:00Z", DETAILS, { eventId: "overflow" });
  assert.equal(overflow.queued, false);
  assert.equal(sdk.coverage().queued, 1000);
  assert.equal(sdk.coverage().dropped, 1);
  assert.equal(sdk.coverage().last_error, "queue_full");
  const free = new DatabaseSync(context.outbox);
  free.prepare("UPDATE sdk_events SET state='accepted' WHERE event_id='filler-0'").run();
  free.close();
  const replay = sdk.emit("feature_access_decided", "user-1", "2026-11-07T12:00:00Z", DETAILS, { eventId: "overflow" });
  assert.equal(replay.queued, true);
  assert.equal(replay.event_hash,overflow.event_hash);
  assert.equal(sdk.coverage().queued,1000);
});
