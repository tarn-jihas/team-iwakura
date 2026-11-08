import { createHash, createHmac, randomUUID } from "node:crypto";
import { chmodSync, lstatSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  canonical,
  validateEvent,
  type CollectorAcknowledgement,
  type CollectorEnvelope,
  type EventScope,
  type RecoveryDetails,
  type RecoveryEvent,
  type RecoveryKind,
} from "@reconcile/contracts";

export { canonical, validateEvent } from "@reconcile/contracts";
export type {
  CollectorAcknowledgement,
  CollectorEnvelope,
  EventScope,
  RecoveryDetails,
  RecoveryEvent,
  RecoveryEventV1,
  RecoveryEventV2,
  RecoveryKind,
  RecoveryState,
  TraceRevisions,
  TraceStackFrame,
  TraceStep,
} from "@reconcile/contracts";

const MAX_EVENT_BYTES = 16 * 1024;
const MAX_PENDING = 1000;
const MAX_RECORDS = 2000;
const RETENTION_SECONDS = 30 * 24 * 60 * 60;
const MAX_ATTEMPTS = 5;
const BATCH_SIZE = 25;
const TABLES = `
  CREATE TABLE IF NOT EXISTS sdk_events(
    event_id TEXT PRIMARY KEY, event_hash TEXT NOT NULL, event_json TEXT NOT NULL,
    state TEXT NOT NULL CHECK(state IN ('queued','accepted','dropped')),
    created_at INTEGER NOT NULL, attempts INTEGER NOT NULL DEFAULT 0,
    next_attempt_at INTEGER NOT NULL DEFAULT 0, last_error TEXT
  );
  CREATE TABLE IF NOT EXISTS sdk_stats(key TEXT PRIMARY KEY, value INTEGER NOT NULL);
  CREATE TABLE IF NOT EXISTS sdk_meta(key TEXT PRIMARY KEY, value TEXT NOT NULL);
`;

export type CollectorTransport = (
  envelope: CollectorEnvelope,
  signature: string,
) => unknown | Promise<unknown>;

export interface CollectorSDKOptions {
  key: string | Uint8Array;
  runId: string;
  app: string;
  outboxPath: string;
  transport?: CollectorTransport | null;
  collectorUrl?: string;
  environment?: string;
}

export interface EmitOptions {
  eventId?: string;
  sourceEventId?: string;
  correlationId?: string;
  schemaVersion?: 1 | 2;
}

export interface EmitReceipt {
  event_id: string;
  event_hash: string;
  queued: boolean;
  accepted: boolean;
}

export interface FlushResult {
  accepted: number;
  dropped: number;
  failed: number;
  retries: number;
}

export interface Coverage extends FlushResult {
  queued: number;
  last_error: string | null;
}

export class CollectorAuthError extends Error {
  readonly status?: number;

  constructor(status?: number) {
    super("Collector authentication failed");
    this.name = "CollectorAuthError";
    this.status = status;
  }
}

export class CollectorHTTPError extends Error {
  readonly status: number;
  readonly retryAfter?: number;

  constructor(status: number, retryAfter?: string | null) {
    const safeStatus = Number.isInteger(status) ? status : 0;
    super(`Collector request failed (HTTP ${safeStatus})`);
    this.name = "CollectorHTTPError";
    this.status = safeStatus;
    this.retryAfter = safeStatus === 429 ? retrySeconds(retryAfter, 1) : undefined;
  }
}

class CollectorResponseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CollectorResponseError";
  }
}

class EventIdentityConflictError extends Error {}

export function digest(value: unknown): string {
  return createHash("sha256").update(canonical(value), "utf8").digest("hex");
}

function keyBytes(key: string | Uint8Array): Buffer {
  if (typeof key !== "string" && !(key instanceof Uint8Array)) throw new CollectorAuthError();
  const bytes = typeof key === "string" ? Buffer.from(key, "utf8") : Buffer.from(key);
  if (bytes.byteLength < 32) throw new CollectorAuthError();
  return bytes;
}

export function sign(envelope: CollectorEnvelope | unknown, key: string | Uint8Array): string {
  return createHmac("sha256", keyBytes(key)).update(canonical(envelope), "utf8").digest("hex");
}

function target(url: string, timeout: number): URL {
  if (typeof timeout !== "number" || !Number.isFinite(timeout) || timeout <= 0 || timeout > 5) {
    throw new TypeError("Collector timeout must be from 0 to 5 seconds");
  }
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new TypeError("Collector URL must use a loopback HTTP endpoint");
  }
  if (parsed.protocol !== "http:" || parsed.hostname !== "127.0.0.1"
      || parsed.username || parsed.password || parsed.hash || parsed.search
      || !["/api/recovery/collector", "/api/collector/events"].includes(parsed.pathname)
      || Number(parsed.port || 80) < 1 || Number(parsed.port || 80) > 65535) {
    throw new TypeError("Collector URL must use a loopback HTTP endpoint");
  }
  return parsed;
}

async function readBounded(response: Response, maximum: number): Promise<Uint8Array> {
  const reader = response.body?.getReader();
  if (!reader) return new Uint8Array();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      length += part.value.byteLength;
      if (length > maximum) {
        try {
          await reader.cancel();
        } catch {
          // Keep the bounded-size protocol error if cancellation races the stream.
        }
        throw new CollectorResponseError("Collector acknowledgement is too large");
      }
      chunks.push(part.value);
    }
  } finally {
    reader.releaseLock();
  }
  const payload = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    payload.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return payload;
}

export function httpTransport(url: string, timeout = 3): CollectorTransport {
  const parsed = target(url, timeout);
  return async (envelope, signature) => {
    const response = await fetch(parsed, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        "X-Reconcile-Signature": signature,
      },
      body: canonical(envelope),
      redirect: "manual",
      signal: AbortSignal.timeout(timeout * 1000),
    });
    if (response.status === 401 || response.status === 403) {
      void response.body?.cancel().catch(() => undefined);
      throw new CollectorAuthError(response.status);
    }
    if (response.status !== 200) {
      const retryAfter = response.status === 429 ? response.headers.get("Retry-After") : null;
      void response.body?.cancel().catch(() => undefined);
      throw new CollectorHTTPError(response.status, retryAfter);
    }
    const payload = await readBounded(response, MAX_EVENT_BYTES);
    let result: unknown;
    try {
      result = JSON.parse(new TextDecoder().decode(payload));
    } catch {
      throw new CollectorResponseError("Collector acknowledgement is invalid");
    }
    if (typeof result !== "object" || result === null || Array.isArray(result)) {
      throw new CollectorResponseError("Collector acknowledgement is invalid");
    }
    return result;
  };
}

function retrySeconds(value: string | number | null | undefined, attempt: number): number {
  const fallback = Math.min(2 ** Math.min(attempt, 6), 60);
  if (value === null || value === undefined) return fallback;
  try {
    let seconds: number;
    if (typeof value === "number") {
      seconds = value;
    } else if (/^[+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?$/iu.test(value.trim())) {
      seconds = Number(value);
    } else {
      const deadline = Date.parse(value);
      if (!Number.isFinite(deadline)) return fallback;
      seconds = (deadline - Date.now()) / 1000;
    }
    const maximum = Number.MAX_SAFE_INTEGER - Math.ceil(Date.now() / 1000);
    if (seconds === Number.POSITIVE_INFINITY) return maximum;
    if (!Number.isFinite(seconds)) return fallback;
    return Math.min(maximum, Math.max(1, Math.ceil(seconds)));
  } catch {
    return fallback;
  }
}

function storageFailure(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const code = (error as NodeJS.ErrnoException).code ?? "";
  return code.startsWith("ERR_SQLITE_")
    || ["EACCES", "EEXIST", "EISDIR", "ENOENT", "ENOSPC", "EROFS"].includes(code);
}

function errorName(error: unknown): string {
  if (error instanceof CollectorHTTPError) return `http_${error.status}`;
  if (error instanceof CollectorAuthError) return error.status === 401 || error.status === 403
    ? `http_${error.status}` : "auth_error";
  if (error instanceof CollectorResponseError) return "invalid_ack";
  return "transport_error";
}

function parseCanonicalEvent(text: string): RecoveryEvent {
  const parseWithSource = JSON.parse as unknown as (
    text: string,
    reviver: (key: string, value: unknown, context?: { source: string }) => unknown,
  ) => unknown;
  return parseWithSource(text, (_key, value, context) => {
    if (typeof value === "number" && context?.source && /^-?\d+$/u.test(context.source)
        && !Number.isSafeInteger(value)) return BigInt(context.source);
    return value;
  }) as RecoveryEvent;
}

function rollback(db: DatabaseSync): void {
  try {
    db.exec("ROLLBACK");
  } catch {
    // Preserve the transaction's original failure.
  }
}

export class CollectorSDK {
  private readonly key: Buffer;
  private readonly runId: string;
  private readonly app: string;
  private readonly environment: string;
  private readonly outboxPath: string;
  private readonly transport: CollectorTransport;
  private lastError: string | null = null;
  private readonly memory = { accepted: 0, dropped: 0, failed: 0, retries: 0 };
  private flushing = false;
  private storageValidated = false;

  constructor(options: CollectorSDKOptions) {
    this.key = keyBytes(options.key);
    text(options.runId, "run_id", 128);
    text(options.app, "app", 128);
    const environment = options.environment ?? "Production";
    text(environment, "environment", 128);
    if (typeof options.outboxPath !== "string" || !options.outboxPath) {
      throw new TypeError("Invalid collector outbox path");
    }
    if (options.collectorUrl !== undefined) target(options.collectorUrl, 3);
    const transport = options.transport ?? (options.collectorUrl ? httpTransport(options.collectorUrl) : undefined);
    if (typeof transport !== "function") throw new TypeError("A collector transport or URL is required");
    this.runId = options.runId;
    this.app = options.app;
    this.environment = environment;
    this.outboxPath = options.outboxPath;
    this.transport = transport;
    try {
      this.openDatabase().close();
    } catch {
      this.lastError = "outbox_unavailable";
    }
  }

  private openDatabase(): DatabaseSync {
    mkdirSync(dirname(this.outboxPath), { recursive: true });
    if (!this.storageValidated) {
      let existing = true;
      try { lstatSync(this.outboxPath); }
      catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') existing = false; else throw error; }
      if (existing) {
        let previous: DatabaseSync | undefined;
        try {
          const info = lstatSync(this.outboxPath);
          if (!info.isFile() || info.isSymbolicLink() || !info.size) throw new Error('invalid');
          previous = new DatabaseSync(this.outboxPath,{ readOnly:true });
          const marker = previous.prepare("SELECT value FROM sdk_meta WHERE key='typescript_runtime'").get() as { value:string } | undefined;
          if (marker?.value !== 'server-sdk-v1') throw new Error('invalid');
        } catch {
          const error = new Error('Outbox is not an isolated TypeScript runtime') as NodeJS.ErrnoException;
          error.code = 'ERR_SQLITE_ISOLATION';
          throw error;
        } finally { previous?.close(); }
      }
    }
    const db = new DatabaseSync(this.outboxPath);
    try {
      db.exec("PRAGMA busy_timeout=200; PRAGMA synchronous=FULL;");
      db.exec(TABLES);
      db.prepare("INSERT OR IGNORE INTO sdk_meta(key,value) VALUES('typescript_runtime','server-sdk-v1')").run();
      this.storageValidated = true;
    } catch (error) { db.close(); throw error; }
    try {
      chmodSync(this.outboxPath, 0o600);
    } catch {
      // Match Python SDK behavior on filesystems that do not support chmod.
    }
    return db;
  }

  private syncMemory(db: DatabaseSync): void {
    const increments = Object.entries(this.memory).filter(([, value]) => value > 0);
    if (!increments.length && this.lastError === null) return;
    db.exec("BEGIN IMMEDIATE");
    try {
      const stat = db.prepare("INSERT INTO sdk_stats(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=value+excluded.value");
      for (const [name, value] of increments) stat.run(name, value);
      if (this.lastError !== null) {
        db.prepare("INSERT INTO sdk_meta(key,value) VALUES('last_error',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(this.lastError);
      }
      db.exec("COMMIT");
      for (const [name] of increments) this.memory[name as keyof typeof this.memory] = 0;
    } catch (error) {
      rollback(db);
      throw error;
    }
  }

  private increment(db: DatabaseSync, name: keyof typeof this.memory, amount = 1): void {
    db.prepare("INSERT INTO sdk_stats(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=value+excluded.value").run(name, amount);
  }

  private saveEvent(event: RecoveryEvent, eventHash: string): "queued" | "accepted" | "dropped" {
    let db: DatabaseSync | undefined;
    try {
      db = this.openDatabase();
      this.syncMemory(db);
      db.exec("BEGIN IMMEDIATE");
      const now = Math.floor(Date.now() / 1000);
      const cutoff = now - RETENTION_SECONDS;
      const stale = Number(db.prepare("SELECT COUNT(*) AS count FROM sdk_events WHERE state='queued' AND created_at<?").get(cutoff)?.count ?? 0);
      if (stale) {
        db.prepare("UPDATE sdk_events SET state='dropped',last_error='retention_expired' WHERE state='queued' AND created_at<?").run(cutoff);
        this.increment(db, "dropped", stale);
      }
      db.prepare("DELETE FROM sdk_events WHERE created_at<?").run(cutoff);
      const previous = db.prepare("SELECT event_hash,state,last_error FROM sdk_events WHERE event_id=?").get(event.event_id) as
        | { event_hash: string; state: "queued" | "accepted" | "dropped"; last_error:string | null }
        | undefined;
      if (previous) {
        if (previous.event_hash !== eventHash) {
          rollback(db);
          throw new EventIdentityConflictError("Collector event ID is already bound to a different payload");
        }
        let state = previous.state;
        if (state === 'dropped' && previous.last_error === 'queue_full') {
          const pending = Number(db.prepare("SELECT COUNT(*) AS count FROM sdk_events WHERE state='queued'").get()?.count ?? 0);
          if (pending < MAX_PENDING) {
            db.prepare("UPDATE sdk_events SET state='queued',attempts=0,next_attempt_at=0,last_error=NULL WHERE event_id=?").run(event.event_id);
            state = 'queued';
          }
        }
        db.exec("COMMIT");
        return state;
      }
      let total = Number(db.prepare("SELECT COUNT(*) AS count FROM sdk_events").get()?.count ?? 0);
      while (total >= MAX_RECORDS) {
        const oldest = db.prepare("SELECT event_id FROM sdk_events WHERE state!='queued' ORDER BY created_at,event_id LIMIT 1").get() as { event_id: string } | undefined;
        if (!oldest) break;
        db.prepare("DELETE FROM sdk_events WHERE event_id=?").run(oldest.event_id);
        total -= 1;
      }
      const pending = Number(db.prepare("SELECT COUNT(*) AS count FROM sdk_events WHERE state='queued'").get()?.count ?? 0);
      const state = pending < MAX_PENDING && total < MAX_RECORDS ? "queued" : "dropped";
      db.prepare("INSERT INTO sdk_events(event_id,event_hash,event_json,state,created_at,last_error) VALUES(?,?,?,?,?,?)")
        .run(event.event_id, eventHash, canonical(event), state, now, state === "queued" ? null : "queue_full");
      if (state === "dropped") {
        this.increment(db, "dropped");
        db.exec("INSERT INTO sdk_meta(key,value) VALUES('last_error','queue_full') ON CONFLICT(key) DO UPDATE SET value='queue_full'");
      }
      db.exec("COMMIT");
      if (state === "dropped") {
        this.lastError = "queue_full";
      }
      return state;
    } catch (error) {
      if (db) rollback(db);
      if (error instanceof EventIdentityConflictError) throw error;
      if (!storageFailure(error)) throw error;
      this.memory.dropped += 1;
      this.lastError = "outbox_unavailable";
      return "dropped";
    } finally {
      db?.close();
    }
  }

  private takeBatch(limit = BATCH_SIZE): Array<{ event_id: string; event_hash: string; event_json: string; attempts: number }> {
    const db = this.openDatabase();
    try {
      this.syncMemory(db);
      db.exec("BEGIN IMMEDIATE");
      const exhausted = db.prepare("SELECT event_id FROM sdk_events WHERE state='queued' AND attempts>=?").all(MAX_ATTEMPTS) as { event_id: string }[];
      if (exhausted.length) {
        const update = db.prepare("UPDATE sdk_events SET state='dropped',last_error='attempts_exhausted' WHERE event_id=?");
        for (const row of exhausted) update.run(row.event_id);
        this.increment(db, "dropped", exhausted.length);
      }
      const rows = db.prepare("SELECT event_id,event_hash,event_json,attempts FROM sdk_events WHERE state='queued' AND next_attempt_at<=? ORDER BY created_at,event_id LIMIT ?")
        .all(Math.floor(Date.now() / 1000), limit) as { event_id: string; event_hash: string; event_json: string; attempts: number }[];
      const update = db.prepare("UPDATE sdk_events SET attempts=attempts+1 WHERE event_id=? AND state='queued'");
      for (const row of rows) update.run(row.event_id);
      db.exec("COMMIT");
      return rows.map((row) => ({ ...row, attempts: row.attempts + 1 }));
    } catch (error) {
      rollback(db);
      throw error;
    } finally {
      db.close();
    }
  }

  private finish(eventId: string, options: {
    accepted: boolean;
    error?: string;
    retryAfter?: number;
    attempt: number;
    permanent?: boolean;
  }): void {
    const db = this.openDatabase();
    try {
      this.syncMemory(db);
      db.exec("BEGIN IMMEDIATE");
      if (options.accepted) {
        const changed = db.prepare("UPDATE sdk_events SET state='accepted',next_attempt_at=0,last_error=NULL WHERE event_id=? AND state='queued'").run(eventId).changes;
        if (changed) {
          this.increment(db, "accepted");
          db.exec("INSERT INTO sdk_meta(key,value) VALUES('last_error','') ON CONFLICT(key) DO UPDATE SET value=''");
          this.lastError = null;
        }
      } else {
        const retry = !options.permanent && options.attempt < MAX_ATTEMPTS;
        if (retry) {
          const delay = retrySeconds(options.retryAfter, options.attempt);
          db.prepare("UPDATE sdk_events SET next_attempt_at=?,last_error=? WHERE event_id=? AND state='queued'")
            .run(Math.ceil(Date.now() / 1000) + delay, options.error ?? "transport_error", eventId);
          this.increment(db, "retries");
        } else {
          db.prepare("UPDATE sdk_events SET state='dropped',last_error=? WHERE event_id=? AND state='queued'")
            .run(options.error ?? "transport_error", eventId);
          this.increment(db, "dropped");
        }
        this.increment(db, "failed");
        this.lastError = options.error ?? "transport_error";
        db.prepare("INSERT INTO sdk_meta(key,value) VALUES('last_error',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value")
          .run(this.lastError);
      }
      db.exec("COMMIT");
    } catch (error) {
      rollback(db);
      throw error;
    } finally {
      db.close();
    }
  }

  emit(
    kind: RecoveryKind,
    userId: string,
    occurredAt: string,
    details: RecoveryDetails,
    options: EmitOptions = {},
  ): EmitReceipt {
    const eventId = options.eventId ?? randomUUID();
    const sourceEventId = options.sourceEventId ?? eventId;
    const correlationId = options.correlationId ?? eventId;
    const event = {
      schema_version: options.schemaVersion ?? 1,
      event_id: eventId,
      run_id: this.runId,
      app: this.app,
      environment: this.environment,
      app_user_id: userId,
      kind,
      occurred_at: occurredAt,
      correlation_id: correlationId,
      source_event_id: sourceEventId,
      details,
    } as RecoveryEvent;
    const scope: EventScope = { runId: this.runId, app: this.app, environment: this.environment };
    validateEvent(event, scope);
    const payload = canonical(event);
    if (new TextEncoder().encode(payload).byteLength > MAX_EVENT_BYTES) throw new TypeError("Collector event is too large");
    const stableEvent = parseCanonicalEvent(payload);
    const eventHash = createHash("sha256").update(payload, "utf8").digest("hex");
    const state = this.saveEvent(stableEvent, eventHash);
    return { event_id: eventId, event_hash: eventHash, queued: state === "queued", accepted: state === "accepted" };
  }

  async flush(): Promise<FlushResult> {
    const result: FlushResult = { accepted: 0, dropped: 0, failed: 0, retries: 0 };
    if (this.flushing) return result;
    this.flushing = true;
    try {
      let rows: ReturnType<CollectorSDK["takeBatch"]>;
      try {
        rows = this.takeBatch();
      } catch (error) {
        if (!storageFailure(error)) throw error;
        this.lastError = "outbox_unavailable";
        return result;
      }
      for (const row of rows) {
        let accepted = false;
        let permanent = false;
        let errorNameValue: string | undefined;
        let retryAfter: number | undefined;
        try {
          const event = parseCanonicalEvent(row.event_json);
          const envelope: CollectorEnvelope = {
            schema_version: event.schema_version,
            event,
            sent_at: Math.floor(Date.now() / 1000),
          };
          const receipt = await this.transport(envelope, sign(envelope, this.key));
          if (typeof receipt !== "object" || receipt === null || Array.isArray(receipt)
              || (receipt as Record<string, unknown>).accepted !== true
              || (receipt as Record<string, unknown>).event_id !== row.event_id
              || (receipt as Record<string, unknown>).event_hash !== row.event_hash
              || typeof (receipt as Record<string, unknown>).duplicate !== "boolean") {
            throw new CollectorResponseError("Collector acknowledgement is invalid");
          }
          accepted = true;
        } catch (error) {
          errorNameValue = errorName(error);
          if (error instanceof CollectorHTTPError) {
            permanent = error.status >= 400 && error.status < 500 && error.status !== 429;
            retryAfter = error.retryAfter;
          } else if (error instanceof CollectorAuthError) {
            permanent = true;
          }
        }
        try {
          this.finish(row.event_id, {
            accepted,
            error: errorNameValue,
            retryAfter,
            attempt: row.attempts,
            permanent,
          });
        } catch (error) {
          if (!storageFailure(error)) throw error;
          this.lastError = "outbox_unavailable";
        }
        if (accepted) result.accepted += 1;
        else {
          result.failed += 1;
          if (permanent || row.attempts >= MAX_ATTEMPTS) result.dropped += 1;
          else result.retries += 1;
        }
      }
      return result;
    } finally {
      this.flushing = false;
    }
  }

  coverage(): Coverage {
    let db: DatabaseSync | undefined;
    try {
      db = this.openDatabase();
      this.syncMemory(db);
      const counts = Object.fromEntries((db.prepare("SELECT key,value FROM sdk_stats").all() as { key: string; value: number }[])
        .map((row) => [row.key, row.value])) as Record<string, number>;
      const queued = Number(db.prepare("SELECT COUNT(*) AS count FROM sdk_events WHERE state='queued'").get()?.count ?? 0);
      const lastErrorRow = db.prepare("SELECT value FROM sdk_meta WHERE key='last_error'").get() as { value: string } | undefined;
      return {
        queued,
        accepted: counts.accepted ?? 0,
        dropped: counts.dropped ?? 0,
        failed: counts.failed ?? 0,
        retries: counts.retries ?? 0,
        last_error: lastErrorRow?.value || null,
      };
    } catch (error) {
      if (!storageFailure(error)) throw error;
      this.lastError = "outbox_unavailable";
      return { queued: 0, ...this.memory, last_error: this.lastError };
    } finally {
      db?.close();
    }
  }
}

function text(value: unknown, name: string, limit = 256): asserts value is string {
  if (typeof value !== "string" || !value || value.trim() !== value || [...value].length > limit
      || /[\u0000-\u001f\u007f]/u.test(value)) throw new TypeError(`Invalid collector ${name}`);
}
