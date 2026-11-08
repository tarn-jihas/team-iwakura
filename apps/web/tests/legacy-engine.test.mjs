import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseSource, reconcile, exportReport } from '../src/legacy-engine.ts';

const data = file => readFileSync(new URL(`../../../Reconcile/dist/data/${file}`, import.meta.url), 'utf8');
const parse = (file, provider) => { const source = parseSource(data(file), provider); source.provenance = 'synthetic'; source.filename = file; return source; };
const left = () => parse('adapty.jsonl', 'adapty');
const run = (name, coverage = 'declared_complete') => reconcile(left(), parse(`${name}.jsonl`, 'mixpanel'), { coverage });

test('bounded fixture scenarios preserve exact decimal totals and findings', () => {
  const cases = [
    ['clean', '4893', '0', 0, 0, 9], ['missing_refund', '5592', '699', 1, 0, 8],
    ['repeated_delivery', '4893', '0', 0, 1, 9], ['double_tracking', '5592', '699', 1, 0, 10],
    ['zero_net_two_errors', '4893', '0', 2, 0, 9], ['price_unit_error', '74094', '69201', 1, 0, 9],
  ];
  for (const [name, total, delta, issues, info, dedup] of cases) {
    const result = run(name);
    assert.equal(result.left.totalMinor, '4893');
    assert.equal(result.right.totalMinor, total);
    assert.equal(result.deltaMinor, delta);
    assert.equal(result.counts.issues, issues);
    assert.equal(result.counts.info, info);
    assert.equal(result.right.dedupCount, dedup);
    assert.ok(result.findings.every(finding => finding.evidence.every(evidence => typeof evidence.raw === 'string' && evidence.locator && evidence.operationId)));
  }
});

test('equal totals still show the missing and duplicated transaction identities', () => {
  const result = run('zero_net_two_errors');
  assert.equal(result.verdict, 'issues');
  assert.equal(result.findings.find(finding => finding.kind === 'missing_operation').transactionId, 'GPA.9000-0000-0598-00001..1');
  assert.equal(result.findings.find(finding => finding.kind === 'economic_duplicate').transactionId, 'GPA.9000-0000-0598-00001..2');
});

test('repeat deliveries retain raw evidence but only contribute once', () => {
  const result = run('repeated_delivery');
  assert.equal(result.right.rawCount, 10);
  assert.equal(result.right.rawTotalMinor, '5592');
  assert.equal(result.findings[0].evidence.length, 2);
  assert.equal(result.verdict, 'matched');
});

test('Google order fixtures produce nine exact cash operations', () => {
  const result = reconcile(parse('google_orders.json', 'google_play'), left(), { coverage: 'declared_complete' });
  assert.equal(result.left.recordCount, 8);
  assert.equal(result.left.rawCount, 9);
  assert.equal(result.left.totalMinor, '4893');
  assert.equal(result.counts.matched, 9);
  assert.equal(result.findings.length, 0);
});

test('incomplete coverage cannot prove a missing refund', () => {
  const result = run('missing_refund', 'unknown');
  assert.equal(result.counts.issues, 0);
  assert.equal(result.verdict, 'inconclusive');
  assert.equal(result.findings.find(finding => finding.kind === 'missing_operation').deltaMinor, null);
});

test('invalid financial sources and unsupported refund histories are rejected', () => {
  assert.throws(() => parseSource('{oops', 'mixpanel'), /Invalid JSON/);
  const row = JSON.parse(data('clean.jsonl').split('\n')[0]);
  row.properties.currency = 'EUR';
  assert.throws(() => parseSource(JSON.stringify(row), 'mixpanel'), /USD only/);
  row.properties.currency = 'USD';
  row.properties.price_usd = 6.999;
  assert.throws(() => parseSource(JSON.stringify(row), 'mixpanel'), /fraction digits/);
  const order = JSON.parse(data('google_orders.json'));
  order.orders[0].orderHistory.partialRefundEvents = [{ eventTime: '2026-08-14T00:00:00Z', refundDetails: { total: { currencyCode: 'USD', units: '1', nanos: 0 } } }];
  assert.throws(() => parseSource(JSON.stringify(order), 'google_play'), /unsupported order history/);
});

test('decimal lexemes remain exact and do not rewrite JSON strings', () => {
  const line = data('clean.jsonl').split('\n')[0].replace('"price_usd":6.99', '"price_usd":90071992547409.91');
  const source = parseSource(line, 'mixpanel');
  assert.equal(source.operations[0].amountMinor, '9007199254740991');
  const row = JSON.parse(data('clean.jsonl').split('\n')[0]);
  row.properties.note = 'text containing "price_usd":999.99';
  assert.equal(parseSource(JSON.stringify(row), 'mixpanel').operations[0].amountMinor, '699');
  assert.doesNotThrow(() => JSON.stringify(exportReport(run('clean'))));
});
