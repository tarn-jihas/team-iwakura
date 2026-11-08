import test from 'node:test';
import assert from 'node:assert/strict';
import { SQLiteStorage } from '../dist/infrastructure/sqlite.js';
import { Expectations } from '../dist/modules/fulfillment/expectations.js';
import { scanFulfillments } from '../dist/modules/fulfillment/scan.js';
import { classifyFulfillment } from '../dist/modules/fulfillment/classification.js';
import { prepareRecovery } from '../dist/modules/recovery/preview.js';
import { FulfillmentRegistry } from '../dist/modules/fulfillment/registry.js';
import { persistScan } from '../dist/modules/fulfillment/persist-scan.js';

test('registry scan preserves the processing window and fails closed during source outage', async () => {
  const storage = new SQLiteStorage(':memory:');
  try {
    const expectations = new Expectations(storage);
    await expectations.initialize();
    const registry = new FulfillmentRegistry(storage); await registry.initialize();
    const users = ['one','two','three'];
    const accounts = users.map(user_id => ({ user_id,provider_customer_id:user_id,identity_status:'mapped',policy_enabled:true,
      identity_revision:1,policy_revision:1,projection_revision:1 }));
    const lumen = { async listAccounts() { return { items:accounts,total:3,next_cursor:null }; },
      async readAccess() { return { active:false,expires_at:null,entitlement_hash:null,allowed:false,reason:'subscription_inactive',
        identity_revision:1,policy_revision:1,projection_revision:1 }; } };
    let reads = 0, sourceStopped = false, observedAt = '2026-11-08T12:00:00Z';
    const provider = { async profile(userId) {
      reads++;
      if (sourceStopped && userId === 'two') throw new Error('cooldown');
      return { user_id:userId,app_id:'app',provider_customer_id:userId,identity_match:true,status:'active',reason:'active',
        source_fingerprint:'a'.repeat(64),observed_at:observedAt,entitlement:{ app_id:'app',user_id:userId,provider_customer_id:userId,
          transaction_id:`txn-${userId}`,product_id:'premium',store:'app_store',source_environment:'Production',
          source_fingerprint:'a'.repeat(64),starts_at:'2026-11-01T00:00:00Z',expires_at:'2026-12-01T00:00:00Z',
          is_in_grace_period:false,entitlement_hash:'b'.repeat(64),raw_source_profile:{ receipt:'secret-receipt' } } };
    } };
    const first = await scanFulfillments(lumen,provider,expectations,'app','Production',() => new Date(observedAt),async () => false);
    assert.deepEqual(first.observations.map(item => classifyFulfillment(item).status),['potential','potential','potential']);
    assert.deepEqual(await persistScan(registry,first,'app','sandbox',async () => true),[]);
    assert.throws(() => prepareRecovery('app',first.current,['one'],new Date(observedAt)), /not eligible/);
    observedAt = '2026-11-08T12:01:00Z'; sourceStopped = true; reads = 0;
    const second = await scanFulfillments(lumen,provider,expectations,'app','Production',() => new Date(observedAt),async () => false);
    assert.deepEqual(second.observations.map(item => classifyFulfillment(item).status),['confirmed','inconclusive','inconclusive']);
    assert.deepEqual(second.coverage,{ registered:3,scanned:3,sourceRead:1,clientRead:3,incomplete:2,sourceStopped:true });
    assert.equal(second.current.size,1);
    assert.deepEqual((await persistScan(registry,second,'app','sandbox',async () => true)).map(item => item.userId),['one']);
    const saved = await storage.statement({ mode:'all',sql:'SELECT user_id,status FROM fulfillment_current ORDER BY user_id' });
    assert.deepEqual(saved.map(row => row.status),['discrepancy','inconclusive','inconclusive']);
    const preview = prepareRecovery('app',second.current,['one'],new Date(observedAt));
    assert.equal(preview.targets.length,1);
    assert.equal(preview.actions.length,2);
    assert.equal(JSON.stringify(preview).includes('secret-receipt'),false);
    assert.throws(() => prepareRecovery('app',second.current,['two'],new Date(observedAt)), /not eligible/);
    assert.equal(reads,2);
    sourceStopped = false;
    let clockMs = Date.parse('2026-11-08T12:02:00Z');
    const oldProfile = provider.profile;
    provider.profile = async userId => { clockMs += 1_000; observedAt = new Date(clockMs).toISOString(); return oldProfile(userId); };
    const crossing = await scanFulfillments(lumen,provider,expectations,'app','Production',() => new Date(clockMs),async () => false);
    assert.equal(crossing.coverage.incomplete,0);
  } finally { await storage.close(); }
});
