import test from 'node:test';
import assert from 'node:assert/strict';
import { SQLiteStorage } from '../dist/infrastructure/sqlite.js';
import { Collector } from '../dist/modules/fulfillment/collector.js';
import { FulfillmentRegistry } from '../dist/modules/fulfillment/registry.js';
import { RecoveryRepository } from '../dist/modules/recovery/repository.js';
import { Reporting } from '../dist/modules/reporting/export.js';
import { sign } from '@reconcile/server-sdk';

test('incident trace includes scoped processing steps without arbitrary identifiers or other accounts', async () => {
  const storage = new SQLiteStorage(':memory:'), at = new Date().toISOString();
  const key = Buffer.from('collector-trace-test-key-0123456789abcdef');
  try {
    const repository = new RecoveryRepository(storage), registry = new FulfillmentRegistry(storage), reporting = new Reporting(storage);
    const collector = new Collector(storage,key,{ runId:'run',app:'app',environment:'sandbox' });
    await repository.initialize(); await registry.initialize(); await reporting.initialize(); await collector.initialize();
    const observed = await registry.observe({ app:'app',environment:'sandbox',store:'app_store',transactionId:'transaction',
      userId:'user',accessLevel:'premium' },{ status:'confirmed',reason:'projection_mismatch',eligible:true,projectionMatches:false },
      'a'.repeat(64),'b'.repeat(64),at);
    assert.equal(await registry.claimIncident('incident','app','sandbox',[observed.identityHash],at),true);
    const event = { schema_version:2,event_id:'event',run_id:'run',app:'app',environment:'sandbox',app_user_id:'user',
      kind:'access_projection_changed',occurred_at:at,correlation_id:'correlation',source_event_id:'source',details:{
        action_id:'action',source_hash:'a'.repeat(64),expected_revision:1,policy_version:'policy-v2',adapter_version:'adapter-v2',
        projection_version:'projection-v2',cache_version:'cache-v2',outcome:'projection_updated',
        before:{ active:false,projection_revision:1 },after:{ active:true,projection_revision:2 },cache_invalidated:false,
        processing_id:'processing',trace_id:'private-identifier',transaction_id:'private-transaction',
        steps:[{ name:'projection_commit',status:'completed',owner:'lumen',result:'committed',revision:2 }],
        revisions:{ identity:1,policy:1,projection:2,cache:2 } } };
    const envelope = { schema_version:2,event,sent_at:Math.floor(Date.now()/1000) };
    await collector.collect(envelope,sign(envelope,key));
    const other = { ...envelope,event:{ ...event,event_id:'other',app_user_id:'other' } };
    await collector.collect(other,sign(other,key));
    const trace = await reporting.trace('app','sandbox','incident');
    assert.equal(trace.processing_receipts.length,1);
    assert.equal(trace.processing_receipts[0].steps[0].name,'projection_commit');
    assert.equal(JSON.stringify(trace).includes('private-identifier'),false);
    assert.equal(JSON.stringify(trace).includes('private-transaction'),false);
    assert.equal(trace.processing_receipts_truncated,false);
    const report = JSON.parse((await reporting.export('app','sandbox',new Date(Date.now()-60_000).toISOString(),
      new Date(Date.now()+60_000).toISOString(),'json')).body);
    assert.equal(report.incidents[0].processing_receipts.length,1);
    assert.equal(JSON.stringify(report).includes('private-identifier'),false);
    assert.equal(JSON.stringify(report).includes('private-transaction'),false);
    await assert.rejects(reporting.trace('another-app','sandbox','incident'),/not found/);
  } finally { await storage.close(); }
});
