import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { LumenAdapter } from '../dist/modules/client/lumen-adapter.js';
import { verifyInternal } from '../dist/infrastructure/internal-auth.js';

const key = Buffer.from('k'.repeat(32));
function requestBody() {
  return { schema_version:2, user_id:'user', expected_provider_customer_id:'user',
    expected_identity_revision:1, expected_policy_revision:1, expected_projection_revision:3,
    entitlement:{ product_id:'annual', expires_at:'2027-01-01T00:00:00Z',
      entitlement_hash:'a'.repeat(64), transaction_id:'txn', source_fingerprint:'b'.repeat(64),
      store:'app_store', source_environment:'Production' }, operation_key:'op',
    processing_id:'processing', trace_id:'trace' };
}

test('signed loopback adapter reads gates and resolves ambiguous writes by readback', async () => {
  let writes = 0, committed = null;
  const server = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = Buffer.concat(chunks);
    if (!verifyInternal(key, request.method, request.url, request.headers['x-recovery-timestamp'],
      body, request.headers['x-recovery-signature'])) {
      response.writeHead(401).end('{}'); return;
    }
    const url = new URL(request.url, 'http://localhost');
    response.setHeader('Content-Type','application/json');
    if (url.pathname === '/internal/lumen/resync') {
      const payload = JSON.parse(body.toString()); writes++;
      committed = { accepted:true, schema_version:2, user_id:payload.user_id,
        operation_key:payload.operation_key, processing_id:payload.processing_id,
        trace_id:payload.trace_id, projection_revision:4 };
      request.socket.destroy(); return;
    }
    if (url.pathname === '/internal/lumen/action') {
      response.end(JSON.stringify(url.searchParams.get('operation_key') === 'op' ? committed : null)); return;
    }
    if (url.pathname === '/internal/lumen/accounts') {
      response.end(JSON.stringify({ items:[{ user_id:'user' }], total:1, next_cursor:null })); return;
    }
    if (url.pathname === '/internal/lumen/probe') {
      const payload = JSON.parse(body.toString());
      if (payload.initiator !== 'reconcile_probe' || payload.feature !== 'premium_export'
          || payload.user_id !== 'user' || Object.keys(payload).length !== 3) {
        response.writeHead(400).end('{}'); return;
      }
    }
    if (url.pathname === '/internal/lumen/access' || url.pathname === '/internal/lumen/probe') {
      response.end(JSON.stringify({ user_id:'user', allowed:true, projection_revision:4, cache_revision:4 })); return;
    }
    response.writeHead(404).end('{}');
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const adapter = new LumenAdapter(`http://127.0.0.1:${server.address().port}`, key, 'Production');
  try {
    assert.equal((await adapter.listAccounts(null)).total, 1);
    assert.equal((await adapter.readAccess('user')).allowed, true);
    assert.equal((await adapter.probeAccess('user')).allowed, true);
    assert.equal(await adapter.readAction('missing'), null);
    await assert.rejects(adapter.resyncAccess(requestBody()), error => error.outcome === 'unknown_outcome');
    assert.equal((await adapter.readAction('op')).processing_id, 'processing');
    assert.equal(writes, 1);
    const wrong = requestBody(); wrong.entitlement.source_environment = 'Sandbox';
    await assert.rejects(adapter.resyncAccess(wrong), error => error.outcome === 'rejected');
    assert.equal(writes, 1);
  } finally {
    server.closeAllConnections(); server.close();
    await once(server, 'close');
  }
});
