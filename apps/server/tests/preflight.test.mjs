import test from 'node:test';
import assert from 'node:assert/strict';
import { preflightPlan } from '../dist/modules/recovery/preflight.js';
import { semanticDigest } from '../dist/infrastructure/json.js';

const at = new Date('2026-11-08T12:00:00Z');
const sourceHash = 'a'.repeat(64), entitlementHash = 'b'.repeat(64);
function actions(target) {
  const request = { schema_version:2, user_id:target.userId, expected_provider_customer_id:target.customerId,
    expected_identity_revision:target.identityRevision, expected_policy_revision:target.policyRevision,
    expected_projection_revision:target.projectionRevision, operation_key:`resync-${target.userId}`,
    processing_id:`processing-${target.userId}`, trace_id:`trace-${target.userId}`,
    entitlement:{ product_id:'premium', expires_at:'2026-12-01T00:00:00Z', entitlement_hash:entitlementHash,
      transaction_id:target.transactionId, source_fingerprint:sourceHash, store:target.store,
      source_environment:target.sourceEnvironment } };
  const probe = { user_id:target.userId, feature:'premium_export', initiator:'reconcile_probe' };
  return [...(target.mode === 'resync' ? [{ kind:'resync_access', userId:target.userId,
    operationKey:request.operation_key, request, requestHash:semanticDigest(request) }] : []),
    { kind:'verify_gate', userId:target.userId, operationKey:`probe-${target.userId}`,
      request:probe, requestHash:semanticDigest(probe) }];
}
function fixture() {
  const target = { userId:'user', mode:'resync', customerId:'user', transactionId:'transaction',
    store:'app_store', sourceEnvironment:'Production', sourceFingerprint:sourceHash,
    entitlementHash, identityRevision:1, policyRevision:2, projectionRevision:3 };
  const observation = { appId:'app', userId:'user', now:at, complete:true, sourceScopeMatches:true,
    ownedByOtherIncident:false, normalProcessingWindow:false, explicitHandlerFailure:false,
    provider:{ provider_customer_id:'user', identity_status:'mapped' },
    profile:{ app_id:'app', user_id:'user', identity_match:true, observed_at:'2026-11-08T11:59:00Z',
      status:'active', reason:'active' },
    entitlement:{ app_id:'app', user_id:'user', provider_customer_id:'user', transaction_id:'transaction',
      product_id:'premium',
      store:'app_store', source_environment:'Production', source_fingerprint:sourceHash,
      starts_at:'2026-11-01T00:00:00Z', expires_at:'2026-12-01T00:00:00Z',
      is_in_grace_period:false, entitlement_hash:entitlementHash },
    client:{ provider_customer_id:'user', identity_status:'mapped', policy_enabled:true,
      access_active:false, access_expires_at:null, entitlement_hash:null,
      gate:{ allowed:false, reason:'subscription_inactive' } } };
  const actual = { observation, customerId:'user', store:'app_store', sourceEnvironment:'Production',
    sourceFingerprint:sourceHash, identityRevision:1, policyRevision:2, projectionRevision:3 };
  const plan = { id:'plan', incidentId:'incident', snapshotId:'snapshot', snapshotHash:'c'.repeat(64), appId:'app',
    environment:'hackathon_seed', policyRevision:4, createdAt:'2026-11-08T11:59:00Z',
    expiresAt:'2026-11-08T12:04:00Z', targets:[target], actions:actions(target) };
  return { plan, actual, scope:{ appId:'app', environment:'hackathon_seed', policyRevision:4 } };
}
const run = ({ plan, actual, scope }, clock = at) => preflightPlan(plan, scope, new Map([['user',actual]]), clock);

test('a verified discrepancy passes preflight and a self-healed target requires a new plan', () => {
  const f = fixture();
  assert.doesNotThrow(() => run(f));
  Object.assign(f.actual.observation.client, { access_active:true, access_expires_at:'2026-12-01T00:00:00Z',
    entitlement_hash:entitlementHash, gate:{ allowed:true, reason:'allowed' } });
  assert.throws(() => run(f), error => error.code === 'account_not_eligible');
  f.plan.targets[0].mode = 'probe';
  f.plan.actions = actions(f.plan.targets[0]);
  assert.doesNotThrow(() => run(f));
});

test('any scope, source or revision drift blocks the entire plan before writes', () => {
  for (const change of [
    f => { f.actual.identityRevision++; }, f => { f.actual.policyRevision++; },
    f => { f.actual.projectionRevision++; }, f => { f.actual.sourceFingerprint = 'd'.repeat(64); },
    f => { f.actual.observation.entitlement.transaction_id = 'another'; },
    f => { f.actual.observation.entitlement.source_environment = 'Sandbox'; },
    f => { f.actual.customerId = 'another'; }, f => { f.scope.policyRevision++; }
  ]) {
    const f = fixture(); change(f);
    assert.throws(() => run(f));
  }
  const f = fixture();
  assert.throws(() => run(f, new Date(f.plan.expiresAt)), error => error.code === 'invalid_or_expired_plan');
  f.plan.createdAt = '2026-02-30T00:00:00Z';
  assert.throws(() => run(f), error => error.code === 'invalid_or_expired_plan');
  f.plan.createdAt = '2026-11-08T11:59:00Z';
  f.plan.targets.push({ ...f.plan.targets[0] });
  assert.throws(() => run(f), error => error.code === 'invalid_targets');
});

test('ambiguous or stale evidence cannot authorize resync', () => {
  for (const change of [
    f => { f.actual.observation.complete = false; },
    f => { f.actual.observation.profile.observed_at = '2026-11-08T11:54:59Z'; },
    f => { f.actual.observation.entitlement.is_in_grace_period = true; },
    f => { f.actual.observation.client.policy_enabled = false; },
    f => { f.actual.observation.ownedByOtherIncident = true; }
  ]) {
    const f = fixture(); change(f);
    assert.throws(() => run(f), error => error.code === 'account_not_eligible');
  }
});

test('a change to any account blocks a multi-account plan', () => {
  const first = fixture(), second = fixture();
  second.plan.targets[0].userId = second.plan.targets[0].customerId = 'other';
  second.actual.customerId = 'other';
  second.actual.observation.userId = second.actual.observation.profile.user_id = 'other';
  second.actual.observation.provider.provider_customer_id = 'other';
  second.actual.observation.client.provider_customer_id = 'other';
  second.actual.observation.entitlement.user_id = second.actual.observation.entitlement.provider_customer_id = 'other';
  first.plan.targets.push(second.plan.targets[0]);
  first.plan.actions.push(...actions(second.plan.targets[0]));
  second.actual.policyRevision++;
  assert.throws(() => preflightPlan(first.plan, first.scope,
    new Map([['user',first.actual],['other',second.actual]]),at),
    error => error.code === 'source_or_revision_changed' && error.userId === 'other');
});

test('the exact approved write must match fresh source evidence', () => {
  const f = fixture();
  f.plan.actions[0].request.entitlement.product_id = 'other-product';
  f.plan.actions[0].requestHash = semanticDigest(f.plan.actions[0].request);
  assert.throws(() => run(f), error => error.code === 'source_or_revision_changed');
  f.plan.actions[0].request.expected_identity_revision++;
  f.plan.actions[0].requestHash = semanticDigest(f.plan.actions[0].request);
  assert.throws(() => run(f), error => error.code === 'invalid_plan_actions');
});
