import test from 'node:test';
import assert from 'node:assert/strict';
import { SQLiteStorage } from '../dist/infrastructure/sqlite.js';
import { RecoveryRepository } from '../dist/modules/recovery/repository.js';
import { FulfillmentMonitor } from '../dist/modules/fulfillment/monitor.js';
import { prepareRecovery } from '../dist/modules/recovery/preview.js';

test('a late old-plan commit receives an approved real gate readback after the write budget is spent', async () => {
  const storage = new SQLiteStorage(':memory:'), repo = new RecoveryRepository(storage);
  const now = new Date('2026-11-08T12:00:00Z'), iso = now.toISOString();
  const scope = { appId:'app',environment:'sandbox',sourceEnvironment:'Production',policyRevision:1,provenance:'local_fixture' };
  const current = (user,healthy) => {
    const entitlement = { app_id:'app',user_id:user,provider_customer_id:user,transaction_id:`txn-${user}`,product_id:'premium',
      store:'app_store',source_environment:'Production',source_fingerprint:'a'.repeat(64),starts_at:'2026-11-01T00:00:00Z',
      expires_at:'2026-12-01T00:00:00Z',is_in_grace_period:false,entitlement_hash:'b'.repeat(64) };
    return { observation:{ appId:'app',userId:user,now,complete:true,sourceScopeMatches:true,ownedByOtherIncident:false,
      normalProcessingWindow:false,explicitHandlerFailure:false,provider:{ provider_customer_id:user,identity_status:'mapped' },
      profile:{ app_id:'app',user_id:user,identity_match:true,observed_at:iso,status:'active',reason:'active' },entitlement,
      client:{ provider_customer_id:user,identity_status:'mapped',policy_enabled:true,access_active:healthy,
        access_expires_at:healthy ? entitlement.expires_at : null,entitlement_hash:healthy ? entitlement.entitlement_hash : null,
        gate:{ allowed:healthy,reason:healthy ? 'allowed' : 'subscription_inactive' } } },customerId:user,store:'app_store',
      sourceEnvironment:'Production',sourceFingerprint:entitlement.source_fingerprint,identityRevision:1,policyRevision:1,
      projectionRevision:healthy ? 2 : 1 };
  };
  try {
    await repo.initialize(); await repo.createIncident('incident','app','sandbox',iso);
    const plans = [];
    for (const user of ['a','b']) {
      const preview = prepareRecovery('app',new Map([[user,current(user,false)]]),[user],now);
      const snapshotId = `snapshot-${user}`, planId = `plan-${user}`;
      const snapshotHash = await repo.saveSnapshot(snapshotId,'incident',{ appId:'app',environment:'sandbox',
        targets:preview.targets,evidence:preview.evidence },iso);
      const plan = { id:planId,incidentId:'incident',snapshotId,snapshotHash,appId:'app',environment:'sandbox',policyRevision:1,
        createdAt:iso,expiresAt:'2026-11-08T12:05:00Z',targets:preview.targets,actions:preview.actions };
      const hash = await repo.savePlan(planId,'incident',snapshotId,plan,iso,plan.expiresAt);
      await repo.approve(`approval-${user}`,planId,hash,'policy',iso);
      assert.equal(await repo.acquireOwnership('incident','app','sandbox',user,iso),true);
      await repo.reserveAutomaticAttempt('incident',planId,iso);
      const write = plan.actions.find(action => action.kind === 'resync_access');
      const gate = plan.actions.find(action => action.kind === 'verify_gate');
      await repo.recordAction(write.operationKey,'incident',planId,write.request,iso);
      if (user === 'a') await repo.finishAction(write.operationKey,'unknown_outcome',{ reason:'timeout' },iso);
      else {
        await repo.finishAction(write.operationKey,'verified',{ evidence_ref:'lumen-action:b' },iso);
        await repo.recordAction(gate.operationKey,'incident',planId,gate.request,iso);
        await repo.finishAction(gate.operationKey,'verified',{ evidence_ref:'lumen-gate:b' },iso);
        await repo.releaseVerifiedOwnership('incident',user,iso);
      }
      plans.push(plan);
    }
    const request = plans[0].actions.find(action => action.kind === 'resync_access').request;
    let probes = 0, writes = 0, probeAvailable = false;
    const gate = { user_id:'a',active:true,allowed:true,expires_at:request.entitlement.expires_at,
      entitlement_hash:request.entitlement.entitlement_hash,projection_revision:2,cache_revision:2,identity_revision:1,policy_revision:1 };
    const lumen = { async readAction() { return { accepted:true,schema_version:2,user_id:'a',operation_key:request.operation_key,
      processing_id:request.processing_id,trace_id:request.trace_id,projection_revision:2 }; },
      async readAccess() { return gate; },async probeAccess() { probes++; if (!probeAvailable) throw new Error('unavailable'); return gate; },
      async resyncAccess() { writes++; } };
    const monitor = new FulfillmentMonitor(scope,lumen,{}, {},{},repo,{},() => now);
    const a = current('a',true);
    monitor.scan = async () => ({ observations:[a.observation],current:new Map([['a',a]]),
      coverage:{ registered:1,scanned:1,sourceRead:1,clientRead:1,incomplete:0,sourceStopped:false } });
    monitor.persist = async () => [];
    await monitor.processIncident('incident',['a','b']);
    assert.equal((await repo.readAction(request.operation_key)).status,'verified');
    assert.equal(await repo.hasPendingOwnVerification('incident','a'),true);
    const pendingPlan = (await repo.latestPlan('incident')).plan.id;
    const counts = await storage.statement({ mode:'get',sql:'SELECT (SELECT COUNT(*) FROM recovery_plans) AS plans, (SELECT COUNT(*) FROM snapshots) AS snapshots' });
    await monitor.processIncident('incident',['a','b']);
    assert.equal((await repo.latestPlan('incident')).plan.id,pendingPlan);
    assert.deepEqual(await storage.statement({ mode:'get',sql:'SELECT (SELECT COUNT(*) FROM recovery_plans) AS plans, (SELECT COUNT(*) FROM snapshots) AS snapshots' }),counts);
    probeAvailable = true;
    await monitor.processIncident('incident',['a','b']);
    assert.equal(await repo.hasPendingOwnVerification('incident','a'),false);
    assert.equal(await repo.hasOwnership('incident','a'),false);
    assert.equal(await repo.automaticAttemptCount('incident'),2);
    assert.equal(probes,3);
    assert.equal(writes,0);
  } finally { await storage.close(); }
});
