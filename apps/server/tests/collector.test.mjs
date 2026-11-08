import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { CollectorSDK, sign } from '@reconcile/server-sdk';
import { SQLiteStorage } from '../dist/infrastructure/sqlite.js';
import { Collector } from '../dist/modules/fulfillment/collector.js';
import { collectorRoute } from '../dist/infrastructure/collector-http.js';

test('SDK outbox delivers signed scoped evidence once and rejects tampering', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'reconcile-collector-'));
  const storage = new SQLiteStorage(join(directory, 'engine.sqlite'));
  const key = 'local-recovery-test-key-0123456789abcdef';
  const scope = { runId:'run', app:'lumen', environment:'sandbox' };
  const collector = new Collector(storage, Buffer.from(key), scope);
  try {
    await collector.initialize();
    let savedEnvelope, savedSignature;
    const sdk = new CollectorSDK({ key, ...scope, outboxPath:join(directory,'outbox.sqlite'),
      transport:(envelope, signature) => { savedEnvelope = envelope; savedSignature = signature;
        return collector.collect(envelope,signature); } });
    const details = { feature:'premium_export', decision:'deny', reason_code:'subscription_inactive',
      projection_version:'v1', cache_version:'v1', policy_version:'v1', adapter_version:'v1', initiator:'customer_demo' };
    sdk.emit('feature_access_decided','user','2026-11-07T12:00:00Z',details,{ eventId:'event' });
    assert.equal((await sdk.flush()).accepted,1);
    assert.equal((await collector.collect(savedEnvelope,savedSignature)).duplicate,true);
    await assert.rejects(collector.collect(savedEnvelope,'0'.repeat(64)), error => error.status === 401);
    const changed = structuredClone(savedEnvelope);
    changed.event.app_user_id = 'other';
    await assert.rejects(collector.collect(changed,sign(changed,key)), error => error.status === 409);
    changed.event.app = 'another-app';
    await assert.rejects(collector.collect(changed,sign(changed,key)), error => error.status === 400);
    await assert.rejects(storage.statement({ mode:'run', sql:'DELETE FROM collector_events' }), /immutable/);
    const other = new Collector(storage, Buffer.from(key), { ...scope, runId:'other' });
    await assert.rejects(other.initialize(), /scope/);
  } finally {
    await storage.close();
    await rm(directory,{ recursive:true, force:true });
  }
});

test('the SDK reaches the collector over HTTP without putting the network on emit', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'reconcile-collector-http-'));
  const storage = new SQLiteStorage(join(directory, 'engine.sqlite'));
  const key = 'local-recovery-test-key-0123456789abcdef';
  const collector = new Collector(storage,Buffer.from(key),{ runId:'run',app:'lumen',environment:'sandbox' });
  await collector.initialize();
  const route = collectorRoute(collector);
  const server = createServer((request,response) => { void route(request,response).then(handled => {
    if (!handled) { response.writeHead(404); response.end(); }
  }); });
  try {
    await new Promise(resolve => server.listen(0,'127.0.0.1',resolve));
    const sdk = new CollectorSDK({ key,runId:'run',app:'lumen',environment:'sandbox',
      outboxPath:join(directory,'outbox.sqlite'),
      collectorUrl:`http://127.0.0.1:${server.address().port}/api/recovery/collector` });
    const receipt = sdk.emit('feature_access_decided','user','2026-11-07T12:00:00Z',
      { feature:'premium_export', decision:'deny', reason_code:'subscription_inactive', projection_version:'v1',
        cache_version:'v1', policy_version:'v1', adapter_version:'v1', initiator:'customer_demo' });
    assert.equal(receipt.queued,true);
    assert.equal((await sdk.flush()).accepted,1);
    const response = await fetch(`http://127.0.0.1:${server.address().port}/api/recovery/collector`,
      { method:'POST', body:'not json' });
    assert.equal(response.status,400);
  } finally {
    await new Promise(resolve => server.close(resolve));
    await storage.close();
    await rm(directory,{ recursive:true, force:true });
  }
});
