import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdtempSync, readFileSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { createProviderService,loadOfficialFixture } from '../dist/index.js';
import { normalizeProfile } from '@reconcile/server/source/profile';
import { signInternal, verifyInternal } from '@reconcile/server/infrastructure/internal-auth';

const key = Buffer.from('provider-integration-key'.padEnd(32, 'x'));
const now = Date.parse('2026-11-08T12:00:00Z');
const fixtureDirectory = resolve(fileURLToPath(new URL('../../../reconcile-mock-first-kit/fixtures/hackathon/', import.meta.url)));
const appId = '46a573aa-8c90-4b4b-ba72-2349ae9fb030';
const mockAppId = 'mock-lumen-activation';
const userId = 'live-customer-001';

const fileHash = (path) => createHash('sha256').update(readFileSync(path)).digest('hex');

test('explicit demo overlay preserves original history and adds 100 synthetic active rights', () => {
  const options = { directory:fixtureDirectory,runId:'overlay-test',now:new Date(now) };
  const original = loadOfficialFixture(options), overlay = loadOfficialFixture({ ...options,activeOverlay:true });
  assert.equal(overlay.manifest.synthetic_active_overlay,true);
  assert.equal(overlay.manifest.payment_verification,'unverified_synthetic_history');
  for (let index=0; index<100; index++) {
    const before = original.profiles[index],after = overlay.profiles[index];
    assert.equal(after.source_user_id,before.source_user_id);
    assert.deepEqual(after.raw_profile.subscriptions.slice(0,-1),before.raw_profile.subscriptions);
    assert.equal(normalizeProfile(after.raw_profile,mockAppId,after.user_id,new Date(now)).status,'active');
  }
});

async function listen(server) {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return server.address().port;
}

async function signedGet(base, path, signingKey = key, timestamp = now) {
  const seconds = Math.floor(timestamp / 1000);
  const response = await fetch(new URL(path, base), { method: 'GET', headers: {
    'X-Recovery-Timestamp': String(seconds),
    'X-Recovery-Signature': signInternal(signingKey, 'GET', path, seconds, Buffer.alloc(0)),
  } });
  return { status: response.status, retryAfter: response.headers.get('retry-after'), body: await response.json() };
}

function sourceProfile() {
  const start = '2026-11-01T00:00:00Z';
  const expiry = '2027-11-01T00:00:00Z';
  return { app_id: appId, profile_id: 'profile-live-001', customer_user_id: userId,
    access_levels: [{ access_level_id: 'premium', store: 'app_store', store_product_id: 'premium.annual',
      store_transaction_id: 'store-transaction-001', store_original_transaction_id: 'original-001',
      starts_at: start, purchased_at: start, expires_at: expiry, is_in_grace_period: false }],
    subscriptions: [{ store: 'app_store', store_product_id: 'premium.annual',
      store_transaction_id: 'store-transaction-001', store_original_transaction_id: 'original-001',
      environment: 'Production', expires_at: expiry, status: 'active', is_in_grace_period: false,
      is_trial_period: false }] };
}

test('mock routes use the pinned official fixture and preserve its separate source IDs', async (t) => {
  const temp = mkdtempSync(join(tmpdir(), 'reconcile-provider-mock-'));
  let externalCalls = 0;
  const service = await createProviderService({
    dbPath: join(temp, 'provider.sqlite3'), key, mode: 'mock', runId: 'test-run',
    fixtureDirectory, sampleSize: 100, appId: mockAppId, now: () => now,
    sourceFetcher: async () => { externalCalls += 1; throw new Error('mock mode must not fetch'); },
  });
  const port = await service.listen();
  const base = `http://127.0.0.1:${port}`;
  t.after(async () => { await service.close(); rmSync(temp, { recursive: true, force: true }); });

  const unsigned = await fetch(`${base}/internal/manifest`);
  assert.equal(unsigned.status, 401);
  const manifest = await signedGet(base, '/internal/manifest');
  assert.equal(manifest.status, 200);
  assert.equal(manifest.body.provenance, 'official_hackathon_synthetic');
  assert.equal(manifest.body.source_user_count, 5000);
  assert.equal(manifest.body.customer_count, 100);

  const accountPage = await signedGet(base, '/internal/provider/accounts?limit=7');
  assert.equal(accountPage.status, 200);
  assert.equal(accountPage.body.total, 100);
  assert.equal(accountPage.body.items.length, 7);
  assert.equal(accountPage.body.next_cursor, '7');
  const account = accountPage.body.items[0];
  assert.notEqual(account.user_id, account.source_user_id);
  assert.equal(account.provider_customer_id, account.user_id);

  const profile = await signedGet(base, `/internal/adapty/profile?user=${encodeURIComponent(account.provider_customer_id)}`);
  assert.equal(profile.status, 200);
  assert.equal(profile.body.user_id, account.user_id);
  assert.equal(profile.body.provider_customer_id, account.provider_customer_id);
  assert.equal(profile.body.source_user_id, account.source_user_id);
  assert.equal(profile.body.identity_match, true);
  assert.ok(['active', 'inactive', 'unknown'].includes(profile.body.status));
  assert.ok(profile.body.entitlement === null || profile.body.entitlement.app_id === mockAppId);

  const profilePage = await signedGet(base, '/internal/adapty/profiles?limit=5');
  assert.equal(profilePage.status, 200);
  assert.equal(profilePage.body.items.length, 5);
  assert.equal(profilePage.body.total, 100);
  assert.equal(profilePage.body.next_cursor, '5');
  assert.equal((await signedGet(base, '/internal/adapty/profile?user=unknown')).status, 404);
  assert.equal((await signedGet(base, '/internal/provider/accounts?limit=5&limit=8')).status, 400);
  assert.equal(externalCalls, 0);
});

test('legacy and symlink database paths are rejected before any write', async (t) => {
  const temp = mkdtempSync(join(tmpdir(), 'reconcile-provider-preflight-'));
  const legacyPath = join(temp, 'legacy.sqlite3');
  const legacy = new DatabaseSync(legacyPath);
  legacy.exec('CREATE TABLE sentinel(value TEXT NOT NULL); INSERT INTO sentinel VALUES (\'preserve-me\')');
  legacy.close();
  const before = fileHash(legacyPath);
  await assert.rejects(createProviderService({ dbPath: legacyPath, key, mode: 'mock' }), /owned TypeScript simulator database/);
  assert.equal(fileHash(legacyPath), before);
  const readOnly = new DatabaseSync(legacyPath, { readOnly: true });
  assert.equal(readOnly.prepare('SELECT value FROM sentinel').get().value, 'preserve-me');
  readOnly.close();

  const symlinkPath = join(temp, 'legacy-link.sqlite3');
  symlinkSync(legacyPath, symlinkPath);
  await assert.rejects(createProviderService({ dbPath: symlinkPath, key, mode: 'mock' }), /non-symlink/);
  assert.equal(fileHash(legacyPath), before);
  t.after(() => rmSync(temp, { recursive: true, force: true }));
});

test('live profile reads normalize through the durable source cooldown across restart', async (t) => {
  const temp = mkdtempSync(join(tmpdir(), 'reconcile-provider-live-'));
  const dbPath = join(temp, 'provider.sqlite3');
  let sourceCalls = 0;
  const fakeSource = async (url, options) => {
    sourceCalls += 1;
    assert.equal(url, 'https://api.adapty.io/api/v2/server-side-api/profile/');
    assert.equal(options.headers['adapty-customer-user-id'], userId);
    if (sourceCalls === 1) return Response.json({ data: sourceProfile() });
    return new Response('{}', { status: 429, headers: { 'Retry-After': '60' } });
  };
  const customerUserIds = [userId, ...Array.from({ length: 99 }, (_, index) => `live-customer-${String(index + 2).padStart(3, '0')}`)];
  const liveConfig = { appId, appTitle: 'Synthetic live source test', environment: 'hackathon_seed',
    sourceEnvironment: 'Production', seedRevision: 'fixture-revision-1', seedRunPrefix: 'fixture-run', customerUserIds };
  const create = (sourceFetcher) => createProviderService({ dbPath, key, mode: 'live', apiKey: 'test-api-key',
    liveConfig, sourceFetcher, now: () => now });
  const first = await create(fakeSource);
  const firstPort = await first.listen();
  const firstBase = `http://127.0.0.1:${firstPort}`;
  t.after(async () => { await first.close().catch(() => undefined); rmSync(temp, { recursive: true, force: true }); });

  const page = await signedGet(firstBase, '/internal/adapty/profiles?limit=1');
  assert.equal(page.status, 200);
  assert.equal(page.body.total, 100);
  const profile = page.body.items[0];
  assert.equal(profile.user_id, userId);
  assert.equal(profile.provider_customer_id, userId);
  assert.equal(profile.status, 'active');
  assert.equal(profile.identity_match, true);
  assert.equal(profile.entitlement.store, 'app_store');
  assert.equal(profile.entitlement.user_id, userId);
  assert.equal(profile.entitlement.provider_customer_id, userId);
  assert.equal(typeof profile.entitlement.source_fingerprint, 'string');

  const throttled = await signedGet(firstBase, `/internal/adapty/profile?user=${userId}`);
  assert.equal(throttled.status, 429);
  assert.equal(throttled.retryAfter, '60');
  assert.equal(sourceCalls, 2);
  await first.close();

  let restartedCalls = 0;
  const second = await create(async () => { restartedCalls += 1; return Response.json(sourceProfile()); });
  const secondPort = await second.listen();
  try {
    const stillThrottled = await signedGet(`http://127.0.0.1:${secondPort}`,
      `/internal/adapty/profile?user=${userId}`);
    assert.equal(stillThrottled.status, 429);
    assert.equal(stillThrottled.retryAfter, '60');
    assert.equal(restartedCalls, 0);
  } finally { await second.close(); }
});
