import test from 'node:test';
import assert from 'node:assert/strict';
import { groupStatus, receiptStatus } from '../src/mock-model.ts';

test('analytics receipt status distinguishes pending visibility from verified readback', () => {
  const report = { clock: 4, groups: [{ cls: 'PRICE_MISMATCH' }] };
  const audit = { verification: { actions: [{ action_id: 'a1', status: 'verified' }] } };
  assert.deepEqual(receiptStatus(report, audit, 'a1', { group: 'PRICE_MISMATCH', visible_at_tick: 5 }), ['Pending visibility', 'amber']);
  assert.deepEqual(receiptStatus({ ...report, clock: 5, group_states: { PRICE_MISMATCH: 'verified' } }, audit, 'a1', { group: 'PRICE_MISMATCH', visible_at_tick: 5 }), ['Verified by current read', 'green']);
  assert.equal(groupStatus({ groups: [] }, 'EXTRA_IN_MIXPANEL'), 'manual');
});
