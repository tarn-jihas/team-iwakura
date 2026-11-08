import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { canonical, digest } from '@reconcile/server-sdk';
import { createLumenService, signInternal, verifyInternal } from '../dist/index.js';

const key = Buffer.from('lumen-handler-test-key'.padEnd(32, 'x'));
const appId = 'lumen-handler-test';
const expiry = '2030-01-01T00:00:00Z';
const product = 'premium.annual';
const userIds = Array.from({ length: 100 }, (_, index) => `handler-${String(index + 1).padStart(3, '0')}`);

function sourceProfile(userId, changes = {}) {
  const transactionId = changes.transaction_id ?? `transaction-${userId}`;
  const expiresAt = changes.expires_at ?? expiry;
  const productId = changes.product_id ?? product;
  const fingerprint = changes.source_fingerprint ?? digest({ user_id: userId, transaction_id: transactionId, expires_at: expiresAt });
  const entitlementHash = digest({ user_id: userId, product_id: productId, expires_at: expiresAt });
  return {
    status: 'active', app_id: appId, user_id: userId, identity_match: true,
    provider_customer_id: userId, source_fingerprint: fingerprint,
    observed_at: '2026-11-08T12:00:00Z',
    entitlement: {
      app_id: appId, user_id: userId, provider_customer_id: userId,
      source_fingerprint: fingerprint, product_id: productId, expires_at: expiresAt,
      transaction_id: transactionId, entitlement_hash: entitlementHash,
      store: 'app_store', source_environment: 'Production', original_transaction_id: null,
    },
  };
}

function observation(profile, processingId) {
  const entitlement = profile.entitlement;
  return {
    user_id: profile.user_id, source_fingerprint: profile.source_fingerprint,
    observed_at: profile.observed_at, starts_at: null, expires_at: entitlement.expires_at,
    reason: 'active', status: profile.status, identity_match: profile.identity_match,
    provider_customer_id: profile.provider_customer_id,
    transaction_id: entitlement.transaction_id, store: entitlement.store,
    source_environment: entitlement.source_environment, product_id: entitlement.product_id,
    entitlement_hash: entitlement.entitlement_hash, processing_id: processingId,
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

async function fixture(t) {
  const temp = mkdtempSync(join(tmpdir(), 'reconcile-lumen-handler-'));
  const dbPath = join(temp, 'lumen.sqlite3');
  const outboxPath = join(temp, 'outbox.sqlite3');
  const profiles = new Map(userIds.map((userId) => [userId, sourceProfile(userId)]));
  const calls = new Map();
  const driftOnSecondRead = new Set();
  const provider = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const raw = Buffer.concat(chunks);
    if (!verifyInternal(key, request.method ?? '', request.url ?? '',
      String(request.headers['x-recovery-timestamp'] ?? ''), raw,
      String(request.headers['x-recovery-signature'] ?? ''))) {
      response.writeHead(401).end('{}');
      return;
    }
    const url = new URL(request.url ?? '/', 'http://127.0.0.1');
    if (request.method !== 'GET' || url.pathname !== '/internal/adapty/profile') {
      response.writeHead(404).end('{}');
      return;
    }
    const userId = url.searchParams.get('user');
    const read = (calls.get(userId) ?? 0) + 1;
    calls.set(userId, read);
    try {
      const lockCheck = new DatabaseSync(dbPath);
      lockCheck.exec('BEGIN IMMEDIATE; ROLLBACK');
      lockCheck.close();
    } catch {
      response.writeHead(500).end('{}');
      return;
    }
    let profile = profiles.get(userId);
    if (driftOnSecondRead.has(userId) && read === 2 && profile) {
      profile = { ...profile, source_fingerprint: 'f'.repeat(64) };
    }
    if (!profile) {
      response.writeHead(404).end('{}');
      return;
    }
    response.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(profile));
  });
  const providerPort = await listen(provider);
  const providerUrl = `http://127.0.0.1:${providerPort}`;
  const bootstrapProfiles = userIds.map((userId) => {
    const profile = sourceProfile(userId);
    return { user_id: userId, provider_customer_id: userId, identity_match: true,
      observed_at: profile.observed_at, status: 'active',
      entitlement: { product_id: profile.entitlement.product_id, expires_at: profile.entitlement.expires_at,
        entitlement_hash: profile.entitlement.entitlement_hash } };
  });
  const options = {
    dbPath, outboxPath, key, providerUrl, autoFlush: false,
    liveConfig: { appId, sourceEnvironment: 'Production', customerUserIds: userIds },
    liveBootstrapPending: true, demo: true,
    bootstrapManifest: { app: appId, environment: 'Production', run_id: 'lumen-handler-test-run',
      scenario_now: '2026-11-08T12:00:00Z' },
    bootstrapProfiles,
  };
  let service = await createLumenService(options);
  let base = `http://127.0.0.1:${await service.listen()}`;
  t.after(async () => {
    await service.close();
    await new Promise((resolve) => provider.close(resolve));
    rmSync(temp, { recursive: true, force: true });
  });
  return {
    dbPath, outboxPath, profiles, calls, driftOnSecondRead,
    get base() { return base; },
    async restart() {
      await service.close();
      service = await createLumenService(options);
      base = `http://127.0.0.1:${await service.listen()}`;
    },
  };
}

async function configure(fx, faults = [], paused = false) {
  return signedFetch(fx.base, 'POST', '/internal/lumen/simulation/configure', { faults, paused });
}

async function deliver(fx, profile, processingId) {
  return signedFetch(fx.base, 'POST', '/internal/lumen/handler/deliver', {
    items: [observation(profile, processingId)],
  });
}

test('handler delivery honors pause, commits once, reads the real gate, and survives restart', async (t) => {
  const fx = await fixture(t);
  const profile = fx.profiles.get(userIds[0]);
  const paused = await deliver(fx, profile, 'processing-success');
  assert.equal(paused.status, 200);
  assert.equal(paused.body.paused, true);
  assert.equal(paused.body.handled, 0);
  assert.equal((await signedFetch(fx.base, 'GET', `/internal/lumen/access?user=${userIds[0]}`)).body.allowed, false);

  assert.equal((await configure(fx)).status, 200);
  const success = await deliver(fx, profile, 'processing-success');
  assert.equal(success.status, 200);
  assert.deepEqual([success.body.accepted, success.body.handled, success.body.failed], [1, 1, 0]);
  const access = await signedFetch(fx.base, 'GET', `/internal/lumen/access?user=${userIds[0]}`);
  assert.equal(access.body.allowed, true);
  assert.equal(access.body.projection_revision, 2);
  const readback = await signedFetch(fx.base, 'GET', '/internal/lumen/handler/result?processing_id=processing-success');
  assert.equal(readback.body.outcome, 'completed');
  assert.equal(readback.body.result.trace_id, 'trace:' + digest({ processing_id: 'processing-success' }));
  assert.ok(readback.body.result.steps.some((step) => step.name === 'projection_commit'));
  assert.deepEqual(readback.body.result.steps.at(-1), {
    name: 'gate_readback', status: 'completed', owner: 'lumen', revision: 2, result: 'allowed',
  });
  const providerCalls = fx.calls.get(userIds[0]);

  const duplicate = await deliver(fx, profile, 'processing-success');
  assert.equal(duplicate.body.handled, 1);
  assert.equal(fx.calls.get(userIds[0]), providerCalls);
  const conflict = await deliver(fx, { ...profile, source_fingerprint: 'e'.repeat(64) }, 'processing-success');
  assert.equal(conflict.status, 409);

  const secondId = await deliver(fx, profile, 'processing-success-alias');
  assert.equal(secondId.body.handled, 1);
  const page = await signedFetch(fx.base, 'GET', '/internal/lumen/handler/results?limit=1');
  assert.equal(page.body.total, 1);
  assert.equal(page.body.items.length, 1);
  assert.equal(page.body.next_cursor, null);

  await fx.restart();
  const persisted = await signedFetch(fx.base, 'GET', '/internal/lumen/handler/result?processing_id=processing-success');
  assert.equal(persisted.body.result.trace_id, readback.body.result.trace_id);
  const outbox = new DatabaseSync(fx.outboxPath, { readOnly: true });
  assert.equal(outbox.prepare('SELECT count(*) AS n FROM sdk_events WHERE event_id=?').get('handler:processing-success').n, 1);
  outbox.close();
});

test('handler delivery classifies temporary, permanent, cache, delayed and timeout outcomes', async (t) => {
  const fx = await fixture(t);
  assert.equal((await configure(fx)).status, 200);

  const temporaryUser = userIds[1];
  const temporaryProfile = fx.profiles.get(temporaryUser);
  await configure(fx, [{ user_id: temporaryUser, fault_mode: 'handler_precommit', remaining_attempts: 1, permanent: false }]);
  const temporary = await deliver(fx, temporaryProfile, 'processing-temporary');
  assert.equal(temporary.body.failure_classes.recovery_http_503, 1);
  assert.equal((await signedFetch(fx.base, 'GET', `/internal/lumen/access?user=${temporaryUser}`)).body.allowed, false);
  assert.equal((await deliver(fx, temporaryProfile, 'processing-temporary-retry')).body.handled, 1);

  const precommitUser = userIds[2];
  await configure(fx, [{ user_id: precommitUser, fault_mode: 'db_precommit', remaining_attempts: 1, permanent: false }]);
  const precommit = await deliver(fx, fx.profiles.get(precommitUser), 'processing-db-precommit');
  assert.equal(precommit.body.failure_classes.recovery_http_503, 1);

  const permanentUser = userIds[3];
  await configure(fx, [{ user_id: permanentUser, fault_mode: 'permanent_handler', remaining_attempts: 1, permanent: true }]);
  assert.equal((await deliver(fx, fx.profiles.get(permanentUser), 'processing-permanent-1')).body.failed, 1);
  assert.equal((await deliver(fx, fx.profiles.get(permanentUser), 'processing-permanent-2')).body.failed, 1);

  const sourceUser = userIds[7];
  const observed = fx.profiles.get(sourceUser);
  fx.profiles.set(sourceUser, sourceProfile(sourceUser, { source_fingerprint: 'c'.repeat(64) }));
  const sourceMismatch = await deliver(fx, observed, 'processing-source-mismatch');
  assert.equal(sourceMismatch.body.failure_classes.recovery_http_409, 1);
  const sourceState = await signedFetch(fx.base, 'GET', `/internal/lumen/access?user=${sourceUser}`);
  assert.equal(sourceState.body.projection_revision, 1);
  assert.equal(sourceState.body.allowed, false);
  const sourceCheck = new DatabaseSync(fx.dbPath, { readOnly: true });
  assert.equal(sourceCheck.prepare('SELECT count(*) AS n FROM actions WHERE operation_key=?')
    .get(`source-handler:${digest({ user_id: sourceUser, processing_id: 'processing-source-mismatch' })}`).n, 0);
  sourceCheck.close();

  const cacheUser = userIds[4];
  assert.equal((await deliver(fx, fx.profiles.get(cacheUser), 'processing-cache-initial')).body.handled, 1);
  await configure(fx, [{ user_id: cacheUser, fault_mode: 'cache_refresh_skipped', remaining_attempts: 1, permanent: false }]);
  const cacheProfile = sourceProfile(cacheUser, { expires_at: '2031-01-01T00:00:00Z', source_fingerprint: 'd'.repeat(64) });
  fx.profiles.set(cacheUser, cacheProfile);
  const cache = await deliver(fx, cacheProfile, 'processing-cache-skipped');
  assert.equal(cache.body.failure_classes.cache_refresh_skipped, 1);
  const cacheResult = await signedFetch(fx.base, 'GET', '/internal/lumen/handler/result?processing_id=processing-cache-skipped');
  assert.equal(cacheResult.body.result.steps.at(-1).result, 'denied');
  assert.equal((await signedFetch(fx.base, 'GET', `/internal/lumen/access?user=${cacheUser}`)).body.reason, 'cache_stale');

  const delayedUser = userIds[5];
  await configure(fx, [{ user_id: delayedUser, fault_mode: 'delayed_older_update', remaining_attempts: 1, permanent: false }]);
  fx.driftOnSecondRead.add(delayedUser);
  const delayed = await deliver(fx, fx.profiles.get(delayedUser), 'processing-delayed');
  assert.equal(delayed.body.failure_classes.recovery_http_409, 1);
  assert.equal((await signedFetch(fx.base, 'GET', `/internal/lumen/access?user=${delayedUser}`)).body.allowed, false);

  const timeoutUser = userIds[6];
  await configure(fx, [{ user_id: timeoutUser, fault_mode: 'timeout_after_commit', remaining_attempts: 1, permanent: false }]);
  const timeout = await deliver(fx, fx.profiles.get(timeoutUser), 'processing-timeout');
  assert.equal(timeout.body.handled, 1);
  const timeoutResult = await signedFetch(fx.base, 'GET', '/internal/lumen/handler/result?processing_id=processing-timeout');
  assert.equal(timeoutResult.body.result.reason, 'committed_readback');
  assert.equal(timeoutResult.body.result.steps.at(-1).reason_code, 'timeout_after_commit');
  assert.equal((await signedFetch(fx.base, 'GET', `/internal/lumen/access?user=${timeoutUser}`)).body.allowed, true);

  const all = await signedFetch(fx.base, 'GET', '/internal/lumen/handler/results?limit=1');
  assert.ok(all.body.total >= 7);
  assert.equal(all.body.pagination.next_cursor, all.body.next_cursor);
  assert.ok(all.body.next_cursor);
  const next = await signedFetch(fx.base, 'GET', `/internal/lumen/handler/results?cursor=${all.body.next_cursor}&limit=1`);
  assert.equal(next.body.cursor, all.body.next_cursor);
  assert.equal(next.body.items.length, 1);
  assert.equal((await signedFetch(fx.base, 'GET', '/internal/lumen/handler/results?limit=1001')).status, 400);
});
