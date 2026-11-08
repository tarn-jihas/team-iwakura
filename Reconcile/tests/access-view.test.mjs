import test from 'node:test';
import assert from 'node:assert/strict';
import { orderedAccounts, utcInput, utcValue, recoveryOutcome, STATUS, gateReasonLabel } from '../dist/access-view.js';

test('Unknown and legitimate denials stay visible without becoming repair candidates', () => {
  const rows = [{ id: 'a', status: 'healthy' }, { id: 'b', status: 'inconclusive' }, { id: 'c', status: 'confirmed' }, { id: 'd', status: 'legitimate_denial' }];
  assert.deepEqual(orderedAccounts(rows).map(r => r.id), ['c', 'b', 'a', 'd']);
  assert.deepEqual(orderedAccounts(rows, 'inconclusive').map(r => r.id), ['b']);
  assert.equal(orderedAccounts(rows, 'all', 'missing').length, 0);
});
test('Incident form UTC timestamps do not depend on operator timezone', () => {
  assert.equal(utcInput('2026-11-03T00:05:00Z'), '2026-11-03T00:05:00');
  assert.equal(utcValue('2026-11-03T00:05'), '2026-11-03T00:05:00Z');
  assert.equal(utcValue('2026-11-03T00:05:04'), '2026-11-03T00:05:04Z');
  assert.throws(() => utcValue('2026-11-03'), /UTC/);
});
test('Transport acceptance and partial cache repair cannot become a resolved badge', () => {
  assert.deepEqual(recoveryOutcome({ target_count: 24, verified_count: 0, unresolved_count: 24 }), ['0 verified / 24 unresolved', 'amber']);
  assert.deepEqual(recoveryOutcome({ target_count: 24, verified_count: 23, unresolved_count: 1 }), ['23 verified / 1 unresolved', 'amber']);
  assert.deepEqual(recoveryOutcome({ target_count: 24, verified_count: 24, unresolved_count: 0 }), ['Premium access confirmed', 'green']);
});
test('policy blocks and known gate reasons use plain-language labels', () => {
  assert.equal(STATUS.policy_denial[0], 'Blocked by app rule');
  assert.equal(gateReasonLabel('policy_restricted'), 'Blocked by app rule');
  assert.equal(gateReasonLabel('subscription_expired'), 'App considers the access period expired');
  assert.equal(gateReasonLabel('subscription_inactive'), 'App has not enabled Premium access');
  assert.equal(gateReasonLabel('future_reason_code'), 'future reason code');
});
