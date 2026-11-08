import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { DatabaseSync } from 'node:sqlite';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { semanticDigest, semanticJson } from '../dist/infrastructure/json.js';
import { AccessDemo } from '../dist/modules/legacy-access/demo.js';

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'reconcile-access-demo-'));
  const databasePath = join(directory, 'access.sqlite3');
  let demo = await AccessDemo.create({ databasePath });
  t.after(async () => { await demo.close(); await rm(directory, { recursive: true, force: true }); });
  return { directory, databasePath, get demo() { return demo; }, replaceDemo(value) { demo = value; } };
}
const call = (demo, method, url, body, headers) => demo.handle(method, url, body, headers);
function readState(databasePath) {
  const db = new DatabaseSync(databasePath, { readOnly: true });
  try { return JSON.parse(db.prepare('SELECT payload FROM legacy_access_state WHERE id=1').get().payload); }
  finally { db.close(); }
}
function mutateState(databasePath, mutate) {
  const db = new DatabaseSync(databasePath);
  try {
    const row = db.prepare('SELECT revision,payload FROM legacy_access_state WHERE id=1').get();
    const state = JSON.parse(row.payload); mutate(state);
    const payload = semanticJson(state), digest = semanticDigest(state);
    db.prepare('UPDATE legacy_access_state SET revision=?,payload=?,digest=? WHERE id=1').run(row.revision + 1, payload, digest);
  } finally { db.close(); }
}
async function dynamicHttp(demo, t) {
  const server = createServer(async (request, response) => {
    const host = request.headers.host ?? '';
    if (request.method === 'POST' && request.headers.origin !== `http://${host}`) {
      response.writeHead(403, { 'content-type': 'application/json' }).end('{"error":"loopback same-origin request required"}\n'); return;
    }
    if (request.method === 'POST' && request.headers['content-type']?.split(';', 1)[0]?.trim().toLowerCase() !== 'application/json') {
      response.writeHead(415, { 'content-type': 'application/json' }).end('{"error":"Content-Type must be application/json"}\n'); return;
    }
    let body;
    try {
      const chunks = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const raw = Buffer.concat(chunks).toString('utf8');
      body = raw ? JSON.parse(raw) : undefined;
    } catch {
      response.writeHead(400, { 'content-type': 'application/json' }).end('{"error":"bad request"}\n'); return;
    }
    const result = await demo.handle(request.method ?? 'GET', request.url ?? '/', body, request.headers);
    response.writeHead(result.status, { 'content-type': result.contentType, 'cache-control': 'no-store' });
    response.end(`${JSON.stringify(result.body)}\n`);
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  t.after(async () => { server.close(); await once(server, 'close'); });
  return `http://127.0.0.1:${address.port}`;
}

test('cancellation recovery keeps projection writes pending until actual gate verification', async t => {
  const { demo } = await fixture(t);
  const before = (await call(demo, 'POST', '/mock/lumen/export', { user_id: 'u00000' }));
  assert.equal(before.status, 403);
  assert.equal(before.body.reason, 'subscription_inactive');

  const detected = await call(demo, 'POST', '/api/access/detect', {});
  assert.equal(detected.status, 200);
  assert.deepEqual([
    detected.body.summary.in_scope, detected.body.summary.evaluated, detected.body.summary.confirmed,
    detected.body.summary.healthy, detected.body.summary.legitimate_denial,
    detected.body.summary.policy_denial, detected.body.summary.inconclusive
  ], [100, 94, 24, 60, 6, 4, 6]);
  const ids = detected.body.accounts.filter(row => row.eligible).map(row => row.id);
  assert.equal(ids.length, 24);
  const preview = await call(demo, 'POST', '/api/access/preview', { ids });
  assert.equal(preview.status, 200);
  const approval = await call(demo, 'POST', '/api/access/approve', {
    plan_id: preview.body.id, plan_hash: preview.body.plan_hash, actor: 'local-reviewer'
  });
  assert.equal(approval.status, 200);
  const applied = await call(demo, 'POST', '/api/access/apply', { plan_id: preview.body.id, plan_hash: preview.body.plan_hash });
  assert.equal(applied.status, 200);
  assert.equal(applied.body.writes_accepted, 24);
  assert.ok(applied.body.receipts.every(receipt => receipt.status === 'transport_accepted'));
  assert.equal(applied.body.report.recovery.target_count, 24);

  const eventCount = (await call(demo, 'GET', '/api/access/journal')).body.total;
  const duplicate = await call(demo, 'POST', '/api/access/apply', { plan_id: preview.body.id, plan_hash: preview.body.plan_hash });
  assert.equal(duplicate.body.duplicate, true);
  assert.equal(duplicate.body.writes_accepted, 0);
  assert.equal((await call(demo, 'GET', '/api/access/journal')).body.total, eventCount);

  const first = await call(demo, 'POST', '/api/access/verify', { plan_id: preview.body.id });
  assert.equal(first.status, 200);
  assert.deepEqual([first.body.verified_count, first.body.unresolved_count], [23, 1]);
  const unresolved = first.body.unresolved_ids;
  const retry = await call(demo, 'POST', '/api/access/preview', { ids: unresolved, retry_of: preview.body.id });
  assert.equal(retry.status, 200);
  assert.equal((await call(demo, 'POST', '/api/access/approve', {
    plan_id: retry.body.id, plan_hash: retry.body.plan_hash, actor: 'local-reviewer'
  })).status, 200);
  const retryApply = await call(demo, 'POST', '/api/access/apply', { plan_id: retry.body.id, plan_hash: retry.body.plan_hash });
  assert.equal(retryApply.body.writes_accepted, 1);
  const final = await call(demo, 'POST', '/api/access/verify', { plan_id: retry.body.id });
  assert.deepEqual([final.body.verified_count, final.body.unresolved_count], [24, 0]);
  assert.equal(final.body.report.recovery.root_cause_status, 'pending');
  assert.equal((await call(demo, 'POST', '/mock/lumen/export', { user_id: unresolved[0] })).status, 200);
});

test('identity and policy denials never become eligible for repair', async t => {
  const fixtureState = await fixture(t), { demo, databasePath } = fixtureState;
  mutateState(databasePath, state => { state.mappings.u00000.provider_user_id = 'different-provider-user'; });
  const detected = await call(demo, 'POST', '/api/access/detect', {});
  const wrongIdentity = detected.body.accounts.find(row => row.id === 'u00000');
  assert.equal(wrongIdentity.status, 'inconclusive');
  assert.equal(wrongIdentity.reason, 'mapping_source_identity_mismatch');
  assert.equal(wrongIdentity.eligible, false);
  const restricted = detected.body.accounts.find(row => row.status === 'policy_denial');
  assert.ok(restricted);
  assert.equal(restricted.eligible, false);
  assert.equal((await call(demo, 'POST', '/api/access/preview', { ids: [wrongIdentity.id] })).status, 409);
  assert.equal((await call(demo, 'POST', '/api/access/preview', { ids: [restricted.id] })).status, 409);
});

test('source staleness invalidates the full approved cohort before any projection write', async t => {
  const fixtureState = await fixture(t), { databasePath } = fixtureState;
  let demo = fixtureState.demo;
  const detected = await call(demo, 'POST', '/api/access/detect', {});
  const staleFixture = detected.body.accounts.find(row => row.source_freshness === 'stale');
  assert.ok(staleFixture);
  assert.equal(staleFixture.eligible, false);
  const userId = detected.body.accounts.find(row => row.status === 'confirmed').id;
  const plan = (await call(demo, 'POST', '/api/access/preview', { ids: [userId] })).body;
  await call(demo, 'POST', '/api/access/approve', { plan_id: plan.id, plan_hash: plan.plan_hash, actor: 'reviewer' });
  const before = (await call(demo, 'GET', `/api/access/evidence?user=${userId}`)).body;
  await demo.close();
  mutateState(databasePath, state => { state.source_entitlements[userId].observed_at = '2026-11-02T00:00:00Z'; });
  demo = await AccessDemo.create({ databasePath }); fixtureState.replaceDemo(demo);
  const blocked = await call(demo, 'POST', '/api/access/apply', { plan_id: plan.id, plan_hash: plan.plan_hash });
  assert.equal(blocked.status, 409);
  assert.match(blocked.body.error, /preconditions changed/);
  const after = (await call(demo, 'GET', `/api/access/evidence?user=${userId}`)).body;
  assert.deepEqual(after.projection, before.projection);
  assert.deepEqual(after.cache, before.cache);
  assert.equal((await call(demo, 'GET', '/api/access/audit')).body.actions.length, 0);
});

test('signed collector works over a dynamic port and rejects invalid signatures without mutation', async t => {
  const { demo, databasePath } = await fixture(t), baseUrl = await dynamicHttp(demo, t), state = readState(databasePath);
  const eventId = 'sdk-http-event';
  const event = { event_id: eventId, run_id: state.manifest.run_id, app: state.manifest.app, environment: 'Production',
    app_user_id: 'u00000', kind: 'source_entitlement_observed', occurred_at: new Date().toISOString(),
    correlation_id: eventId, source_event_id: eventId,
    details: { outcome: 'observed', source_hash: 'test-observation', initiator: 'sdk_http_test' } };
  const envelope = { event, sent_at: Math.floor(Date.now() / 1000) };
  const signature = createHmac('sha256', Buffer.from(state._collector_key, 'hex')).update(semanticJson(envelope)).digest('hex');
  const send = async sig => fetch(`${baseUrl}/api/collector/events`, { method: 'POST', headers: {
    'content-type': 'application/json', origin: baseUrl, 'x-reconcile-signature': sig
  }, body: JSON.stringify(envelope) });
  const first = await send(signature), firstBody = await first.json();
  assert.equal(first.status, 200);
  assert.equal(firstBody.duplicate, false);
  const repeated = await send(signature), repeatedBody = await repeated.json();
  assert.equal(repeated.status, 200);
  assert.equal(repeatedBody.duplicate, true);
  const beforeBad = (await call(demo, 'GET', '/api/access/journal')).body.total;
  const invalid = await send('0'.repeat(64));
  assert.equal(invalid.status, 401);
  assert.equal((await call(demo, 'GET', '/api/access/journal')).body.total, beforeBad);
});

test('seeded access evidence and collector journal survive adapter restart', async t => {
  const fixtureState = await fixture(t), { databasePath } = fixtureState;
  let demo = fixtureState.demo;
  await call(demo, 'POST', '/api/access/detect', {});
  const before = (await call(demo, 'GET', '/api/access/report')).body;
  const beforeRegistry = (await call(demo, 'GET', '/api/access/registry')).body;
  await demo.close();
  demo = await AccessDemo.create({ databasePath }); fixtureState.replaceDemo(demo);
  const after = (await call(demo, 'GET', '/api/access/report')).body;
  assert.equal(after.summary.confirmed, before.summary.confirmed);
  assert.equal(after.collector.event_count, before.collector.event_count);
  assert.deepEqual((await call(demo, 'GET', '/api/access/registry')).body, beforeRegistry);
});

test('demo reset, handler, cancellation and clock controls keep both fixture variants isolated', async t => {
  const { demo } = await fixture(t);
  const reset = await call(demo, 'POST', '/api/access/demo', { action: 'reset', variant: 1 });
  assert.equal(reset.status, 200);
  assert.equal(reset.body.manifest.run_id, 'mock-lumen-access-20261103-v1');
  assert.ok(reset.body.accounts.every(row => row.id.startsWith('v1-')));
  assert.deepEqual(reset.body.consumer, { mode: 'faulty', handler_version: 'cancel-handler-v1' });
  const fixed = await call(demo, 'POST', '/api/access/demo', { action: 'handler', mode: 'fixed' });
  assert.equal(fixed.body.report.recovery.root_cause_status, 'resolved');
  const cancellation = await call(demo, 'POST', '/api/access/demo', { action: 'cancel', ids: ['v1-u02000'] });
  assert.equal(cancellation.status, 200);
  assert.equal((await call(demo, 'POST', '/mock/lumen/export', { user_id: 'v1-u02000' })).status, 200);
  assert.equal((await call(demo, 'POST', '/api/access/demo', { action: 'advance', seconds: 86401 })).status, 400);
  const advanced = await call(demo, 'POST', '/api/access/demo', { action: 'advance', seconds: 60 });
  assert.equal(advanced.body.scenario_now, '2026-11-03T00:13:04Z');
  const backToDefault = await call(demo, 'POST', '/api/access/demo', { action: 'seed', variant: 0 });
  assert.equal(backToDefault.body.manifest.run_id, 'mock-lumen-access-20261103-v0');
  assert.deepEqual(backToDefault.body.consumer, { mode: 'faulty', handler_version: 'cancel-handler-v1' });
});

test('existing unmarked SQLite files are rejected without modification', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'reconcile-access-isolation-'));
  const databasePath = join(directory, 'unmarked.sqlite3'), db = new DatabaseSync(databasePath);
  db.exec("CREATE TABLE sentinel(value TEXT NOT NULL); INSERT INTO sentinel VALUES ('keep-me')"); db.close();
  const before = await readFile(databasePath);
  t.after(() => rm(directory, { recursive: true, force: true }));
  await assert.rejects(AccessDemo.create({ databasePath }), /legacy access marker/);
  assert.deepEqual(await readFile(databasePath), before);
});
