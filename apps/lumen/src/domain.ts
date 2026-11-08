import { chmodSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { canonical, digest } from "@reconcile/server-sdk";

export const FEATURE = "premium_export";
const FAULT_MODES = new Set([
  "handler_precommit", "db_precommit", "cache_refresh_skipped",
  "timeout_after_commit", "delayed_older_update", "permanent_handler",
]);
const SCHEMA = `
  CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY,value TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS accounts(user_id TEXT PRIMARY KEY,provider_customer_id TEXT,identity_status TEXT NOT NULL,provenance TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS mappings(user_id TEXT PRIMARY KEY,provider_customer_id TEXT,status TEXT NOT NULL,revision INTEGER NOT NULL);
  CREATE TABLE IF NOT EXISTS policies(user_id TEXT PRIMARY KEY,feature TEXT NOT NULL,enabled INTEGER NOT NULL,revision INTEGER NOT NULL);
  CREATE TABLE IF NOT EXISTS access(user_id TEXT PRIMARY KEY,active INTEGER NOT NULL,expires_at TEXT,entitlement_hash TEXT,projection_revision INTEGER NOT NULL,cache_revision INTEGER NOT NULL,cache_active INTEGER NOT NULL,cache_expires_at TEXT,cache_entitlement_hash TEXT,cache_invalidated INTEGER NOT NULL,stale_once INTEGER NOT NULL,updated_at TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS actions(operation_key TEXT PRIMARY KEY,request_hash TEXT NOT NULL,result TEXT NOT NULL,created_at TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS processing_receipts(operation_key TEXT PRIMARY KEY,body_json TEXT NOT NULL,result_json TEXT NOT NULL,enqueued_at TEXT);
  CREATE TABLE IF NOT EXISTS live_fault_tags(user_id TEXT PRIMARY KEY,handler_version TEXT NOT NULL,config_version TEXT NOT NULL,occurred_at TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS live_handler_faults(user_id TEXT PRIMARY KEY,fault_mode TEXT NOT NULL,remaining_attempts INTEGER NOT NULL,permanent INTEGER NOT NULL,created_at TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS simulation_injections(operation_key TEXT PRIMARY KEY,request_hash TEXT NOT NULL,result_json TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS live_source_events(user_id TEXT NOT NULL,source_fingerprint TEXT NOT NULL,event_id TEXT NOT NULL,occurred_at TEXT NOT NULL,details_json TEXT NOT NULL,created_at TEXT NOT NULL,PRIMARY KEY(user_id,source_fingerprint));
  CREATE TABLE IF NOT EXISTS live_handler_results(processing_id TEXT PRIMARY KEY,user_id TEXT NOT NULL,transaction_id TEXT,source_fingerprint TEXT NOT NULL,outcome TEXT NOT NULL,result_json TEXT NOT NULL,recorded_at TEXT NOT NULL);
  CREATE INDEX IF NOT EXISTS live_handler_results_source ON live_handler_results(user_id,transaction_id,source_fingerprint,recorded_at DESC,processing_id DESC);
`;

export class LumenError extends Error {
  constructor(message: string, readonly status = 409) {
    super(message);
    this.name = "LumenError";
  }
}

export interface BootstrapProfile {
  user_id: string;
  provider_customer_id?: string;
  identity_match?: boolean;
  observed_at?: string;
  status: "active" | "inactive" | "unknown" | "missing";
  entitlement?: Record<string, unknown> | null;
  source_fingerprint?: string;
}

export interface ResyncBody extends Record<string, unknown> {
  user_id: string;
  entitlement: Record<string, string>;
  operation_key: string;
}

export function openDatabase(path: string): DatabaseSync {
  mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec("PRAGMA busy_timeout=15000; PRAGMA foreign_keys=ON; PRAGMA synchronous=FULL;");
  db.exec(SCHEMA);
  try { chmodSync(path, 0o600); } catch { /* Filesystems may not support mode changes. */ }
  return db;
}

export function readMeta(db: DatabaseSync, key: string, fallback?: unknown): unknown {
  const row = db.prepare("SELECT value FROM meta WHERE key=?").get(key) as { value: string } | undefined;
  return row ? JSON.parse(row.value) : fallback;
}

export function writeMeta(db: DatabaseSync, key: string, value: unknown): void {
  db.prepare("INSERT INTO meta(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value")
    .run(key, canonical(value));
}

export function initializeLumen(path: string, manifest: Record<string, unknown>, profiles: BootstrapProfile[], options: {
  live: boolean;
  pending?: boolean;
}): void {
  const db = openDatabase(path);
  try {
    if (readMeta(db, "initialized", false) === true) return;
    if (options.live && (manifest.customer_count !== 100 || profiles.length !== 100
        || profiles.some((profile) => !profile.observed_at || profile.identity_match !== true))) {
      throw new LumenError("Live Lumen bootstrap requires 100 observed matching profiles", 400);
    }
    db.exec("BEGIN IMMEDIATE");
    try {
      for (const [name, value] of Object.entries(manifest)) writeMeta(db, name, value);
      writeMeta(db, "scenario", options.live ? "live_adapty" : String(manifest.scenario ?? "stripe"));
      writeMeta(db, "scenario_now", manifest.scenario_now ?? new Date().toISOString());
      writeMeta(db, "logical_elapsed_seconds", 0);
      writeMeta(db, "live_bootstrap_pending", Boolean(options.pending));
      writeMeta(db, "live_handler_paused", Boolean(options.pending));
      const now = new Date().toISOString().replace(/\.\d{3}Z$/u, "Z");
      for (const profile of profiles) {
        const userId = profile.user_id;
        const customerId = profile.provider_customer_id ?? userId;
        const identity = customerId === userId && profile.identity_match !== false ? "mapped" : "unknown";
        const entitlement = profile.entitlement && typeof profile.entitlement === "object"
          ? profile.entitlement : profile as unknown as Record<string, unknown>;
        const active = !options.pending && profile.status === "active"
          && typeof entitlement.product_id === "string" && typeof entitlement.expires_at === "string";
        const expiresAt = active ? entitlement.expires_at as string : null;
        const entitlementHash = active && typeof entitlement.entitlement_hash === "string"
          ? entitlement.entitlement_hash : active ? digest({ user_id: userId, product_id: entitlement.product_id, expires_at: expiresAt }) : null;
        db.prepare("INSERT INTO accounts VALUES(?,?,?,?)").run(userId, customerId, identity, String(manifest.provenance ?? "synthetic"));
        db.prepare("INSERT INTO mappings VALUES(?,?,?,1)").run(userId, customerId, identity);
        db.prepare("INSERT INTO policies VALUES(?,?,1,1)").run(userId, FEATURE);
        db.prepare("INSERT INTO access VALUES(?,?,?,?,1,1,?,?,?,0,0,?)")
          .run(userId, Number(active), expiresAt, entitlementHash, Number(active), expiresAt, entitlementHash, now);
      }
      writeMeta(db, "initialized", true);
      db.exec("COMMIT");
    } catch (error) {
      rollback(db);
      throw error;
    }
  } finally {
    db.close();
  }
}

export function manifest(path: string): Record<string, unknown> {
  const db = openDatabase(path);
  try {
    const output: Record<string, unknown> = {};
    for (const row of db.prepare("SELECT key,value FROM meta").all() as { key: string; value: string }[]) {
      if (!["logical_elapsed_seconds", "last_advance_at", "initialized"].includes(row.key)) {
        output[row.key] = JSON.parse(row.value);
      }
    }
    return output;
  } finally { db.close(); }
}

function appNow(db: DatabaseSync): number {
  if (readMeta(db, "scenario") === "live_adapty") return Date.now();
  const base = Date.parse(String(readMeta(db, "scenario_now", "")));
  const elapsed = Number(readMeta(db, "logical_elapsed_seconds", 0));
  if (!Number.isFinite(base) || !Number.isSafeInteger(elapsed) || elapsed < 0) throw new LumenError("Invalid Lumen clock state", 500);
  return base + elapsed * 1000;
}

function gate(db: DatabaseSync, userId: string): Record<string, unknown> {
  const account = db.prepare("SELECT user_id FROM accounts WHERE user_id=?").get(userId);
  if (!account) throw new LumenError("Unknown account", 404);
  const mapping = db.prepare("SELECT * FROM mappings WHERE user_id=?").get(userId) as
    { status: string; revision: number } | undefined;
  const access = db.prepare("SELECT * FROM access WHERE user_id=?").get(userId) as
    { active: number; expires_at: string | null; entitlement_hash: string | null; projection_revision: number;
      cache_revision: number; cache_active: number; cache_expires_at: string | null; cache_invalidated: number } | undefined;
  const policy = db.prepare("SELECT * FROM policies WHERE user_id=?").get(userId) as
    { feature: string; enabled: number; revision: number } | undefined;
  if (!mapping || !access || !policy) throw new LumenError("Lumen account state is incomplete", 500);
  const revisions = { projection_revision: access.projection_revision, cache_revision: access.cache_revision };
  if (mapping.status !== "mapped") return { allowed: false, reason: "identity_unavailable", ...revisions };
  if (!policy.enabled || policy.feature !== FEATURE) return { allowed: false, reason: "policy_restricted", ...revisions };
  if (access.cache_invalidated || access.cache_revision !== access.projection_revision) {
    return { allowed: false, reason: "cache_stale", ...revisions };
  }
  if (!access.cache_expires_at || Date.parse(access.cache_expires_at) <= appNow(db)) {
    return { allowed: false, reason: "subscription_expired", ...revisions };
  }
  if (!access.cache_active) return { allowed: false, reason: "subscription_inactive", ...revisions };
  return { allowed: true, reason: "allowed", ...revisions };
}

export function access(path: string, userId: string): Record<string, unknown> {
  const db = openDatabase(path);
  try {
    const row = db.prepare("SELECT * FROM access WHERE user_id=?").get(userId) as
      { active: number; expires_at: string | null; entitlement_hash: string | null } | undefined;
    const mapping = db.prepare("SELECT revision FROM mappings WHERE user_id=?").get(userId) as { revision: number } | undefined;
    const policy = db.prepare("SELECT revision FROM policies WHERE user_id=?").get(userId) as { revision: number } | undefined;
    if (!row || !mapping || !policy) throw new LumenError("Unknown account", 404);
    return { ...gate(db, userId), user_id: userId, active: Boolean(row.active), expires_at: row.expires_at,
      entitlement_hash: row.entitlement_hash, identity_revision: mapping.revision, policy_revision: policy.revision };
  } finally { db.close(); }
}

export function accounts(path: string, cursor: string | null, limit: number): Record<string, unknown> {
  if (!Number.isInteger(limit) || limit < 1 || limit > 1000 || (cursor !== null && !/^\d+$/u.test(cursor))) {
    throw new LumenError("Invalid account page", 400);
  }
  const offset = cursor === null ? 0 : Number(cursor);
  if (!Number.isSafeInteger(offset)) throw new LumenError("Invalid account cursor", 400);
  const db = openDatabase(path);
  try {
    const ids = db.prepare("SELECT user_id FROM accounts ORDER BY user_id LIMIT ? OFFSET ?").all(limit, offset) as { user_id: string }[];
    const items = ids.map(({ user_id: userId }) => {
      const account = db.prepare("SELECT * FROM accounts WHERE user_id=?").get(userId) as Record<string, unknown>;
      const mapping = db.prepare("SELECT * FROM mappings WHERE user_id=?").get(userId) as { status: string; revision: number };
      const policy = db.prepare("SELECT * FROM policies WHERE user_id=?").get(userId) as { enabled: number; revision: number };
      const state = db.prepare("SELECT * FROM access WHERE user_id=?").get(userId) as
        { active: number; expires_at: string | null; entitlement_hash: string | null; projection_revision: number; cache_revision: number };
      const result: Record<string, unknown> = { user_id: userId, provider_customer_id: account.provider_customer_id,
        identity_status: mapping.status, identity_revision: mapping.revision, policy_enabled: Boolean(policy.enabled),
        policy_revision: policy.revision, gate: gate(db, userId), projection_revision: state.projection_revision,
        cache_revision: state.cache_revision, access_active: Boolean(state.active), access_expires_at: state.expires_at,
        entitlement_hash: state.entitlement_hash };
      const tag = db.prepare("SELECT handler_version,config_version,occurred_at FROM live_fault_tags WHERE user_id=?").get(userId);
      if (tag) result.delivery_signature = tag;
      return result;
    });
    const total = Number((db.prepare("SELECT COUNT(*) AS total FROM accounts").get() as { total: number }).total);
    return { items, next_cursor: offset + items.length < total ? String(offset + items.length) : null, total };
  } finally { db.close(); }
}

export function action(path: string, operationKey: string): Record<string, unknown> | null {
  const db = openDatabase(path);
  try {
    const row = db.prepare("SELECT result FROM actions WHERE operation_key=?").get(operationKey) as { result: string } | undefined;
    return row ? JSON.parse(row.result) as Record<string, unknown> : null;
  } finally { db.close(); }
}

function validId(value: unknown, max = 256): value is string {
  return typeof value === "string" && !!value && value.length <= max && value.trim() === value
    && !/[\u0000-\u001f\u007f]/u.test(value);
}

function exactKeys(value: Record<string, unknown>, allowed: Set<string>): boolean {
  return Object.keys(value).length === allowed.size && Object.keys(value).every((key) => allowed.has(key));
}

export function validateResync(body: unknown): asserts body is ResyncBody {
  if (!body || typeof body !== "object" || Array.isArray(body)) throw new LumenError("Resync fields do not match the contract", 400);
  const value = body as Record<string, unknown>;
  const version = Object.hasOwn(value, "schema_version") ? value.schema_version : 1;
  const v1 = new Set(["user_id", "expected_revision", "entitlement", "operation_key"]);
  const v2 = new Set(["schema_version", "user_id", "expected_provider_customer_id", "expected_identity_revision",
    "expected_policy_revision", "expected_projection_revision", "entitlement", "operation_key", "processing_id", "trace_id"]);
  if (version === 1 ? !exactKeys(value, v1) : version === 2 ? !exactKeys(value, v2) : true) {
    throw new LumenError("Resync fields do not match the contract", 400);
  }
  if (!validId(value.user_id)) throw new LumenError("Invalid user_id", 400);
  if (typeof value.operation_key !== "string") throw new LumenError("Invalid operation_key", 400);
  const revision = value.expected_projection_revision ?? value.expected_revision;
  const identityRevision = value.expected_identity_revision;
  const policyRevision = value.expected_policy_revision;
  if (!Number.isSafeInteger(revision) || Number(revision) < 1) throw new LumenError("Invalid expected_revision", 400);
  if (version === 2 && (!validId(value.expected_provider_customer_id) || !validId(value.processing_id)
      || !validId(value.trace_id) || !Number.isSafeInteger(identityRevision) || Number(identityRevision) < 1
      || !Number.isSafeInteger(policyRevision) || Number(policyRevision) < 1)) {
    throw new LumenError("Invalid v2 resync metadata", 400);
  }
  const entitlement = value.entitlement;
  const required = new Set(["product_id", "expires_at", "entitlement_hash", "transaction_id"]);
  const optional = new Set(["source_fingerprint", "original_transaction_id", "store", "source_environment"]);
  if (!entitlement || typeof entitlement !== "object" || Array.isArray(entitlement)) throw new LumenError("Invalid entitlement", 400);
  const details = entitlement as Record<string, unknown>;
  if ([...required].some((key) => typeof details[key] !== "string" || !details[key])
      || Object.keys(details).some((key) => !required.has(key) && !optional.has(key))
      || (version === 1 && Object.keys(details).length !== required.size
        && !(Object.keys(details).length === required.size + 1 && "source_fingerprint" in details))) {
    throw new LumenError("Invalid entitlement", 400);
  }
  for (const key of optional) if (key in details && (typeof details[key] !== "string" || !details[key])) {
    throw new LumenError("Invalid entitlement", 400);
  }
  if ("source_fingerprint" in details && !/^[a-f0-9]{64}$/u.test(String(details.source_fingerprint))) {
    throw new LumenError("Invalid source fingerprint", 400);
  }
  if (!isTimestamp(details.expires_at)
      || digest({ user_id: value.user_id, product_id: details.product_id, expires_at: details.expires_at }) !== details.entitlement_hash) {
    throw new LumenError("Invalid entitlement hash or expiry", 400);
  }
}

function isTimestamp(value: unknown): value is string {
  return typeof value === "string" && /(?:Z|[+-]\d{2}:\d{2})$/u.test(value) && Number.isFinite(Date.parse(value));
}

export function resync(path: string, body: ResyncBody, live: boolean): Record<string, unknown> {
  const version = Object.hasOwn(body, "schema_version") ? body.schema_version : 1;
  const entitlement = body.entitlement as Record<string, string>;
  if (live && (version !== 2 || !entitlement.source_fingerprint || !entitlement.store || !entitlement.source_environment
      || !entitlement.transaction_id)) throw new LumenError("Live resync requires v2 source binding", 409);
  if (!live && (version !== 1 || entitlement.source_fingerprint)) throw new LumenError("Source fingerprint is live-only", 409);
  const db = openDatabase(path);
  try {
    db.exec("BEGIN IMMEDIATE");
    try {
      const existing = db.prepare("SELECT request_hash,result FROM actions WHERE operation_key=?").get(body.operation_key) as
        { request_hash: string; result: string } | undefined;
      const requestHash = digest(body);
      if (existing) {
        if (existing.request_hash !== requestHash) throw new LumenError("Operation key already has a different request", 409);
        db.exec("COMMIT");
        return { ...JSON.parse(existing.result) as Record<string, unknown>, duplicate: true };
      }
      const userId = body.user_id;
      const account = db.prepare("SELECT * FROM accounts WHERE user_id=?").get(userId) as Record<string, unknown> | undefined;
      const mapping = db.prepare("SELECT * FROM mappings WHERE user_id=?").get(userId) as
        { provider_customer_id: string; status: string; revision: number } | undefined;
      const policy = db.prepare("SELECT * FROM policies WHERE user_id=?").get(userId) as
        { feature: string; enabled: number; revision: number } | undefined;
      const state = db.prepare("SELECT * FROM access WHERE user_id=?").get(userId) as
        { active: number; expires_at: string | null; entitlement_hash: string | null; projection_revision: number;
          cache_revision: number; cache_active: number; cache_expires_at: string | null;
          cache_entitlement_hash: string | null; cache_invalidated: number; stale_once: number } | undefined;
      if (!account || !mapping || mapping.status !== "mapped") throw new LumenError("Lumen identity is not mapped", 409);
      if (!policy?.enabled || policy.feature !== FEATURE) throw new LumenError("Lumen policy blocks this feature", 409);
      if (version === 2 && (account.provider_customer_id !== body.expected_provider_customer_id
          || mapping.provider_customer_id !== body.expected_provider_customer_id
          || mapping.revision !== body.expected_identity_revision || policy.revision !== body.expected_policy_revision)) {
        throw new LumenError("Lumen identity or policy revision changed", 409);
      }
      if (!state) throw new LumenError("Unknown account", 404);
      const expectedProjection = Number(version === 2 ? body.expected_projection_revision : body.expected_revision);
      if (state.projection_revision !== expectedProjection) throw new LumenError("Lumen access revision changed", 409);
      const expiresAt = isTimestamp(entitlement.expires_at) ? Date.parse(entitlement.expires_at) : Number.NaN;
      if (!Number.isFinite(expiresAt) || expiresAt <= appNow(db)) throw new LumenError("Entitlement is expired", 409);
      const now = new Date(appNow(db));
      now.setUTCMilliseconds(0);
      const processedAt = now.toISOString().replace(/\.000Z$/u, "Z");
      const nextRevision = state.projection_revision + 1;
      const skipCache = Boolean(state.stale_once);
      const expiresAtText = entitlement.expires_at!;
      const entitlementHash = entitlement.entitlement_hash!;
      const before = { active: Boolean(state.active), premium: Boolean(state.active), expires_at: state.expires_at,
        projection_revision: state.projection_revision, cache_revision: state.cache_revision,
        source_hash: state.entitlement_hash, invalidated: Boolean(state.cache_invalidated) };
      if (skipCache) {
        db.prepare("UPDATE access SET active=1,expires_at=?,entitlement_hash=?,projection_revision=?,stale_once=0,cache_invalidated=1,updated_at=? WHERE user_id=?")
          .run(expiresAtText, entitlementHash, nextRevision, processedAt, userId);
      } else {
        db.prepare("UPDATE access SET active=1,expires_at=?,entitlement_hash=?,projection_revision=?,cache_revision=?,cache_active=1,cache_expires_at=?,cache_entitlement_hash=?,cache_invalidated=0,updated_at=? WHERE user_id=?")
          .run(expiresAtText, entitlementHash, nextRevision, nextRevision,
            expiresAtText, entitlementHash, processedAt, userId);
      }
      const cacheRevision = skipCache ? state.cache_revision : nextRevision;
      const sourceHash = entitlement.source_fingerprint ?? entitlement.entitlement_hash;
      const after = { active: true, premium: true, expires_at: entitlement.expires_at,
        projection_revision: nextRevision, cache_revision: cacheRevision,
        source_hash: sourceHash, invalidated: skipCache };
      const result: Record<string, unknown> = {
        accepted: true, user_id: userId, projection_revision: nextRevision,
        cache_revision: cacheRevision, cache_skipped: skipCache, operation_key: body.operation_key,
        processed_at: processedAt,
      };
      if (live) Object.assign(result, { before, after, source_hash: sourceHash,
        policy_version: "premium-policy-v1", adapter_version: "adapty-profile-read-v1",
        projection_version: readMeta(db, "live_handler_version", "lumen-handler-v2"),
        config_version: readMeta(db, "live_config_version", "premium-export-v2") });
      if (version === 2) Object.assign(result, {
        schema_version: 2, transaction_id: entitlement.transaction_id,
        original_transaction_id: entitlement.original_transaction_id ?? null,
        processing_id: body.processing_id, trace_id: body.trace_id,
        revisions: { identity: mapping.revision, policy: policy.revision, projection: nextRevision, cache: cacheRevision },
        steps: [
          { name: "receive", status: "completed", owner: "lumen", result: "accepted" },
          { name: "handler", status: "completed", owner: "lumen", result: "verified" },
          { name: "projection_commit", status: "completed", owner: "lumen", result: "committed", revision: nextRevision },
          { name: "cache_refresh", status: skipCache ? "skipped" : "completed", owner: "lumen",
            result: skipCache ? "skipped" : "committed", revision: cacheRevision },
        ],
      });
      db.prepare("DELETE FROM live_fault_tags WHERE user_id=?").run(userId);
      db.prepare("INSERT INTO actions VALUES(?,?,?,?)").run(body.operation_key, requestHash, canonical(result), processedAt);
      if (live && version === 2) {
        db.prepare("INSERT INTO processing_receipts VALUES(?,?,?,NULL)")
          .run(body.operation_key,canonical(body),canonical(result));
      }
      db.exec("COMMIT");
      return { ...result, duplicate: false };
    } catch (error) {
      rollback(db);
      throw error;
    }
  } finally { db.close(); }
}

export function pendingReceipts(path:string, limit = 25): { operationKey:string; body:ResyncBody; result:Record<string,unknown> }[] {
  const db = openDatabase(path);
  try {
    const rows = db.prepare('SELECT operation_key,body_json,result_json FROM processing_receipts WHERE enqueued_at IS NULL ORDER BY rowid LIMIT ?').all(limit) as
      { operation_key:string; body_json:string; result_json:string }[];
    return rows.map(row => ({ operationKey:row.operation_key,body:JSON.parse(row.body_json) as ResyncBody,
      result:JSON.parse(row.result_json) as Record<string,unknown> }));
  } finally { db.close(); }
}

export function markReceiptEnqueued(path:string, operationKey:string, at:string): void {
  const db = openDatabase(path);
  try { db.prepare('UPDATE processing_receipts SET enqueued_at=? WHERE operation_key=? AND enqueued_at IS NULL').run(at,operationKey); }
  finally { db.close(); }
}

export function receiptBacklog(path:string): number {
  const db = openDatabase(path);
  try { return Number((db.prepare('SELECT COUNT(*) AS total FROM processing_receipts WHERE enqueued_at IS NULL').get() as { total:number }).total); }
  finally { db.close(); }
}

export function configureSimulation(path: string, faults: unknown, paused: unknown, projectionLoss: unknown): Record<string, unknown> {
  if (typeof paused !== "boolean" || !Array.isArray(faults) || faults.length > 100
      || faults.some((item) => !item || typeof item !== "object" || Array.isArray(item)
        || Object.keys(item).length !== 4 || !validId((item as Record<string, unknown>).user_id)
        || !FAULT_MODES.has(String((item as Record<string, unknown>).fault_mode))
        || !Number.isSafeInteger((item as Record<string, unknown>).remaining_attempts)
        || Number((item as Record<string, unknown>).remaining_attempts) < 1
        || typeof (item as Record<string, unknown>).permanent !== "boolean")
      || new Set(faults.map((item) => (item as Record<string, unknown>).user_id)).size !== faults.length
      || !Array.isArray(projectionLoss) || projectionLoss.length > 100
      || projectionLoss.some((item) => !validId(item))
      || new Set(projectionLoss).size !== projectionLoss.length) throw new LumenError("Invalid live simulation handler faults", 400);
  const db = openDatabase(path);
  try {
    db.exec("BEGIN IMMEDIATE");
    if (readMeta(db, "scenario") !== "live_adapty" || !readMeta(db, "live_bootstrap_pending", false)) {
      throw new LumenError("Live simulation controls require pending demo bootstrap", 404);
    }
    const now = new Date().toISOString();
    for (const userId of projectionLoss as string[]) {
      if (!gate(db, userId).allowed) throw new LumenError("Projection loss requires a healthy account", 409);
      const state = db.prepare("SELECT projection_revision FROM access WHERE user_id=?").get(userId) as { projection_revision: number };
      const revision = state.projection_revision + 1;
      db.prepare("UPDATE access SET active=0,projection_revision=?,cache_revision=?,cache_active=0,cache_invalidated=0,updated_at=? WHERE user_id=?")
        .run(revision, revision, now, userId);
    }
    for (const item of faults as Record<string, unknown>[]) {
      const userId = item.user_id as string;
      const faultMode = item.fault_mode as string;
      const remainingAttempts = item.remaining_attempts as number;
      db.prepare("INSERT INTO live_handler_faults VALUES(?,?,?,?,?) ON CONFLICT(user_id) DO UPDATE SET fault_mode=excluded.fault_mode,remaining_attempts=excluded.remaining_attempts,permanent=excluded.permanent,created_at=excluded.created_at")
        .run(userId, faultMode, remainingAttempts, Number(item.permanent), now);
    }
    writeMeta(db, "live_handler_paused", paused);
    db.exec("COMMIT");
    return { configured_faults: faults.length, prepared_projection_losses: projectionLoss.length, paused };
  } catch (error) {
    rollback(db);
    throw error;
  } finally { db.close(); }
}

export function takeFault(path: string, userId: string): string | null {
  const db = openDatabase(path);
  try {
    db.exec("BEGIN IMMEDIATE");
    const row = db.prepare("SELECT * FROM live_handler_faults WHERE user_id=?").get(userId) as
      { fault_mode: string; remaining_attempts: number; permanent: number } | undefined;
    if (!row) { db.exec("COMMIT"); return null; }
    if (!row.permanent) {
      if (row.remaining_attempts <= 1) db.prepare("DELETE FROM live_handler_faults WHERE user_id=?").run(userId);
      else db.prepare("UPDATE live_handler_faults SET remaining_attempts=? WHERE user_id=?").run(row.remaining_attempts - 1, userId);
    }
    db.exec("COMMIT");
    return row.fault_mode;
  } catch (error) { rollback(db); throw error; }
  finally { db.close(); }
}

export function liveFaultStatus(path: string): Record<string, unknown> {
  const db = openDatabase(path);
  try {
    if (readMeta(db, "scenario") !== "live_adapty") throw new LumenError("Live status requires live scenario", 404);
    return { injected: Boolean(readMeta(db, "live_fault_injected", false)),
      fault_kind: readMeta(db, "live_fault_kind", null), account_count: readMeta(db, "live_fault_account_count", 0),
      handler_version: readMeta(db, "live_fault_handler_version", null), config_version: readMeta(db, "live_fault_config_version", null),
      occurred_at: readMeta(db, "live_fault_occurred_at", null) };
  } finally { db.close(); }
}

export function markCacheRefreshSkipped(path: string, userId: string): void {
  const db = openDatabase(path);
  try {
    db.prepare("UPDATE access SET stale_once=1 WHERE user_id=?").run(userId);
  } finally { db.close(); }
}

export function sourceEvent(path: string, profile: Record<string, unknown>, eventId: string,
  occurredAt: string, details: Record<string, unknown>): Record<string, unknown> {
  const userId = profile.user_id;
  const fingerprint = profile.source_fingerprint;
  if (!validId(userId) || typeof fingerprint !== "string" || !/^[a-f0-9]{64}$/u.test(fingerprint)
      || !validId(eventId) || !Number.isFinite(Date.parse(occurredAt))) throw new LumenError("Invalid source event binding", 400);
  const db = openDatabase(path);
  try {
    db.exec("BEGIN IMMEDIATE");
    const previous = db.prepare("SELECT event_id,occurred_at,details_json FROM live_source_events WHERE user_id=? AND source_fingerprint=?")
      .get(userId, fingerprint) as { event_id: string; occurred_at: string; details_json: string } | undefined;
    if (previous) {
      db.exec("COMMIT");
      return { event_id: previous.event_id, occurred_at: previous.occurred_at, details: JSON.parse(previous.details_json) };
    }
    const record = { event_id: eventId, occurred_at: occurredAt, details };
    db.prepare("INSERT INTO live_source_events VALUES(?,?,?,?,?,?)")
      .run(userId, fingerprint, eventId, occurredAt, canonical(details), new Date().toISOString());
    db.exec("COMMIT");
    return record;
  } catch (error) { rollback(db); throw error; }
  finally { db.close(); }
}

export function actionByProcessing(path: string, processingId: string): Record<string, unknown> | null {
  const db = openDatabase(path);
  try {
    for (const row of db.prepare("SELECT result FROM actions ORDER BY created_at DESC").all() as { result: string }[]) {
      try {
        const result = JSON.parse(row.result) as Record<string, unknown>;
        if (result.processing_id === processingId) return { processing_id: processingId, outcome: "committed_readback", result };
      } catch { /* Ignore malformed historical rows, matching the Python reader. */ }
    }
    return { processing_id: processingId, outcome: "unknown" };
  } finally { db.close(); }
}

export interface LiveHandlerResult {
  processing_id: string;
  user_id: string;
  transaction_id: string | null;
  source_fingerprint: string;
  outcome: string;
  result: Record<string, unknown>;
  recorded_at: string;
}

export function liveHandlerResult(path: string, processingId: string): LiveHandlerResult | null {
  const db = openDatabase(path);
  try {
    const row = db.prepare("SELECT * FROM live_handler_results WHERE processing_id=?").get(processingId) as
      { processing_id: string; user_id: string; transaction_id: string | null; source_fingerprint: string;
        outcome: string; result_json: string; recorded_at: string } | undefined;
    if (!row) return null;
    return { ...row, result: JSON.parse(row.result_json) as Record<string, unknown> };
  } finally { db.close(); }
}

export function saveLiveHandlerResult(path: string, input: LiveHandlerResult): LiveHandlerResult {
  if (!validId(input.processing_id) || !validId(input.user_id)
      || !(input.transaction_id === null || validId(input.transaction_id))
      || !/^[a-f0-9]{64}$/u.test(input.source_fingerprint) || !validId(input.outcome)
      || !isTimestamp(input.recorded_at) || !input.result || typeof input.result !== "object" || Array.isArray(input.result)) {
    throw new LumenError("Invalid handler processing result", 400);
  }
  const db = openDatabase(path);
  try {
    db.exec("BEGIN IMMEDIATE");
    const existing = db.prepare("SELECT * FROM live_handler_results WHERE processing_id=?").get(input.processing_id) as
      { processing_id: string; user_id: string; transaction_id: string | null; source_fingerprint: string;
        outcome: string; result_json: string; recorded_at: string } | undefined;
    if (existing) {
      if (existing.user_id !== input.user_id || existing.transaction_id !== input.transaction_id
          || existing.source_fingerprint !== input.source_fingerprint) {
        throw new LumenError("Processing ID is already bound to different source evidence", 409);
      }
      db.exec("COMMIT");
      return { ...existing, result: JSON.parse(existing.result_json) as Record<string, unknown> };
    }
    db.prepare("INSERT INTO live_handler_results VALUES(?,?,?,?,?,?,?)")
      .run(input.processing_id, input.user_id, input.transaction_id, input.source_fingerprint,
        input.outcome, canonical(input.result), input.recorded_at);
    db.exec("COMMIT");
    return input;
  } catch (error) { rollback(db); throw error; }
  finally { db.close(); }
}

export function liveHandlerResults(path: string, cursor: string | null, limit: number): Record<string, unknown> {
  if (!Number.isInteger(limit) || limit < 1 || limit > 1000
      || cursor !== null && cursor !== "" && !/^\d+$/u.test(cursor)) {
    throw new LumenError("Invalid handler result page", 400);
  }
  const offset = cursor ? Number(cursor) : 0;
  if (!Number.isSafeInteger(offset)) throw new LumenError("Invalid handler result cursor", 400);
  const latest = " FROM live_handler_results h WHERE NOT EXISTS (SELECT 1 FROM live_handler_results newer "
    + "WHERE newer.user_id=h.user_id AND newer.transaction_id IS h.transaction_id "
    + "AND newer.source_fingerprint=h.source_fingerprint AND (newer.recorded_at>h.recorded_at "
    + "OR (newer.recorded_at=h.recorded_at AND newer.processing_id>h.processing_id)))";
  const db = openDatabase(path);
  try {
    const total = Number((db.prepare("SELECT COUNT(*) AS count" + latest).get() as { count: number }).count);
    const rows = db.prepare("SELECT h.*" + latest
      + " ORDER BY h.user_id,h.transaction_id,h.source_fingerprint LIMIT ? OFFSET ?").all(limit, offset) as
      { processing_id: string; user_id: string; transaction_id: string | null; source_fingerprint: string;
        outcome: string; result_json: string; recorded_at: string }[];
    const items = rows.map(({ result_json, ...row }) => ({ ...row,
      result: JSON.parse(result_json) as Record<string, unknown> }));
    const nextCursor = offset + items.length < total ? String(offset + items.length) : null;
    return { items, cursor: String(offset), limit, next_cursor: nextCursor, total,
      pagination: { cursor: String(offset), limit, next_cursor: nextCursor, total } };
  } finally { db.close(); }
}

export function injectLiveFault(path: string, userIds: unknown, handlerVersion: unknown,
  configVersion: unknown, occurredAt: unknown, faultKind: unknown, operationKey?:unknown, repairFailureUser?:unknown): Record<string, unknown> {
  const allowedKinds = new Set(["stale_cache", "missed_projection", "out_of_order"]);
  if (!Array.isArray(userIds) || userIds.length < 2 || userIds.length > 24
      || userIds.some((item) => !validId(item)) || new Set(userIds).size !== userIds.length
      || !validId(handlerVersion) || !validId(configVersion) || !allowedKinds.has(String(faultKind))
      || !isTimestamp(occurredAt) || (operationKey !== undefined && !validId(operationKey))
      || (repairFailureUser !== undefined && (!validId(repairFailureUser) || !userIds.includes(repairFailureUser)))) {
    throw new LumenError("Live fault request is invalid", 400);
  }
  const db = openDatabase(path);
  try {
    db.exec("BEGIN IMMEDIATE");
    if (readMeta(db, "scenario") !== "live_adapty") throw new LumenError("Live fault is supported only in live scenario", 409);
    const requestHash = digest({ userIds,handlerVersion,configVersion,occurredAt,faultKind,repairFailureUser:repairFailureUser ?? null });
    if (typeof operationKey === 'string') {
      const prior = db.prepare('SELECT request_hash,result_json FROM simulation_injections WHERE operation_key=?').get(operationKey) as
        { request_hash:string; result_json:string } | undefined;
      if (prior) {
        if (prior.request_hash !== requestHash) throw new LumenError('Simulation operation key conflict',409);
        db.exec('COMMIT');
        return { ...JSON.parse(prior.result_json) as Record<string,unknown>,duplicate:true };
      }
    }
    const changed: Record<string, unknown>[] = [];
    for (const userId of userIds as string[]) {
      const state = db.prepare("SELECT * FROM access WHERE user_id=?").get(userId) as
        { active: number; expires_at: string | null; entitlement_hash: string | null; projection_revision: number;
          cache_revision: number; cache_active: number; cache_invalidated: number } | undefined;
      const mapping = db.prepare("SELECT status FROM mappings WHERE user_id=?").get(userId) as { status: string } | undefined;
      const policy = db.prepare("SELECT enabled FROM policies WHERE user_id=?").get(userId) as { enabled: number } | undefined;
      if (!state || mapping?.status !== "mapped" || !policy?.enabled || !gate(db, userId).allowed || !state.entitlement_hash) {
        throw new LumenError("Live fault target is not currently healthy", 409);
      }
      const before = { active: Boolean(state.active), premium: Boolean(state.active), expires_at: state.expires_at,
        projection_revision: state.projection_revision, cache_revision: state.cache_revision,
        source_hash: state.entitlement_hash, invalidated: false };
      const revision = state.projection_revision + 1;
      let active = true;
      let expiresAt = state.expires_at;
      let cacheRevision = state.cache_revision;
      if (faultKind === "stale_cache") {
        db.prepare("UPDATE access SET projection_revision=?,updated_at=? WHERE user_id=?").run(revision, occurredAt, userId);
      } else if (faultKind === "missed_projection") {
        active = false;
        cacheRevision = revision;
        db.prepare("UPDATE access SET active=0,projection_revision=?,cache_revision=?,cache_active=0,cache_invalidated=0,updated_at=? WHERE user_id=?")
          .run(revision, revision, occurredAt, userId);
      } else {
        expiresAt = new Date(Date.parse(occurredAt) - 1000).toISOString().replace(/\.000Z$/u, "Z");
        cacheRevision = revision;
        db.prepare("UPDATE access SET expires_at=?,projection_revision=?,cache_revision=?,cache_expires_at=?,cache_invalidated=0,updated_at=? WHERE user_id=?")
          .run(expiresAt, revision, revision, expiresAt, occurredAt, userId);
      }
      db.prepare("INSERT OR REPLACE INTO live_fault_tags VALUES(?,?,?,?)").run(userId, handlerVersion, configVersion, occurredAt);
      changed.push({ user_id: userId, before, after: { active, premium: active, expires_at: expiresAt,
        projection_revision: revision, cache_revision: cacheRevision, source_hash: state.entitlement_hash, invalidated: false },
        source_hash: state.entitlement_hash, projection_revision: revision, cache_revision: cacheRevision,
        policy_version: "premium-policy-v1", adapter_version: "adapty-profile-read-v1" });
    }
    for (const [key, value] of Object.entries({ live_fault_injected: true, live_fault_account_count: changed.length,
      live_fault_handler_version: handlerVersion, live_fault_config_version: configVersion,
      live_fault_occurred_at: occurredAt, live_fault_kind: faultKind,
      live_handler_version: handlerVersion, live_config_version: configVersion })) writeMeta(db, key, value);
    if (typeof repairFailureUser === 'string') db.prepare("INSERT INTO live_handler_faults VALUES (?,?,1,1,?) ON CONFLICT(user_id) DO UPDATE SET fault_mode=excluded.fault_mode,remaining_attempts=1,permanent=1,created_at=excluded.created_at")
      .run(repairFailureUser,'permanent_handler',occurredAt);
    const result = { injected: true, fault_kind: faultKind, account_count: changed.length,
      handler_version: handlerVersion, config_version: configVersion, occurred_at: occurredAt, accounts: changed,
      ...(typeof operationKey === 'string' ? { operation_key:operationKey,request_hash:requestHash } : {}) };
    if (typeof operationKey === 'string') db.prepare('INSERT INTO simulation_injections VALUES (?,?,?)')
      .run(operationKey,requestHash,canonical(result));
    db.exec("COMMIT");
    return result;
  } catch (error) { rollback(db); throw error; }
  finally { db.close(); }
}

export function readInjection(path:string,operationKey:string):Record<string,unknown> | null {
  if (!validId(operationKey)) throw new LumenError('Invalid simulation operation key',400);
  const db = openDatabase(path);
  try {
    const row = db.prepare('SELECT result_json FROM simulation_injections WHERE operation_key=?').get(operationKey) as { result_json:string } | undefined;
    if (!row) return null;
    const { accounts:_accounts,...summary } = JSON.parse(row.result_json) as Record<string,unknown>;
    return summary;
  } finally { db.close(); }
}

export function rollback(db: DatabaseSync): void {
  try { db.exec("ROLLBACK"); } catch { /* Preserve the original failure. */ }
}
