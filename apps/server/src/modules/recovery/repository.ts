import { SQLiteStorage, type Statement } from '../../infrastructure/sqlite.js';
import { randomUUID } from 'node:crypto';
import { semanticDigest, semanticJson } from '../../infrastructure/json.js';
import { parseTimestamp } from '../../infrastructure/time.js';
import { validatePlanActions, type RecoveryPlan } from './preflight.js';
import type { ResyncRequest } from '../client/lumen-adapter.js';

export type ActionStatus = 'accepted' | 'verified' | 'failed' | 'unknown_outcome' | 'blocked' | 'awaiting_client_action';
const validId = (value: string): boolean => typeof value === 'string' && value.length > 0
  && value.length <= 256 && value === value.trim() && !/[\u0000-\u001f\u007f]/.test(value);
const validHash = (value: string): boolean => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const run = (sql: string, params: Statement['params'] = []): Statement => ({ sql, params, mode:'run' });
const get = (sql: string, params: Statement['params'] = []): Statement => ({ sql, params, mode:'get' });

interface Changes { changes: number | bigint }
interface ActionRow {
  operation_key: string;
  request_hash: string;
  incident_id: string;
  plan_id: string;
  status: ActionStatus;
  result_json: string | null;
}

/** Persistence only; authorization and fresh source checks belong to the engine. */
export class RecoveryRepository {
  constructor(private readonly storage: SQLiteStorage) {}

  async initialize(): Promise<void> {
    await this.storage.transaction([
      run('CREATE TABLE IF NOT EXISTS incidents (id TEXT PRIMARY KEY, app_id TEXT NOT NULL, environment TEXT NOT NULL, created_at TEXT NOT NULL)'),
      run('CREATE TABLE IF NOT EXISTS recovery_event_order (sequence INTEGER PRIMARY KEY, kind TEXT NOT NULL, reference INTEGER NOT NULL)'),
      run('CREATE INDEX IF NOT EXISTS recovery_event_reference ON recovery_event_order(kind,reference)'),
      run("CREATE TRIGGER IF NOT EXISTS incident_identity_immutable BEFORE UPDATE OF id,app_id,environment,created_at ON incidents BEGIN SELECT RAISE(ABORT,'Incident identity is immutable'); END"),
      run("CREATE TRIGGER IF NOT EXISTS incidents_no_delete BEFORE DELETE ON incidents BEGIN SELECT RAISE(ABORT,'Incidents are immutable history'); END"),
      run('CREATE TABLE IF NOT EXISTS incident_ownership (incident_id TEXT NOT NULL REFERENCES incidents(id), app_id TEXT NOT NULL, environment TEXT NOT NULL, user_id TEXT NOT NULL, acquired_at TEXT NOT NULL, released_at TEXT, PRIMARY KEY(incident_id,user_id))'),
      run('CREATE UNIQUE INDEX IF NOT EXISTS one_open_incident_per_account ON incident_ownership(app_id,environment,user_id) WHERE released_at IS NULL'),
      run("CREATE TRIGGER IF NOT EXISTS ownership_identity_immutable BEFORE UPDATE OF incident_id,app_id,environment,user_id,acquired_at ON incident_ownership BEGIN SELECT RAISE(ABORT,'Ownership identity is immutable'); END"),
      run("CREATE TRIGGER IF NOT EXISTS ownership_no_delete BEFORE DELETE ON incident_ownership BEGIN SELECT RAISE(ABORT,'Ownership history is immutable'); END"),
      run("CREATE TRIGGER IF NOT EXISTS ownership_release_immutable BEFORE UPDATE OF released_at ON incident_ownership WHEN OLD.released_at IS NOT NULL BEGIN SELECT RAISE(ABORT,'Released ownership is immutable'); END"),
      run("CREATE TABLE IF NOT EXISTS external_verifications (id TEXT PRIMARY KEY, incident_id TEXT NOT NULL REFERENCES incidents(id), user_id TEXT NOT NULL, transaction_id TEXT NOT NULL, source_fingerprint TEXT NOT NULL, entitlement_hash TEXT NOT NULL, identity_revision INTEGER NOT NULL, policy_revision INTEGER NOT NULL, projection_revision INTEGER NOT NULL, verified_at TEXT NOT NULL, kind TEXT NOT NULL CHECK(kind IN ('external','own_followup')))"),
      run('CREATE INDEX IF NOT EXISTS external_verification_incident ON external_verifications(incident_id,user_id)'),
      run("CREATE TRIGGER IF NOT EXISTS external_verification_order AFTER INSERT ON external_verifications BEGIN INSERT INTO recovery_event_order(kind,reference) VALUES('external',NEW.rowid); END"),
      run("CREATE TRIGGER IF NOT EXISTS external_verifications_no_update BEFORE UPDATE ON external_verifications BEGIN SELECT RAISE(ABORT,'External verification is immutable'); END"),
      run("CREATE TRIGGER IF NOT EXISTS external_verifications_no_delete BEFORE DELETE ON external_verifications BEGIN SELECT RAISE(ABORT,'External verification is immutable'); END"),
      run('CREATE TABLE IF NOT EXISTS snapshots (id TEXT PRIMARY KEY, incident_id TEXT NOT NULL REFERENCES incidents(id), snapshot_hash TEXT NOT NULL, snapshot_json TEXT NOT NULL, created_at TEXT NOT NULL)'),
      run('CREATE INDEX IF NOT EXISTS snapshot_incident ON snapshots(incident_id)'),
      run("CREATE TRIGGER IF NOT EXISTS snapshots_no_update BEFORE UPDATE ON snapshots BEGIN SELECT RAISE(ABORT,'Snapshots are immutable'); END"),
      run("CREATE TRIGGER IF NOT EXISTS snapshots_no_delete BEFORE DELETE ON snapshots BEGIN SELECT RAISE(ABORT,'Snapshots are immutable'); END"),
      run('CREATE TABLE IF NOT EXISTS recovery_plans (id TEXT PRIMARY KEY, incident_id TEXT NOT NULL REFERENCES incidents(id), snapshot_id TEXT NOT NULL REFERENCES snapshots(id), plan_hash TEXT NOT NULL, plan_json TEXT NOT NULL, created_at TEXT NOT NULL, expires_at TEXT NOT NULL, created_ms INTEGER NOT NULL, expires_ms INTEGER NOT NULL, UNIQUE(id,plan_hash))'),
      run('CREATE INDEX IF NOT EXISTS recovery_plan_incident ON recovery_plans(incident_id)'),
      run("CREATE TRIGGER IF NOT EXISTS recovery_plan_order AFTER INSERT ON recovery_plans BEGIN INSERT INTO recovery_event_order(kind,reference) VALUES('plan',NEW.rowid); END"),
      run("CREATE TRIGGER IF NOT EXISTS recovery_plans_no_update BEFORE UPDATE ON recovery_plans BEGIN SELECT RAISE(ABORT,'Plans are immutable'); END"),
      run("CREATE TRIGGER IF NOT EXISTS recovery_plans_no_delete BEFORE DELETE ON recovery_plans BEGIN SELECT RAISE(ABORT,'Plans are immutable'); END"),
      run('CREATE TABLE IF NOT EXISTS recovery_approvals (id TEXT PRIMARY KEY, plan_id TEXT NOT NULL, plan_hash TEXT NOT NULL, actor TEXT NOT NULL, created_at TEXT NOT NULL, FOREIGN KEY(plan_id,plan_hash) REFERENCES recovery_plans(id,plan_hash))'),
      run("CREATE TRIGGER IF NOT EXISTS recovery_approvals_no_update BEFORE UPDATE ON recovery_approvals BEGIN SELECT RAISE(ABORT,'Approvals are immutable'); END"),
      run("CREATE TRIGGER IF NOT EXISTS recovery_approvals_no_delete BEFORE DELETE ON recovery_approvals BEGIN SELECT RAISE(ABORT,'Approvals are immutable'); END"),
      run('CREATE TABLE IF NOT EXISTS automatic_attempts (incident_id TEXT NOT NULL REFERENCES incidents(id), attempt INTEGER NOT NULL CHECK(attempt IN (1,2)), plan_id TEXT NOT NULL UNIQUE REFERENCES recovery_plans(id), created_at TEXT NOT NULL, PRIMARY KEY(incident_id,attempt))'),
      run("CREATE TRIGGER IF NOT EXISTS automatic_attempts_no_update BEFORE UPDATE ON automatic_attempts BEGIN SELECT RAISE(ABORT,'Attempts are immutable'); END"),
      run("CREATE TRIGGER IF NOT EXISTS automatic_attempts_no_delete BEFORE DELETE ON automatic_attempts BEGIN SELECT RAISE(ABORT,'Attempts are immutable'); END"),
      run("CREATE TABLE IF NOT EXISTS recovery_actions (operation_key TEXT PRIMARY KEY, incident_id TEXT NOT NULL REFERENCES incidents(id), plan_id TEXT NOT NULL REFERENCES recovery_plans(id), request_hash TEXT NOT NULL, status TEXT NOT NULL CHECK(status IN ('accepted','verified','failed','unknown_outcome','blocked','awaiting_client_action')), result_json TEXT, updated_at TEXT NOT NULL)"),
      run('CREATE INDEX IF NOT EXISTS recovery_action_incident ON recovery_actions(incident_id,status,plan_id)'),
      run('CREATE TABLE IF NOT EXISTS action_history (sequence INTEGER PRIMARY KEY, operation_key TEXT NOT NULL REFERENCES recovery_actions(operation_key), status TEXT NOT NULL, result_json TEXT, occurred_at TEXT NOT NULL)'),
      run('CREATE INDEX IF NOT EXISTS action_history_operation ON action_history(operation_key,status,sequence)'),
      run("CREATE TRIGGER IF NOT EXISTS action_history_order AFTER INSERT ON action_history BEGIN INSERT INTO recovery_event_order(kind,reference) VALUES('action',NEW.sequence); END"),
      run("CREATE TRIGGER IF NOT EXISTS action_history_insert AFTER INSERT ON recovery_actions BEGIN INSERT INTO action_history(operation_key,status,result_json,occurred_at) VALUES(NEW.operation_key,NEW.status,NEW.result_json,NEW.updated_at); END"),
      run("CREATE TRIGGER IF NOT EXISTS action_history_transition AFTER UPDATE OF status ON recovery_actions WHEN NEW.status<>OLD.status BEGIN INSERT INTO action_history(operation_key,status,result_json,occurred_at) VALUES(NEW.operation_key,NEW.status,NEW.result_json,NEW.updated_at); END"),
      run("CREATE TRIGGER IF NOT EXISTS action_history_no_update BEFORE UPDATE ON action_history BEGIN SELECT RAISE(ABORT,'Action history is immutable'); END"),
      run("CREATE TRIGGER IF NOT EXISTS action_history_no_delete BEFORE DELETE ON action_history BEGIN SELECT RAISE(ABORT,'Action history is immutable'); END"),
      run("CREATE TRIGGER IF NOT EXISTS action_identity_immutable BEFORE UPDATE OF operation_key, incident_id, plan_id, request_hash ON recovery_actions BEGIN SELECT RAISE(ABORT,'Action identity is immutable'); END"),
      run("CREATE TRIGGER IF NOT EXISTS actions_no_delete BEFORE DELETE ON recovery_actions BEGIN SELECT RAISE(ABORT,'Actions are immutable history'); END")
    ]);
  }

  async createIncident(id: string, appId: string, environment: string, createdAt: string): Promise<void> {
    if (![id, appId, environment].every(validId) || !Number.isFinite(parseTimestamp(createdAt))) {
      throw new Error('Invalid incident');
    }
    await this.storage.statement(run('INSERT INTO incidents VALUES (?,?,?,?)', [id, appId, environment, createdAt]));
  }

  async acquireOwnership(incidentId:string, appId:string, environment:string, userId:string, at:string): Promise<boolean> {
    if (![incidentId,appId,environment,userId].every(validId) || !Number.isFinite(parseTimestamp(at))) throw new Error('Invalid ownership');
    const [,row] = await this.storage.transaction([
      run('INSERT INTO incident_ownership SELECT id,app_id,environment,?,?,NULL FROM incidents WHERE id=? AND app_id=? AND environment=? ON CONFLICT DO NOTHING',
        [userId,at,incidentId,appId,environment]),
      get('SELECT incident_id FROM incident_ownership WHERE app_id=? AND environment=? AND user_id=? AND released_at IS NULL',
        [appId,environment,userId])
    ]) as [Changes,{ incident_id:string } | null];
    return row?.incident_id === incidentId;
  }

  async ownedByAnother(appId:string, environment:string, userId:string, incidentId?:string): Promise<boolean> {
    if (![appId,environment,userId].every(validId) || (incidentId !== undefined && !validId(incidentId))) throw new Error('Invalid ownership scope');
    const row = await this.storage.statement(get('SELECT incident_id FROM incident_ownership WHERE app_id=? AND environment=? AND user_id=? AND released_at IS NULL',
      [appId,environment,userId])) as { incident_id:string } | null;
    return !!row && row.incident_id !== incidentId;
  }

  async acquirePlanOwnership(incidentId:string, appId:string, environment:string, planId:string, planHash:string,
    users:readonly string[], at:string): Promise<void> {
    if (![incidentId,appId,environment,planId,...users].every(validId) || !validHash(planHash) || !users.length || users.length > 10_000
        || new Set(users).size !== users.length || !Number.isFinite(parseTimestamp(at))) throw new Error('Invalid ownership');
    const saved = await this.readPlan(planId);
    const allowed = new Set(saved?.plan.targets.map(target => target.userId) ?? []);
    if (!saved || saved.hash !== planHash || users.some(userId => !allowed.has(userId))) throw new Error('Ownership is outside the plan');
    const authorization = 'EXISTS (SELECT 1 FROM recovery_plans p JOIN recovery_approvals a ON a.plan_id=p.id AND a.plan_hash=p.plan_hash WHERE p.id=? AND p.plan_hash=? AND p.incident_id=i.id AND p.created_ms<=? AND p.expires_ms>?)';
    const authorizedParams = [planId,planHash,parseTimestamp(at),parseTimestamp(at)] as const;
    const statements:Statement[] = [get(`SELECT id FROM incidents i WHERE id=? AND app_id=? AND environment=? AND ${authorization}`,
      [incidentId,appId,environment,...authorizedParams])];
    for (const userId of users) statements.push(run(`INSERT INTO incident_ownership SELECT id,app_id,environment,?,?,NULL FROM incidents i WHERE id=? AND app_id=? AND environment=? AND ${authorization} AND EXISTS (SELECT 1 FROM recovery_plans p,json_each(p.plan_json,'$.targets') t WHERE p.id=? AND json_extract(t.value,'$.userId')=?) AND NOT EXISTS (SELECT 1 FROM incident_ownership o WHERE o.incident_id=i.id AND o.user_id=? AND o.released_at IS NULL)`,
      [userId,at,incidentId,appId,environment,...authorizedParams,planId,userId,userId]));
    const results = await this.storage.transaction(statements) as [unknown,...unknown[]];
    if (!results[0]) throw new Error('Plan is not approved, expired or outside incident scope');
  }

  async releaseVerifiedOwnership(incidentId:string, userId:string, at:string): Promise<boolean> {
    if (![incidentId,userId].every(validId) || !Number.isFinite(parseTimestamp(at))) throw new Error('Invalid ownership release');
    const result = await this.storage.statement(run("UPDATE incident_ownership SET released_at=? WHERE incident_id=? AND user_id=? AND released_at IS NULL AND EXISTS (SELECT 1 FROM recovery_actions a JOIN recovery_plans p ON p.id=a.plan_id, json_each(p.plan_json,'$.actions') item WHERE a.incident_id=incident_ownership.incident_id AND a.status='verified' AND a.operation_key=json_extract(item.value,'$.operationKey') AND json_extract(item.value,'$.userId')=incident_ownership.user_id AND json_extract(item.value,'$.kind')='verify_gate')",
      [at,incidentId,userId])) as Changes;
    return Number(result.changes) === 1;
  }

  async hasOwnership(incidentId:string,userId:string):Promise<boolean> {
    if (![incidentId,userId].every(validId)) throw new Error('Invalid ownership');
    return !!await this.storage.statement(get('SELECT incident_id FROM incident_ownership WHERE incident_id=? AND user_id=? AND released_at IS NULL',[incidentId,userId]));
  }

  async hasAmbiguousWrite(incidentId:string,userId:string):Promise<boolean> {
    if (![incidentId,userId].every(validId)) throw new Error('Invalid action scope');
    return !!await this.storage.statement(get("SELECT a.operation_key FROM recovery_actions a JOIN recovery_plans p ON p.id=a.plan_id, json_each(p.plan_json,'$.actions') item WHERE a.incident_id=? AND a.status IN ('accepted','unknown_outcome') AND a.operation_key=json_extract(item.value,'$.operationKey') AND json_extract(item.value,'$.userId')=? AND json_extract(item.value,'$.kind')='resync_access' LIMIT 1",[incidentId,userId]));
  }

  async pendingWriteRequests(incidentId:string):Promise<ResyncRequest[]> {
    if (!validId(incidentId)) throw new Error('Invalid incident');
    const rows = await this.storage.statement({ mode:'all',sql:"SELECT DISTINCT plan_id FROM recovery_actions WHERE incident_id=? AND status IN ('accepted','unknown_outcome')",params:[incidentId] }) as { plan_id:string }[];
    const pending:ResyncRequest[] = [];
    for (const row of rows) {
      const saved = await this.readPlan(row.plan_id);
      if (!saved || saved.plan.incidentId !== incidentId) throw new Error('Action plan unavailable');
      for (const action of saved.plan.actions) if (action.kind === 'resync_access') {
        const state = await this.readAction(action.operationKey);
        if (state && ['accepted','unknown_outcome'].includes(state.status)) pending.push(action.request);
      }
    }
    return pending;
  }

  async hasPendingOwnVerification(incidentId:string,userId:string):Promise<boolean> {
    if (![incidentId,userId].every(validId)) throw new Error('Invalid action scope');
    const sql = `SELECT w.operation_key FROM recovery_actions w JOIN recovery_plans p ON p.id=w.plan_id,
      json_each(p.plan_json,'$.actions') write_action, json_each(p.plan_json,'$.actions') gate_action
      WHERE w.incident_id=? AND w.status='verified'
        AND w.operation_key=json_extract(write_action.value,'$.operationKey')
        AND json_extract(write_action.value,'$.kind')='resync_access' AND json_extract(write_action.value,'$.userId')=?
        AND json_extract(gate_action.value,'$.kind')='verify_gate' AND json_extract(gate_action.value,'$.userId')=?
        AND NOT EXISTS (SELECT 1 FROM recovery_actions g WHERE g.operation_key=json_extract(gate_action.value,'$.operationKey')
          AND g.status IN ('verified','failed','blocked','awaiting_client_action'))
        AND NOT EXISTS (SELECT 1 FROM recovery_actions verified JOIN recovery_plans vp ON vp.id=verified.plan_id,
          json_each(vp.plan_json,'$.actions') va WHERE verified.incident_id=w.incident_id AND verified.status='verified'
          AND verified.operation_key=json_extract(va.value,'$.operationKey') AND json_extract(va.value,'$.kind')='verify_gate'
          AND json_extract(va.value,'$.userId')=?
          AND (SELECT MAX(sequence) FROM action_history WHERE operation_key=verified.operation_key AND status='verified')
            > (SELECT MAX(sequence) FROM action_history WHERE operation_key=w.operation_key AND status='verified')) LIMIT 1`;
    return !!await this.storage.statement(get(sql,[incidentId,userId,userId,userId]));
  }

  async recordExternalVerification(incidentId:string,appId:string,environment:string,userId:string,transactionId:string,
    sourceFingerprint:string,entitlementHash:string,identityRevision:number,policyRevision:number,projectionRevision:number,
    at:string):Promise<boolean> {
    if (![incidentId,appId,environment,userId,transactionId].every(validId) || !validHash(sourceFingerprint) || !validHash(entitlementHash)
        || ![identityRevision,policyRevision,projectionRevision].every(value => Number.isSafeInteger(value) && value >= 1)
        || !Number.isFinite(parseTimestamp(at))) throw new Error('Invalid external verification');
    const id = randomUUID();
    const noAmbiguous = "NOT EXISTS (SELECT 1 FROM recovery_actions a JOIN recovery_plans p ON p.id=a.plan_id, json_each(p.plan_json,'$.actions') item WHERE a.incident_id=i.id AND a.status IN ('accepted','unknown_outcome') AND a.operation_key=json_extract(item.value,'$.operationKey') AND json_extract(item.value,'$.userId')=ctx.user_id AND json_extract(item.value,'$.kind')='resync_access')";
    const noPending = `NOT EXISTS (SELECT 1 FROM recovery_actions w JOIN recovery_plans p ON p.id=w.plan_id,
      json_each(p.plan_json,'$.actions') wa,json_each(p.plan_json,'$.actions') ga
      WHERE w.incident_id=i.id AND w.status='verified'
        AND w.operation_key=json_extract(wa.value,'$.operationKey') AND json_extract(wa.value,'$.kind')='resync_access'
        AND json_extract(wa.value,'$.userId')=ctx.user_id AND json_extract(ga.value,'$.kind')='verify_gate'
        AND json_extract(ga.value,'$.userId')=ctx.user_id
        AND NOT EXISTS (SELECT 1 FROM recovery_actions g WHERE g.operation_key=json_extract(ga.value,'$.operationKey')
          AND g.status IN ('verified','failed','blocked','awaiting_client_action'))
        AND NOT EXISTS (SELECT 1 FROM recovery_actions v JOIN recovery_plans vp ON vp.id=v.plan_id,json_each(vp.plan_json,'$.actions') va
          WHERE v.incident_id=w.incident_id AND v.status='verified' AND v.operation_key=json_extract(va.value,'$.operationKey')
            AND json_extract(va.value,'$.kind')='verify_gate' AND json_extract(va.value,'$.userId')=ctx.user_id
            AND (SELECT MAX(sequence) FROM action_history WHERE operation_key=v.operation_key AND status='verified')
              > (SELECT MAX(sequence) FROM action_history WHERE operation_key=w.operation_key AND status='verified')))`;
    // Keep incident selection ahead of event-order lookups; SQLite otherwise scans global history.
    const proofKind = `CASE WHEN EXISTS (SELECT 1 FROM recovery_actions g CROSS JOIN recovery_plans gp ON gp.id=g.plan_id,
      json_each(gp.plan_json,'$.actions') ga CROSS JOIN action_history gh ON gh.operation_key=g.operation_key AND gh.status='verified'
      CROSS JOIN recovery_event_order ge ON ge.kind='action' AND ge.reference=gh.sequence
      WHERE g.incident_id=i.id AND g.status='verified' AND g.operation_key=json_extract(ga.value,'$.operationKey')
        AND json_extract(ga.value,'$.kind')='verify_gate' AND json_extract(ga.value,'$.userId')=ctx.user_id
        AND NOT EXISTS (SELECT 1 FROM fulfillment_history f CROSS JOIN fulfillment_current fc ON fc.identity_hash=f.identity_hash
          CROSS JOIN recovery_event_order fe ON fe.kind='fulfillment' AND fe.reference=f.sequence
          WHERE f.incident_id=i.id AND fc.user_id=ctx.user_id AND f.status IN ('discrepancy','inconclusive','awaiting_application','excluded')
            AND fe.sequence>ge.sequence)) THEN 'own_followup' ELSE 'external' END`;
    const [inserted,,owner] = await this.storage.transaction([
      run(`INSERT INTO external_verifications SELECT ?,i.id,ctx.user_id,?,?,?,?,?,?,?,${proofKind} FROM incidents i CROSS JOIN (SELECT ? AS user_id) ctx
        WHERE i.id=? AND i.app_id=? AND i.environment=? AND ${noAmbiguous} AND ${noPending}
          AND NOT EXISTS (SELECT 1 FROM incident_ownership o WHERE o.app_id=i.app_id AND o.environment=i.environment
            AND o.user_id=ctx.user_id AND o.released_at IS NULL AND o.incident_id<>i.id) ON CONFLICT(id) DO NOTHING`,
        [id,transactionId,sourceFingerprint,entitlementHash,identityRevision,policyRevision,projectionRevision,at,userId,incidentId,appId,environment]),
      run('UPDATE incident_ownership SET released_at=? WHERE incident_id=? AND user_id=? AND released_at IS NULL AND changes()=1',
        [at,incidentId,userId]),
      get('SELECT incident_id FROM incident_ownership WHERE app_id=? AND environment=? AND user_id=? AND released_at IS NULL',
        [appId,environment,userId])
    ]) as [Changes,Changes,{ incident_id:string } | null];
    return Number(inserted.changes) === 1 && !owner;
  }

  async saveSnapshot(id: string, incidentId: string, payload: unknown, createdAt: string): Promise<string> {
    if (![id, incidentId].every(validId) || !Number.isFinite(parseTimestamp(createdAt))) throw new Error('Invalid snapshot');
    const json = semanticJson(payload), digest = semanticDigest(payload);
    await this.storage.statement(run('INSERT INTO snapshots VALUES (?,?,?,?,?)', [id, incidentId, digest, json, createdAt]));
    return digest;
  }

  async readSnapshot(id: string): Promise<{ incidentId: string; hash: string; payload: unknown } | null> {
    if (!validId(id)) throw new Error('Invalid snapshot');
    const row = await this.storage.statement(get('SELECT incident_id,snapshot_hash,snapshot_json FROM snapshots WHERE id=?', [id])) as
      { incident_id: string; snapshot_hash: string; snapshot_json: string } | null;
    if (!row) return null;
    const payload: unknown = JSON.parse(row.snapshot_json);
    if (semanticDigest(payload) !== row.snapshot_hash) throw new Error('Snapshot integrity check failed');
    return { incidentId:row.incident_id, hash:row.snapshot_hash, payload };
  }

  async savePlan(id: string, incidentId: string, snapshotId: string, payload: RecoveryPlan,
    createdAt: string, expiresAt: string): Promise<string> {
    const created = parseTimestamp(createdAt), expires = parseTimestamp(expiresAt);
    if (![id, incidentId, snapshotId].every(validId) || !Number.isFinite(created)
        || !Number.isFinite(expires) || expires <= created || expires - created > 300_000) throw new Error('Invalid plan');
    const snapshot = await this.readSnapshot(snapshotId);
    const snapshotPayload = snapshot?.payload && typeof snapshot.payload === 'object' && !Array.isArray(snapshot.payload)
      ? snapshot.payload as Record<string,unknown> : null;
    const incident = await this.storage.statement(get('SELECT app_id,environment FROM incidents WHERE id=?', [incidentId])) as
      { app_id: string; environment: string } | null;
    if (!snapshot || snapshot.incidentId !== incidentId || payload.id !== id
        || payload.incidentId !== incidentId || payload.snapshotId !== snapshotId
        || payload.snapshotHash !== snapshot.hash || payload.createdAt !== createdAt
        || payload.expiresAt !== expiresAt || !incident || payload.appId !== incident.app_id
        || payload.environment !== incident.environment || !Number.isSafeInteger(payload.policyRevision)
        || payload.policyRevision < 0 || !Array.isArray(payload.targets) || !payload.targets.length
        || payload.targets.length > 10_000 || payload.targets.some(target => !validId(target.userId))
        || new Set(payload.targets.map(target => target.userId)).size !== payload.targets.length
        || !Array.isArray(payload.actions) || !payload.actions.length || payload.actions.length > 20_000
        || payload.actions.some(action => !validId(action.operationKey) || !validHash(action.requestHash))
        || new Set(payload.actions.map(action => action.operationKey)).size !== payload.actions.length) {
      throw new Error('Plan does not match the snapshot or incident scope');
    }
    if (!snapshotPayload || snapshotPayload.appId !== payload.appId || snapshotPayload.environment !== payload.environment
        || !Array.isArray(snapshotPayload.targets)) throw new Error('Plan does not match snapshot evidence');
    const snapshotTargets = new Map<string,unknown>();
    for (const target of snapshotPayload.targets) {
      if (!target || typeof target !== 'object' || Array.isArray(target) || !('userId' in target)
          || typeof target.userId !== 'string' || snapshotTargets.has(target.userId)) {
        throw new Error('Invalid snapshot evidence');
      }
      snapshotTargets.set(target.userId,target);
    }
    if (payload.targets.some(target => !snapshotTargets.has(target.userId)
        || semanticJson(target) !== semanticJson(snapshotTargets.get(target.userId)))) {
      throw new Error('Plan does not match snapshot evidence');
    }
    validatePlanActions(payload);
    const json = semanticJson(payload), digest = semanticDigest(payload);
    await this.storage.statement(run('INSERT INTO recovery_plans VALUES (?,?,?,?,?,?,?,?,?)',
      [id, incidentId, snapshotId, digest, json, createdAt, expiresAt, created, expires]));
    return digest;
  }

  async readPlan(id: string): Promise<{ plan: RecoveryPlan; hash: string } | null> {
    if (!validId(id)) throw new Error('Invalid plan');
    const row = await this.storage.statement(get('SELECT plan_hash,plan_json FROM recovery_plans WHERE id=?', [id])) as
      { plan_hash: string; plan_json: string } | null;
    if (!row) return null;
    const plan = JSON.parse(row.plan_json) as RecoveryPlan;
    if (semanticDigest(plan) !== row.plan_hash) throw new Error('Plan integrity check failed');
    validatePlanActions(plan);
    return { plan, hash:row.plan_hash };
  }

  async latestPlan(incidentId:string):Promise<{ plan:RecoveryPlan; hash:string } | null> {
    if (!validId(incidentId)) throw new Error('Invalid incident');
    const row = await this.storage.statement(get('SELECT id FROM recovery_plans WHERE incident_id=? ORDER BY rowid DESC LIMIT 1',[incidentId])) as
      { id:string } | null;
    return row ? this.readPlan(row.id) : null;
  }

  async hasApproval(planId:string,planHash:string):Promise<boolean> {
    if (!validId(planId) || !validHash(planHash)) throw new Error('Invalid approval scope');
    return !!await this.storage.statement(get('SELECT id FROM recovery_approvals WHERE plan_id=? AND plan_hash=? LIMIT 1',[planId,planHash]));
  }

  async automaticAttemptCount(incidentId:string):Promise<number> {
    if (!validId(incidentId)) throw new Error('Invalid incident');
    const row = await this.storage.statement(get('SELECT COUNT(*) AS total FROM automatic_attempts WHERE incident_id=?',[incidentId])) as { total:number };
    return Number(row.total);
  }

  async approve(id: string, planId: string, planHash: string, actor: string, createdAt: string): Promise<void> {
    if (![id, planId, actor].every(validId) || !validHash(planHash)
        || !Number.isFinite(parseTimestamp(createdAt))) throw new Error('Invalid approval');
    const at = parseTimestamp(createdAt);
    const [, row] = await this.storage.transaction([
      run('INSERT INTO recovery_approvals SELECT ?,id,plan_hash,?,? FROM recovery_plans '
        + 'WHERE id=? AND plan_hash=? AND created_ms<=? AND expires_ms>? ON CONFLICT(id) DO NOTHING',
        [id, actor, createdAt, planId, planHash, at, at]),
      get('SELECT plan_id,plan_hash,actor,created_at FROM recovery_approvals WHERE id=?', [id])
    ]) as [Changes, { plan_id: string; plan_hash: string; actor: string; created_at: string } | null];
    if (!row) throw new Error('Plan is missing, changed or expired');
    if (row.plan_id !== planId || row.plan_hash !== planHash || row.actor !== actor || row.created_at !== createdAt) {
      throw new Error('Approval ID is bound to a different decision');
    }
  }

  async reserveAutomaticAttempt(incidentId:string, planId:string, at:string): Promise<number> {
    const ms = parseTimestamp(at);
    if (![incidentId,planId].every(validId) || !Number.isFinite(ms)) throw new Error('Invalid attempt');
    const [, row] = await this.storage.transaction([
      run('INSERT INTO automatic_attempts SELECT p.incident_id,(SELECT COUNT(*)+1 FROM automatic_attempts x WHERE x.incident_id=p.incident_id),p.id,? '
        + 'FROM recovery_plans p WHERE p.id=? AND p.incident_id=? AND p.created_ms<=? AND p.expires_ms>? '
        + 'AND (SELECT COUNT(*) FROM automatic_attempts x WHERE x.incident_id=p.incident_id)<2 '
        + 'AND EXISTS (SELECT 1 FROM recovery_approvals a WHERE a.plan_id=p.id AND a.plan_hash=p.plan_hash) '
        + 'ON CONFLICT(plan_id) DO NOTHING',[at,planId,incidentId,ms,ms]),
      get('SELECT incident_id,attempt FROM automatic_attempts WHERE plan_id=?',[planId])
    ]) as [Changes,{ incident_id:string; attempt:number } | null];
    if (!row || row.incident_id !== incidentId) throw new Error('Plan is not approved, expired or retry budget exhausted');
    return row.attempt;
  }

  async recordAction(operationKey: string, incidentId: string, planId: string,
    request: unknown, at: string): Promise<{ created: boolean; status: ActionStatus }> {
    if (![operationKey, incidentId, planId].every(validId) || !Number.isFinite(parseTimestamp(at))) {
      throw new Error('Invalid action');
    }
    const requestHash = semanticDigest(request);
    const atMs = parseTimestamp(at);
    const results = await this.storage.transaction([
      run('INSERT INTO recovery_actions SELECT ?,p.incident_id,p.id,?,\'accepted\',NULL,? '
        + 'FROM recovery_plans p WHERE p.id=? AND p.incident_id=? AND p.created_ms<=? AND p.expires_ms>? '
        + 'AND EXISTS (SELECT 1 FROM recovery_approvals a WHERE a.plan_id=p.id AND a.plan_hash=p.plan_hash) '
        + "AND EXISTS (SELECT 1 FROM json_each(p.plan_json,'$.actions') action JOIN incident_ownership owner "
        + "ON owner.incident_id=p.incident_id AND owner.user_id=json_extract(action.value,'$.userId') AND owner.released_at IS NULL "
        + "WHERE json_extract(action.value,'$.operationKey')=? AND json_extract(action.value,'$.requestHash')=?) "
        + 'ON CONFLICT(operation_key) DO NOTHING', [operationKey, requestHash, at, planId, incidentId, atMs, atMs,
          operationKey, requestHash]),
      get('SELECT * FROM recovery_actions WHERE operation_key=?', [operationKey])
    ]) as [Changes, ActionRow | null];
    const row = results[1];
    if (!row) throw new Error('Plan is not approved or has expired');
    if (row.request_hash !== requestHash || row.incident_id !== incidentId || row.plan_id !== planId) {
      throw new Error('Operation key is bound to a different action');
    }
    return { created:Number(results[0].changes) === 1, status:row.status };
  }

  async finishAction(operationKey: string, status: Exclude<ActionStatus, 'accepted'>,
    result: unknown, at: string): Promise<boolean> {
    if (!validId(operationKey) || !['verified','failed','unknown_outcome','blocked','awaiting_client_action'].includes(status)
        || !Number.isFinite(parseTimestamp(at)) || result === null || typeof result !== 'object' || Array.isArray(result)
        || (status === 'verified' && (!('evidence_ref' in result)
          || typeof result.evidence_ref !== 'string' || !result.evidence_ref.trim()))) {
      throw new Error('Invalid action result');
    }
    const resultJson = semanticJson(result);
    const hasEvidence = 'evidence_ref' in result && typeof result.evidence_ref === 'string' && !!result.evidence_ref.trim();
    const changed = await this.storage.statement(run(
      "UPDATE recovery_actions SET status=?,result_json=?,updated_at=? WHERE operation_key=? "
        + "AND (status='accepted' OR (status='unknown_outcome' AND (?='verified' OR (?='failed' AND ?=1 "
        + "AND EXISTS (SELECT 1 FROM recovery_plans p,json_each(p.plan_json,'$.actions') item WHERE p.id=recovery_actions.plan_id "
        + "AND json_extract(item.value,'$.operationKey')=recovery_actions.operation_key AND json_extract(item.value,'$.kind')='verify_gate')))))",
      [status, resultJson, at, operationKey, status, status, Number(hasEvidence)])) as Changes;
    return Number(changed.changes) === 1;
  }

  async readAction(operationKey: string): Promise<{ status: ActionStatus; result: unknown; requestHash: string;
    incidentId:string; planId:string } | null> {
    if (!validId(operationKey)) throw new Error('Invalid operation key');
    const row = await this.storage.statement(get('SELECT status,result_json,request_hash,incident_id,plan_id FROM recovery_actions WHERE operation_key=?',
      [operationKey])) as Pick<ActionRow, 'status' | 'result_json' | 'request_hash' | 'incident_id' | 'plan_id'> | null;
    return row ? { status:row.status, result:row.result_json === null ? null : JSON.parse(row.result_json) as unknown,
      requestHash:row.request_hash,incidentId:row.incident_id,planId:row.plan_id } : null;
  }

  async readActionHistory(operationKey:string): Promise<{ status:ActionStatus; result:unknown; occurredAt:string }[]> {
    if (!validId(operationKey)) throw new Error('Invalid operation key');
    const rows = await this.storage.statement({ mode:'all',sql:'SELECT status,result_json,occurred_at FROM action_history WHERE operation_key=? ORDER BY sequence',params:[operationKey] }) as
      { status:ActionStatus; result_json:string | null; occurred_at:string }[];
    return rows.map(row => ({ status:row.status,result:row.result_json === null ? null : JSON.parse(row.result_json) as unknown,
      occurredAt:row.occurred_at }));
  }
}
