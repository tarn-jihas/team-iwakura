import { Worker } from 'node:worker_threads';
import type { SQLInputValue } from 'node:sqlite';

export type Statement = { sql: string; params?: SQLInputValue[]; mode: 'run' | 'all' | 'get' };
type Request = { kind: 'statement'; statement: Statement }
  | { kind: 'transaction'; statements: Statement[] }
  | { kind: 'close' };
type Response = { id: number; ok: boolean; value?: unknown; error?: string };

/** A single owner serializes short DB transactions outside the HTTP event loop. */
export class SQLiteStorage {
  private readonly worker: Worker;
  private readonly pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();
  private nextId = 0;
  private closed = false;
  private closing: Promise<void> | null = null;

  constructor(path: string) {
    this.worker = new Worker(new URL('./sqlite-worker.js', import.meta.url), { workerData: { path } });
    this.worker.on('message', (response: Response) => {
      const promise = this.pending.get(response.id);
      if (!promise) return;
      this.pending.delete(response.id);
      if (response.ok) promise.resolve(response.value);
      else promise.reject(new Error(response.error ?? 'SQLite operation failed'));
    });
    this.worker.on('error', error => this.fail(error));
    this.worker.on('exit', code => {
      if (!this.closed || this.pending.size) this.fail(new Error(`SQLite worker stopped (${code})`));
    });
  }

  private fail(error: Error): void {
    this.closed = true;
    for (const promise of this.pending.values()) promise.reject(error);
    this.pending.clear();
  }

  private request(request: Request): Promise<unknown> {
    if (this.closed || this.closing) return Promise.reject(new Error('SQLite storage is closed or closing'));
    const id = ++this.nextId;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      try {
        this.worker.postMessage({ ...request, id });
      } catch (error) {
        this.pending.delete(id);
        reject(error instanceof Error ? error : new Error('Invalid SQLite request'));
      }
    });
  }

  statement(statement: Statement): Promise<unknown> {
    return this.request({ kind: 'statement', statement });
  }

  transaction(statements: Statement[]): Promise<unknown> {
    return this.request({ kind: 'transaction', statements });
  }

  async close(): Promise<void> {
    if (this.closing) return this.closing;
    if (this.closed) return;
    this.closing = this.request({ kind: 'close' }).then(() => { this.closed = true; }, error => {
      this.closing = null;
      throw error;
    });
    return this.closing;
  }
}
