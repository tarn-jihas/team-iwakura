import { Worker } from 'node:worker_threads';
import { semanticJson } from '../../infrastructure/json.js';
import { parseTimestamp } from '../../infrastructure/time.js';
import { SQLiteStorage } from '../../infrastructure/sqlite.js';
import { FulfillmentRegistry } from '../fulfillment/registry.js';
import { safeReceipt } from './receipt.js';

export interface Coverage {
  registered:number; scanned:number; sourceRead:number; clientRead:number; incomplete:number; sourceStopped:boolean;
}
export type Provenance = 'official_synthetic_seed' | 'local_fixture' | 'unknown';
export interface MonitorOptions {
  cursor:number; limit:number; status:'needs_attention' | 'detecting' | 'repairing' | 'repaired';
  mode:string; title:string; sourceReady:boolean; sourceFresh:boolean; lastError:string | null;
}

/** Exports from a single local SQLite snapshot; never reads the source provider. */
export class Reporting {
  constructor(private readonly storage:SQLiteStorage, private readonly now:() => Date = () => new Date()) {}

  async initialize(): Promise<void> {
    await new FulfillmentRegistry(this.storage).initialize();
    await this.storage.transaction([
      { mode:'run',sql:'CREATE TABLE IF NOT EXISTS reporting_state (key TEXT PRIMARY KEY,value TEXT NOT NULL)' },
      { mode:'run',sql:'CREATE TABLE IF NOT EXISTS collector_events (event_id TEXT PRIMARY KEY, payload_hash TEXT NOT NULL, event_json TEXT NOT NULL, received_at TEXT NOT NULL)' }
    ]);
  }

  async updateCoverage(coverage:Coverage, provenance:Provenance): Promise<void> {
    if (!coverage || Object.keys(coverage).sort().join(',') !== 'clientRead,incomplete,registered,scanned,sourceRead,sourceStopped'
        || ![coverage.registered,coverage.scanned,coverage.sourceRead,coverage.clientRead,coverage.incomplete]
          .every(value => Number.isSafeInteger(value) && value >= 0)
        || coverage.scanned > coverage.registered || coverage.sourceRead > coverage.scanned
        || coverage.clientRead > coverage.scanned || coverage.incomplete > coverage.scanned
        || typeof coverage.sourceStopped !== 'boolean' || !['official_synthetic_seed','local_fixture','unknown'].includes(provenance)) {
      throw new Error('Invalid report coverage');
    }
    const state = semanticJson({ coverage,provenance });
    await this.storage.statement({ mode:'run',sql:"INSERT INTO reporting_state VALUES ('coverage',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",params:[state] });
  }

  async export(appId:string,environment:string,from:string,to:string,format:'csv' | 'json' | 'monitor',
    monitor?:MonitorOptions): Promise<{ body:string; contentType:string }> {
    const start = parseTimestamp(from), end = parseTimestamp(to), exportedAt = this.now();
    if (typeof appId !== 'string' || !appId.trim() || typeof environment !== 'string' || !environment.trim()
        || typeof from !== 'string' || typeof to !== 'string' || !from.endsWith('Z') || !to.endsWith('Z') || !Number.isFinite(start)
        || !Number.isFinite(end) || start >= end || !Number.isFinite(exportedAt.getTime()) || !['csv','json','monitor'].includes(format)
        || (format === 'monitor' && (!monitor || !Number.isSafeInteger(monitor.cursor) || monitor.cursor < 0
          || !Number.isInteger(monitor.limit) || monitor.limit < 1 || monitor.limit > 200
          || !['needs_attention','detecting','repairing','repaired'].includes(monitor.status)))) {
      throw new Error('Invalid UTC export range');
    }
    const selection = `
      SELECT i.id FROM incidents i WHERE i.app_id=? AND i.environment=? AND julianday(i.created_at)<=julianday(?) AND (
        (julianday(i.created_at)>=julianday(?) AND julianday(i.created_at)<julianday(?)) OR
        EXISTS (SELECT 1 FROM recovery_actions a JOIN action_history h ON h.operation_key=a.operation_key
          WHERE a.incident_id=i.id AND julianday(h.occurred_at)>=julianday(?) AND julianday(h.occurred_at)<julianday(?)
          AND julianday(h.occurred_at)<=julianday(?)) OR
        EXISTS (SELECT 1 FROM fulfillment_history f WHERE f.incident_id=i.id AND julianday(f.occurred_at)>=julianday(?)
          AND julianday(f.occurred_at)<julianday(?) AND julianday(f.occurred_at)<=julianday(?)) OR
        EXISTS (SELECT 1 FROM external_verifications e WHERE e.incident_id=i.id AND julianday(e.verified_at)>=julianday(?)
          AND julianday(e.verified_at)<julianday(?) AND julianday(e.verified_at)<=julianday(?)))`;
    const sql = `WITH selected AS (${selection})
      SELECT i.id,i.created_at,(SELECT s.snapshot_json FROM snapshots s WHERE s.incident_id=i.id AND julianday(s.created_at)<=julianday(?) ORDER BY s.rowid DESC LIMIT 1) AS snapshot_json,p.id AS plan_id,p.plan_json,p.created_at AS plan_created_at,po.sequence AS plan_order,a.operation_key,
      (SELECT h2.status FROM action_history h2 WHERE h2.operation_key=a.operation_key AND julianday(h2.occurred_at)<=julianday(?) ORDER BY h2.sequence DESC LIMIT 1) AS action_status,
      h.sequence,eo.sequence AS event_order,h.status AS event_status,h.result_json,h.occurred_at
      FROM selected s JOIN incidents i ON i.id=s.id LEFT JOIN recovery_plans p ON p.incident_id=i.id AND julianday(p.created_at)<=julianday(?)
      LEFT JOIN recovery_event_order po ON po.kind='plan' AND po.reference=p.rowid
      LEFT JOIN recovery_actions a ON a.plan_id=p.id LEFT JOIN action_history h ON h.operation_key=a.operation_key AND julianday(h.occurred_at)<=julianday(?)
      LEFT JOIN recovery_event_order eo ON eo.kind='action' AND eo.reference=h.sequence
      ORDER BY i.created_at,i.id,p.rowid,a.rowid,h.sequence`;
    const historySql = `WITH selected AS (${selection}) SELECT DISTINCT selected.id AS incident_id,h.identity_hash,h.sequence,
      h.status,h.reason,h.episode_no,h.occurred_at,f.user_id,eo.sequence AS event_order FROM selected JOIN fulfillment_history claimed ON claimed.incident_id=selected.id
      JOIN fulfillment_history h ON h.identity_hash=claimed.identity_hash AND h.episode_no=claimed.episode_no
      JOIN recovery_event_order eo ON eo.kind='fulfillment' AND eo.reference=h.sequence
      JOIN fulfillment_current f ON f.identity_hash=h.identity_hash WHERE julianday(h.occurred_at)<=julianday(?)
      ORDER BY selected.id,h.sequence`;
    const externalSql = `WITH selected AS (${selection}) SELECT e.id,e.incident_id,e.user_id,e.verified_at,e.kind,eo.sequence AS event_order FROM selected
      JOIN external_verifications e ON e.incident_id=selected.id JOIN recovery_event_order eo ON eo.kind='external' AND eo.reference=e.rowid
      WHERE julianday(e.verified_at)<=julianday(?) ORDER BY eo.sequence`;
    const receiptSql = `WITH selected AS (${selection}) SELECT DISTINCT i.id AS incident_id,c.event_json,c.received_at FROM selected
      JOIN incidents i ON i.id=selected.id JOIN fulfillment_history h ON h.incident_id=i.id
      JOIN fulfillment_current f ON f.identity_hash=h.identity_hash AND f.app=i.app_id AND f.environment=i.environment
      JOIN collector_events c ON json_extract(c.event_json,'$.app_user_id')=f.user_id
      WHERE json_extract(c.event_json,'$.app')=i.app_id AND json_extract(c.event_json,'$.environment')=i.environment
        AND julianday(c.received_at)<=julianday(?)
        AND julianday(json_extract(c.event_json,'$.occurred_at')) BETWEEN julianday(i.created_at,'-5 minutes') AND julianday(i.created_at,'+5 minutes')
      ORDER BY i.id,c.received_at`;
    const cutoff = exportedAt.toISOString();
    const selectionParams = [appId,environment,cutoff,from,to,from,to,cutoff,from,to,cutoff,from,to,cutoff];
    const [rows,fulfillments,external,state,receipts] = await this.storage.transaction([
      { mode:'all',sql,params:[...selectionParams,cutoff,cutoff,cutoff,cutoff] },
      { mode:'all',sql:historySql,params:[...selectionParams,cutoff] },
      { mode:'all',sql:externalSql,params:[...selectionParams,cutoff] },
      { mode:'get',sql:"SELECT value FROM reporting_state WHERE key='coverage'" },
      format === 'json' ? { mode:'all',sql:receiptSql,params:[...selectionParams,cutoff] }
        : { mode:'all',sql:'SELECT NULL WHERE 0' }
    ]) as [unknown[],unknown[],unknown[],{ value:string } | null,unknown[]];
    const metadata = state ? JSON.parse(state.value) as unknown : { coverage:null,provenance:'unknown' };
    return new Promise((resolve,reject) => {
      const worker = new Worker(new URL('./export-worker.js',import.meta.url));
      worker.once('message',(result:unknown) => { void worker.terminate(); resolve(result as { body:string; contentType:string }); });
      worker.once('error',reject);
      worker.once('exit',code => { if (code !== 0) reject(new Error('Report export failed')); });
      worker.postMessage({ rows,fulfillments,external,receipts,metadata,appId,environment,from,to,format,monitor,exportedAt:exportedAt.toISOString() });
    });
  }

  async monitor(appId:string,environment:string,options:MonitorOptions):Promise<{ body:string; contentType:string }> {
    const to = new Date(this.now().getTime()+1).toISOString();
    return this.export(appId,environment,'1970-01-01T00:00:00Z',to,'monitor',options);
  }

  async trace(appId:string,environment:string,incidentId:string):Promise<Record<string,unknown>> {
    if (![appId,environment,incidentId].every(value => typeof value === 'string' && value.length > 0 && value.length <= 256)) {
      throw new Error('Invalid incident scope');
    }
    const [incident,snapshot,fulfillments,actions,external,receipts] = await this.storage.transaction([
      { mode:'get',sql:'SELECT id FROM incidents WHERE id=? AND app_id=? AND environment=?',params:[incidentId,appId,environment] },
      { mode:'get',sql:'SELECT created_at FROM snapshots WHERE incident_id=? ORDER BY rowid DESC LIMIT 1',params:[incidentId] },
      { mode:'all',sql:`SELECT DISTINCT h.sequence,h.status,h.reason,h.occurred_at,f.user_id FROM fulfillment_history claimed
        JOIN fulfillment_history h ON h.identity_hash=claimed.identity_hash AND h.episode_no=claimed.episode_no
        JOIN fulfillment_current f ON f.identity_hash=h.identity_hash WHERE claimed.incident_id=? ORDER BY h.sequence`,params:[incidentId] },
      { mode:'all',sql:`SELECT h.sequence,h.status,h.occurred_at,json_extract(item.value,'$.userId') AS user_id,
        json_extract(item.value,'$.kind') AS kind FROM recovery_actions a JOIN recovery_plans p ON p.id=a.plan_id
        JOIN action_history h ON h.operation_key=a.operation_key JOIN json_each(p.plan_json,'$.actions') item
        ON json_extract(item.value,'$.operationKey')=a.operation_key WHERE a.incident_id=? ORDER BY h.sequence`,params:[incidentId] },
      { mode:'all',sql:'SELECT user_id,kind,verified_at FROM external_verifications WHERE incident_id=? ORDER BY rowid',params:[incidentId] },
      { mode:'all',sql:`SELECT DISTINCT c.event_json,c.received_at FROM collector_events c
        JOIN incidents i ON i.id=? AND i.app_id=? AND i.environment=?
        JOIN fulfillment_current f ON f.app=i.app_id AND f.environment=i.environment
          AND f.user_id=json_extract(c.event_json,'$.app_user_id')
        JOIN fulfillment_history h ON h.identity_hash=f.identity_hash AND h.incident_id=i.id
        WHERE json_extract(c.event_json,'$.app')=i.app_id AND json_extract(c.event_json,'$.environment')=i.environment
          AND julianday(json_extract(c.event_json,'$.occurred_at')) BETWEEN julianday(i.created_at,'-5 minutes') AND julianday(i.created_at,'+5 minutes')
        ORDER BY c.received_at LIMIT 501`,params:[incidentId,appId,environment] }
    ]) as [{ id:string } | null,{ created_at:string } | null,
      { status:string; reason:string; occurred_at:string; user_id:string }[],
      { status:string; occurred_at:string; user_id:string; kind:string }[],{ user_id:string; kind:string; verified_at:string }[],
      { event_json:string; received_at:string }[]];
    if (!incident) throw new Error('Incident not found');
    const traces = new Map<string,{ user_id:string; steps:Record<string,unknown>[] }>();
    for (const item of fulfillments) {
      const trace = traces.get(item.user_id) ?? { user_id:item.user_id,steps:[] };
      trace.steps.push({ name:'assessment',owner:'engine',status:item.status,result:item.reason,at:item.occurred_at });
      traces.set(item.user_id,trace);
    }
    for (const item of actions) {
      const trace = traces.get(item.user_id) ?? { user_id:item.user_id,steps:[] };
      trace.steps.push({ name:item.kind,owner:'lumen',status:item.status,result:item.status,at:item.occurred_at });
      traces.set(item.user_id,trace);
    }
    for (const item of external) {
      const trace = traces.get(item.user_id) ?? { user_id:item.user_id,steps:[] };
      trace.steps.push({ name:item.kind === 'own_followup' ? 'followup_gate_verification' : 'external_gate_verification',
        owner:'engine',status:'verified',result:'verified',at:item.verified_at });
      traces.set(item.user_id,trace);
    }
    for (const trace of traces.values()) trace.steps.sort((a,b) => Date.parse(String(a.at))-Date.parse(String(b.at)));
    const processingReceipts = receipts.slice(0,500).map(safeReceipt).filter(value => value !== null);
    return { incident_id:incidentId,snapshot_at:snapshot?.created_at ?? null,traces:[...traces.values()],
      processing_receipts:processingReceipts,processing_receipts_truncated:receipts.length > 500 };
  }
}
