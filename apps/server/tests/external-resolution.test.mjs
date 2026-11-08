import test from 'node:test';
import assert from 'node:assert/strict';
import { SQLiteStorage } from '../dist/infrastructure/sqlite.js';
import { FulfillmentRegistry } from '../dist/modules/fulfillment/registry.js';
import { persistScan } from '../dist/modules/fulfillment/persist-scan.js';
import { RecoveryRepository } from '../dist/modules/recovery/repository.js';
import { ExternalResolution } from '../dist/modules/recovery/external-resolution.js';

test('failed incident stays owned until independent external gate verification, then a new episode can open', async () => {
  const storage = new SQLiteStorage(':memory:');
  try {
    const registry = new FulfillmentRegistry(storage), repository = new RecoveryRepository(storage);
    await repository.initialize(); await registry.initialize();
    const key = { app:'app',environment:'sandbox',store:'app_store',transactionId:'txn',userId:'user',accessLevel:'premium' };
    const bad = { status:'confirmed',reason:'projection_mismatch',eligible:true,projectionMatches:false };
    const first = await registry.observe(key,bad,'a'.repeat(64),'b'.repeat(64),'2026-11-08T12:00:00Z');
    assert.equal(await registry.claimIncident('incident','app','sandbox',[first.identityHash],'2026-11-08T12:00:01Z'),true);
    assert.equal(await repository.acquireOwnership('incident','app','sandbox','user','2026-11-08T12:00:02Z'),true);
    await repository.saveSnapshot('snapshot','incident',{},'2026-11-08T12:00:01Z');
    await storage.statement({ mode:'run',sql:'INSERT INTO recovery_plans VALUES (?,?,?,?,?,?,?,?,?)',
      params:['failed-plan','incident','snapshot','c'.repeat(64),'{}','2026-11-08T12:00:01Z','2026-11-08T12:04:00Z',0,99_999_999_999_999] });
    await storage.statement({ mode:'run',sql:"INSERT INTO recovery_actions VALUES (?,?,?,?,'failed',?,?)",
      params:['failed-write','incident','failed-plan','d'.repeat(64),'{"reason":"handler_failure"}','2026-11-08T12:00:03Z'] });
    let now = new Date('2026-11-08T12:01:00Z'), gateAllowed = false, waitForGate = null;
    const entitlement = { app_id:'app',user_id:'user',provider_customer_id:'user',transaction_id:'txn',product_id:'premium',
      store:'app_store',source_environment:'Production',source_fingerprint:'a'.repeat(64),
      starts_at:'2026-11-01T00:00:00Z',expires_at:'2026-12-01T00:00:00Z',is_in_grace_period:false,entitlement_hash:'b'.repeat(64) };
    const observation = { appId:'app',userId:'user',now,complete:true,sourceScopeMatches:true,ownedByOtherIncident:true,
      normalProcessingWindow:false,explicitHandlerFailure:false,provider:{ provider_customer_id:'user',identity_status:'mapped' },
      profile:{ app_id:'app',user_id:'user',identity_match:true,status:'active',reason:'active',observed_at:'2026-11-08T12:00:30Z' },
      entitlement,client:{ provider_customer_id:'user',identity_status:'mapped',policy_enabled:true,access_active:true,
        access_expires_at:entitlement.expires_at,entitlement_hash:entitlement.entitlement_hash,gate:{ allowed:true,reason:'allowed' } } };
    const current = { observation,customerId:'user',store:'app_store',sourceEnvironment:'Production',sourceFingerprint:'a'.repeat(64),
      identityRevision:1,policyRevision:1,projectionRevision:2 };
    const lumen = { async probeAccess() { if (waitForGate) await waitForGate(); return { user_id:'user',allowed:gateAllowed,active:true,identity_revision:1,policy_revision:1,
      projection_revision:2,cache_revision:2,expires_at:entitlement.expires_at,entitlement_hash:entitlement.entitlement_hash }; } };
    const resolution = new ExternalResolution(repository,lumen,() => now);
    const scan = { observations:[observation],current:new Map([['user',current]]),coverage:{} };
    const resolve = (id,record) => resolution.resolve(id,'app','sandbox',record);
    await persistScan(registry,scan,'app','sandbox',resolve);
    assert.equal(await repository.hasOwnership('incident','user'),true);
    assert.equal(await registry.openIncident('app','sandbox','user'),'incident');
    gateAllowed = true;
    let gateReached, releaseGate;
    const reached = new Promise(resolve => { gateReached = resolve; });
    waitForGate = () => { gateReached(); return new Promise(resolve => { releaseGate = resolve; }); };
    const racingResolution = resolution.resolve('incident','app','sandbox',current);
    await reached;
    const pendingPlan = { actions:[{ operationKey:'pending-write',userId:'user',kind:'resync_access' }] };
    await storage.statement({ mode:'run',sql:'INSERT INTO recovery_plans VALUES (?,?,?,?,?,?,?,?,?)',
      params:['pending-plan','incident','snapshot','e'.repeat(64),JSON.stringify(pendingPlan),
        '2026-11-08T12:00:01Z','2026-11-08T12:04:00Z',0,99_999_999_999_999] });
    await storage.statement({ mode:'run',sql:"INSERT INTO recovery_actions VALUES (?,?,?,?,'accepted',NULL,?)",
      params:['pending-write','incident','pending-plan','f'.repeat(64),'2026-11-08T12:01:15Z'] });
    releaseGate();
    assert.equal(await racingResolution,false);
    waitForGate = null;
    now = new Date('2026-11-08T12:02:00Z'); observation.now = now;
    await persistScan(registry,scan,'app','sandbox',resolve);
    assert.equal(await repository.hasOwnership('incident','user'),true);
    await repository.finishAction('pending-write','verified',{ evidence_ref:'lumen-action:pending-write' },now.toISOString());
    now = new Date('2026-11-08T12:02:01Z'); observation.now = now;
    entitlement.transaction_id = 'txn-renewed';
    entitlement.source_fingerprint = 'e'.repeat(64); current.sourceFingerprint = entitlement.source_fingerprint;
    entitlement.entitlement_hash = 'f'.repeat(64); observation.client.entitlement_hash = entitlement.entitlement_hash;
    await persistScan(registry,scan,'app','sandbox',resolve);
    assert.equal(await repository.hasOwnership('incident','user'),false);
    assert.equal(await registry.openIncident('app','sandbox','user'),null);
    const evidence = await storage.statement({ mode:'get',sql:'SELECT transaction_id FROM external_verifications' });
    assert.equal(evidence.transaction_id,'txn-renewed');
    const old = await storage.statement({ mode:'get',sql:'SELECT status,episode_open FROM fulfillment_current WHERE identity_hash=?',params:[first.identityHash] });
    assert.equal(old.status,'superseded'); assert.equal(old.episode_open,0);
    await registry.markCoverageGap('app','sandbox','user','2026-11-08T12:02:30Z');
    const oldAfterOutage = await storage.statement({ mode:'get',sql:'SELECT status FROM fulfillment_current WHERE identity_hash=?',params:[first.identityHash] });
    assert.equal(oldAfterOutage.status,'superseded');
    const second = await registry.observe({ ...key,transactionId:'txn-renewed' },bad,'e'.repeat(64),'f'.repeat(64),'2026-11-08T12:03:00Z');
    assert.equal(second.episodeNo,1);
    assert.notEqual(second.identityHash,first.identityHash);
    assert.equal(await registry.claimIncident('next-incident','app','sandbox',[second.identityHash],'2026-11-08T12:03:01Z'),true);
    assert.equal(await repository.acquireOwnership('next-incident','app','sandbox','user','2026-11-08T12:03:02Z'),true);
  } finally { await storage.close(); }
});
