import { Worker } from 'node:worker_threads';
import type { ActivationProviderOptions } from './activation.js';

type ActivationMethod = 'manifest' | 'reset' | 'advanceClock' | 'providerAccounts' | 'providerEvidence'
  | 'providerHistory' | 'providerObservations' | 'adaptyProfiles' | 'adaptyCatalog' | 'repairCatalog'
  | 'providerValidate' | 'adaptyOperation' | 'providerDemoFault' | 'demoFault' | 'adaptyDemoFault'
  | 'providerFaultActive' | 'consumeProviderFault' | 'close';

interface WorkerReply {
  type?: 'ready' | 'startup_error' | 'result';
  id?: number;
  ok?: boolean;
  value?: unknown;
  error?: string;
  status?: number;
}

interface Pending {
  resolve(value: unknown): void;
  reject(error: Error): void;
}

export class ActivationProviderWorker {
  private readonly worker: Worker;
  private readonly pending = new Map<number, Pending>();
  private readonly ready: Promise<void>;
  private readonly exit: Promise<number>;
  private nextId = 0;
  private closed = false;
  private closing?: Promise<void>;

  private constructor(options: ActivationProviderOptions) {
    this.worker = new Worker(new URL('./activation-worker.js', import.meta.url), { workerData: options });
    let markReady!: () => void;
    let failReady!: (error: Error) => void;
    this.ready = new Promise<void>((resolve, reject) => { markReady = resolve; failReady = reject; });
    this.exit = new Promise(resolve => this.worker.once('exit', resolve));
    this.worker.on('message', (reply: WorkerReply) => {
      if (reply.type === 'ready') { markReady(); return; }
      if (reply.type === 'startup_error') { failReady(new Error(reply.error ?? 'Activation worker failed to start')); return; }
      if (typeof reply.id !== 'number') return;
      const pending = this.pending.get(reply.id);
      if (!pending) return;
      this.pending.delete(reply.id);
      if (reply.ok) pending.resolve(reply.value);
      else {
        const error = new Error(reply.error ?? 'Activation worker request failed') as Error & { status?: number };
        if (typeof reply.status === 'number') error.status = reply.status;
        pending.reject(error);
      }
    });
    this.worker.on('error', error => {
      this.closed = true;
      failReady(error);
      for (const pending of this.pending.values()) pending.reject(error);
      this.pending.clear();
    });
    this.worker.on('exit', code => {
      if (code === 0 && this.closing) return;
      const error = new Error(`Activation worker stopped (${code})`);
      this.closed = true;
      failReady(error);
      for (const pending of this.pending.values()) pending.reject(error);
      this.pending.clear();
    });
  }

  static async create(options: ActivationProviderOptions): Promise<ActivationProviderWorker> {
    const worker = new ActivationProviderWorker(options);
    try { await worker.ready; return worker; }
    catch (error) { await worker.worker.terminate(); throw error; }
  }

  async call(method: ActivationMethod, ...args: unknown[]): Promise<unknown> {
    await this.ready;
    if (this.closed || (this.closing && method !== 'close')) throw new Error('Activation worker is closed');
    const id = ++this.nextId;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      try { this.worker.postMessage({ id, method, args }); }
      catch (error) {
        this.pending.delete(id);
        reject(error instanceof Error ? error : new Error('Activation worker request failed'));
      }
    });
  }

  async close(): Promise<void> {
    if (this.closing) return this.closing;
    if (this.closed) return;
    this.closing = (async () => {
      try { await this.call('close'); }
      finally { this.closed = true; }
      await this.exit;
    })();
    return this.closing;
  }
}
