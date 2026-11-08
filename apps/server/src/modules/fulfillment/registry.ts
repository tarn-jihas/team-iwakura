import { semanticDigest } from '../../infrastructure/json.js';
import { parseTimestamp } from '../../infrastructure/time.js';
import { SQLiteStorage } from '../../infrastructure/sqlite.js';
import type { Classification } from './classification.js';

export interface FulfillmentKey {
  app:string; environment:string; store:string; transactionId:string | null; userId:string; accessLevel:string;
}
export type FulfillmentState = 'awaiting_application' | 'verified_application' | 'discrepancy' | 'inconclusive' | 'excluded' | 'superseded';
const state = (status:Classification['status']):FulfillmentState => status === 'healthy' ? 'verified_application'
  : status === 'confirmed' ? 'discrepancy' : status === 'potential' ? 'awaiting_application'
    : status === 'inconclusive' ? 'inconclusive' : 'excluded';
const validText = (value:unknown): value is string => typeof value === 'string' && value.length > 0
  && value.length <= 256 && value.trim() === value && !/[\u0000-\u001f\u007f]/.test(value);

/** The same observed state updates coverage without creating activity or a new episode. */
export class FulfillmentRegistry {
  constructor(private readonly storage:SQLiteStorage) {}

  async initialize():Promise<void> {
    await this.storage.transaction([
      { mode:'run',sql:'CREATE TABLE IF NOT EXISTS recovery_event_order (sequence INTEGER PRIMARY KEY, kind TEXT NOT NULL, reference INTEGER NOT NULL)' },
      { mode:'run',sql:'CREATE TABLE IF NOT EXISTS fulfillment_current (identity_hash TEXT PRIMARY KEY,app TEXT NOT NULL,environment TEXT NOT NULL,store TEXT NOT NULL,transaction_id TEXT,user_id TEXT NOT NULL,access_level TEXT NOT NULL,status TEXT NOT NULL,reason TEXT NOT NULL,source_fingerprint TEXT NOT NULL,entitlement_hash TEXT NOT NULL,episode_no INTEGER NOT NULL,episode_open INTEGER NOT NULL,incident_id TEXT,verified_source_fingerprint TEXT,verified_entitlement_hash TEXT,last_checked_at TEXT NOT NULL,last_checked_ms INTEGER NOT NULL,updated_at TEXT NOT NULL)' },
      { mode:'run',sql:'CREATE TABLE IF NOT EXISTS fulfillment_history (sequence INTEGER PRIMARY KEY,identity_hash TEXT NOT NULL REFERENCES fulfillment_current(identity_hash),status TEXT NOT NULL,reason TEXT NOT NULL,source_fingerprint TEXT NOT NULL,entitlement_hash TEXT NOT NULL,episode_no INTEGER NOT NULL,episode_open INTEGER NOT NULL,incident_id TEXT,occurred_at TEXT NOT NULL)' },
      { mode:'run',sql:'CREATE INDEX IF NOT EXISTS fulfillment_scope_user ON fulfillment_current(app,environment,user_id,episode_open)' },
      { mode:'run',sql:'CREATE INDEX IF NOT EXISTS fulfillment_history_identity ON fulfillment_history(identity_hash,episode_no,sequence)' },
      { mode:'run',sql:'CREATE INDEX IF NOT EXISTS fulfillment_history_incident ON fulfillment_history(incident_id,identity_hash,episode_no)' },
      { mode:'run',sql:"CREATE TRIGGER IF NOT EXISTS fulfillment_history_order AFTER INSERT ON fulfillment_history BEGIN INSERT INTO recovery_event_order(kind,reference) VALUES('fulfillment',NEW.sequence); END" },
      { mode:'run',sql:'CREATE TRIGGER IF NOT EXISTS fulfillment_record_insert AFTER INSERT ON fulfillment_current BEGIN INSERT INTO fulfillment_history(identity_hash,status,reason,source_fingerprint,entitlement_hash,episode_no,episode_open,incident_id,occurred_at) VALUES(NEW.identity_hash,NEW.status,NEW.reason,NEW.source_fingerprint,NEW.entitlement_hash,NEW.episode_no,NEW.episode_open,NEW.incident_id,NEW.updated_at); END' },
      { mode:'run',sql:'CREATE TRIGGER IF NOT EXISTS fulfillment_record_change AFTER UPDATE ON fulfillment_current WHEN NEW.status<>OLD.status OR NEW.reason<>OLD.reason OR NEW.source_fingerprint<>OLD.source_fingerprint OR NEW.entitlement_hash<>OLD.entitlement_hash OR NEW.episode_no<>OLD.episode_no OR NEW.episode_open<>OLD.episode_open OR NEW.incident_id IS NOT OLD.incident_id BEGIN INSERT INTO fulfillment_history(identity_hash,status,reason,source_fingerprint,entitlement_hash,episode_no,episode_open,incident_id,occurred_at) VALUES(NEW.identity_hash,NEW.status,NEW.reason,NEW.source_fingerprint,NEW.entitlement_hash,NEW.episode_no,NEW.episode_open,NEW.incident_id,NEW.updated_at); END' },
      { mode:'run',sql:"CREATE TRIGGER IF NOT EXISTS fulfillment_history_no_update BEFORE UPDATE ON fulfillment_history BEGIN SELECT RAISE(ABORT,'Fulfillment history is immutable'); END" },
      { mode:'run',sql:"CREATE TRIGGER IF NOT EXISTS fulfillment_history_no_delete BEFORE DELETE ON fulfillment_history BEGIN SELECT RAISE(ABORT,'Fulfillment history is immutable'); END" }
    ]);
  }

  async observe(key:FulfillmentKey, classification:Classification, sourceFingerprint:string, entitlementHash:string,
    at:string):Promise<{ identityHash:string; status:FulfillmentState; episodeNo:number; episodeOpen:boolean; incidentId:string | null }> {
    const time = parseTimestamp(at);
    if (![key.app,key.environment,key.store,key.userId,key.accessLevel].every(validText)
        || !(key.transactionId === null || validText(key.transactionId)) || !Number.isFinite(time)
        || (key.transactionId === null && classification.status === 'confirmed')
        || !/^[0-9a-f]{64}$/.test(sourceFingerprint) || !/^[0-9a-f]{64}$/.test(entitlementHash)
        || !['healthy','confirmed','potential','inconclusive','legitimate_denial','policy_denial'].includes(classification.status)
        || !/^[a-z0-9_]{1,80}$/.test(classification.reason)) throw new Error('Invalid fulfillment observation');
    const identityHash = semanticDigest([key.app,key.environment,key.store,key.transactionId,key.userId,key.accessLevel]);
    const status = state(classification.status);
    const [_,row] = await this.storage.transaction([
      { mode:'run',sql:`INSERT INTO fulfillment_current VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
        ON CONFLICT(identity_hash) DO UPDATE SET
          status=excluded.status,reason=excluded.reason,source_fingerprint=excluded.source_fingerprint,
          entitlement_hash=excluded.entitlement_hash,
          episode_no=fulfillment_current.episode_no + CASE WHEN excluded.status='discrepancy' AND fulfillment_current.episode_open=0 THEN 1 ELSE 0 END,
          episode_open=CASE WHEN excluded.status='discrepancy' THEN 1 WHEN excluded.status='verified_application' THEN 0 ELSE fulfillment_current.episode_open END,
          incident_id=CASE WHEN excluded.status='discrepancy' AND fulfillment_current.episode_open=0 THEN NULL ELSE fulfillment_current.incident_id END,
          verified_source_fingerprint=CASE WHEN excluded.status='verified_application' THEN excluded.source_fingerprint
            WHEN fulfillment_current.source_fingerprint<>excluded.source_fingerprint OR fulfillment_current.entitlement_hash<>excluded.entitlement_hash THEN NULL
            ELSE fulfillment_current.verified_source_fingerprint END,
          verified_entitlement_hash=CASE WHEN excluded.status='verified_application' THEN excluded.entitlement_hash
            WHEN fulfillment_current.source_fingerprint<>excluded.source_fingerprint OR fulfillment_current.entitlement_hash<>excluded.entitlement_hash THEN NULL
            ELSE fulfillment_current.verified_entitlement_hash END,
          last_checked_at=excluded.last_checked_at,last_checked_ms=excluded.last_checked_ms,
          updated_at=CASE WHEN fulfillment_current.status<>excluded.status OR fulfillment_current.reason<>excluded.reason
            OR fulfillment_current.source_fingerprint<>excluded.source_fingerprint OR fulfillment_current.entitlement_hash<>excluded.entitlement_hash
            THEN excluded.updated_at ELSE fulfillment_current.updated_at END
        WHERE excluded.last_checked_ms>fulfillment_current.last_checked_ms OR (excluded.last_checked_ms=fulfillment_current.last_checked_ms
          AND excluded.status=fulfillment_current.status AND excluded.reason=fulfillment_current.reason
          AND excluded.source_fingerprint=fulfillment_current.source_fingerprint AND excluded.entitlement_hash=fulfillment_current.entitlement_hash)`,
        params:[identityHash,key.app,key.environment,key.store,key.transactionId,key.userId,key.accessLevel,status,classification.reason,
          sourceFingerprint,entitlementHash,status === 'discrepancy' ? 1 : 0,status === 'discrepancy' ? 1 : 0,null,
          status === 'verified_application' ? sourceFingerprint : null,status === 'verified_application' ? entitlementHash : null,at,time,at] },
      { mode:'get',sql:'SELECT status,episode_no,episode_open,incident_id FROM fulfillment_current WHERE identity_hash=?',params:[identityHash] }
    ]) as [unknown,{ status:FulfillmentState; episode_no:number; episode_open:number; incident_id:string | null }];
    return { identityHash,status:row.status,episodeNo:row.episode_no,episodeOpen:!!row.episode_open,incidentId:row.incident_id };
  }

  async wasVerified(key:FulfillmentKey,sourceFingerprint:string,entitlementHash:string):Promise<boolean> {
    if (![key.app,key.environment,key.store,key.userId,key.accessLevel].every(validText)
        || !(key.transactionId === null || validText(key.transactionId))
        || !/^[0-9a-f]{64}$/.test(sourceFingerprint) || !/^[0-9a-f]{64}$/.test(entitlementHash)) return false;
    const identity = semanticDigest([key.app,key.environment,key.store,key.transactionId,key.userId,key.accessLevel]);
    return !!await this.storage.statement({ mode:'get',sql:'SELECT identity_hash FROM fulfillment_current WHERE identity_hash=? AND verified_source_fingerprint=? AND verified_entitlement_hash=?',params:[identity,sourceFingerprint,entitlementHash] });
  }

  async markCoverageGap(app:string,environment:string,userId:string,at:string):Promise<void> {
    const timestamp = parseTimestamp(at);
    if (![app,environment,userId].every(validText) || !Number.isFinite(timestamp)) throw new Error('Invalid coverage gap');
    await this.storage.statement({ mode:'run',sql:`UPDATE fulfillment_current SET status='inconclusive',reason='coverage_incomplete',
      updated_at=CASE WHEN status<>'inconclusive' OR reason<>'coverage_incomplete' THEN ? ELSE updated_at END,
      last_checked_at=?,last_checked_ms=? WHERE app=? AND environment=? AND user_id=? AND last_checked_ms<?
        AND (episode_open=1 OR incident_id IS NULL) AND status<>'superseded'`,
      params:[at,at,timestamp,app,environment,userId,timestamp] });
  }

  async claimIncident(incidentId:string,app:string,environment:string,identities:readonly string[],at:string):Promise<boolean> {
    if (![incidentId,app,environment].every(validText) || !identities.length || identities.length > 10_000
        || identities.some(value => !/^[0-9a-f]{64}$/.test(value)) || new Set(identities).size !== identities.length
        || !Number.isFinite(parseTimestamp(at))) throw new Error('Invalid incident claim');
    const marks = identities.map(() => '?').join(',');
    const results = await this.storage.transaction([
      { mode:'run',sql:`INSERT INTO incidents(id,app_id,environment,created_at) SELECT ?,?,?,? WHERE
        (SELECT COUNT(*)=? AND COUNT(DISTINCT candidate.user_id)=? FROM fulfillment_current candidate WHERE candidate.identity_hash IN (${marks})
        AND candidate.app=? AND candidate.environment=? AND candidate.status='discrepancy' AND candidate.episode_open=1 AND candidate.incident_id IS NULL
        AND NOT EXISTS (SELECT 1 FROM fulfillment_current other WHERE other.app=candidate.app AND other.environment=candidate.environment
          AND other.user_id=candidate.user_id AND other.episode_open=1 AND other.incident_id IS NOT NULL))`,
        params:[incidentId,app,environment,at,identities.length,identities.length,...identities,app,environment] },
      { mode:'run',sql:`UPDATE fulfillment_current SET incident_id=?,updated_at=? WHERE identity_hash IN (${marks})
        AND app=? AND environment=? AND status='discrepancy' AND episode_open=1 AND incident_id IS NULL AND changes()=1`,
        params:[incidentId,at,...identities,app,environment] }
    ]) as [{ changes:number | bigint },{ changes:number | bigint }];
    return Number(results[0].changes) === 1 && Number(results[1].changes) === identities.length;
  }

  async ownedByAnother(app:string,environment:string,userId:string,incidentId?:string):Promise<boolean> {
    if (![app,environment,userId].every(validText) || (incidentId !== undefined && !validText(incidentId))) throw new Error('Invalid incident scope');
    const row = await this.storage.statement({ mode:'get',sql:'SELECT incident_id FROM fulfillment_current WHERE app=? AND environment=? AND user_id=? AND episode_open=1 AND incident_id IS NOT NULL AND (? IS NULL OR incident_id<>?) LIMIT 1',
      params:[app,environment,userId,incidentId ?? null,incidentId ?? null] });
    return !!row;
  }

  async openIncident(app:string,environment:string,userId:string):Promise<string | null> {
    return (await this.openIncidents(app,environment,userId))[0] ?? null;
  }

  async openIncidents(app:string,environment:string,userId:string):Promise<string[]> {
    if (![app,environment,userId].every(validText)) throw new Error('Invalid incident scope');
    const rows = await this.storage.statement({ mode:'all',sql:'SELECT DISTINCT incident_id FROM fulfillment_current WHERE app=? AND environment=? AND user_id=? AND episode_open=1 AND incident_id IS NOT NULL ORDER BY incident_id',
      params:[app,environment,userId] }) as { incident_id:string }[];
    return rows.map(row => row.incident_id);
  }

  async closeSuperseded(incidentId:string,key:FulfillmentKey,at:string):Promise<void> {
    if (![incidentId,key.app,key.environment,key.userId,key.store,key.accessLevel].every(validText)
        || !(key.transactionId === null || validText(key.transactionId)) || !Number.isFinite(parseTimestamp(at))) {
      throw new Error('Invalid superseded scope');
    }
    const identity = semanticDigest([key.app,key.environment,key.store,key.transactionId,key.userId,key.accessLevel]);
    await this.storage.statement({ mode:'run',sql:"UPDATE fulfillment_current SET status='superseded',reason='superseded_by_current_access',episode_open=0,updated_at=?,last_checked_at=?,last_checked_ms=? WHERE incident_id=? AND app=? AND environment=? AND user_id=? AND episode_open=1 AND identity_hash<>? AND last_checked_ms<=?",
      params:[at,at,parseTimestamp(at),incidentId,key.app,key.environment,key.userId,identity,parseTimestamp(at)] });
  }

  async openClaims(app:string,environment:string):Promise<{ incidentId:string; userId:string }[]> {
    if (![app,environment].every(validText)) throw new Error('Invalid incident scope');
    const rows = await this.storage.statement({ mode:'all',sql:'SELECT DISTINCT incident_id,user_id FROM fulfillment_current WHERE app=? AND environment=? AND episode_open=1 AND incident_id IS NOT NULL ORDER BY incident_id,user_id',
      params:[app,environment] }) as { incident_id:string; user_id:string }[];
    return rows.map(row => ({ incidentId:row.incident_id,userId:row.user_id }));
  }

  async list(app:string,environment:string,cursor:number,limit:number,status?:FulfillmentState):Promise<{
    items:unknown[]; total:number; next_cursor:string | null;
  }> {
    if (![app,environment].every(validText) || !Number.isSafeInteger(cursor) || cursor < 0
        || !Number.isInteger(limit) || limit < 1 || limit > 200
        || (status !== undefined && !['awaiting_application','verified_application','discrepancy','inconclusive','excluded','superseded'].includes(status))) {
      throw new Error('Invalid fulfillment page');
    }
    const filter = status === undefined ? '' : ' AND status=?';
    const params = status === undefined ? [app,environment] : [app,environment,status];
    const [rows,count] = await this.storage.transaction([
      { mode:'all',sql:`SELECT user_id,transaction_id,access_level,store,status,reason,episode_no,episode_open,incident_id,updated_at FROM fulfillment_current WHERE app=? AND environment=?${filter} ORDER BY updated_at DESC,identity_hash LIMIT ? OFFSET ?`,params:[...params,limit,cursor] },
      { mode:'get',sql:`SELECT COUNT(*) AS total FROM fulfillment_current WHERE app=? AND environment=?${filter}`,params }
    ]) as [{ user_id:string; transaction_id:string | null; access_level:string; store:string; status:FulfillmentState;
      reason:string; episode_no:number; episode_open:number; incident_id:string | null; updated_at:string }[],{ total:number }];
    const items = rows.map(row => ({ key:{ app,store:row.store,customer_id:row.user_id,transaction_id:row.transaction_id,
      access_level:row.access_level },status:row.status,reason:row.reason,episode_no:row.episode_no,
      episode_open:!!row.episode_open,incident_id:row.incident_id,updated_at:row.updated_at,telemetry_status:'unknown',
      stages:{ source_recorded:{ status:row.transaction_id ? 'recorded' : 'unknown' },
        application_applied:{ status:row.status === 'verified_application' ? 'applied' : 'unknown' },
        access_verified:{ status:row.status === 'verified_application' ? 'verified' : 'unknown' } },
      next_step:row.status === 'verified_application' ? 'No further action' : 'Review source and access evidence' }));
    return { items,total:Number(count.total),next_cursor:cursor+items.length < Number(count.total) ? String(cursor+items.length) : null };
  }
}
