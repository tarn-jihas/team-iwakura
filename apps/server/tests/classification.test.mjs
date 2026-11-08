import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyFulfillment } from '../dist/modules/fulfillment/classification.js';

function observation() {
  return {
    appId: 'app', userId: 'user', now: new Date('2026-11-08T12:00:00Z'), complete: true,
    sourceScopeMatches: true, ownedByOtherIncident: false, normalProcessingWindow: false,
    explicitHandlerFailure: false, provider: { provider_customer_id: 'user', identity_status: 'mapped' },
    profile: { user_id: 'user', app_id: 'app', identity_match: true,
      observed_at: '2026-11-08T11:59:00Z', status: 'active', reason: 'active' },
    entitlement: { app_id: 'app', user_id: 'user', provider_customer_id: 'user',
      transaction_id: 'transaction', store: 'app_store', source_environment: 'Production',
      source_fingerprint: 'a'.repeat(64), starts_at: '2026-11-01T00:00:00Z',
      expires_at: '2026-12-01T00:00:00Z', is_in_grace_period: false, entitlement_hash: 'hash' },
    client: { provider_customer_id: 'user', identity_status: 'mapped', policy_enabled: true,
      access_active: true, access_expires_at: '2026-12-01T00:00:00Z', entitlement_hash: 'hash',
      gate: { allowed: true, reason: 'allowed' } }
  };
}

test('healthy access, mismatched renewal and denied cache remain distinguishable', () => {
  const input = observation();
  assert.equal(classifyFulfillment(input).status, 'healthy');
  input.ownedByOtherIncident = true;
  assert.equal(classifyFulfillment(input).status, 'healthy');
  input.ownedByOtherIncident = false;
  input.client.access_expires_at = '2026-11-10T00:00:00Z';
  assert.deepEqual(classifyFulfillment(input), {
    status: 'confirmed', reason: 'projection_mismatch', eligible: true, projectionMatches: false
  });
  input.normalProcessingWindow = true;
  assert.equal(classifyFulfillment(input).reason, 'normal_processing_window');
  input.explicitHandlerFailure = true;
  assert.equal(classifyFulfillment(input).eligible, true);
  input.client.access_expires_at = input.entitlement.expires_at;
  input.client.gate = { allowed: false, reason: 'cache_stale' };
  assert.equal(classifyFulfillment(input).reason, 'gate_denied_despite_matching_projection');
});

test('unsafe, stale and ambiguous source evidence never authorizes a repair', () => {
  for (const [change, reason] of [
    [x => { x.complete = false; }, 'coverage_incomplete'],
    [x => { x.provider.provider_customer_id = 'another'; }, 'identity_unknown'],
    [x => { x.sourceScopeMatches = false; }, 'source_scope_mismatch'],
    [x => { x.profile.observed_at = '2026-11-08T11:54:59Z'; }, 'adapty_profile_stale'],
    [x => { x.entitlement.app_id = 'another'; }, 'identity_unknown'],
    [x => { x.entitlement.transaction_id = null; }, 'transaction_link_missing'],
    [x => { x.entitlement.is_in_grace_period = true; }, 'grace_period'],
    [x => { x.entitlement.expires_at = 'invalid'; }, 'period_unavailable'],
    [x => { x.client.policy_enabled = false; }, 'policy_restricted'],
    [x => { x.ownedByOtherIncident = true; x.client.access_active = false; }, 'owned_by_open_incident']
  ]) {
    const input = observation(); change(input);
    const outcome = classifyFulfillment(input);
    assert.equal(outcome.reason, reason);
    assert.equal(outcome.eligible, false);
  }
});

test('the entitlement interval is start-inclusive and expiry-exclusive', () => {
  const input = observation();
  input.now = new Date(input.entitlement.starts_at);
  input.profile.observed_at = input.entitlement.starts_at;
  assert.equal(classifyFulfillment(input).status, 'healthy');
  input.now = new Date(input.entitlement.expires_at);
  input.profile.observed_at = input.entitlement.expires_at;
  assert.equal(classifyFulfillment(input).reason, 'premium_entitlement_not_current');
});
