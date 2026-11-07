import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseSource, reconcile, exportReport } from '../dist/engine.js';

const data = file => readFileSync(new URL('../dist/data/' + file, import.meta.url), 'utf8');
const parse = (file, provider) => { const s = parseSource(data(file), provider); s.provenance = 'synthetic'; s.filename = file; return s; };
const left = () => parse('adapty.jsonl', 'adapty');
const run = (name, coverage = 'declared_complete') => reconcile(left(), parse(name + '.jsonl', 'mixpanel'), { coverage });
// Expected outcomes are evaluation controls, never app runtime inputs.
const cases = [
  ['clean', '4893', '0', 0, 0, 9],
  ['missing_refund', '5592', '699', 1, 0, 8],
  ['repeated_delivery', '4893', '0', 0, 1, 9],
  ['double_tracking', '5592', '699', 1, 0, 10],
  ['zero_net_two_errors', '4893', '0', 2, 0, 9],
  ['price_unit_error', '74094', '69201', 1, 0, 9],
];
for (const [name,total,delta,issues,info,dedup] of cases) test(name, () => {
  const r=run(name); assert.equal(r.left.totalMinor, '4893'); assert.equal(r.right.totalMinor,total);
  assert.equal(r.deltaMinor,delta); assert.equal(r.counts.issues,issues); assert.equal(r.counts.info,info); assert.equal(r.right.dedupCount,dedup);
  for (const f of r.findings) assert.ok(f.evidence.every(e=>typeof e.raw==='string'&&e.locator&&e.operationId));
});
test('zero total cannot hide exact missing and duplicated identities',()=>{
  const r=run('zero_net_two_errors'); assert.equal(r.verdict,'issues');
  assert.equal(r.findings.find(f=>f.kind==='missing_operation').transactionId,'GPA.9000-0000-0598-00001..1');
  assert.equal(r.findings.find(f=>f.kind==='economic_duplicate').transactionId,'GPA.9000-0000-0598-00001..2');
});
test('retry retains both raw observations but counts only one',()=>{
  const r=run('repeated_delivery'); assert.equal(r.right.rawCount,10); assert.equal(r.right.rawTotalMinor,'5592');
  assert.equal(r.findings[0].evidence.length,2); assert.equal(r.verdict,'matched');
});
test('8 order objects yield 9 matched cash operations',()=>{
  const r=reconcile(parse('google_orders.json','google_play'),left(),{coverage:'declared_complete'});
  assert.equal(r.left.recordCount,8); assert.equal(r.left.rawCount,9); assert.equal(r.left.totalMinor,'4893'); assert.equal(r.counts.matched,9); assert.equal(r.findings.length,0);
});
test('unknown coverage prevents proving a missing refund',()=>{
  const r=run('missing_refund','unknown'); assert.equal(r.counts.issues,0); assert.equal(r.verdict,'inconclusive');
  assert.equal(r.findings.find(f=>f.kind==='missing_operation').deltaMinor,null);
});
test('same input yields same fingerprint and financial result',()=>{
  const a=run('zero_net_two_errors'), b=run('zero_net_two_errors'); assert.equal(a.fingerprint,b.fingerprint); assert.deepEqual(a.findings,b.findings);
  assert.doesNotThrow(()=>JSON.stringify(exportReport(a)));
});
test('reject malformed JSON, unsupported currency and false precision',()=>{
  assert.throws(()=>parseSource('{oops','mixpanel'),/Invalid JSON/);
  const row=JSON.parse(data('clean.jsonl').split('\n')[0]); row.properties.currency='EUR';
  assert.throws(()=>parseSource(JSON.stringify(row),'mixpanel'),/USD only/);
  row.properties.currency='USD'; row.properties.price_usd=6.999;
  assert.throws(()=>parseSource(JSON.stringify(row),'mixpanel'),/fraction digits/);
});
test('source scope cannot silently cross production and sandbox',()=>{
  const text=data('clean.jsonl').replaceAll('Production','Sandbox');
  assert.throws(()=>reconcile(left(),parseSource(text,'mixpanel'),{coverage:'declared_complete'}),/same store, environment/);
});
test('conflicting delivery identity blocks unsupported source',()=>{
  const rows=data('clean.jsonl').trim().split('\n'), duplicate=JSON.parse(rows[0]); duplicate.properties.price_usd=7.99;
  assert.throws(()=>parseSource(rows.join('\n')+'\n'+JSON.stringify(duplicate),'mixpanel'),/Conflicting financial payloads/);
});
test('partial refund history is rejected instead of disappearing',()=>{
  const raw=JSON.parse(data('google_orders.json'));
  raw.orders[0].orderHistory.partialRefundEvents=[{eventTime:'2026-08-14T00:00:00Z',refundDetails:{total:{currencyCode:'USD',units:'1',nanos:0}}}];
  assert.throws(()=>parseSource(JSON.stringify(raw),'google_play'),/unsupported order history/);
});
test('identity conflict takes precedence over claimed amount mismatch',()=>{
  const rows=data('clean.jsonl').trim().split('\n'), row=JSON.parse(rows[0]); row.properties.price_usd=7.99; row.properties.vendor_product_id='other_product'; rows[0]=JSON.stringify(row);
  const r=reconcile(left(),parseSource(rows.join('\n'),'mixpanel'),{coverage:'declared_complete'});
  assert.equal(r.counts.issues,0); assert.equal(r.verdict,'inconclusive'); assert.equal(r.findings[0].kind,'identity_conflict');
});
test('numeric money lexeme is exact beyond IEEE precision and inside JSON strings',()=>{
  const line=data('clean.jsonl').split('\n')[0].replace('"price_usd":6.99','"price_usd":90071992547409.91');
  const s=parseSource(line,'mixpanel'); assert.equal(s.operations[0].amountMinor,'9007199254740991');
  assert.equal(s.operations[0].rawText,line);
  const row=JSON.parse(data('clean.jsonl').split('\n')[0]); row.properties.note='a string with "price_usd":999.99 inside';
  assert.equal(parseSource(JSON.stringify(row),'mixpanel').operations[0].amountMinor,'699');
});
test('money containers cannot be coerced into amounts',()=>{
  const row=JSON.parse(data('clean.jsonl').split('\n')[0]); row.properties.price_usd=[6.99];
  assert.throws(()=>parseSource(JSON.stringify(row),'mixpanel'),/decimal string or numeric literal/);
  const raw=JSON.parse(data('google_orders.json')); raw.orders[0].total.units=6;
  assert.throws(()=>parseSource(JSON.stringify(raw),'google_play'),/int64 string/);
});
test('decimal preservation does not repair invalid JSON leading zeros',()=>{
  const line=data('clean.jsonl').split('\n')[0].replace('"price_usd":6.99','"price_usd":06.99');
  assert.throws(()=>parseSource(line,'mixpanel'),/Invalid JSON/);
});
