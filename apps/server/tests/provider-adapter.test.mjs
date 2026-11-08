import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { ProviderAdapter,ProviderUnavailable } from '../dist/modules/source/provider-adapter.js';
import { verifyInternal } from '../dist/infrastructure/internal-auth.js';

test('signed provider reads stay scoped and surface source cooldown without retrying', async () => {
  const key = Buffer.from('internal-test-key-0123456789abcdef');
  let requests = 0;
  const server = createServer((request,response) => {
    requests++;
    assert.equal(verifyInternal(key,'GET',request.url,request.headers['x-recovery-timestamp'],
      Buffer.alloc(0),request.headers['x-recovery-signature']),true);
    response.setHeader('Content-Type','application/json');
    if (request.url.startsWith('/internal/adapty/profiles?') || request.url.startsWith('/internal/provider/accounts?')) return response.end(JSON.stringify({ items:[],total:0,next_cursor:null }));
    if (request.url.includes('user=limited')) { response.writeHead(503); return response.end('{}'); }
    return response.end(JSON.stringify({ user_id:'known',provider_customer_id:'known',observed_at:'2026-11-08T12:00:00Z',
      status:'active',identity_match:true }));
  });
  await new Promise(resolve => server.listen(0,'127.0.0.1',resolve));
  try {
    const client = new ProviderAdapter(`http://127.0.0.1:${server.address().port}`,key);
    assert.equal((await client.profile('known')).status,'active');
    assert.equal((await client.profiles(null)).total,0);
    assert.equal((await client.accounts(null)).total,0);
    await assert.rejects(client.profile('limited'),error => error instanceof ProviderUnavailable && error.status === 503);
    assert.equal(requests,4);
    await assert.rejects(client.profile(''), /Invalid/);
  } finally { await new Promise(resolve => server.close(resolve)); }
});
