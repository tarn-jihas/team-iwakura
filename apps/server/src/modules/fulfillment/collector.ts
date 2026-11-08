import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { canonical, validateEvent, type CollectorAcknowledgement, type EventScope } from '@reconcile/contracts';
import { SQLiteStorage } from '../../infrastructure/sqlite.js';

export class CollectorError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}

/** Collector evidence is untrusted telemetry; source verification authorizes repairs. */
export class Collector {
  constructor(private readonly storage: SQLiteStorage, private readonly key: Uint8Array,
    private readonly scope: Required<EventScope>, private readonly now: () => number = Date.now) {
    if (key.byteLength < 32 || !scope.runId || !scope.app || !scope.environment) throw new Error('Invalid collector configuration');
  }

  async initialize(): Promise<void> {
    await this.storage.transaction([
      { mode:'run', sql:'CREATE TABLE IF NOT EXISTS collector_scope (singleton INTEGER PRIMARY KEY CHECK(singleton=1), run_id TEXT NOT NULL, app TEXT NOT NULL, environment TEXT NOT NULL)' },
      { mode:'run', sql:'INSERT OR IGNORE INTO collector_scope VALUES (1,?,?,?)', params:[this.scope.runId,this.scope.app,this.scope.environment] },
      { mode:'run', sql:"CREATE TRIGGER IF NOT EXISTS collector_scope_no_update BEFORE UPDATE ON collector_scope BEGIN SELECT RAISE(ABORT,'Collector scope is immutable'); END" },
      { mode:'run', sql:"CREATE TRIGGER IF NOT EXISTS collector_scope_no_delete BEFORE DELETE ON collector_scope BEGIN SELECT RAISE(ABORT,'Collector scope is immutable'); END" },
      { mode:'run', sql:'CREATE TABLE IF NOT EXISTS collector_events (event_id TEXT PRIMARY KEY, payload_hash TEXT NOT NULL, event_json TEXT NOT NULL, received_at TEXT NOT NULL)' },
      { mode:'run', sql:"CREATE TRIGGER IF NOT EXISTS collector_events_no_update BEFORE UPDATE ON collector_events BEGIN SELECT RAISE(ABORT,'Collector evidence is immutable'); END" },
      { mode:'run', sql:"CREATE TRIGGER IF NOT EXISTS collector_events_no_delete BEFORE DELETE ON collector_events BEGIN SELECT RAISE(ABORT,'Collector evidence is immutable'); END" }
    ]);
    const scope = await this.storage.statement({ mode:'get', sql:'SELECT run_id,app,environment FROM collector_scope WHERE singleton=1' }) as
      { run_id:string; app:string; environment:string };
    if (scope.run_id !== this.scope.runId || scope.app !== this.scope.app || scope.environment !== this.scope.environment) {
      throw new Error('Collector scope does not match stored runtime');
    }
  }

  async collect(envelope: unknown, signature: unknown): Promise<CollectorAcknowledgement> {
    if (!envelope || typeof envelope !== 'object' || Array.isArray(envelope)
        || Object.keys(envelope).sort().join(',') !== 'event,schema_version,sent_at') {
      throw new CollectorError(400, 'Invalid collector envelope');
    }
    const value = envelope as Record<string, unknown>;
    if (!Number.isSafeInteger(value.sent_at) || Math.abs(this.now() / 1000 - (value.sent_at as number)) > 300) {
      throw new CollectorError(401, 'Collector signature expired');
    }
    let body: string;
    try { body = canonical(envelope); } catch { throw new CollectorError(400, 'Invalid collector envelope'); }
    if (Buffer.byteLength(body) > 20 * 1024) throw new CollectorError(400, 'Collector envelope too large');
    const expected = createHmac('sha256', this.key).update(body).digest();
    if (typeof signature !== 'string' || !/^[a-f0-9]{64}$/.test(signature)
        || !timingSafeEqual(expected, Buffer.from(signature, 'hex'))) throw new CollectorError(401, 'Invalid collector signature');
    try { validateEvent(value.event, this.scope); } catch { throw new CollectorError(400, 'Invalid collector event'); }
    const event = value.event;
    if (value.schema_version !== event.schema_version) throw new CollectorError(400, 'Unsupported collector schema version');
    const payload = canonical(event), hash = createHash('sha256').update(payload).digest('hex');
    const [inserted, row] = await this.storage.transaction([
      { mode:'run', sql:'INSERT INTO collector_events SELECT ?,?,?,? FROM collector_scope WHERE singleton=1 AND run_id=? AND app=? AND environment=? ON CONFLICT(event_id) DO NOTHING',
        params:[event.event_id,hash,payload,new Date(this.now()).toISOString(),this.scope.runId,this.scope.app,this.scope.environment] },
      { mode:'get', sql:'SELECT payload_hash FROM collector_events WHERE event_id=?', params:[event.event_id] }
    ]) as [{ changes:number | bigint }, { payload_hash:string } | null];
    if (!row || row.payload_hash !== hash) throw new CollectorError(409, 'Collector event ID or scope conflict');
    return { accepted:true, duplicate:Number(inserted.changes) === 0, event_id:event.event_id, event_hash:hash };
  }
}
