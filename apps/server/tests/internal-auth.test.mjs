import test from 'node:test';
import assert from 'node:assert/strict';
import { loopbackUrl, signInternal, verifyInternal } from '../dist/infrastructure/internal-auth.js';

test('internal signatures match the Python transport and bind method, path, time and body', () => {
  const key = Buffer.from('k'.repeat(32));
  const body = Buffer.from('{"a":1}');
  const signature = signInternal(key, 'POST', '/internal/test?x=1', 1762600000, body);
  assert.equal(signature, '5552dd79fd82fc65f6f175b53be57de6fa7a24e8908326420033d6e431eb948f');
  const valid = (method, path, at, payload, sig, now) =>
    verifyInternal(key, method, path, at, payload, sig, now);
  assert.equal(valid('POST', '/internal/test?x=1', '1762600000', body, signature, 1762600000000), true);
  assert.equal(valid('GET', '/internal/test?x=1', '1762600000', body, signature, 1762600000000), false);
  assert.equal(valid('POST', '/internal/test?x=2', '1762600000', body, signature, 1762600000000), false);
  assert.equal(valid('POST', '/internal/test?x=1', '1762600000', Buffer.from('{}'), signature, 1762600000000), false);
  assert.equal(valid('POST', '/internal/test?x=1', '1762600000', body, signature, 1762600301000), false);
});

test('only scoped loopback HTTP addresses are accepted', () => {
  for (const value of ['http://localhost:8080', 'http://127.0.0.2:42', 'http://[::1]:8080']) {
    assert.equal(loopbackUrl(value).protocol, 'http:');
  }
  for (const value of ['https://localhost:8080', 'http://example.org', 'http://127.0.0.1/path',
    'http://user:pass@localhost', 'http://localhost/?token=x', 'http://10.0.0.1:80']) {
    assert.throws(() => loopbackUrl(value));
  }
  assert.equal(loopbackUrl('http://localhost:3/api/recovery/collector', '/api/recovery/collector').port, '3');
});
