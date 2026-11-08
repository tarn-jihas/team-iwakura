import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { canonical, digest } from '@reconcile/server-sdk';
import { createLumenService, internalRequest, resync, signInternal, verifyInternal } from '../dist/index.js';

const key = Buffer.from('lumen-integration-key'.padEnd(32, 'x'));
const appId = 'lumen-test-app';
const userId = 'customer-001';
const expiresAt = '2030-01-01T00:00:00Z';
const productId = 'premium.annual';
const transactionId = 'transaction-001';
const sourceFingerprint = 'a'.repeat(64);
const entitlementHash = digest({ user_id: userId, product_id: productId, expires_at: expiresAt });

function profile() {
  return {
    status: 'active', app_id: appId, user_id: userId, identity_match: true,
    provider_customer_id: userId, source_fingerprint: sourceFingerprint,
    observed_at: '2026-11-08T12:00:00Z',
    entitlement: {
      app_id: appId, user_id: userId, provider_customer_id: userId,
      product_id: productId, expires_at: expiresAt, transaction_id: transactionId,
      entitlement_hash: entitlementHash, store: 'app_store', source_environment: 'Production',
      original_transaction_id: null,
    },
  };
}

function resyncBody(overrides = {}) {
  return {
    schema_version: 2, user_id: userId, expected_provider_customer_id: userId,
    expected_identity_revision: 1, expected_policy_revision: 1, expected_projection_revision: 1,
    entitlement: {
      product_id: productId, expires_at: expiresAt, entitlement_hash: entitlementHash,
      transaction_id: transactionId, source_fingerprint: sourceFingerprint,
      store: 'app_store', source_environment: 'Production',
    },
    operation_key: 'operation-001', processing_id: 'processing-001', trace_id: 'trace-001',
    ...overrides,
  };
}

async function listen(server) {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return server.address().port;
}

async function signedFetch(base, method, path, body) {
  const raw = body === undefined ? Buffer.alloc(0) : Buffer.from(canonical(body));
  const timestamp = Math.floor(Date.now() / 1000);
  const response = await fetch(new URL(path, base), {
    method,
    headers: {
      'X-Recovery-Timestamp': String(timestamp),
      'X-Recovery-Signature': signInternal(key, method, path, timestamp, raw),
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body: raw }),
  });
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : null };
}

test('live Lumen routes authenticate, use the signed source, enforce v2 CAS, and queue telemetry', async (t) => {
  const temp = mkdtempSync(join(tmpdir(), 'reconcile-lumen-'));
  const sourceCalls = [];
  let collectorCalls = 0;
  const sourceProfile = profile();
  const provider = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const raw = Buffer.concat(chunks);
    if (request.url?.startsWith('/api/recovery/collector')) collectorCalls += 1;
    if (!verifyInternal(key, request.method ?? '', request.url ?? '',
      String(request.headers['x-recovery-timestamp'] ?? ''), raw,
      String(request.headers['x-recovery-signature'] ?? ''))) {
      response.writeHead(401).end('{}');
      return;
    }
    if (request.url?.startsWith('/internal/adapty/profile?')) {
      sourceCalls.push(request.url);
      response.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(sourceProfile));
      return;
    }
    response.writeHead(404).end('{}');
  });
  const providerPort = await listen(provider);
  const providerUrl = `http://127.0.0.1:${providerPort}`;
  const userIds = Array.from({ length: 100 }, (_, index) => `customer-${String(index + 1).padStart(3, '0')}`);
  const bootstrapProfiles = userIds.map((id) => ({
    user_id: id, provider_customer_id: id, identity_match: true,
    observed_at: '2026-11-08T12:00:00Z', status: 'active',
    entitlement: {
      product_id: productId, expires_at: expiresAt,
      entitlement_hash: digest({ user_id: id, product_id: productId, expires_at: expiresAt }),
    },
  }));
  const service = await createLumenService({
    dbPath: join(temp, 'lumen.sqlite3'), outboxPath: join(temp, 'outbox.sqlite3'),
    key, providerUrl, collectorUrl: `${providerUrl}/api/recovery/collector`, autoFlush: false,
    liveConfig: { appId, sourceEnvironment: 'Production', customerUserIds: userIds },
    liveBootstrapPending: true, demo: true,
    bootstrapManifest: { app: appId, environment: 'Production', run_id: 'lumen-test-run', scenario_now: '2026-11-08T12:00:00Z' },
    bootstrapProfiles,
  });
  const lumenPort = await service.listen();
  const lumenUrl = `http://127.0.0.1:${lumenPort}`;
  t.after(async () => {
    await service.close();
    await new Promise((resolve) => provider.close(resolve));
    rmSync(temp, { recursive: true, force: true });
  });

  const unsigned = await fetch(`${lumenUrl}/internal/lumen/access?user=${userId}`);
  assert.equal(unsigned.status, 401);
  const listed = await signedFetch(lumenUrl, 'GET', '/internal/lumen/accounts?limit=1');
  assert.equal(listed.status, 200);
  assert.equal(listed.body.total, 100);
  assert.equal(listed.body.items.length, 1);

  const probe = await signedFetch(lumenUrl, 'POST', '/internal/lumen/probe', {
    user_id: userId, feature: 'premium_export', initiator: 'reconcile_probe',
  });
  assert.equal(probe.status, 200);
  assert.equal(probe.body.allowed, false);

  const sourceObservation = {
    user_id: userId, source_fingerprint: 'b'.repeat(64), observed_at: '2026-11-08T12:00:01Z',
    starts_at: null, expires_at: expiresAt, reason: 'active', status: 'active', identity_match: true,
    provider_customer_id: userId, transaction_id: transactionId, store: 'app_store',
    source_environment: 'Production', product_id: productId, entitlement_hash: entitlementHash,
  };
  const observed = await signedFetch(lumenUrl, 'POST', '/internal/lumen/source-observed', { items: [sourceObservation] });
  assert.equal(observed.status, 200);
  assert.equal(observed.body.telemetry_emitted, 1);
  const malformedObservation = await signedFetch(lumenUrl, 'POST', '/internal/lumen/source-observed', {
    items: [{ ...sourceObservation, unrecognized: true }],
  });
  assert.equal(malformedObservation.status, 400);

  const first = await signedFetch(lumenUrl, 'POST', '/internal/lumen/resync', resyncBody());
  assert.equal(first.status, 200);
  assert.equal(first.body.accepted, true);
  assert.equal(first.body.processing_id, 'processing-001');
  assert.equal(first.body.projection_revision, 2);
  assert.equal(sourceCalls.length, 1);
  const dbPath = join(temp,'lumen.sqlite3');
  const crashUser = 'customer-002';
  const crashBody = resyncBody({ user_id:crashUser,expected_provider_customer_id:crashUser,
    operation_key:'crash-operation',processing_id:'crash-processing',trace_id:'crash-trace',
    entitlement:{ ...resyncBody().entitlement,entitlement_hash:digest({ user_id:crashUser,product_id:productId,expires_at:expiresAt }) } });
  resync(dbPath,crashBody,true);
  let db = new DatabaseSync(dbPath);
  assert.equal(db.prepare('SELECT enqueued_at FROM processing_receipts WHERE operation_key=?').get('crash-operation').enqueued_at,null);
  db.close();
  const restarted = await createLumenService({ dbPath,outboxPath:join(temp,'outbox.sqlite3'),key,providerUrl,
    liveConfig:{ appId,sourceEnvironment:'Production',customerUserIds:userIds },autoFlush:false });
  await assert.rejects(createLumenService({ dbPath,key,providerUrl,
    liveConfig:{ appId:'another-app',sourceEnvironment:'Production',customerUserIds:userIds } }), /scope does not match/);
  await assert.rejects(createLumenService({ dbPath,key,providerUrl,
    liveConfig:{ appId,sourceEnvironment:'Sandbox',customerUserIds:userIds } }), /scope does not match/);
  await assert.rejects(createLumenService({ dbPath,key,providerUrl,
    liveConfig:{ appId,sourceEnvironment:'Production',customerUserIds:[...userIds.slice(1),'other-customer'] } }), /scope does not match/);
  db = new DatabaseSync(dbPath);
  assert.ok(db.prepare('SELECT enqueued_at FROM processing_receipts WHERE operation_key=?').get('crash-operation').enqueued_at);
  db.close();
  const outbox = new DatabaseSync(join(temp,'outbox.sqlite3'));
  assert.equal(outbox.prepare('SELECT count(*) AS n FROM sdk_events WHERE event_id=?').get('processing:crash-processing').n,1);
  outbox.close();
  await restarted.close();
  const overflowUser = 'customer-003';
  const overflowBody = resyncBody({ user_id:overflowUser,expected_provider_customer_id:overflowUser,
    operation_key:'overflow-operation',processing_id:'overflow-processing',trace_id:'overflow-trace',
    entitlement:{ ...resyncBody().entitlement,entitlement_hash:digest({ user_id:overflowUser,product_id:productId,expires_at:expiresAt }) } });
  resync(dbPath,overflowBody,true);
  let fullOutbox = new DatabaseSync(join(temp,'outbox.sqlite3'));
  const queued = Number(fullOutbox.prepare("SELECT COUNT(*) AS n FROM sdk_events WHERE state='queued'").get().n);
  const insert = fullOutbox.prepare("INSERT INTO sdk_events(event_id,event_hash,event_json,state,created_at) VALUES(?,?,?,'queued',?)");
  fullOutbox.exec('BEGIN');
  for (let index=queued; index<1000; index++) insert.run(`filler-${index}`,'a'.repeat(64),'{}',Math.floor(Date.now()/1000));
  fullOutbox.exec('COMMIT'); fullOutbox.close();
  const blocked = await createLumenService({ dbPath,outboxPath:join(temp,'outbox.sqlite3'),key,providerUrl,
    liveConfig:{ appId,sourceEnvironment:'Production',customerUserIds:userIds },autoFlush:false });
  await blocked.close();
  fullOutbox = new DatabaseSync(join(temp,'outbox.sqlite3'));
  assert.equal(fullOutbox.prepare("SELECT state FROM sdk_events WHERE event_id='processing:overflow-processing'").get().state,'dropped');
  fullOutbox.prepare("UPDATE sdk_events SET state='accepted' WHERE event_id=(SELECT event_id FROM sdk_events WHERE event_id LIKE 'filler-%' LIMIT 1)").run();
  fullOutbox.close();
  const resumed = await createLumenService({ dbPath,outboxPath:join(temp,'outbox.sqlite3'),key,providerUrl,
    liveConfig:{ appId,sourceEnvironment:'Production',customerUserIds:userIds },autoFlush:false });
  await resumed.close();
  fullOutbox = new DatabaseSync(join(temp,'outbox.sqlite3'));
  assert.equal(fullOutbox.prepare("SELECT state FROM sdk_events WHERE event_id='processing:overflow-processing'").get().state,'queued');
  fullOutbox.close();
  db = new DatabaseSync(dbPath);
  assert.ok(db.prepare('SELECT enqueued_at FROM processing_receipts WHERE operation_key=?').get('overflow-operation').enqueued_at);
  db.close();

  const duplicate = await signedFetch(lumenUrl, 'POST', '/internal/lumen/resync', resyncBody());
  assert.equal(duplicate.status, 200);
  assert.equal(duplicate.body.duplicate, true);
  assert.equal(sourceCalls.length, 2);

  for (const overrides of [
    { operation_key: 'stale-projection', processing_id: 'proc-stale', trace_id: 'trace-stale', expected_projection_revision: 1 },
    { operation_key: 'stale-identity', processing_id: 'proc-identity', trace_id: 'trace-identity', expected_projection_revision: 2, expected_identity_revision: 2 },
    { operation_key: 'stale-policy', processing_id: 'proc-policy', trace_id: 'trace-policy', expected_projection_revision: 2, expected_policy_revision: 2 },
  ]) {
    const stale = await signedFetch(lumenUrl, 'POST', '/internal/lumen/resync', resyncBody(overrides));
    assert.equal(stale.status, 409);
  }

  const readback = await signedFetch(lumenUrl, 'GET', '/internal/lumen/handler/result?processing_id=processing-001');
  assert.equal(readback.status, 200);
  assert.equal(readback.body.outcome, 'committed_readback');
  assert.equal(readback.body.result.projection_revision, 2);
  const coverage = await signedFetch(lumenUrl, 'GET', '/internal/lumen/collector-coverage');
  assert.equal(coverage.status, 200);
  assert.ok(coverage.body.queued >= 1);
  assert.equal(collectorCalls, 0);
  await assert.rejects(createLumenService({
    dbPath: join(temp, 'lumen.sqlite3'), key, providerUrl,
  }), /runtime mode does not match/);
  const legacyPath = join(temp,'legacy.sqlite3');
  const legacy = new DatabaseSync(legacyPath);
  legacy.exec("CREATE TABLE meta(key TEXT PRIMARY KEY,value TEXT); INSERT INTO meta VALUES ('initialized','true'); CREATE TABLE sentinel(value TEXT); INSERT INTO sentinel VALUES ('untouched')");
  legacy.close();
  await assert.rejects(createLumenService({ dbPath:legacyPath,key,providerUrl }), /not an isolated TypeScript runtime/);
  const check = new DatabaseSync(legacyPath,{ readOnly:true });
  assert.equal(check.prepare('SELECT value FROM sentinel').get().value,'untouched');
  assert.equal(check.prepare("SELECT count(*) AS n FROM sqlite_master WHERE name='processing_receipts'").get().n,0);
  check.close();
});

test('long provider cooldowns are not retried early', async () => {
  let calls = 0;
  const provider = createServer((_request,response) => {
    calls++;
    response.writeHead(429,{ 'Retry-After':'99999999999999999999999999999999' }).end('{}');
  });
  const port = await listen(provider);
  try {
    await assert.rejects(internalRequest(key,new URL(`http://127.0.0.1:${port}`),'GET','/internal/adapty/profile?user=customer-001'),
      error => error.status === 429);
    assert.equal(calls,1);
  } finally { await new Promise(resolve => provider.close(resolve)); }
});
