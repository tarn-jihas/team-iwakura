import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AnalyticsDemo } from '../dist/modules/legacy-analytics/demo.js';
import { semanticDigest, semanticJson } from '../dist/infrastructure/json.js';

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'reconcile-analytics-demo-'));
  const databasePath = join(directory, 'analytics.sqlite3');
  const demo = await AnalyticsDemo.create({ databasePath });
  t.after(async () => { await demo.close(); await rm(directory, { recursive: true, force: true }); });
  return { demo, directory, databasePath };
}

const call = (demo, method, url, body) => demo.handle(method, url, body);

function storedState(databasePath) {
  const database = new DatabaseSync(databasePath, { readOnly: true });
  try {
    const row = database.prepare('SELECT revision,payload,digest FROM legacy_analytics_state WHERE id=1').get();
    assert.ok(row);
    const value = JSON.parse(row.payload);
    assert.equal(semanticDigest(value), row.digest);
    return { revision: row.revision, value };
  } finally { database.close(); }
}

function editStoredState(databasePath, edit) {
  const database = new DatabaseSync(databasePath);
  try {
    database.exec('BEGIN IMMEDIATE');
    const row = database.prepare('SELECT revision,payload FROM legacy_analytics_state WHERE id=1').get();
    assert.ok(row);
    const value = JSON.parse(row.payload);
    edit(value);
    const payload = semanticJson(value), digest = semanticDigest(value);
    database.prepare('UPDATE legacy_analytics_state SET revision=revision+1,payload=?,digest=? WHERE id=1 AND revision=?')
      .run(payload, digest, row.revision);
    database.exec('COMMIT');
  } catch (error) {
    try { database.exec('ROLLBACK'); } catch {}
    throw error;
  } finally { database.close(); }
}

test('analytics demo seeds exact per-currency findings and completes approved write/readback loop', async t => {
  const { demo, databasePath } = await fixture(t);
  const initial = await call(demo, 'GET', '/api/report');
  assert.equal(initial.status, 200);
  assert.deepEqual(initial.body.gap, { EUR: '989.01', USD: '21.97' });
  assert.equal(initial.body.groups.length, 6);
  assert.equal(initial.body.groups.reduce((count, item) => count + item.findings.length, 0), 7);
  assert.equal(initial.body.query_event_count, initial.body.raw_event_count);

  const revision = storedState(databasePath).revision;
  for (const url of ['/api/report?run=mock-run-20261107', '/api/preview', '/api/verify', '/api/manifest', '/api/audit',
    '/api/history', '/api/operations', '/api/samples', '/api/sample?path=amplitude%2Fingestion.json',
    '/mock/adapty/api/v2/server-side-api/profile/?customer_user_id=u00002',
    '/mock/adapty/api/v2/server-side-api/profile/?adapty-customer-user-id=u00002', '/mock/mixpanel/query']) {
    assert.equal((await call(demo, 'GET', url)).status, 200, url);
  }
  const sourceExport = await call(demo, 'GET', '/mock/adapty/events/export');
  const destinationExport = await call(demo, 'GET', '/mock/mixpanel/api/2.0/export');
  assert.equal(sourceExport.contentType, 'application/x-ndjson');
  assert.equal(destinationExport.contentType, 'application/x-ndjson');
  assert.ok(sourceExport.body.endsWith('\n'));
  assert.ok(destinationExport.body.endsWith('\n'));
  assert.equal((await call(demo, 'GET', '/mock/adapty/api/v2/server-side-api/profile/?customer_user_id=unknown-user')).status, 404);
  assert.equal(storedState(databasePath).revision, revision);

  const mapped = await call(demo, 'POST', '/api/map', { event: 'premium_paid_v2', cls: 'purchase' });
  assert.equal(mapped.status, 200, JSON.stringify(mapped.body));
  const preview = (await call(demo, 'GET', '/api/preview')).body;
  assert.equal(preview.groups.reduce((count, item) => count + item.payloads.length, 0), 4);
  const hashes = Object.fromEntries(preview.groups.map(item => [item.class, item.approval_hash]));
  assert.deepEqual((await call(demo, 'POST', '/api/approve', { ids: Object.keys(hashes), hashes })).body,
    { approved: Object.keys(hashes) });
  const applied = await call(demo, 'POST', '/api/apply', { ids: Object.keys(hashes) });
  assert.equal(applied.status, 200);
  assert.equal(applied.body.writes_accepted, 4);
  assert.equal(applied.body.report.pending_count, 4);
  assert.equal((await call(demo, 'POST', '/api/apply', { ids: Object.keys(hashes) })).body.writes_accepted, 0);
  assert.equal((await call(demo, 'GET', '/api/evidence?txn=txn_missing_purchase')).body.pending_destination.length, 1);

  const advanced = await call(demo, 'POST', '/api/advance-clock', { ticks: 1 });
  assert.deepEqual(advanced.body.gap, { EUR: '0.00', USD: '11.98' });
  assert.equal(advanced.body.verification_status, 'verified', JSON.stringify({
    verification: advanced.body.verification_status, groups: advanced.body.groups, gap: advanced.body.gap
  }));
  assert.deepEqual(advanced.body.groups.map(item => item.cls), ['EXTRA_IN_MIXPANEL', 'SANDBOX_EXPECTED']);
  assert.equal((await call(demo, 'GET', '/api/verify')).body.verification.status, 'verified');
  assert.equal((await call(demo, 'POST', '/api/apply', { ids: Object.keys(hashes) })).body.writes_accepted, 0);
  assert.equal((await call(demo, 'GET', '/api/evidence?txn=txn_price')).body.correction_receipts.length, 1);
  const audit = (await call(demo, 'GET', '/api/audit')).body;
  assert.equal(Object.keys(audit.actions).length, 4);
  assert.equal(audit.verification.status, 'verified');
});

test('imports preserve refund semantics, latest same-tuple dedup and two-place money validation', async t => {
  const { demo } = await fixture(t);
  const source = await call(demo, 'GET', '/mock/adapty/events/export');
  assert.equal(source.contentType, 'application/x-ndjson');
  assert.ok(source.body.endsWith('\n'));
  const refund = source.body.trimEnd().split('\n').map(JSON.parse).find(item => item.event_type === 'subscription_refunded');
  const p = refund.event_properties;
  const renamedRefund = { event: 'unmapped_refund', properties: { distinct_id: refund.customer_user_id,
    time: 1794042200, '$insert_id': 'unmapped-refund-id', transaction_id: p.transaction_id,
    original_transaction_id: p.original_transaction_id, currency: p.currency, price_local: '6.99',
    environment: p.environment, store: 'play_store' } };
  assert.equal((await call(demo, 'POST', '/mock/mixpanel/import', [renamedRefund])).body.num_records_imported, 1);
  await call(demo, 'POST', '/api/advance-clock', { ticks: 1 });
  const report = (await call(demo, 'GET', '/api/report')).body;
  const findings = report.groups.flatMap(item => item.findings);
  assert.ok(findings.some(item => item.cls === 'UNMAPPED_EVENT_NAME' && item.txn === p.transaction_id && item.event_class === 'refund'));
  assert.ok(!findings.some(item => item.cls === 'MISSING_IN_MIXPANEL' && item.txn === p.transaction_id && item.event_class === 'refund'));
  const operation = (await call(demo, 'GET', '/api/operations')).body.operations.find(item => item.txn === p.transaction_id && item.event_class === 'refund');
  assert.deepEqual([operation.status, operation.source_amount, operation.destination_amount], ['unmapped', '-6.99', '-6.99']);

  const exported = await call(demo, 'GET', '/mock/mixpanel/api/2.0/export');
  const healthy = exported.body.trimEnd().split('\n').map(JSON.parse).find(item => item.properties.transaction_id === 'txn_healthy_usd');
  const first = structuredClone(healthy), latest = structuredClone(healthy);
  first.properties.price_local = '1.00'; latest.properties.price_local = '6.99';
  assert.equal((await call(demo, 'POST', '/mock/mixpanel/import', [first, latest])).body.num_records_imported, 2);
  await call(demo, 'POST', '/api/advance-clock', { ticks: 1 });
  const deduped = (await call(demo, 'GET', '/api/report')).body;
  assert.equal(deduped.raw_event_count, deduped.query_event_count + 2);
  assert.ok(!deduped.groups.some(item => item.cls === 'PRICE_MISMATCH' && item.findings.some(row => row.txn === 'txn_healthy_usd')));
  assert.equal((await call(demo, 'GET', '/mock/adapty/api/v2/server-side-api/profile/?customer_user_id=u00002')).body.data.total_revenue_usd, 0);

  const before = (await call(demo, 'GET', '/api/report')).body;
  const invalid = structuredClone(healthy); invalid.properties.price_local = '1.001';
  assert.equal((await call(demo, 'POST', '/mock/mixpanel/import', [healthy, invalid])).status, 400);
  assert.deepEqual((await call(demo, 'GET', '/api/report')).body, before);
  const wrongApp = structuredClone(healthy); wrongApp.app_id = 'another-app';
  assert.equal((await call(demo, 'POST', '/mock/mixpanel/import', [wrongApp])).status, 400);
  assert.deepEqual((await call(demo, 'GET', '/api/report')).body, before);
  const badInputs = [
    event => { delete event.properties.currency; },
    event => { event.properties.price_local = Number.NaN; },
    event => { event.properties.price_local = '1e100'; },
    event => { event.properties.currency = 'JPY'; },
    event => { event.properties.time = -1; }
  ];
  for (const mutate of badInputs) {
    const invalidInput = structuredClone(healthy);
    mutate(invalidInput);
    assert.equal((await call(demo, 'POST', '/mock/mixpanel/import', [invalidInput])).status, 400);
    assert.deepEqual((await call(demo, 'GET', '/api/report')).body, before);
  }
  const wrongRegion = await call(demo, 'POST', '/mock/mixpanel/import?region=us', [healthy]);
  assert.deepEqual(wrongRegion.body, { status: 'accepted_transport_but_dropped_mock', num_records_imported: 0 });
  assert.deepEqual((await call(demo, 'GET', '/api/report')).body, before);
});

test('approval hashes and apply prevalidation reject stale or mixed batches without partial writes', async t => {
  const { demo, databasePath } = await fixture(t);
  const preview = (await call(demo, 'GET', '/api/preview')).body;
  const missing = preview.groups.find(item => item.class === 'MISSING_IN_MIXPANEL');
  const beforeBadApproval = storedState(databasePath);
  assert.equal((await call(demo, 'POST', '/api/approve', { ids: [missing.class], hashes: { [missing.class]: 'stale' } })).status, 400);
  assert.deepEqual(storedState(databasePath), beforeBadApproval);
  assert.equal((await call(demo, 'POST', '/api/approve', { ids: [missing.class], hashes: { [missing.class]: missing.approval_hash } })).status, 200);

  const beforeMixedApply = storedState(databasePath);
  assert.equal((await call(demo, 'POST', '/api/apply', { ids: [missing.class, 'PRICE_MISMATCH'] })).status, 400);
  assert.deepEqual(storedState(databasePath), beforeMixedApply);
  assert.deepEqual((await call(demo, 'GET', '/api/audit')).body.actions, {});
  const applied = await call(demo, 'POST', '/api/apply', { ids: [missing.class] });
  assert.equal(applied.status, 200);
  assert.equal(applied.body.writes_accepted, missing.payloads.length);
});

test('source and destination changes stale approvals; mapping remains separate from writes', async t => {
  const { demo, databasePath } = await fixture(t);
  const beforeMap = storedState(databasePath);
  const writesBeforeMap = beforeMap.value.mixpanel.length;
  assert.equal((await call(demo, 'POST', '/api/map', { event: 'premium_paid_v2', cls: 'purchase' })).status, 200);
  assert.equal(storedState(databasePath).value.mixpanel.length, writesBeforeMap);
  const mappedReport = (await call(demo, 'GET', '/api/report')).body;
  assert.ok(!mappedReport.groups.some(item => item.cls === 'UNMAPPED_EVENT_NAME'));
  assert.equal(mappedReport.group_states.UNMAPPED_EVENT_NAME, 'mapped');
  const resetMappings = await call(demo, 'POST', '/api/reset-mappings', {});
  assert.deepEqual(resetMappings.body.mappings, { subscription_started: 'purchase', subscription_refunded: 'refund' });
  assert.ok((await call(demo, 'GET', '/api/report')).body.groups.some(item => item.cls === 'UNMAPPED_EVENT_NAME'));

  assert.equal((await call(demo, 'POST', '/api/reset', {})).status, 200);
  let preview = (await call(demo, 'GET', '/api/preview')).body;
  let missing = preview.groups.find(item => item.class === 'MISSING_IN_MIXPANEL');
  assert.equal((await call(demo, 'POST', '/api/approve', { ids: [missing.class], hashes: { [missing.class]: missing.approval_hash } })).status, 200);
  editStoredState(databasePath, state => {
    state.source.find(item => item.event_properties.transaction_id === 'txn_missing_purchase')
      .event_properties.original_transaction_id = 'changed-but-same-amount';
  });
  const changedEvidence = storedState(databasePath);
  assert.equal((await call(demo, 'POST', '/api/apply', { ids: [missing.class] })).status, 400);
  assert.deepEqual(storedState(databasePath), changedEvidence);
  assert.deepEqual((await call(demo, 'GET', '/api/audit')).body.actions, {});

  assert.equal((await call(demo, 'POST', '/api/reset', {})).status, 200);
  preview = (await call(demo, 'GET', '/api/preview')).body;
  missing = preview.groups.find(item => item.class === 'MISSING_IN_MIXPANEL');
  assert.equal((await call(demo, 'POST', '/api/approve', { ids: [missing.class], hashes: { [missing.class]: missing.approval_hash } })).status, 200);
  assert.equal((await call(demo, 'POST', '/api/map', { event: 'subscription_refunded', cls: 'purchase' })).status, 200);
  const changedMapping = storedState(databasePath);
  assert.equal((await call(demo, 'POST', '/api/apply', { ids: [missing.class] })).status, 400);
  assert.deepEqual(storedState(databasePath), changedMapping);
});

test('identity, environment and currency conflicts remain manual rather than generating missing writes', async t => {
  const { demo } = await fixture(t);
  const sourceRows = (await call(demo, 'GET', '/mock/adapty/events/export')).body.trimEnd().split('\n').map(JSON.parse);
  const source = sourceRows.find(item => item.event_properties.transaction_id === 'txn_missing_purchase');
  const properties = source.event_properties;
  const conflicts = [
    { distinct_id: 'somebody-else' },
    { environment: 'Sandbox' },
    { currency: 'EUR' }
  ];
  for (const [index, changed] of conflicts.entries()) {
    if (index) assert.equal((await call(demo, 'POST', '/api/reset', {})).status, 200);
    const event = { event: source.event_type, properties: { distinct_id: source.customer_user_id,
      time: 1794042050 + index, '$insert_id': `identity-conflict-${index}`, transaction_id: properties.transaction_id,
      original_transaction_id: properties.original_transaction_id, currency: properties.currency, price_local: '9.99',
      environment: properties.environment, store: 'play_store', ...changed } };
    assert.equal((await call(demo, 'POST', '/mock/mixpanel/import', [event])).status, 200);
    await call(demo, 'POST', '/api/advance-clock', { ticks: 1 });
    const report = (await call(demo, 'GET', '/api/report')).body;
    const findings = report.groups.flatMap(item => item.findings);
    assert.ok(!findings.some(item => item.cls === 'MISSING_IN_MIXPANEL' && item.txn === 'txn_missing_purchase'));
    assert.ok(findings.some(item => ['AMBIGUOUS_IDENTITY', 'CURRENCY_MISMATCH'].includes(item.cls) && item.txn === 'txn_missing_purchase'));
  }
});

test('same transaction under two users keeps separate findings and approved receipts', async t => {
  const { demo, databasePath } = await fixture(t);
  editStoredState(databasePath, state => {
    const other = structuredClone(state.source.find(item => item.event_properties.transaction_id === 'txn_missing_purchase'));
    other.customer_user_id = 'u00010';
    other.profile_id = 'profile-u00010-test';
    other.event_properties.profile_event_id = 'source-txn_missing_purchase-u00010';
    state.source.push(other);
  });
  const report = (await call(demo, 'GET', '/api/report')).body;
  const missingRows = report.groups.find(item => item.cls === 'MISSING_IN_MIXPANEL').findings
    .filter(item => item.txn === 'txn_missing_purchase');
  assert.deepEqual(missingRows.map(item => item.user).sort(), ['u00001', 'u00010']);
  assert.equal(new Set(missingRows.map(item => item.id)).size, 2);
  const preview = (await call(demo, 'GET', '/api/preview')).body;
  const hashes = Object.fromEntries(preview.groups.map(item => [item.class, item.approval_hash]));
  assert.equal((await call(demo, 'POST', '/api/approve', { ids: Object.keys(hashes), hashes })).status, 200);
  const applied = await call(demo, 'POST', '/api/apply', { ids: Object.keys(hashes) });
  assert.equal(applied.body.writes_accepted, 5);
  const transaction = (await call(demo, 'GET', '/api/evidence?txn=txn_missing_purchase')).body;
  assert.deepEqual(transaction.pending_destination.map(item => item.payload.properties.distinct_id).sort(), ['u00001', 'u00010']);
  assert.equal(Object.keys((await call(demo, 'GET', '/api/audit')).body.actions).length, 5);
});

test('new duplicate after a completed correction gets a new idempotency identity', async t => {
  const { demo } = await fixture(t);
  let duplicate = (await call(demo, 'GET', '/api/preview')).body.groups.find(item => item.class === 'DUPLICATE_IN_MIXPANEL');
  const firstPlanInsertId = duplicate.payloads[0].properties['$insert_id'];
  await call(demo, 'POST', '/api/approve', { ids: [duplicate.class], hashes: { [duplicate.class]: duplicate.approval_hash } });
  assert.equal((await call(demo, 'POST', '/api/apply', { ids: [duplicate.class] })).body.writes_accepted, 1);
  await call(demo, 'POST', '/api/advance-clock', { ticks: 1 });

  const visible = (await call(demo, 'GET', '/mock/mixpanel/api/2.0/export')).body.trimEnd().split('\n').map(JSON.parse);
  const original = visible.find(item => item.properties.transaction_id === 'txn_duplicate' && item.event !== 'reconcile_correction');
  const extra = structuredClone(original);
  extra.properties['$insert_id'] = 'new-duplicate-after-correction';
  extra.properties.time += 100;
  assert.equal((await call(demo, 'POST', '/mock/mixpanel/import', [extra])).body.num_records_imported, 1);
  await call(demo, 'POST', '/api/advance-clock', { ticks: 1 });

  const latestPreview = (await call(demo, 'GET', '/api/preview')).body;
  duplicate = latestPreview.groups.find(item => item.class === 'DUPLICATE_IN_MIXPANEL');
  assert.ok(duplicate);
  assert.notEqual(duplicate.payloads[0].properties['$insert_id'], firstPlanInsertId);
  await call(demo, 'POST', '/api/approve', { ids: [duplicate.class], hashes: { [duplicate.class]: duplicate.approval_hash } });
  assert.equal((await call(demo, 'POST', '/api/apply', { ids: [duplicate.class] })).body.writes_accepted, 1);
  const pending = (await call(demo, 'GET', '/api/evidence?txn=txn_duplicate')).body.pending_destination;
  assert.equal(pending.length, 1);
  assert.equal(pending[0].payload.properties['$insert_id'], duplicate.payloads[0].properties['$insert_id']);
  await call(demo, 'POST', '/api/advance-clock', { ticks: 1 });
  assert.ok(!(await call(demo, 'GET', '/api/report')).body.groups.some(item => item.cls === 'DUPLICATE_IN_MIXPANEL'));
  assert.equal((await call(demo, 'POST', '/api/apply', { ids: ['DUPLICATE_IN_MIXPANEL'] })).body.writes_accepted, 0);
  assert.equal(Object.values((await call(demo, 'GET', '/api/audit')).body.actions).filter(item => item.group === 'DUPLICATE_IN_MIXPANEL').length, 2);
});

test('sandbox destination is exported but stays out of production totals and operation amounts', async t => {
  const { demo } = await fixture(t);
  const source = (await call(demo, 'GET', '/mock/adapty/events/export')).body.trimEnd().split('\n').map(JSON.parse)
    .find(item => item.event_properties.environment === 'Sandbox');
  const properties = source.event_properties;
  const sandboxEvent = { event: source.event_type, properties: { distinct_id: source.customer_user_id,
    time: 1794042500, '$insert_id': 'sandbox-import', transaction_id: properties.transaction_id,
    original_transaction_id: properties.original_transaction_id, currency: properties.currency, price_local: '4.99',
    environment: 'Sandbox', store: 'play_store' } };
  assert.equal((await call(demo, 'POST', '/mock/mixpanel/import', [sandboxEvent])).status, 200);
  await call(demo, 'POST', '/api/advance-clock', { ticks: 1 });
  const report = (await call(demo, 'GET', '/api/report')).body;
  assert.deepEqual(report.gap, { EUR: '989.01', USD: '21.97' });
  const exportResult = await call(demo, 'GET', '/mock/mixpanel/api/2.0/export');
  assert.ok(exportResult.body.includes('sandbox-import'));
  const ops = (await call(demo, 'GET', '/api/operations')).body.operations;
  assert.equal(ops.length, 10);
  const sandbox = ops.find(item => item.txn === 'txn_sandbox');
  const ghost = ops.find(item => item.txn === 'txn_ghost');
  assert.deepEqual([sandbox.source_amount, sandbox.destination_amount, sandbox.delta, sandbox.status], ['0.00', '0.00', '0.00', 'expected']);
  assert.deepEqual([ghost.source_amount, ghost.destination_amount, ghost.delta, ghost.status], ['0.00', '11.98', '11.98', 'manual']);
  assert.ok(report.groups.some(item => item.cls === 'SANDBOX_EXPECTED'));
});

test('missing destination readback is reported as failed, never verified', async t => {
  const { demo, databasePath } = await fixture(t);
  const price = (await call(demo, 'GET', '/api/preview')).body.groups.find(item => item.class === 'PRICE_MISMATCH');
  assert.equal((await call(demo, 'POST', '/api/approve', { ids: [price.class], hashes: { [price.class]: price.approval_hash } })).status, 200);
  assert.equal((await call(demo, 'POST', '/api/apply', { ids: [price.class] })).body.writes_accepted, 1);
  await call(demo, 'POST', '/api/advance-clock', { ticks: 1 });
  const action = Object.values(storedState(databasePath).value.actions)[0];
  editStoredState(databasePath, state => {
    state.mixpanel = state.mixpanel.filter(item => item.payload.properties['$insert_id'] !== action.insert_id);
  });
  const verification = (await call(demo, 'GET', '/api/verify')).body;
  assert.equal(verification.verification.status, 'readback_failed');
  assert.equal(verification.verification.actions[0].status, 'missing_readback');
  assert.notEqual(verification.verification_status, 'verified');
  assert.equal(verification.gap.EUR, '989.01');
  assert.equal((await call(demo, 'GET', '/api/audit')).body.verification.status, 'readback_failed');
});

test('failed SQLite commit returns an error and leaves demo state unchanged', async t => {
  const { demo, databasePath } = await fixture(t);
  const before = storedState(databasePath);
  const database = new DatabaseSync(databasePath);
  try {
    database.exec("CREATE TRIGGER reject_analytics_update BEFORE UPDATE ON legacy_analytics_state BEGIN SELECT RAISE(ABORT,'write deliberately unavailable'); END");
  } finally { database.close(); }
  const failed = await call(demo, 'POST', '/api/advance-clock', { ticks: 1 });
  assert.equal(failed.status, 500);
  assert.deepEqual(failed.body, { error: 'internal error' });
  assert.ok(!JSON.stringify(failed.body).includes('write deliberately unavailable'));
  assert.deepEqual(storedState(databasePath), before);
  const cleanup = new DatabaseSync(databasePath);
  try { cleanup.exec('DROP TRIGGER reject_analytics_update'); }
  finally { cleanup.close(); }
  assert.equal((await call(demo, 'POST', '/api/advance-clock', { ticks: 1 })).status, 200);
  assert.equal((await call(demo, 'GET', '/api/report')).body.clock, 1);
});

test('history, mapping, sample routes and invalid requests keep their response semantics', async t => {
  const { demo } = await fixture(t);
  assert.equal((await call(demo, 'POST', '/api/detect', {})).status, 200);
  assert.equal((await call(demo, 'POST', '/api/verify', {})).status, 200);
  assert.deepEqual((await call(demo, 'GET', '/api/history')).body.runs.map(item => item.kind), ['verify', 'detect']);
  assert.equal((await call(demo, 'POST', '/api/approve', { ids: [] })).status, 400);
  assert.equal((await call(demo, 'POST', '/api/advance-clock', { ticks: 0 })).status, 400);
  assert.equal((await call(demo, 'GET', '/api/report?run=unknown')).status, 404);
  const samples = (await call(demo, 'GET', '/api/samples')).body.samples;
  assert.equal(samples.length, 20);
  assert.equal(samples[0].provider, 'amplitude');
  for (const sample of samples) {
    const response = await call(demo, 'GET', `/api/sample?path=${encodeURIComponent(sample.path)}`);
    assert.equal(response.status, 200, sample.path);
    assert.equal(response.body.path, sample.path);
  }
  assert.equal((await call(demo, 'GET', '/api/sample?path=..%2Fruntime%2Fstate.json')).status, 400);
  assert.equal((await call(demo, 'GET', '/api/sample?path=missing.json')).status, 404);
  assert.equal((await call(demo, 'GET', '/mock/unknown')).status, 404);
  assert.equal((await call(demo, 'GET', '/api/access/report')).status, 404);
  const reset = await call(demo, 'POST', '/api/reset', {});
  assert.equal(reset.status, 200);
  assert.deepEqual(reset.body.report.gap, { EUR: '989.01', USD: '21.97' });
  assert.deepEqual((await call(demo, 'GET', '/api/history')).body.runs, []);
  for (let index = 0; index < 22; index++) assert.equal((await call(demo, 'POST', '/api/detect', {})).status, 200);
  assert.equal((await call(demo, 'GET', '/api/history')).body.runs.length, 20);
  assert.equal((await call(demo, 'POST', '/api/reset', {})).status, 200);
  assert.deepEqual((await call(demo, 'GET', '/api/history')).body.runs, []);
  const updates = await Promise.all(Array.from({ length: 12 }, () => call(demo, 'POST', '/api/advance-clock', { ticks: 1 })));
  assert.ok(updates.every(item => item.status === 200));
  assert.equal((await call(demo, 'GET', '/api/report')).body.clock, 12);
});

test('SQLite state survives restart and rejects an unmarked existing database without mutation', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'reconcile-analytics-isolation-'));
  const path = join(directory, 'analytics.sqlite3');
  t.after(() => rm(directory, { recursive: true, force: true }));
  let demo = await AnalyticsDemo.create({ databasePath: path });
  const before = (await call(demo, 'GET', '/api/report')).body.gap;
  await demo.close();
  demo = await AnalyticsDemo.create({ databasePath: path });
  assert.deepEqual((await call(demo, 'GET', '/api/report')).body.gap, before);
  await demo.close();

  const unmarked = join(directory, 'legacy.sqlite3'), db = new DatabaseSync(unmarked);
  db.exec('CREATE TABLE sentinel(value TEXT NOT NULL); INSERT INTO sentinel VALUES (\'keep-me\')'); db.close();
  const snapshot = await readFile(unmarked);
  await assert.rejects(AnalyticsDemo.create({ databasePath: unmarked }), /legacy analytics marker/);
  assert.deepEqual(await readFile(unmarked), snapshot);

  const memory = await AnalyticsDemo.create({ databasePath: ':memory:' });
  assert.deepEqual((await call(memory, 'GET', '/api/report')).body.gap, { EUR: '989.01', USD: '21.97' });
  await memory.close();
});
