import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SQLiteStorage } from '../dist/infrastructure/sqlite.js';
import { semanticDigest } from '../dist/infrastructure/json.js';
import { RecoveryRepository } from '../dist/modules/recovery/repository.js';
import { RecoveryExecution } from '../dist/modules/recovery/execution.js';
import { LumenAdapterError } from '../dist/modules/client/lumen-adapter.js';
import { prepareRecovery } from '../dist/modules/recovery/preview.js';

test('approved recovery survives timeout by readback and verifies the actual gate', async () => {
  const directory = await mkdtemp(join(tmpdir(),'reconcile-execution-'));
  const storage = new SQLiteStorage(join(directory,'engine.sqlite'));
  const repository = new RecoveryRepository(storage);
  const now = () => new Date('2026-11-08T12:00:00Z');
  try {
    await repository.initialize();
    await repository.createIncident('incident','app','sandbox','2026-11-08T11:59:00Z');
    const target = { userId:'user',mode:'resync',customerId:'user',transactionId:'txn',store:'app_store',
      sourceEnvironment:'Production',sourceFingerprint:'a'.repeat(64),entitlementHash:'b'.repeat(64),
      identityRevision:1,policyRevision:1,projectionRevision:1 };
    const snapshotPayload = { appId:'app',environment:'sandbox',targets:[target] };
    const snapshotHash = await repository.saveSnapshot('snapshot','incident',snapshotPayload,'2026-11-08T11:59:00Z');
    const request = { schema_version:2,user_id:'user',expected_provider_customer_id:'user',
      expected_identity_revision:1,expected_policy_revision:1,expected_projection_revision:1,
      entitlement:{ product_id:'premium',expires_at:'2026-12-01T00:00:00Z',entitlement_hash:target.entitlementHash,
        transaction_id:'txn',source_fingerprint:target.sourceFingerprint,store:'app_store',source_environment:'Production' },
      operation_key:'write',processing_id:'processing',trace_id:'trace' };
    const probe = { user_id:'user',feature:'premium_export',initiator:'reconcile_probe' };
    const plan = { id:'plan',incidentId:'incident',snapshotId:'snapshot',snapshotHash,appId:'app',environment:'sandbox',
      policyRevision:1,createdAt:'2026-11-08T11:59:00Z',expiresAt:'2026-11-08T12:04:00Z',targets:[target],
      actions:[{ operationKey:'write',userId:'user',kind:'resync_access',request,requestHash:semanticDigest(request) },
        { operationKey:'probe',userId:'user',kind:'verify_gate',request:probe,requestHash:semanticDigest(probe) }] };
    const planHash = await repository.savePlan('plan','incident','snapshot',plan,plan.createdAt,plan.expiresAt);
    const observation = { appId:'app',userId:'user',now:now(),complete:true,sourceScopeMatches:true,
      ownedByOtherIncident:false,normalProcessingWindow:false,explicitHandlerFailure:false,
      provider:{ provider_customer_id:'user',identity_status:'mapped' },
      profile:{ app_id:'app',user_id:'user',identity_match:true,observed_at:'2026-11-08T11:59:00Z',status:'active',reason:'active' },
      entitlement:{ app_id:'app',user_id:'user',provider_customer_id:'user',transaction_id:'txn',product_id:'premium',
        store:'app_store',source_environment:'Production',source_fingerprint:target.sourceFingerprint,
        starts_at:'2026-11-01T00:00:00Z',expires_at:request.entitlement.expires_at,is_in_grace_period:false,
        entitlement_hash:target.entitlementHash },
      client:{ provider_customer_id:'user',identity_status:'mapped',policy_enabled:true,access_active:false,
        access_expires_at:null,entitlement_hash:null,gate:{ allowed:false,reason:'subscription_inactive' } } };
    const current = { observation,customerId:'user',store:'app_store',sourceEnvironment:'Production',
      sourceFingerprint:target.sourceFingerprint,identityRevision:1,policyRevision:1,projectionRevision:1 };
    let writes = 0, committed = false, gateAllowed = true, gateIdentityRevision = 1, probeUnavailable = false, activeRequest = request;
    const lumen = {
      async resyncAccess(body) { activeRequest = body; writes++; committed = true; throw new LumenAdapterError('unknown_outcome'); },
      async readAction() { return committed ? { accepted:true,schema_version:2,user_id:'user',operation_key:activeRequest.operation_key,
        processing_id:'processing',trace_id:'trace',projection_revision:2 } : null; },
      async readAccess() { return { user_id:'user',active:committed,expires_at:request.entitlement.expires_at,
        entitlement_hash:target.entitlementHash,projection_revision:2,cache_revision:2,identity_revision:1,policy_revision:1 }; },
      async probeAccess() { if (probeUnavailable) throw new Error('probe timeout'); return { user_id:'user',allowed:gateAllowed,projection_revision:2,cache_revision:2,
        identity_revision:gateIdentityRevision,policy_revision:1,active:true,expires_at:request.entitlement.expires_at,
        entitlement_hash:target.entitlementHash }; }
    };
    const executor = new RecoveryExecution(repository,lumen,async () => new Map([['user',current]]),now);
    const scope = { appId:'app',environment:'sandbox',policyRevision:1 };
    await assert.rejects(executor.execute('plan',scope), /not approved/);
    assert.equal(writes,0);
    await repository.approve('approval','plan',planHash,'policy',now().toISOString());
    current.identityRevision++;
    await assert.rejects(executor.execute('plan',scope), /source_or_revision_changed/);
    assert.equal(writes,0);
    current.identityRevision--;
    const release = repository.releaseVerifiedOwnership.bind(repository);
    let crashAfterVerification = true;
    repository.releaseVerifiedOwnership = async (...args) => {
      if (crashAfterVerification) { crashAfterVerification = false; throw new Error('simulated restart'); }
      return release(...args);
    };
    await assert.rejects(executor.execute('plan',scope), /simulated restart/);
    assert.equal(await repository.ownedByAnother('app','sandbox','user','other-incident'),true);
    const result = await executor.execute('plan',scope);
    assert.deepEqual(result,[{ operationKey:'write',status:'verified' },{ operationKey:'probe',status:'verified' }]);
    assert.equal(writes,1);
    assert.equal(await repository.ownedByAnother('app','sandbox','user','other-incident'),false);
    await executor.execute('plan',scope);
    assert.equal(writes,1);
    await assert.rejects(executor.execute('plan',{ ...scope,environment:'other' }), /scope_changed/);
    await assert.rejects(executor.resolveWrite({ ...request,trace_id:'different' }), /payload/);
    await repository.createIncident('incident-2','app','sandbox',plan.createdAt);
    const snapshot2 = await repository.saveSnapshot('snapshot-2','incident-2',snapshotPayload,plan.createdAt);
    const request2 = { ...request,operation_key:'write-2' };
    const second = { ...plan,id:'plan-2',incidentId:'incident-2',snapshotId:'snapshot-2',snapshotHash:snapshot2,
      actions:[{ ...plan.actions[0],operationKey:'write-2',request:request2,requestHash:semanticDigest(request2) },
        { ...plan.actions[1],operationKey:'probe-2' }] };
    const secondHash = await repository.savePlan('plan-2','incident-2','snapshot-2',second,second.createdAt,second.expiresAt);
    await repository.approve('approval-2','plan-2',secondHash,'policy',now().toISOString());
    assert.equal(await repository.acquireOwnership('incident-2','app','sandbox','user',now().toISOString()),true);
    await repository.recordAction('write-2','incident-2','plan-2',request2,now().toISOString());
    activeRequest = request2;
    current.projectionRevision = 2;
    Object.assign(observation.client,{ access_active:true,access_expires_at:request.entitlement.expires_at,
      entitlement_hash:target.entitlementHash,gate:{ allowed:true,reason:'allowed' } });
    probeUnavailable = true;
    assert.deepEqual(await executor.execute('plan-2',scope),[
      { operationKey:'write-2',status:'verified' },{ operationKey:'probe-2',status:'unknown_outcome' }]);
    assert.equal(await repository.hasPendingOwnVerification('incident-2','user'),true);
    probeUnavailable = false; gateIdentityRevision = 2;
    assert.equal((await executor.execute('plan-2',scope))[1].status,'failed');
    gateIdentityRevision = 1;
    assert.equal(await repository.hasPendingOwnVerification('incident-2','user'),false);
    const preview = prepareRecovery('app',new Map([['user',current]]),['user'],now(),new Map([['user','probe']]));
    assert.deepEqual(preview.actions.map(action => action.kind),['verify_gate']);
    const snapshot3 = await repository.saveSnapshot('snapshot-3','incident-2',
      { appId:'app',environment:'sandbox',targets:preview.targets,evidence:preview.evidence },plan.createdAt);
    const third = { ...plan,id:'plan-3',incidentId:'incident-2',snapshotId:'snapshot-3',snapshotHash:snapshot3,
      targets:preview.targets,actions:preview.actions };
    const thirdHash = await repository.savePlan('plan-3','incident-2','snapshot-3',third,third.createdAt,third.expiresAt);
    await repository.approve('approval-3','plan-3',thirdHash,'policy',now().toISOString());
    const retryRequest = { ...request,operation_key:'write-4' };
    const fourth = { ...second,id:'plan-4',actions:[{ ...second.actions[0],operationKey:'write-4',request:retryRequest,
      requestHash:semanticDigest(retryRequest) },{ ...second.actions[1],operationKey:'probe-4' }] };
    const fourthHash = await repository.savePlan('plan-4','incident-2','snapshot-2',fourth,fourth.createdAt,fourth.expiresAt);
    await repository.approve('approval-4','plan-4',fourthHash,'policy',now().toISOString());
    assert.equal(await repository.reserveAutomaticAttempt('incident-2','plan-4',now().toISOString()),2);
    assert.equal((await executor.execute('plan-3',scope))[0].status,'verified');
    assert.equal(await repository.automaticAttemptCount('incident-2'),2);
    assert.equal(writes,1);
  } finally {
    await storage.close();
    await rm(directory,{ recursive:true,force:true });
  }
});

test('verified ownership is released before a remaining account fails an expired preflight', async () => {
  const actions = [
    { operationKey:'a-write',userId:'a',kind:'resync_access',requestHash:'a' },
    { operationKey:'a-gate',userId:'a',kind:'verify_gate',requestHash:'b' },
    { operationKey:'b-write',userId:'b',kind:'resync_access',requestHash:'c' },
    { operationKey:'b-gate',userId:'b',kind:'verify_gate',requestHash:'d' }
  ];
  const plan = { id:'plan',incidentId:'incident',snapshotId:'snapshot',snapshotHash:'c'.repeat(64),appId:'app',
    environment:'sandbox',policyRevision:1,createdAt:'2026-11-08T11:59:00Z',expiresAt:'2026-11-08T12:04:00Z',
    targets:[{ userId:'a' },{ userId:'b' }],actions };
  const released = [];
  const repository = {
    async readPlan() { return { plan,hash:'d'.repeat(64) }; },
    async readSnapshot() { return { incidentId:'incident',hash:plan.snapshotHash }; },
    async readAction(key) {
      const index = actions.findIndex(action => action.operationKey === key);
      return index < 2 ? { status:'verified',planId:'plan',incidentId:'incident',requestHash:actions[index].requestHash } : null;
    },
    async releaseVerifiedOwnership(incident,user) { released.push([incident,user]); return true; },
    async acquirePlanOwnership() { assert.fail('expired plan must not acquire new ownership'); }
  };
  const executor = new RecoveryExecution(repository,{},async () => new Map(),() => new Date('2026-11-08T12:05:00Z'));
  await assert.rejects(executor.execute('plan',{ appId:'app',environment:'sandbox',policyRevision:1 }), /invalid_or_expired_plan/);
  assert.deepEqual(released,[['incident','a']]);
});
