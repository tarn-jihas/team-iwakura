// Ported from Reconcile/tests/mock-view.test.mjs: same assertions against the TypeScript modules.
import { h, money } from '../../src/shared';
import { CLASSES, groupStatus, receiptStatus } from '../../src/modules/analytics';
import type { Audit } from '../../src/modules/analytics/domain';

test('Decimal display preserves values beyond JS numeric precision', () => {
  expect(money('9007199254740993.99', true)).toBe('+9,007,199,254,740,993.99');
  expect(money('-989.01', true)).toBe('−989.01');
  expect(money('0.00', true)).toBe('0.00');
  expect(money('11.98')).toBe('11.98');
  expect(money(null)).toBe('—');
});

test('Evidence text is escaped before use as markup', () => {
  expect(h('<script a="x">&\'hello\'')).toBe('&lt;script a=&quot;x&quot;&gt;&amp;&#39;hello&#39;');
});

test('Six groups retain manual and expected states after repair', () => {
  const report = { groups: [], group_states: { PRICE_MISMATCH: 'pending' } };
  expect(Object.keys(CLASSES)).toHaveLength(6);
  expect(groupStatus(report, 'PRICE_MISMATCH')).toBe('pending');
  expect(groupStatus(report, 'EXTRA_IN_MIXPANEL')).toBe('manual');
  expect(groupStatus(report, 'SANDBOX_EXPECTED')).toBe('expected');
});

test('A receipt needs exact readback and a cleared finding before saying verified', () => {
  const action = { group: 'PRICE_MISMATCH', visible_at_tick: 1 };
  const report = { clock: 1, groups: [], group_states: { PRICE_MISMATCH: 'verified' } as Record<string, string> };
  const audit = (status: string): Audit => ({ verification: { actions: [{ action_id: 'action-1', status }] } });
  expect(receiptStatus(report, audit('verified'), 'action-1', action)).toEqual(['Verified by current read', 'green']);
  expect(receiptStatus(report, audit('missing_readback'), 'action-1', action)).toEqual(['Readback failed', 'red']);
  expect(receiptStatus(report, {}, 'action-1', action)).toEqual(['Not verified', 'red']);
  report.group_states.PRICE_MISMATCH = 'open';
  expect(receiptStatus(report, audit('verified'), 'action-1', action)).toEqual(['Read back; findings remain', 'amber']);
  report.clock = 0;
  expect(receiptStatus(report, audit('pending_visibility'), 'action-1', action)).toEqual(['Pending visibility', 'amber']);
});
