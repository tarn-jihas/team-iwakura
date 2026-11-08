import test from 'node:test';
import assert from 'node:assert/strict';
import { orderedAccounts, utcInput, utcValue, recoveryOutcome } from '../src/access-model.ts';

test('unknown and legitimate denials remain visible without becoming repair candidates', () => {
  const rows = [{ id: 'a', status: 'healthy' }, { id: 'b', status: 'inconclusive' }, { id: 'c', status: 'confirmed' }, { id: 'd', status: 'legitimate_denial' }];
  assert.deepEqual(orderedAccounts(rows).map(row => row.id), ['c', 'b', 'a', 'd']);
  assert.deepEqual(orderedAccounts(rows, 'inconclusive').map(row => row.id), ['b']);
  assert.equal(orderedAccounts(rows, 'all', 'missing').length, 0);
});

test('UTC incident inputs do not depend on operator timezone', () => {
  assert.equal(utcInput('2026-11-03T00:05:00Z'), '2026-11-03T00:05:00');
  assert.equal(utcValue('2026-11-03T00:05'), '2026-11-03T00:05:00Z');
  assert.equal(utcValue('2026-11-03T00:05:04'), '2026-11-03T00:05:04Z');
  assert.throws(() => utcValue('2026-11-03'), /UTC/);
});

test('only complete access verification reports restoration', () => {
  assert.deepEqual(recoveryOutcome({ target_count: 24, verified_count: 0, unresolved_count: 24 }), ['0 verified / 24 unresolved', 'amber']);
  assert.deepEqual(recoveryOutcome({ target_count: 24, verified_count: 23, unresolved_count: 1 }), ['23 verified / 1 unresolved', 'amber']);
  assert.deepEqual(recoveryOutcome({ target_count: 24, verified_count: 24, unresolved_count: 0 }), ['Access restored · root cause separate', 'green']);
});
