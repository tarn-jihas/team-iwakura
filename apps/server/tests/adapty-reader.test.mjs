import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, chmod, symlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SQLiteStorage } from '../dist/infrastructure/sqlite.js';
import { AdaptyReader, SourceUnavailable, loadPrivateApiKey } from '../dist/modules/source/adapty-reader.js';

test('a long Retry-After blocks concurrent and restarted reads until its durable deadline', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'reconcile-ts-source-'));
  const path = join(directory, 'provider.sqlite3');
  let storage = new SQLiteStorage(path), now = 1_000_000, calls = 0;
  const customerIds = new Set(['known']);
  const fetcher = async (url, options) => {
    calls++;
    assert.equal(url, 'https://api.adapty.io/api/v2/server-side-api/profile/');
    assert.equal(options.headers['adapty-customer-user-id'], 'known');
    assert.equal(options.headers.Authorization, 'Api-Key fixture-secret');
    if (calls === 1) return new Response('{}', { status: 429, headers: { 'Retry-After': '120' } });
    return new Response(JSON.stringify({ data: { app_id: 'app', profile_id: 'profile',
      customer_user_id: 'known', access_levels: [], subscriptions: [] } }), { status: 200 });
  };
  const create = () => AdaptyReader.create({ storage, appId: 'app', customerIds,
    apiKey: 'fixture-secret', fetcher, now: () => now });
  try {
    let reader = await create();
    const responses = await Promise.allSettled([reader.read('known'), reader.read('known')]);
    assert.ok(responses.every(row => row.status === 'rejected' && row.reason instanceof SourceUnavailable
      && row.reason.code === 'rate_limited'));
    assert.equal(calls, 1);
    assert.equal(await reader.notBefore(), 1_120_000);
    assert.equal(await reader.requestsAttempted(), 1);
    await storage.close();
    storage = new SQLiteStorage(path);
    reader = await create();
    now = 1_119_999;
    await assert.rejects(reader.read('known'), error => error.code === 'rate_limited');
    await assert.rejects(reader.read('other'), error => error.code === 'identity_scope_mismatch');
    assert.equal(calls, 1);
    now++;
    const profile = await reader.read('known');
    assert.equal(profile.reason, 'premium_entitlement_absent');
    assert.equal(calls, 2);
    assert.equal(await reader.requestsAttempted(), 2);
    assert.equal(JSON.stringify(profile).includes('fixture-secret'), false);
  } finally {
    await storage.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('source key loading rejects symlinks and public permissions without exposing its contents', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'reconcile-ts-source-key-'));
  const keyPath = join(directory, 'key');
  const link = join(directory, 'link');
  try {
    await writeFile(keyPath, 'fixture-secret\n', { mode: 0o600 });
    assert.equal(await loadPrivateApiKey(keyPath), 'fixture-secret');
    await symlink(keyPath, link);
    await assert.rejects(loadPrivateApiKey(link), error => !error.message.includes('fixture-secret'));
    await chmod(keyPath, 0o644);
    await assert.rejects(loadPrivateApiKey(keyPath), error => !error.message.includes('fixture-secret'));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('short source rate limits use a bounded retry budget', async () => {
  const storage = new SQLiteStorage(':memory:');
  let calls = 0;
  try {
    const reader = await AdaptyReader.create({ storage, appId: 'app', customerIds: new Set(['known']),
      apiKey: 'fixture-secret', fetcher: async () => {
        calls++;
        return new Response('{}', { status: 429, headers: { 'Retry-After': '0' } });
      } });
    await assert.rejects(reader.read('known'), error => error.code === 'rate_limited');
    assert.equal(calls, 3);
    assert.equal(await reader.requestsAttempted(), 3);
  } finally {
    await storage.close();
  }
});

test('an extremely long Retry-After never overflows into an early retry', async () => {
  const storage = new SQLiteStorage(':memory:');
  let calls = 0;
  try {
    const reader = await AdaptyReader.create({ storage, appId:'app',customerIds:new Set(['known']),
      apiKey:'fixture-secret',now:() => 1_000_000,fetcher:async () => {
        calls++;
        return new Response('{}',{ status:429,headers:{ 'Retry-After':'99999999999999999999999999999999' } });
      } });
    await assert.rejects(reader.read('known'), error => error.code === 'rate_limited');
    await assert.rejects(reader.read('known'), error => error.code === 'rate_limited');
    assert.equal(await reader.notBefore(),Number.MAX_SAFE_INTEGER);
    assert.equal(calls,1);
  } finally { await storage.close(); }
});

test('oversized and failed source responses do not leak transport details', async () => {
  const storage = new SQLiteStorage(':memory:');
  try {
    const options = { storage, appId:'app', customerIds:new Set(['known']), apiKey:'fixture-secret' };
    const oversized = await AdaptyReader.create({ ...options,
      fetcher:async () => new Response(Buffer.alloc(1024 * 1024 + 1)) });
    await assert.rejects(oversized.read('known'), error => error.code === 'response_too_large');
    const failed = await AdaptyReader.create({ ...options,
      fetcher:async () => { throw new Error('fixture-secret'); } });
    await assert.rejects(failed.read('known'), error => error.code === 'transport_error'
      && !error.message.includes('fixture-secret'));
  } finally {
    await storage.close();
  }
});
