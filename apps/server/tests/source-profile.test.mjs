import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeProfile } from '../dist/modules/source/profile.js';

const now = new Date('2026-11-07T20:00:00Z');
function rawProfile() {
  const level = { store:'app_store', store_product_id:'lumen.annual', store_transaction_id:'txn-1',
    purchased_at:'2026-08-09T03:06:34+00:00', starts_at:null, expires_at:'2027-08-09T03:06:34+00:00',
    is_in_grace_period:false, renewal_cancelled_at:'2026-11-07T19:21:25Z',
    cancellation_reason:'voluntarily_cancelled', billing_issue_detected_at:null,
    access_level_id:'premium', offer:null };
  return { app_id:'app', profile_id:'profile-1', customer_user_id:'customer',
    timestamp:'2026-11-07T20:00:00Z', price:9.99, custom_attributes:{},
    access_levels:[level], subscriptions:[{ ...level, environment:'Production', cancellation_reason:null }],
    non_subscriptions:[] };
}
const normalize = raw => normalizeProfile(raw, 'app', 'customer', now);

test('current cancelled renewal preserves the right without claiming a payment', () => {
  const profile = normalize(rawProfile());
  assert.equal(profile.status, 'active');
  assert.equal(profile.entitlement.starts_at, '2026-08-09T03:06:34Z');
  assert.equal(profile.entitlement.expires_at, '2027-08-09T03:06:34Z');
  assert.equal(profile.entitlement.entitlement_hash, 'f0672e02f294aac8e5bdf808a30070bbaa97d181854f7012c9a712f9ccaaf769');
  assert.equal(profile.payment_verification, 'not_independently_verified');
  assert.equal('amount' in profile.entitlement, false);
  assert.equal('payment_state' in profile.entitlement, false);
});

test('fingerprints ignore observation time but capture source changes', () => {
  const raw = rawProfile();
  const initial = normalize(raw).source_fingerprint;
  raw.timestamp = '2026-11-07T20:01:00Z';
  assert.equal(normalize(raw).source_fingerprint, initial);
  raw.subscriptions[0].expires_at = '2027-08-10T03:06:34+00:00';
  assert.notEqual(normalize(raw).source_fingerprint, initial);
  assert.equal(normalize(raw).reason, 'premium_source_binding_uncertain');
});

test('identity, trial, grace, refund, unknown bindings and expired rights fail closed', () => {
  for (const [change, expected] of [
    [raw => { raw.app_id = 'wrong'; }, 'identity_scope_mismatch'],
    [raw => { raw.customer_user_id = 'wrong'; }, 'identity_scope_mismatch'],
    [raw => { raw.subscriptions[0].offer = {type:'trial'}; }, 'trial_period'],
    [raw => { raw.subscriptions[0].is_in_grace_period = true; }, 'grace_period'],
    [raw => { raw.subscriptions[0].refunded_at = '2026-10-01T00:00:00Z'; }, 'premium_source_binding_uncertain'],
    [raw => { raw.subscriptions[0].environment = 'Sandbox'; }, 'premium_source_binding_uncertain'],
    [raw => { raw.access_levels[0].expires_at = '2027-02-30T03:06:34Z'; }, 'premium_source_binding_uncertain'],
    [raw => { raw.access_levels[0].expires_at = raw.subscriptions[0].expires_at = '2026-11-06T00:00:00Z'; }, 'subscription_expired']
  ]) {
    const raw = rawProfile(); change(raw);
    const result = normalize(raw);
    assert.equal(result.reason, expected);
    assert.notEqual(result.status, 'active');
  }
  const unsafe = rawProfile(); unsafe.amount = 9007199254740992;
  assert.throws(() => normalize(unsafe), /Invalid source JSON/);
});
