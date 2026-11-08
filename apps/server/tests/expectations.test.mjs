import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SQLiteStorage } from '../dist/infrastructure/sqlite.js';
import { Expectations } from '../dist/modules/fulfillment/expectations.js';

test('source expectations preserve versions, purchase identities and reject older observations', async () => {
  const directory = await mkdtemp(join(tmpdir(),'reconcile-expectations-'));
  let storage = new SQLiteStorage(join(directory,'engine.sqlite'));
  try {
    let expectations = new Expectations(storage);
    await expectations.initialize();
    const right = { appId:'app', environment:'Production', store:'app_store', transactionId:'renewal-1',
      userId:'user', accessLevel:'premium', startsAt:'2026-11-01T00:00:00Z', expiresAt:'2026-12-01T00:00:00Z',
      sourceFingerprint:'a'.repeat(64), entitlementHash:'b'.repeat(64) };
    const first = await expectations.observe(right,'2026-11-08T12:00:00Z');
    const same = await expectations.observe(right,'2026-11-08T12:01:00Z');
    assert.equal(first.versionHash,same.versionHash);
    const revised = { ...right, expiresAt:'2027-01-01T00:00:00Z', sourceFingerprint:'c'.repeat(64) };
    const next = await expectations.observe(revised,'2026-11-08T12:02:00Z');
    assert.equal(next.identityHash,first.identityHash);
    assert.notEqual(next.versionHash,first.versionHash);
    assert.equal((await expectations.observe(right,'2026-11-08T11:59:00Z')).current,false);
    assert.equal((await expectations.observe(right,'2026-11-08T12:02:00Z')).current,false);
    const renewal = await expectations.observe({ ...right, transactionId:'renewal-2' },'2026-11-08T12:03:00Z');
    assert.notEqual(renewal.identityHash,first.identityHash);
    await assert.rejects(expectations.observe({ ...right, transactionId:'' },'2026-11-08T12:03:00Z'), /Invalid/);
    await assert.rejects(expectations.observe({ ...right, receipt:'secret' },'2026-11-08T12:03:00Z'), /Invalid/);
    await assert.rejects(storage.statement({ mode:'run', sql:'DELETE FROM expectation_versions' }), /immutable/);
    await storage.close();
    storage = new SQLiteStorage(join(directory,'engine.sqlite'));
    expectations = new Expectations(storage);
    assert.deepEqual((await expectations.read(first.identityHash)).right,revised);
    assert.equal((await expectations.read(renewal.identityHash)).right.transactionId,'renewal-2');
  } finally {
    await storage.close();
    await rm(directory,{ recursive:true, force:true });
  }
});
