import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveRoute } from '../src/routes.ts';

test('retained URLs select their Preact workspaces', () => {
  assert.equal(resolveRoute('/'), 'monitor');
  assert.equal(resolveRoute('/recovery.html'), 'monitor');
  assert.equal(resolveRoute('/analytics.html'), 'analytics');
  assert.equal(resolveRoute('/index.html'), 'analytics');
  assert.equal(resolveRoute('/access.html'), 'access');
  assert.equal(resolveRoute('/recovery-console.html'), 'recovery');
  assert.equal(resolveRoute('/legacy.html'), 'legacy');
});
