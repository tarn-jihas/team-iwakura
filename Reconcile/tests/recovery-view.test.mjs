import test from 'node:test';
import assert from 'node:assert/strict';
import { accountRow, escapeHtml, safeReportHtml, statusLabel, statusTone, summaryView, targetLabel } from '../dist/recovery-view.js';

test('text rendered into HTML is escaped', () => {
  assert.equal(escapeHtml(`<script a="x">'&`), '&lt;script a=&quot;x&quot;&gt;&#39;&amp;');
  assert.doesNotMatch(safeReportHtml({ actions: [{ target: '<img src=x onerror=alert(1)>' }] }), /<img/);
});

test('unknown statuses stay understandable without being labeled verified', () => {
  assert.equal(statusLabel('new_backend_state'), 'new backend state');
  assert.equal(statusLabel(undefined), 'Status unavailable');
  assert.equal(statusTone('inconclusive'), 'blue');
});

test('coverage and independent verification counts keep their backend values', () => {
  const html = summaryView({ coverage: { complete: false, gaps: ['client snapshot missing'] }, summary: { in_scope: 100, evaluated: 94, confirmed: 24, inconclusive: 6 }, recovery: { activation_verified: 24, access_verified: 23, unresolved: 1 } });
  assert.match(html, /Incomplete/);
  assert.match(html, /24/);
  assert.match(html, /23/);
  assert.match(html, /1 unresolved/);
});

test('only eligible rows can be selected for an exact plan', () => {
  const row = accountRow({ id: 'acct-1', status: 'inconclusive', eligible: false, reason: 'Insufficient evidence' }, false);
  assert.match(row, /disabled/);
  assert.match(row, /Inconclusive/);
  assert.match(row, /Insufficient evidence/);
});

test('standalone HTML report names remaining work and action ownership', () => {
  const html = safeReportHtml({ manifest: { app: 'Lumen' }, incident: { id: 'INC-1' }, recovery: { root_cause_status: 'inconclusive' }, actions: [{ owner: 'client team', target: 'acct-1', status: 'awaiting_client_action', evidence_ref: 'ev-7', next_step: 'Refresh client cache' }] });
  assert.match(html, /Incident and scope/);
  assert.match(html, /Cause assessment/);
  assert.match(html, /client team/);
  assert.match(html, /Remaining work/);
  assert.match(html, /Refresh client cache/);
});

test('report separates activation from access and does not call verified actions unresolved', () => {
  const html = safeReportHtml({ summary: { confirmed: 24, inconclusive: 6 }, recovery: { activation_verified: 24, access_verified: 23, unresolved: 1 }, actions: [{ target: 'already done', status: 'verified', next_step: 'No retry' }] });
  assert.match(html, /24 activations verified/);
  assert.match(html, /23 accesses verified/);
  assert.match(html, /1 unresolved/);
  assert.doesNotMatch(html.slice(html.indexOf('<h2>Remaining work')), /already done/);
});

test('structured action targets remain readable without raw JSON', () => {
  assert.equal(targetLabel({target: {transaction_id: 'txn-7'}}), 'Purchase txn-7');
  assert.equal(targetLabel({target: {product_id: 'annual', price_id: 'new-price'}}), 'annual / new-price');
  const html = safeReportHtml({actions: [{target: {transaction_id: '<txn-7>'}, status: 'verified'}]});
  assert.match(html, /Purchase &lt;txn-7&gt;/);
  assert.doesNotMatch(html, /\[object Object\]/);
});
