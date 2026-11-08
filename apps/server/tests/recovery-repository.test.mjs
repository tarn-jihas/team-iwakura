import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SQLiteStorage } from '../dist/infrastructure/sqlite.js';
import { RecoveryRepository } from '../dist/modules/recovery/repository.js';
import { semanticDigest } from '../dist/infrastructure/json.js';

test('approval, snapshot and action identity remain durable and idempotent across restart', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'reconcile-ts-recovery-'));
  const path = join(directory, 'engine.sqlite3');
  let storage = new SQLiteStorage(path), repo = new RecoveryRepository(storage);
  const created = '2026-11-08T11:59:00Z', at = '2026-11-08T12:00:00Z', expires = '2026-11-08T12:04:00Z';
  try {
    await repo.initialize();
    await repo.createIncident('incident', 'app', 'sandbox', created);
    await repo.createIncident('other-incident', 'app', 'sandbox', created);
    assert.deepEqual(await Promise.all([
      repo.acquireOwnership('incident','app','sandbox','user',at),
      repo.acquireOwnership('other-incident','app','sandbox','user',at)
    ]),[true,false]);
    assert.equal(await repo.ownedByAnother('app','sandbox','user','incident'),false);
    assert.equal(await repo.ownedByAnother('app','sandbox','user','other-incident'),true);
    assert.equal(await repo.releaseVerifiedOwnership('incident','user',at),false);
    const target = { userId:'user', customerId:'user', mode:'resync', transactionId:'transaction', store:'app_store',
      sourceEnvironment:'Production', sourceFingerprint:'a'.repeat(64), entitlementHash:'b'.repeat(64),
      identityRevision:1, policyRevision:1, projectionRevision:1 };
    const snapshot = { appId:'app',environment:'sandbox',targets:[target],observedAt:created };
    const snapshotHash = await repo.saveSnapshot('snapshot', 'incident', snapshot, created);
    assert.deepEqual(await repo.readSnapshot('snapshot'), { incidentId:'incident', hash:snapshotHash, payload:snapshot });
    await assert.rejects(storage.statement({ mode:'run', sql:'UPDATE snapshots SET snapshot_json=? WHERE id=?',
      params:['{}','snapshot'] }), /immutable/);
    const request = { schema_version:2, user_id:'user', expected_provider_customer_id:'user',
      expected_identity_revision:1, expected_policy_revision:1, expected_projection_revision:1,
      operation_key:'op', processing_id:'processing', trace_id:'trace',
      entitlement:{ product_id:'premium', expires_at:'2026-12-01T00:00:00Z', entitlement_hash:'b'.repeat(64),
        transaction_id:'transaction', source_fingerprint:'a'.repeat(64), store:'app_store', source_environment:'Production' } };
    const probe = { user_id:'user', feature:'premium_export', initiator:'reconcile_probe' };
    const plan = { id:'plan', incidentId:'incident', snapshotId:'snapshot', snapshotHash,
      appId:'app', environment:'sandbox', policyRevision:1, createdAt:created, expiresAt:expires,
      targets:[target],
      actions:[{ operationKey:'op', userId:'user', kind:'resync_access', request,
        requestHash:semanticDigest(request) }, { operationKey:'probe', userId:'user', kind:'verify_gate',
        request:probe, requestHash:semanticDigest(probe) }] };
    await assert.rejects(repo.savePlan('plan','incident','snapshot', { ...plan, appId:'other' },created,expires),
      /incident scope/);
    await assert.rejects(repo.savePlan('plan','incident','snapshot', { ...plan,
      targets:[{ ...target,projectionRevision:2 }] },created,expires), /snapshot evidence/);
    const planHash = await repo.savePlan('plan','incident','snapshot',plan,created,expires);
    assert.deepEqual(await repo.readPlan('plan'), { plan, hash:planHash });
    await assert.rejects(repo.approve('bad','plan','f'.repeat(64),'policy',at), /missing, changed or expired/);
    await assert.rejects(repo.approve('expired','plan',planHash,'policy',expires), /missing, changed or expired/);
    await assert.rejects(repo.recordAction('op','incident','plan',request,at), /not approved/);
    await repo.approve('approval','plan',planHash,'policy',at);
    await assert.rejects(repo.recordAction('unplanned','incident','plan',request,at), /not approved/);
    await assert.rejects(repo.recordAction('op','incident','plan',{ user:'someone-else' },at), /not approved/);
    await repo.approve('approval','plan',planHash,'policy',at);
    await assert.rejects(repo.approve('approval','plan',planHash,'other-policy',at), /different decision/);
    const reservations = await Promise.all(Array.from({ length:5 }, () => repo.reserveAutomaticAttempt('incident','plan',at)));
    assert.deepEqual(reservations,[1,1,1,1,1]);
    const retryRequest = { ...request,operation_key:'retry-write' };
    for (const id of ['retry','exhausted']) {
      const nextPlan = { ...plan,id,actions:[{ ...plan.actions[0],operationKey:`${id}-write`,
        request:{ ...request,operation_key:`${id}-write` },requestHash:semanticDigest({ ...request,operation_key:`${id}-write` }) },
        { ...plan.actions[1],operationKey:`${id}-gate` }] };
      const nextHash = await repo.savePlan(id,'incident','snapshot',nextPlan,created,expires);
      await repo.approve(`approval-${id}`,id,nextHash,'policy',at);
    }
    assert.equal(await repo.reserveAutomaticAttempt('incident','retry',at),2);
    await assert.rejects(repo.reserveAutomaticAttempt('incident','exhausted',at), /retry budget exhausted/);
    await assert.rejects(repo.recordAction('other','other-incident','plan',{ user:'user' },at), /not approved/);
    const results = await Promise.all(Array.from({ length:10 }, () =>
      repo.recordAction('op','incident','plan',request,at)));
    assert.equal(results.filter(result => result.created).length, 1);
    await assert.rejects(repo.recordAction('op','incident','plan',{ user:'someone-else' },at), /different action/);
    assert.equal(await repo.finishAction('op','unknown_outcome',{ reason:'timeout' },at), true);
    assert.equal(await repo.finishAction('op','failed',{ reason:'not sure' },at), false);
    await assert.rejects(repo.finishAction('op','verified',{},at), /Invalid action result/);
    await storage.close();
    storage = new SQLiteStorage(path); repo = new RecoveryRepository(storage);
    assert.equal(await repo.reserveAutomaticAttempt('incident','retry',expires),2);
    assert.equal((await repo.recordAction('op','incident','plan',request,expires)).created, false);
    assert.equal((await repo.readAction('op')).status, 'unknown_outcome');
    assert.equal((await repo.latestPlan('incident')).plan.id,'exhausted');
    assert.deepEqual(await repo.pendingWriteRequests('incident'),[request]);
    assert.equal(await repo.finishAction('op','verified',{ evidence_ref:'lumen://action/op' },at), true);
    assert.deepEqual(await repo.pendingWriteRequests('incident'),[]);
    assert.equal(await repo.finishAction('op','unknown_outcome',{ reason:'duplicate' },at), false);
    assert.equal((await repo.readAction('op')).status, 'verified');
    assert.deepEqual((await repo.readActionHistory('op')).map(item => item.status),['accepted','unknown_outcome','verified']);
    await assert.rejects(storage.statement({ mode:'run',sql:'DELETE FROM action_history' }), /immutable/);
    await repo.recordAction('probe','incident','plan',probe,at);
    await repo.finishAction('probe','verified',{ evidence_ref:'lumen://gate/user' },at);
    assert.equal(await repo.releaseVerifiedOwnership('incident','user',at),true);
    await assert.rejects(repo.recordAction('retry-write','incident','retry',retryRequest,at), /not approved/);
    assert.equal(await repo.acquireOwnership('other-incident','app','sandbox','user',at),true);
    assert.deepEqual((await repo.readSnapshot('snapshot')).payload, snapshot);
  } finally {
    await storage.close();
    await rm(directory, { recursive:true, force:true });
  }
});
