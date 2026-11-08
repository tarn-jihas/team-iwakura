import test from 'node:test';
import assert from 'node:assert/strict';
import { csv, exportUrl, monitorUrl, simulationPayload } from '../src/model.ts';

test('monitor filter requests preserve server cursor semantics', () => {
  const attention = new URL(monitorUrl('next token', 'unresolved'), 'http://local');
  assert.equal(attention.pathname, '/api/recovery/monitor');
  assert.equal(attention.searchParams.get('cursor'), 'next token');
  assert.equal(attention.searchParams.get('limit'), '50');
  assert.equal(attention.searchParams.get('status'), 'needs_attention');
  assert.equal(new URL(monitorUrl(0, 'repaired'), 'http://local').searchParams.get('status'), 'repaired');
});

test('export ranges are interpreted as UTC and reject empty intervals', () => {
  const url = new URL(exportUrl('2026-01-02T03:04:05', '2026-01-03T03:04:05', 'json'), 'http://local');
  assert.equal(url.searchParams.get('from'), '2026-01-02T03:04:05.000Z');
  assert.equal(url.searchParams.get('to'), '2026-01-03T03:04:05.000Z');
  assert.equal(url.searchParams.get('format'), 'json');
  assert.throws(() => exportUrl('2026-01-03T03:04:05', '2026-01-02T03:04:05', 'csv'), /From is earlier than To/);
  assert.throws(() => exportUrl('', '', 'csv'), /valid UTC range/);
});

test('simulation requests use idempotency keys except for stop', () => {
  assert.deepEqual(simulationPayload('continuous', 'operation-1'), { action: 'continuous', operation_key: 'operation-1' });
  assert.deepEqual(simulationPayload('stop', 'unused'), { action: 'stop' });
});

test('CSV export quotes cells and neutralizes spreadsheet formulas', () => {
  const text = csv([{ title: 'say "yes",\nnext', description: '=1+1' }]);
  assert.match(text, /"say ""yes"",\nnext"/);
  assert.match(text, /"'=1\+1"/);
});
