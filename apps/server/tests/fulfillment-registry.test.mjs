import test from 'node:test';
import assert from 'node:assert/strict';
import { SQLiteStorage } from '../dist/infrastructure/sqlite.js';
import { FulfillmentRegistry } from '../dist/modules/fulfillment/registry.js';
import { RecoveryRepository } from '../dist/modules/recovery/repository.js';

test('unchanged polling creates no activity; a later discrepancy opens a new episode', async () => {
  const storage = new SQLiteStorage(':memory:');
  try {
    const registry = new FulfillmentRegistry(storage); await registry.initialize();
    const key = { app:'app',environment:'sandbox',store:'app_store',transactionId:'txn',userId:'user',accessLevel:'premium' };
    const discrepancy = { status:'confirmed',reason:'projection_mismatch',eligible:true,projectionMatches:false };
    const healthy = { status:'healthy',reason:'source_period_and_gate_match',eligible:false,projectionMatches:true };
    const unknown = { status:'inconclusive',reason:'coverage_incomplete',eligible:false,projectionMatches:false };
    const first = await registry.observe(key,discrepancy,'a'.repeat(64),'b'.repeat(64),'2026-11-08T12:00:00Z');
    assert.equal(first.episodeNo,1);
    for (let i=1; i<=10; i++) await registry.observe(key,discrepancy,'a'.repeat(64),'b'.repeat(64),`2026-11-08T12:00:${String(i).padStart(2,'0')}Z`);
    let count = await storage.statement({ mode:'get',sql:'SELECT COUNT(*) AS count FROM fulfillment_history' });
    assert.equal(count.count,1);
    assert.equal((await registry.observe(key,unknown,'a'.repeat(64),'b'.repeat(64),'2026-11-08T12:01:00Z')).episodeOpen,true);
    assert.equal((await registry.observe(key,healthy,'a'.repeat(64),'b'.repeat(64),'2026-11-08T12:02:00Z')).episodeOpen,false);
    assert.equal(await registry.wasVerified(key,'a'.repeat(64),'b'.repeat(64)),true);
    const second = await registry.observe(key,discrepancy,'a'.repeat(64),'b'.repeat(64),'2026-11-08T12:03:00Z');
    assert.equal(await registry.wasVerified(key,'a'.repeat(64),'b'.repeat(64)),true);
    assert.equal(await registry.wasVerified(key,'c'.repeat(64),'b'.repeat(64)),false);
    assert.equal(second.episodeNo,2);
    assert.equal(second.identityHash,first.identityHash);
    assert.equal((await registry.observe(key,healthy,'a'.repeat(64),'b'.repeat(64),'2026-11-08T11:59:00Z')).status,'discrepancy');
    const renewal = await registry.observe({ ...key,transactionId:'renewal' },discrepancy,'a'.repeat(64),'b'.repeat(64),'2026-11-08T12:04:00Z');
    assert.notEqual(renewal.identityHash,first.identityHash);
    count = await storage.statement({ mode:'get',sql:'SELECT COUNT(*) AS count FROM fulfillment_history' });
    assert.equal(count.count,5);
    const page = await registry.list('app','sandbox',0,1,'discrepancy');
    assert.equal(page.total,2); assert.equal(page.items.length,1); assert.equal(page.next_cursor,'1');
    await assert.rejects(storage.statement({ mode:'run',sql:'DELETE FROM fulfillment_history' }), /immutable/);
  } finally { await storage.close(); }
});

test('a cohort claim is atomic, scoped, and cannot be claimed twice', async () => {
  const storage = new SQLiteStorage(':memory:');
  try {
    const registry = new FulfillmentRegistry(storage), repository = new RecoveryRepository(storage);
    await repository.initialize(); await registry.initialize();
    const key = { app:'app',environment:'sandbox',store:'app_store',transactionId:'one',userId:'one',accessLevel:'premium' };
    const discrepancy = { status:'confirmed',reason:'projection_mismatch',eligible:true,projectionMatches:false };
    const a = await registry.observe(key,discrepancy,'a'.repeat(64),'b'.repeat(64),'2026-11-08T12:00:00Z');
    const b = await registry.observe({ ...key,userId:'two',transactionId:'two' },discrepancy,'a'.repeat(64),'b'.repeat(64),'2026-11-08T12:00:00Z');
    assert.equal(await registry.claimIncident('wrong','app','other',[a.identityHash,b.identityHash],'2026-11-08T12:01:00Z'),false);
    const claims = await Promise.all([
      registry.claimIncident('incident','app','sandbox',[a.identityHash,b.identityHash],'2026-11-08T12:01:00Z'),
      registry.claimIncident('duplicate','app','sandbox',[a.identityHash,b.identityHash],'2026-11-08T12:01:00Z')
    ]);
    assert.deepEqual(claims,[true,false]);
    const renewal = await registry.observe({ ...key,transactionId:'renewal' },discrepancy,'a'.repeat(64),'b'.repeat(64),'2026-11-08T12:01:01Z');
    assert.equal(await registry.claimIncident('renewal-incident','app','sandbox',[renewal.identityHash],'2026-11-08T12:01:02Z'),false);
    assert.equal(await registry.ownedByAnother('app','sandbox','one'),true);
    assert.equal(await registry.ownedByAnother('app','sandbox','one','incident'),false);
    const rows = await storage.statement({ mode:'all',sql:'SELECT incident_id FROM fulfillment_current WHERE incident_id IS NOT NULL ORDER BY user_id' });
    assert.deepEqual(rows.map(row => row.incident_id),['incident','incident']);
  } finally { await storage.close(); }
});
