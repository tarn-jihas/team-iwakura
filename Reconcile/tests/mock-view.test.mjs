import test from 'node:test';
import assert from 'node:assert/strict';
import { h, money, groupStatus, receiptStatus, CLASSES } from '../dist/mock-view.js';

test('Decimal display preserves values beyond JS numeric precision', () => {
  assert.equal(money('9007199254740993.99', true), '+9,007,199,254,740,993.99');
  assert.equal(money('-989.01', true), '−989.01');
  assert.equal(money('0.00', true), '0.00');
  assert.equal(money('11.98'), '11.98');
  assert.equal(money(null), '—');
});
test('Evidence text is escaped before use as markup', () => {
  assert.equal(h('<script a="x">&\'hello\''), '&lt;script a=&quot;x&quot;&gt;&amp;&#39;hello&#39;');
});
test('Six groups retain manual and expected states after repair', () => {
  const report = { groups: [], group_states: { PRICE_MISMATCH: 'pending' } };
  assert.equal(Object.keys(CLASSES).length, 6);
  assert.equal(groupStatus(report, 'PRICE_MISMATCH'), 'pending');
  assert.equal(groupStatus(report, 'EXTRA_IN_MIXPANEL'), 'manual');
  assert.equal(groupStatus(report, 'SANDBOX_EXPECTED'), 'expected');
});
test('A receipt needs exact readback and a cleared finding before saying verified', () => {
  const action = { group: 'PRICE_MISMATCH', visible_at_tick: 1 };
  const report = { clock: 1, groups: [], group_states: { PRICE_MISMATCH: 'verified' } };
  const audit = status => ({ verification: { actions: [{ action_id: 'action-1', status }] } });
  assert.deepEqual(receiptStatus(report, audit('verified'), 'action-1', action), ['Verified by current read', 'green']);
  assert.deepEqual(receiptStatus(report, audit('missing_readback'), 'action-1', action), ['Readback failed', 'red']);
  assert.deepEqual(receiptStatus(report, {}, 'action-1', action), ['Not verified', 'red']);
  report.group_states.PRICE_MISMATCH = 'open';
  assert.deepEqual(receiptStatus(report, audit('verified'), 'action-1', action), ['Read back; findings remain', 'amber']);
  report.clock = 0;
  assert.deepEqual(receiptStatus(report, audit('pending_visibility'), 'action-1', action), ['Pending visibility', 'amber']);
});
