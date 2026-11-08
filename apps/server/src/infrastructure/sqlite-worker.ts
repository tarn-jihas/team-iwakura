import { parentPort, workerData } from 'node:worker_threads';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';

type Statement = { sql: string; params?: SQLInputValue[]; mode: 'run' | 'all' | 'get' };
type Request = { id: number; kind: 'statement'; statement: Statement }
  | { id: number; kind: 'transaction'; statements: Statement[] }
  | { id: number; kind: 'close' };

if (!parentPort) throw new Error('SQLite worker requires a parent');
const port = parentPort;
const db = new DatabaseSync((workerData as { path: string }).path, { timeout: 15_000 });
db.exec('PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=15000;');

function execute(statement: Statement): unknown {
  // Transaction boundaries belong to this worker, not individual statements.
  if (/^\s*(?:(?:--[^\r\n]*(?:\r?\n|$)|\/\*[\s\S]*?\*\/)\s*)*(?:BEGIN|COMMIT|END|ROLLBACK|SAVEPOINT|RELEASE)\b/i.test(statement.sql)) {
    throw new Error('Transaction control is not permitted in statements');
  }
  const prepared = db.prepare(statement.sql);
  const parameters = statement.params ?? [];
  if (statement.mode === 'run') return prepared.run(...parameters);
  if (statement.mode === 'get') return prepared.get(...parameters) ?? null;
  return prepared.all(...parameters);
}

port.on('message', (request: Request) => {
  try {
    if (request.kind === 'close') {
      db.close();
      port.postMessage({ id: request.id, ok: true, value: null });
      port.close();
      return;
    }
    let value: unknown;
    if (request.kind === 'transaction') {
      db.exec('BEGIN IMMEDIATE');
      try {
        value = request.statements.map(execute);
        db.exec('COMMIT');
      } catch (error) {
        db.exec('ROLLBACK');
        throw error;
      }
    } else {
      value = execute(request.statement);
    }
    port.postMessage({ id: request.id, ok: true, value });
  } catch (error) {
    port.postMessage({ id: request.id, ok: false,
      error: error instanceof Error ? error.message : 'SQLite operation failed' });
  }
});
