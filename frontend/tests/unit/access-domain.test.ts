// Ported from Reconcile/tests/access-view.test.mjs: same assertions against the TypeScript modules.
import { orderedAccounts, recoveryOutcome, utcInput, utcValue } from '../../src/modules/access';

test('Unknown and legitimate denials stay visible without becoming repair candidates', () => {
  const rows = [{ id: 'a', status: 'healthy' }, { id: 'b', status: 'inconclusive' }, { id: 'c', status: 'confirmed' }, { id: 'd', status: 'legitimate_denial' }];
  expect(orderedAccounts(rows).map(r => r.id)).toEqual(['c', 'b', 'a', 'd']);
  expect(orderedAccounts(rows, 'inconclusive').map(r => r.id)).toEqual(['b']);
  expect(orderedAccounts(rows, 'all', 'missing')).toHaveLength(0);
});

test('Incident form UTC timestamps do not depend on operator timezone', () => {
  expect(utcInput('2026-11-03T00:05:00Z')).toBe('2026-11-03T00:05:00');
  expect(utcValue('2026-11-03T00:05')).toBe('2026-11-03T00:05:00Z');
  expect(utcValue('2026-11-03T00:05:04')).toBe('2026-11-03T00:05:04Z');
  expect(() => utcValue('2026-11-03')).toThrow(/UTC/);
});

test('Transport acceptance and partial cache repair cannot become a resolved badge', () => {
  expect(recoveryOutcome({ target_count: 24, verified_count: 0, unresolved_count: 24 })).toEqual(['0 verified / 24 unresolved', 'amber']);
  expect(recoveryOutcome({ target_count: 24, verified_count: 23, unresolved_count: 1 })).toEqual(['23 verified / 1 unresolved', 'amber']);
  expect(recoveryOutcome({ target_count: 24, verified_count: 24, unresolved_count: 0 })).toEqual(['Access restored · root cause separate', 'green']);
});
