import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  CollectorSDK,
  canonical,
  digest,
  httpTransport,
  sign,
  type CollectorEnvelope,
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

test("loopback HTTP transport signs the bounded collector request and validates its receipt", async (t) => {
  let requests = 0;
  const server = createServer(async (request, response) => {
    requests += 1;
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const envelope = JSON.parse(Buffer.concat(chunks).toString("utf8")) as CollectorEnvelope;
    assert.equal(request.method, "POST");
    assert.equal(request.url, "/api/recovery/collector");
    assert.equal(request.headers["content-type"], "application/json");
    assert.equal(request.headers["x-reconcile-signature"], sign(envelope, KEY));
    const receipt = {
      accepted: true,
      event_id: envelope.event.event_id,
      event_hash: digest(envelope.event),
      duplicate: false,
    };
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(canonical(receipt));
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const address = server.address() as AddressInfo;
  const url = `http://127.0.0.1:${address.port}/api/recovery/collector`;
  const directory = mkdtempSync(join(tmpdir(), "reconcile-http-sdk-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const sdk = new CollectorSDK({
    key: KEY,
    runId: "activation-run-v1",
    app: "mock-app",
    outboxPath: join(directory, "outbox.sqlite3"),
    collectorUrl: url,
  });
  sdk.emit("feature_access_decided", "user-1", "2026-11-07T12:00:00Z", DETAILS, { eventId: "loopback-event" });
  assert.equal(requests, 0);
  assert.equal((await sdk.flush()).accepted, 1);
  assert.equal(requests, 1);
});

test("loopback transport rejects non-local, unknown, or credential-bearing URLs", () => {
  for (const url of [
    "https://127.0.0.1/api/recovery/collector",
    "http://localhost/api/recovery/collector",
    "http://127.0.0.1:8765/private",
    "http://127.0.0.1/api/recovery/collector?key=secret",
    "http://user:pass@127.0.0.1/api/recovery/collector",
  ]) assert.throws(() => httpTransport(url), /loopback HTTP endpoint/u);
});
