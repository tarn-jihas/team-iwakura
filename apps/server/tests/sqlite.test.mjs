import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SQLiteStorage } from '../dist/infrastructure/sqlite.js';

test('durable transactions serialize, roll back on error, and survive restart', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'reconcile-ts-sqlite-'));
  const path = join(directory, 'engine.sqlite3');
  let store = new SQLiteStorage(path);
  try {
    await store.statement({ sql: 'CREATE TABLE item (id TEXT PRIMARY KEY, value INTEGER NOT NULL)', mode: 'run' });
    await Promise.all(Array.from({ length: 20 }, (_, i) => store.transaction([
      { sql: 'INSERT INTO item VALUES (?, ?)', params: [`item-${i}`, i], mode: 'run' }
    ])));
    await assert.rejects(store.transaction([
      { sql: 'INSERT INTO item VALUES (?, ?)', params: ['must-roll-back', 1], mode: 'run' },
      { sql: 'INSERT INTO item VALUES (?, ?)', params: ['item-0', 2], mode: 'run' }
    ]));
    await assert.rejects(store.statement({ sql: 'BEGIN', mode: 'run' }), /Transaction control/);
    await assert.rejects(store.statement({ sql: '/* comment */ BEGIN', mode: 'run' }), /Transaction control/);
    await assert.rejects(store.statement({ sql: '-- comment\nROLLBACK', mode: 'run' }), /Transaction control/);
    await assert.rejects(store.statement({ sql: 'SELECT ?', params: [() => {}], mode: 'get' }));
    const closing = store.close();
    const duplicateClose = store.close();
    await assert.rejects(store.statement({ sql: 'SELECT 1', mode: 'get' }), /closed or closing/);
    await Promise.all([closing, duplicateClose]);
    store = new SQLiteStorage(path);
    const count = await store.statement({ sql: 'SELECT COUNT(*) AS count FROM item', mode: 'get' });
    assert.equal(count.count, 20);
    const missing = await store.statement({ sql: 'SELECT id FROM item WHERE id = ?', params: ['must-roll-back'], mode: 'get' });
    assert.equal(missing, null);
  } finally {
    await store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('a long database query does not block the HTTP event loop', async () => {
  const store = new SQLiteStorage(':memory:');
  try {
    let ticked = false;
    const query = store.statement({ sql: 'WITH RECURSIVE n(x) AS (VALUES(1) UNION ALL SELECT x+1 FROM n WHERE x<300000) SELECT SUM(x) AS total FROM n', mode: 'get' });
    await new Promise(resolve => setTimeout(() => { ticked = true; resolve(); }, 0));
    assert.equal(ticked, true);
    assert.equal((await query).total, 45000150000);
  } finally {
    await store.close();
  }
});
