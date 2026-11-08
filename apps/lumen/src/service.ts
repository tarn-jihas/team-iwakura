import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { lstatSync } from "node:fs";
import { resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  CollectorSDK,
  digest,
  type CollectorTransport,
  type RecoveryDetails,
} from "@reconcile/server-sdk";
import {
  FEATURE,
  LumenError,
  access,
  action,
  actionByProcessing,
  accounts,
  configureSimulation,
  initializeLumen,
  injectLiveFault,
  liveFaultStatus,
  liveHandlerResult,
  liveHandlerResults,
  manifest,
  markCacheRefreshSkipped,
  markReceiptEnqueued,
  openDatabase,
  readMeta,
  readInjection,
  pendingReceipts,
  receiptBacklog,
  resync,
  saveLiveHandlerResult,
  sourceEvent,
  takeFault,
  validateResync,
  writeMeta,
  type BootstrapProfile,
  type ResyncBody,
} from "./domain.js";
import { InternalHTTPError, internalRequest, loopbackUrl, verifyInternal } from "./internal-auth.js";

const BODY_LIMIT = 1024 * 1024;
const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const validId = (value: unknown): value is string => typeof value === "string" && !!value
  && value.length <= 256 && value.trim() === value && !/[\u0000-\u001f\u007f]/u.test(value);
const validTimestamp = (value: unknown): value is string => typeof value === "string"
  && /(?:Z|[+-]\d{2}:\d{2})$/u.test(value) && Number.isFinite(Date.parse(value));
const FAILURE_CLASSES = new Set([
  "recovery_http_400", "recovery_http_404", "recovery_http_409", "recovery_http_429", "recovery_http_503", "recovery_http_504",
  "internal_http_400", "internal_http_404", "internal_http_409", "internal_http_429", "internal_http_503", "internal_http_504",
  "ValueError", "TypeError", "KeyError", "TimeoutError", "OperationalError", "handler_failure", "cache_refresh_skipped", "identity_unknown",
]);

class SourceReadUnavailable extends LumenError {
  constructor() { super("Fresh source profile is unavailable", 503); }
}

class HandlerTimeoutError extends Error {
  constructor() { super("Lumen response closed after commit"); this.name = "TimeoutError"; }
}

export interface LiveConfig {
  appId: string;
  sourceEnvironment: string;
  customerUserIds?: string[];
}

export interface LumenOptions {
  port?: number;
  dbPath: string;
  outboxPath?: string;
  key: Uint8Array;
  providerUrl: string;
  collectorUrl?: string;
  app?: string;
  environment?: string;
  runId?: string;
  scenario?: string;
  liveConfig?: LiveConfig;
  demo?: boolean;
  liveBootstrapPending?: boolean;
  bootstrapProfiles?: BootstrapProfile[];
  bootstrapManifest?: Record<string, unknown>;
  autoFlush?: boolean;
  now?: () => number;
};

interface DispatchResult {
  body: unknown;
  status?: number;
  close?: boolean;
}

function assertRuntimeScope(runtimeManifest:Record<string,unknown>, options:LumenOptions, live:boolean):void {
  if ((runtimeManifest.scenario === 'live_adapty') !== live) {
    throw new LumenError('Lumen runtime mode does not match its initialized database',500);
  }
  if (live && (runtimeManifest.typescript_app_id !== options.liveConfig!.appId
      || runtimeManifest.app !== options.liveConfig!.appId
      || runtimeManifest.typescript_source_environment !== options.liveConfig!.sourceEnvironment
      || runtimeManifest.typescript_customer_ids_hash !== digest([...options.liveConfig!.customerUserIds!].sort()))) {
    throw new LumenError('Lumen live scope does not match its initialized database',500);
  }
  if ((options.app !== undefined && runtimeManifest.app !== options.app)
      || (options.environment !== undefined && runtimeManifest.environment !== options.environment)
      || (options.runId !== undefined && runtimeManifest.run_id !== options.runId)) {
    throw new LumenError('Lumen runtime scope does not match its initialized database',500);
  }
}

export class LumenService {
  readonly server: Server;
  sdk!: CollectorSDK;
  private readonly provider: URL;
  private readonly live: boolean;
  private app: string;
  private environment: string;
  private runId: string;
  private readonly outboxPath: string;
  private readonly now: () => number;
  private readonly autoFlush: boolean;
  private flushTimer: NodeJS.Timeout | undefined;

  private constructor(private readonly options: LumenOptions) {
    if (options.key.byteLength < 32) throw new TypeError("Shared key must contain at least 32 bytes");
    if (options.liveConfig && (!validId(options.liveConfig.appId) || !validId(options.liveConfig.sourceEnvironment)
        || !Array.isArray(options.liveConfig.customerUserIds) || options.liveConfig.customerUserIds.length !== 100
        || options.liveConfig.customerUserIds.some(id => !validId(id))
        || new Set(options.liveConfig.customerUserIds).size !== 100
        || (options.app !== undefined && options.app !== options.liveConfig.appId))) {
      throw new TypeError('Invalid live Lumen scope');
    }
    this.provider = loopbackUrl(options.providerUrl);
    this.live = options.liveConfig !== undefined;
    this.app = options.app ?? options.liveConfig?.appId ?? "mock-lumen-activation";
    this.environment = options.environment ?? "Production";
    this.runId = options.runId ?? "lumen-mock-run";
    this.outboxPath = options.outboxPath ?? `${options.dbPath}-outbox.sqlite3`;
    if (resolve(this.outboxPath) === resolve(options.dbPath)) throw new Error('Lumen and SDK outbox require separate databases');
    this.now = options.now ?? Date.now;
    this.autoFlush = options.autoFlush ?? true;
    this.server = createServer((request, response) => { void this.handle(request, response); });
  }

  static async create(options: LumenOptions): Promise<LumenService> {
    const service = new LumenService(options);
    await service.initialize();
    return service;
  }

  private async initialize(): Promise<void> {
    let existingPath = true;
    try { lstatSync(this.options.dbPath); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') existingPath = false; else throw error; }
    if (existingPath) {
      let existing:DatabaseSync | undefined;
      try {
        const info = lstatSync(this.options.dbPath);
        if (!info.isFile() || info.isSymbolicLink() || info.size === 0) throw new Error('invalid');
        existing = new DatabaseSync(this.options.dbPath,{ readOnly:true });
        const rows = existing.prepare('SELECT key,value FROM meta').all() as { key:string; value:string }[];
        const prior = Object.fromEntries(rows.map(row => [row.key,JSON.parse(row.value) as unknown]));
        if (prior.typescript_runtime !== 'lumen-v1') throw new Error('invalid');
        if (prior.initialized === true) assertRuntimeScope(prior,this.options,this.live);
      } catch (error) {
        if (error instanceof LumenError) throw error;
        throw new Error('Lumen database is not an isolated TypeScript runtime');
      }
      finally { existing?.close(); }
    }
    const db = openDatabase(this.options.dbPath);
    const initialized = readMeta(db, "initialized", false) === true;
    if (!initialized) writeMeta(db,'typescript_runtime','lumen-v1');
    db.close();
    let bootstrapManifest = this.options.bootstrapManifest;
    let profiles = this.options.bootstrapProfiles;
    if (!initialized && (!bootstrapManifest || !profiles)) {
      if (this.live || this.options.providerUrl) {
        try {
          const providerManifest = await internalRequest(this.options.key, this.provider, "GET", "/internal/manifest");
          const page = await internalRequest(this.options.key, this.provider, "GET", "/internal/adapty/profiles?limit=100", undefined, 150_000);
          if (!isRecord(providerManifest) || !isRecord(page) || !Array.isArray(page.items)) {
            throw new LumenError("Invalid provider bootstrap response", 502);
          }
          bootstrapManifest ??= providerManifest;
          profiles ??= page.items as BootstrapProfile[];
        } catch (error) {
          if (this.live || !bootstrapManifest || !profiles) throw error;
        }
      }
    }
    if (!initialized) {
      bootstrapManifest ??= {
        app: this.app,
        environment: this.environment,
        scenario: this.options.scenario ?? "stripe",
        run_id: this.runId,
        scenario_now: new Date(this.now()).toISOString().replace(/\.\d{3}Z$/u, "Z"),
        provenance: "synthetic_extension",
      };
      profiles ??= [];
      const manifestValue: Record<string, unknown> = {
        ...bootstrapManifest,
        app: bootstrapManifest.app ?? this.app,
        environment: bootstrapManifest.environment ?? this.environment,
        run_id: bootstrapManifest.run_id ?? this.runId,
        ...(this.live ? { scenario: "live_adapty", customer_count: this.options.liveConfig?.customerUserIds?.length ?? profiles.length,
          typescript_app_id:this.options.liveConfig!.appId,typescript_source_environment:this.options.liveConfig!.sourceEnvironment,
          typescript_customer_ids_hash:digest([...this.options.liveConfig!.customerUserIds!].sort()) } : {}),
      };
      if (this.live) {
        if (manifestValue.app !== this.options.liveConfig!.appId) throw new LumenError('Lumen bootstrap app scope mismatch',400);
        const allowed = this.options.liveConfig?.customerUserIds;
        if (!allowed || allowed.length !== 100 || new Set(allowed).size !== 100
            || profiles.length !== 100 || profiles.some((profile) => !allowed.includes(profile.user_id))) {
          throw new LumenError("Live bootstrap scope must contain 100 configured customer profiles", 400);
        }
        for (const profile of profiles) {
          if (!profile.observed_at || profile.identity_match !== true || profile.provider_customer_id !== profile.user_id) {
            throw new LumenError("Live bootstrap requires observed matching profiles", 400);
          }
        }
      }
      initializeLumen(this.options.dbPath, manifestValue, profiles, {
        live: this.live,
        pending: this.options.liveBootstrapPending,
      });
    }
    const runtimeManifest = manifest(this.options.dbPath);
    assertRuntimeScope(runtimeManifest,this.options,this.live);
    this.app = String(runtimeManifest.app ?? runtimeManifest.app_id ?? this.app);
    this.environment = String(runtimeManifest.environment ?? this.environment);
    this.runId = String(runtimeManifest.run_id ?? this.runId);
    const transport: CollectorTransport = async () => { throw new Error("collector_unconfigured"); };
    this.sdk = this.options.collectorUrl
      ? new CollectorSDK({ key: this.options.key, runId: this.runId, app: this.app,
        environment: this.environment, outboxPath: this.outboxPath, collectorUrl: this.options.collectorUrl })
      : new CollectorSDK({ key: this.options.key, runId: this.runId, app: this.app,
        environment: this.environment, outboxPath: this.outboxPath, transport });
    this.drainReceipts();
    if (!initialized && this.live && profiles) this.emitSourceObservations(profiles as unknown as Record<string, unknown>[]);
  }

  listen(port = this.options.port ?? 0): Promise<number> {
    return new Promise((resolve, reject) => {
      this.server.once("error", reject);
      this.server.listen(port, "127.0.0.1", () => {
        this.server.removeListener("error", reject);
        const address = this.server.address();
        if (!address || typeof address === "string") return reject(new Error("Lumen listener did not bind a TCP port"));
        if (this.autoFlush && this.options.collectorUrl) {
          this.flushTimer = setInterval(() => { this.drainReceipts(); void this.sdk.flush().catch(() => undefined); }, 250);
          this.flushTimer.unref();
          void this.sdk.flush().catch(() => undefined);
        }
        resolve(address.port);
      });
    });
  }

  async close(): Promise<void> {
    if (this.flushTimer) clearInterval(this.flushTimer);
    if (!this.server.listening) return;
    await new Promise<void>((resolve, reject) => this.server.close((error) => error ? reject(error) : resolve()));
  }

  private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    try {
      const raw = await readRequest(request);
      const path = request.url ?? "/";
      if (request.method === 'POST' && ['/premium/export','/mock/lumen/export','/lumen/export'].includes(path)) {
        let target:URL;
        try {
          target = loopbackUrl(`http://${request.headers.host ?? ''}`);
          if (Number(target.port || 80) !== request.socket.localPort) throw new Error('invalid');
          if (request.headers.origin && request.headers.origin !== target.origin) throw new Error('invalid');
        } catch { throw new LumenError('Loopback same-origin request required',403); }
        let body:unknown;
        try { body = JSON.parse(raw.toString('utf8')); } catch { throw new LumenError('Invalid JSON body',400); }
        if (!isRecord(body) || Object.keys(body).some(key => !['user_id','feature'].includes(key))
            || typeof body.user_id !== 'string' || !body.user_id || body.user_id.length > 256
            || (body.feature !== undefined && body.feature !== FEATURE)) throw new LumenError('Invalid gate request',400);
        const result = access(this.options.dbPath,body.user_id);
        this.emitGate(body.user_id,result,'customer_demo');
        writeResponse(response,result.allowed === true ? 200 : 403,result);
        return;
      }
      if (!verifyInternal(this.options.key, request.method ?? "", path,
        request.headers["x-recovery-timestamp"] as string ?? "",
        raw, request.headers["x-recovery-signature"] as string ?? "", this.now())) {
        writeResponse(response, 401, { error: "Internal authentication failed" });
        return;
      }
      const url = new URL(path, "http://127.0.0.1");
      let body: unknown = {};
      if (raw.length) {
        try { body = JSON.parse(raw.toString("utf8")); }
        catch { throw new LumenError("Invalid JSON body", 400); }
      }
      const result = await this.dispatch(request.method ?? "GET", url, body);
      if (result.close) {
        response.destroy();
        return;
      }
      writeResponse(response, result.status ?? 200, result.body);
    } catch (error) {
      if (response.headersSent || response.destroyed) return;
      if (error instanceof LumenError) writeResponse(response, error.status, { error: error.message });
      else if (error instanceof InternalHTTPError) writeResponse(response, 503, { error: "Internal simulator is unavailable" });
      else writeResponse(response, 500, { error: "Lumen request failed" });
    }
  }

  private async dispatch(method: string, url: URL, body: unknown): Promise<DispatchResult> {
    const path = url.pathname;
    if (method === "GET") {
      if (path === "/internal/manifest") return { body: manifest(this.options.dbPath) };
      if (path === "/internal/lumen/accounts") {
        return { body: accounts(this.options.dbPath, url.searchParams.get("cursor"), parseLimit(url.searchParams.get("limit"))) };
      }
      if (path === "/internal/lumen/access") {
        const user = url.searchParams.get("user");
        if (!user) throw new LumenError("user query is required", 400);
        return { body: access(this.options.dbPath, user) };
      }
      if (path === "/internal/lumen/action") {
        const operationKey = url.searchParams.get("operation_key");
        if (!operationKey) throw new LumenError("operation_key query is required", 400);
        return { body: action(this.options.dbPath, operationKey) };
      }
      if (path === "/internal/lumen/collector-coverage") return { body: { ...this.sdk.coverage(), receipt_backlog:receiptBacklog(this.options.dbPath) } };
      if (path === "/internal/lumen/handler/result") {
        const processingId = url.searchParams.get("processing_id");
        if (!processingId) throw new LumenError("processing_id query is required", 400);
        return { body: liveHandlerResult(this.options.dbPath, processingId)
          ?? actionByProcessing(this.options.dbPath, processingId) };
      }
      if (this.live && path === "/internal/lumen/handler/results") {
        return { body: liveHandlerResults(this.options.dbPath, url.searchParams.get("cursor"),
          parseLimit(url.searchParams.get("limit"))) };
      }
      if (this.live && path === "/internal/lumen/live/status") return { body: liveFaultStatus(this.options.dbPath) };
      if (this.live && this.options.demo && path === '/internal/lumen/simulation/injection') {
        const key = url.searchParams.get('operation_key');
        if (!key) throw new LumenError('operation_key query is required',400);
        return { body:readInjection(this.options.dbPath,key) };
      }
      throw new LumenError("Not found", 404);
    }
    if (method !== "POST") throw new LumenError("Method not allowed", 405);
    if (path === "/internal/lumen/probe") return { body: this.probe(body) };
    if (path === "/internal/lumen/resync") return this.handleResync(body);
    if (this.live && path === "/internal/lumen/handler/deliver") return { body: await this.handlerDeliver(body) };
    if (this.live && path === "/internal/lumen/simulation/configure") return { body: this.configure(body) };
    if (this.live && path === "/internal/lumen/live/inject") return { body: this.inject(body) };
    if (this.live && path === "/internal/lumen/source-observed") return { body: this.sourceObserved(body) };
    if (path === "/internal/demo/advance") return { body: this.advanceClock(body) };
    throw new LumenError("Not found", 404);
  }

  private probe(body: unknown): Record<string, unknown> {
    if (!isRecord(body) || Object.keys(body).length !== 3 || body.feature !== FEATURE
        || body.initiator !== "reconcile_probe" || typeof body.user_id !== "string" || !body.user_id) {
      throw new LumenError("Probe fields do not match the contract", 400);
    }
    const result = access(this.options.dbPath, body.user_id);
    this.emitGate(body.user_id, result, "reconcile_probe");
    return result;
  }

  private async handleResync(body: unknown): Promise<DispatchResult> {
    validateResync(body);
    const version = Object.hasOwn(body, "schema_version") ? body.schema_version : 1;
    if (this.live && version !== 2) throw new LumenError("Live resync requires contract version 2", 409);
    const prior = action(this.options.dbPath, body.operation_key);
    if (prior && !this.live) return { body: resync(this.options.dbPath, body, false) };
    let faultMode: string | null = null;
    if (this.live && this.options.demo && !prior) {
      faultMode = takeFault(this.options.dbPath, body.user_id);
      if (["handler_precommit", "db_precommit", "permanent_handler"].includes(faultMode ?? "")) {
        throw new LumenError("Lumen handler could not commit the projection", 503);
      }
      if (faultMode === "cache_refresh_skipped") markCacheRefreshSkipped(this.options.dbPath, body.user_id);
    }
    let profile: unknown;
    try {
      profile = await internalRequest(this.options.key, this.provider, "GET",
        `/internal/adapty/profile?${new URLSearchParams({ user: body.user_id })}`, undefined, this.live ? 60_000 : 15_000);
    } catch {
      throw new SourceReadUnavailable();
    }
    if (this.live && isRecord(profile)) this.emitSourceObservations([profile]);
    this.validateFreshProfile(profile, body);
    if (faultMode === "delayed_older_update") {
      await new Promise((resolve) => setTimeout(resolve, 100));
      let latest: unknown;
      try {
        latest = await internalRequest(this.options.key, this.provider, "GET",
          `/internal/adapty/profile?${new URLSearchParams({ user: body.user_id })}`, undefined, 60_000);
      } catch { throw new SourceReadUnavailable(); }
      if (!isRecord(latest) || !isRecord(profile) || latest.source_fingerprint !== profile.source_fingerprint) {
        throw new LumenError("Delayed source update is no longer current", 409);
      }
    }
    const result = resync(this.options.dbPath, body, this.live);
    if (this.live) this.drainReceipts();
    return { body: result, ...(faultMode === "timeout_after_commit" ? { close: true } : {}) };
  }

  private validateFreshProfile(profile: unknown, body: ResyncBody): void {
    if (!isRecord(profile) || profile.status !== "active") throw new LumenError("Fresh source profile does not match requested entitlement", 409);
    const expected = body.entitlement;
    if (!this.live) {
      for (const field of ["product_id", "expires_at", "transaction_id", "entitlement_hash"] as const) {
        if (profile[field] !== expected[field]) throw new LumenError("Fresh source profile does not match requested entitlement", 409);
      }
      return;
    }
    const config = this.options.liveConfig!;
    const source = isRecord(profile.entitlement) ? profile.entitlement : {};
    const supportedStores = ["app_store", "play_store"];
    if (profile.app_id !== config.appId || profile.user_id !== body.user_id
        || source.app_id !== config.appId || source.user_id !== body.user_id
        || source.provider_customer_id !== body.expected_provider_customer_id
        || source.source_environment !== config.sourceEnvironment
        || !supportedStores.includes(String(source.store))
        || profile.identity_match !== true
        || profile.provider_customer_id !== body.expected_provider_customer_id
        || expected.source_environment !== config.sourceEnvironment
        || typeof expected.store !== "string" || !supportedStores.includes(expected.store)
        || source.product_id !== expected.product_id || source.expires_at !== expected.expires_at
        || source.transaction_id !== expected.transaction_id || source.entitlement_hash !== expected.entitlement_hash
        || source.original_transaction_id !== (expected.original_transaction_id ?? null)
        || source.store !== expected.store || source.source_environment !== expected.source_environment
        || profile.source_fingerprint !== expected.source_fingerprint) {
      throw new LumenError("Fresh source profile scope or entitlement mismatch", 409);
    }
  }

  private drainReceipts(): void {
    try {
      for (const receipt of pendingReceipts(this.options.dbPath)) {
        if (!this.emitProjectionChange(receipt.body,receipt.result)) break;
        markReceiptEnqueued(this.options.dbPath,receipt.operationKey,this.wallNow());
      }
    } catch { /* The durable receipt remains pending without blocking access. */ }
  }

  private emitProjectionChange(body: ResyncBody, result: Record<string, unknown>): boolean {
    if (!result.before || !result.after || !isRecord(result.before) || !isRecord(result.after)) return false;
    const before = { ...result.before };
    if (before.source_hash === null) delete before.source_hash;
    const details: RecoveryDetails = {
      action_id: body.operation_key,
      source_hash: result.source_hash ?? body.entitlement.source_fingerprint ?? body.entitlement.entitlement_hash,
      expected_revision: before.projection_revision,
      policy_version: result.policy_version ?? "premium-policy-v1",
      adapter_version: result.adapter_version ?? "adapty-profile-read-v1",
      projection_version: result.projection_version ?? "lumen-handler-v2",
      cache_version: result.config_version ?? "premium-export-v2",
      outcome: "projection_updated",
      before,
      after: result.after,
      cache_invalidated: Boolean(isRecord(result.after) && result.after.invalidated),
      processing_id: result.processing_id,
      trace_id: result.trace_id,
      transaction_id: result.transaction_id,
      steps: result.steps,
      revisions: result.revisions,
    };
    try {
      const receipt = this.sdk.emit("access_projection_changed", body.user_id,
        typeof result.processed_at === "string" ? result.processed_at : this.wallNow(), details,
        { schemaVersion: 2, eventId: `processing:${String(result.processing_id)}`,
          correlationId: String(result.trace_id), sourceEventId: body.operation_key });
      return receipt.queued || receipt.accepted;
    } catch { return false; }
  }

  private emitGate(userId: string, result: Record<string, unknown>, initiator: "customer_demo" | "reconcile_probe"): void {
    try {
      const db = openDatabase(this.options.dbPath);
      let revisions: Record<string, unknown>;
      try {
        const mapping = db.prepare("SELECT revision FROM mappings WHERE user_id=?").get(userId) as { revision: number } | undefined;
        const policy = db.prepare("SELECT revision FROM policies WHERE user_id=?").get(userId) as { revision: number } | undefined;
        revisions = { identity: mapping?.revision ?? 0, policy: policy?.revision ?? 0,
          projection: result.projection_revision ?? 0, cache: result.cache_revision ?? 0 };
      } finally { db.close(); }
      this.sdk.emit("feature_access_decided", userId, this.wallNow(), {
        feature: FEATURE, decision: result.allowed ? "allow" : "deny", reason_code: result.reason,
        projection_version: "lumen-projection-v2", cache_version: "lumen-cache-v2",
        policy_version: "access-policy-v2", adapter_version: "lumen-adapter-v2", initiator, revisions,
      });
    } catch { /* Gate decisions are independent of telemetry. */ }
  }

  private emitSourceObservations(profiles: Record<string, unknown>[]): Map<string, Record<string, unknown>> {
    const events = new Map<string, Record<string, unknown>>();
    const reasons: Record<string, string> = {
      active: "allowed", subscription_expired: "subscription_expired",
      subscription_not_started: "subscription_inactive", trial_period: "subscription_inactive",
      grace_period: "subscription_inactive", identity_scope_mismatch: "identity_mismatch",
      premium_entitlement_absent: "none", premium_source_binding_uncertain: "source_unavailable",
    };
    for (const profile of profiles) {
      if (typeof profile.user_id !== "string" || typeof profile.source_fingerprint !== "string"
          || typeof profile.observed_at !== "string") continue;
      const entitlement = isRecord(profile.entitlement) ? profile.entitlement : {};
      const details: Record<string, unknown> = {
        source_hash: profile.source_fingerprint,
        starts_at: typeof entitlement.starts_at === "string" ? entitlement.starts_at : null,
        expires_at: typeof entitlement.expires_at === "string" ? entitlement.expires_at : null,
        adapter_version: "adapty-profile-read-v1", outcome: "observed",
        reason_code: reasons[String(profile.reason)] ?? "source_unavailable",
      };
      for (const [source, target] of [["transaction_id", "transaction_id"],
        ["original_transaction_id", "original_transaction_id"], ["source_environment", "source_environment"],
        ["store", "store"], ["access_level_id", "access_level"], ["source_revision", "source_version"]] as const) {
        if (typeof entitlement[source] === "string" && entitlement[source]) details[target] = entitlement[source];
      }
      if (typeof profile.provider_customer_id === "string" && profile.provider_customer_id) details.customer_id = profile.provider_customer_id;
      const eventId = `source:${digest({ customer: profile.user_id, source_hash: profile.source_fingerprint })}`;
      try {
        const sourceRecord = sourceEvent(this.options.dbPath, profile, eventId, profile.observed_at, details);
        events.set(`${profile.user_id}\u0000${profile.source_fingerprint}`, sourceRecord);
        this.sdk.emit("source_entitlement_observed", profile.user_id,
          String(sourceRecord.occurred_at), sourceRecord.details as RecoveryDetails,
          { eventId: String(sourceRecord.event_id), correlationId: String(sourceRecord.event_id), sourceEventId: String(sourceRecord.event_id) });
      } catch { /* Source observations are diagnostic metadata only. */ }
    }
    return events;
  }

  private configure(body: unknown): Record<string, unknown> {
    const keys = isRecord(body) ? new Set(Object.keys(body)) : new Set<string>();
    const validKeys = keys.size === 2 && keys.has("faults") && keys.has("paused")
      || keys.size === 3 && keys.has("faults") && keys.has("paused") && keys.has("prepare_projection_loss");
    if (!this.options.demo || !this.options.liveBootstrapPending || !isRecord(body) || !validKeys
        || typeof body.paused !== "boolean") throw new LumenError("Live simulation configuration is unavailable", 404);
    return configureSimulation(this.options.dbPath, body.faults, body.paused, body.prepare_projection_loss ?? []);
  }

  private inject(body: unknown): Record<string, unknown> {
    if (!this.options.demo || !isRecord(body)) throw new LumenError("Live fault controls are unavailable", 404);
    const required = new Set(["user_ids", "handler_version", "config_version", "occurred_at"]);
    const allowed = new Set([...required, "fault_kind",'operation_key','repair_failure_user']);
    if ([...required].some((key) => !(key in body)) || Object.keys(body).some((key) => !allowed.has(key))) {
      throw new LumenError("Live fault fields do not match the contract", 400);
    }
    const result = injectLiveFault(this.options.dbPath, body.user_ids, body.handler_version,
      body.config_version, body.occurred_at, body.fault_kind ?? "missed_projection",body.operation_key,body.repair_failure_user);
    if (result.duplicate !== true && Array.isArray(result.accounts)) {
      for (const item of result.accounts) if (isRecord(item)) this.emitFaultProjection(item, result);
    }
    const { accounts: _accounts, ...summary } = result;
    return summary;
  }

  private emitFaultProjection(item: Record<string, unknown>, result: Record<string, unknown>): void {
    if (!isRecord(item.before) || !isRecord(item.after)) return;
    const before = { ...item.before };
    if (before.source_hash === null) delete before.source_hash;
    try {
      this.sdk.emit("access_projection_changed", String(item.user_id), String(result.occurred_at), {
        action_id: `live-fault:${String(item.user_id)}:${String(item.projection_revision)}`,
        source_hash: item.source_hash, expected_revision: before.projection_revision,
        policy_version: item.policy_version, adapter_version: item.adapter_version,
        projection_version: result.handler_version, cache_version: result.config_version,
        outcome: "projection_updated", before, after: item.after,
        cache_invalidated: Boolean((item.after as Record<string, unknown>).invalidated),
      });
    } catch { /* Fault telemetry does not change the deterministic injected state. */ }
  }

  private sourceObserved(body: unknown): Record<string, unknown> {
    const profiles = this.parseSourceObservations(body, false);
    const events = this.emitSourceObservations(profiles);
    return { accepted: profiles.length, telemetry_emitted: events.size, handled: 0, failed: 0, writes: 0 };
  }

  private parseSourceObservations(body: unknown, requireProcessingId: boolean): Record<string, unknown>[] {
    if (!isRecord(body) || Object.keys(body).length !== 1 || !Array.isArray(body.items) || body.items.length > 100) {
      throw new LumenError("Source observation fields do not match the contract", 400);
    }
    const customerIds = this.options.liveConfig?.customerUserIds ?? [];
    const required = new Set(["user_id", "source_fingerprint", "observed_at", "starts_at", "expires_at",
      "reason", "status", "identity_match", "provider_customer_id"]);
    const optional = new Set(["transaction_id", "original_transaction_id", "store", "source_environment",
      "access_level", "product_id", "entitlement_hash", "processing_id"]);
    const profiles: Record<string, unknown>[] = [];
    for (const value of body.items) {
      if (!isRecord(value) || [...required].some((key) => !(key in value))
          || Object.keys(value).some((key) => !required.has(key) && !optional.has(key))
          || !validId(value.user_id) || !customerIds.includes(value.user_id)
          || typeof value.source_fingerprint !== "string" || !/^[a-f0-9]{64}$/u.test(value.source_fingerprint)
          || !validTimestamp(value.observed_at) || !(value.starts_at === null || validTimestamp(value.starts_at))
          || !(value.expires_at === null || validTimestamp(value.expires_at))
          || !validId(value.reason) || !["active", "inactive", "unknown"].includes(String(value.status))
          || typeof value.identity_match !== "boolean" || !validId(value.provider_customer_id)
          || requireProcessingId && !validId(value.processing_id)
          || [...optional].some((key) => key in value && !validId(value[key]))) {
        throw new LumenError("Source observation fields do not match the contract", 400);
      }
      const entitlement: Record<string, unknown> = {
        starts_at: value.starts_at, expires_at: value.expires_at, source_fingerprint: value.source_fingerprint,
      };
      for (const [source, target] of [["transaction_id", "transaction_id"],
        ["original_transaction_id", "original_transaction_id"], ["store", "store"],
        ["source_environment", "source_environment"], ["product_id", "product_id"],
        ["entitlement_hash", "entitlement_hash"], ["access_level", "access_level_id"]] as const) {
        if (source in value) entitlement[target] = value[source];
      }
      profiles.push({ user_id: value.user_id, source_fingerprint: value.source_fingerprint,
        observed_at: value.observed_at, reason: value.reason, status: value.status,
        identity_match: value.identity_match, provider_customer_id: value.provider_customer_id,
        entitlement, ...(typeof value.processing_id === "string" ? { processing_id: value.processing_id } : {}) });
    }
    return profiles;
  }

  private async handlerDeliver(body: unknown): Promise<Record<string, unknown>> {
    if (!this.options.demo || !this.options.liveBootstrapPending) {
      throw new LumenError("Normal handler simulation is unavailable", 404);
    }
    const profiles = this.parseSourceObservations(body, true);
    const sourceEvents = this.emitSourceObservations(profiles);
    const db = openDatabase(this.options.dbPath);
    let paused: boolean;
    try { paused = Boolean(readMeta(db, "live_handler_paused", false)); }
    finally { db.close(); }
    let handled = 0;
    let failed = 0;
    let diagnosticOnly = 0;
    const failureClasses: Record<string, number> = {};
    if (!paused) {
      for (const profile of profiles) {
        const key = `${profile.user_id}\u0000${profile.source_fingerprint}`;
        const source = sourceEvents.get(key) ?? null;
        const result = await this.handleSourceObservation(profile, source);
        if (result.outcome === "completed") handled += 1;
        else if (result.outcome === "failed") {
          failed += 1;
          const candidate = String(result.error_class ?? result.reason ?? "other");
          const category = FAILURE_CLASSES.has(candidate) ? candidate : "other";
          failureClasses[category] = (failureClasses[category] ?? 0) + 1;
        } else diagnosticOnly += 1;
      }
    }
    return { accepted: profiles.length, handled, failed, diagnostic_only: diagnosticOnly, failure_classes: failureClasses, paused };
  }

  private async handleSourceObservation(profile: Record<string, unknown>, source: Record<string, unknown> | null): Promise<Record<string, unknown>> {
    const userId = profile.user_id;
    const entitlement = isRecord(profile.entitlement) ? profile.entitlement : {};
    const transactionId = entitlement.transaction_id;
    const fingerprint = profile.source_fingerprint;
    const processingId = String(profile.processing_id);
    const previous = liveHandlerResult(this.options.dbPath, processingId);
    if (previous) {
      if (previous.user_id !== userId || previous.transaction_id !== transactionId
          || previous.source_fingerprint !== fingerprint) {
        throw new LumenError("Processing ID is already bound to different source evidence", 409);
      }
      if (source && profile.status === "active" && profile.identity_match === true) {
        this.emitHandlerCompleted(profile, processingId, source, previous.result);
      }
      return previous.result;
    }
    if (!validId(userId) || !validId(transactionId) || typeof fingerprint !== "string"
        || !/^[a-f0-9]{64}$/u.test(fingerprint) || !source || profile.status !== "active"
        || profile.identity_match !== true || profile.provider_customer_id !== userId) {
      return { user_id: userId, outcome: "diagnostic_only", reason: "source_transaction_not_eligible" };
    }
    const receivedAt = this.wallNow();
    const traceId = `trace:${digest({ processing_id: processingId })}`;
    const local = (accounts(this.options.dbPath, null, 500).items as Record<string, unknown>[])
      .find((item) => item.user_id === userId);
    if (!local) return { user_id: userId, outcome: "failed", reason: "identity_unknown" };
    const current = access(this.options.dbPath, String(userId));
    const sameProjection = current.active === true && current.expires_at === entitlement.expires_at
      && current.entitlement_hash === entitlement.entitlement_hash;
    if (sameProjection && current.allowed === true && local.identity_status === "mapped" && local.policy_enabled === true) {
      const result: Record<string, unknown> = {
        user_id: userId, outcome: "completed", received_at: receivedAt, processed_at: receivedAt,
        trace_id: traceId, transaction_id: transactionId,
        steps: [
          { name: "receive", status: "completed", owner: "lumen", result: "accepted" },
          { name: "source_observation", status: "completed", owner: "source", result: "observed" },
          { name: "identity_check", status: "completed", owner: "engine", result: "verified", revision: local.identity_revision },
          { name: "policy_check", status: "completed", owner: "lumen", result: "verified", revision: local.policy_revision },
          { name: "projection_readback", status: "completed", owner: "lumen", result: "matched", revision: local.projection_revision },
          { name: "gate_readback", status: "completed", owner: "lumen", result: "allowed", revision: local.cache_revision },
        ],
        revisions: { identity: local.identity_revision, policy: local.policy_revision,
          projection: local.projection_revision, cache: local.cache_revision },
      };
      return this.finishHandler(profile, processingId, source, result, transactionId, fingerprint);
    }

    const requiredEntitlement = ["product_id", "expires_at", "entitlement_hash", "transaction_id",
      "source_fingerprint", "store", "source_environment"] as const;
    if (requiredEntitlement.some((key) => typeof entitlement[key] !== "string" || !entitlement[key])) {
      return { user_id: userId, outcome: "diagnostic_only", reason: "source_transaction_not_eligible" };
    }
    const requestedEntitlement: Record<string, string> = {};
    for (const key of requiredEntitlement) requestedEntitlement[key] = String(entitlement[key]);
    if (typeof entitlement.original_transaction_id === "string" && entitlement.original_transaction_id) {
      requestedEntitlement.original_transaction_id = entitlement.original_transaction_id;
    }
    const operationKey = `source-handler:${digest({ user_id: userId, processing_id: processingId })}`;
    const body: ResyncBody = {
      schema_version: 2, user_id: String(userId), expected_provider_customer_id: String(local.provider_customer_id),
      expected_identity_revision: local.identity_revision, expected_policy_revision: local.policy_revision,
      expected_projection_revision: local.projection_revision, entitlement: requestedEntitlement,
      operation_key: operationKey, processing_id: processingId, trace_id: traceId,
    };
    try {
      const response = await this.handleResync(body);
      if (response.close) throw new HandlerTimeoutError();
      if (!isRecord(response.body)) throw new TypeError("Invalid projection response");
      const committed = response.body;
      const state = access(this.options.dbPath, String(userId));
      const projectionMatches = state.active === true && state.expires_at === entitlement.expires_at
        && state.entitlement_hash === entitlement.entitlement_hash;
      const gateAllowed = state.allowed;
      const steps = Array.isArray(committed.steps) ? [...committed.steps] : [];
      this.appendReadbackSteps(steps, state, projectionMatches, gateAllowed, false);
      const cacheSkipped = committed.cache_skipped === true;
      const outcome = projectionMatches && gateAllowed === true && !cacheSkipped ? "completed" : "failed";
      const reason = cacheSkipped ? "cache_refresh_skipped"
        : projectionMatches && gateAllowed === true ? undefined : "gate_or_projection_mismatch";
      const result: Record<string, unknown> = {
        user_id: userId, outcome, received_at: receivedAt, processed_at: this.wallNow(), trace_id: traceId,
        transaction_id: transactionId, steps, revisions: this.revisionsFrom(state), operation_key: operationKey,
        projection_revision: committed.projection_revision, cache_revision: committed.cache_revision,
        cache_skipped: cacheSkipped, ...(reason ? { reason } : {}),
      };
      return this.finishHandler(profile, processingId, source, result, transactionId, fingerprint);
    } catch (error) {
      const committed = action(this.options.dbPath, operationKey);
      const didCommit = Boolean(committed && committed.operation_key === operationKey
        && committed.processing_id === processingId && committed.user_id === userId
        && committed.transaction_id === transactionId && committed.source_hash === fingerprint);
      let state: Record<string, unknown> | null = null;
      try { state = access(this.options.dbPath, String(userId)); } catch { /* Report only the readback that succeeded. */ }
      const projectionMatches = Boolean(state && state.active === true && state.expires_at === entitlement.expires_at
        && state.entitlement_hash === entitlement.entitlement_hash);
      const gateAllowed = state?.allowed;
      const sourceUnavailable = error instanceof SourceReadUnavailable;
      const timedOut = error instanceof HandlerTimeoutError;
      const knownFailure = error instanceof LumenError || error instanceof InternalHTTPError
        || error instanceof TypeError || error instanceof RangeError || error instanceof SyntaxError;
      const outcome = didCommit && projectionMatches && gateAllowed === true ? "completed"
        : didCommit && (!state || gateAllowed === undefined) ? "diagnostic_only"
          : didCommit ? "failed" : sourceUnavailable ? "diagnostic_only"
            : knownFailure ? "failed" : "diagnostic_only";
      const reason = didCommit && projectionMatches && gateAllowed === true ? "committed_readback"
        : didCommit && (!state || gateAllowed === undefined) ? "readback_unknown"
          : didCommit ? "gate_or_projection_mismatch" : sourceUnavailable ? "source_unavailable"
            : knownFailure ? "handler_failure" : "readback_unknown";
      const localSteps = Array.isArray(committed?.steps) ? [...committed.steps] : [
        { name: "receive", status: "completed", owner: "lumen", result: "accepted" },
        { name: "source_observation", status: "completed", owner: "source", result: "observed" },
        { name: "handler", status: outcome === "failed" ? "failed" : "unknown", owner: "lumen",
          result: outcome === "failed" ? "failed" : "unknown",
          reason_code: outcome === "failed" ? "handler_failure" : "readback_unknown" },
      ];
      if (!didCommit && sourceUnavailable) localSteps.splice(2, 0,
        { name: "fresh_source_read", status: "unknown", owner: "source", result: "unavailable", reason_code: "source_unavailable" });
      if (state) this.appendReadbackSteps(localSteps, state, projectionMatches, gateAllowed, didCommit && timedOut);
      else localSteps.push(
        { name: "projection_readback", status: "unknown", owner: "lumen", result: "unavailable", reason_code: "readback_unknown" },
        { name: "gate_readback", status: "unknown", owner: "lumen", result: "unknown", reason_code: "readback_unknown" },
      );
      const revisions = state ? this.revisionsFrom(state) : {
        identity: local.identity_revision, policy: local.policy_revision,
        projection: local.projection_revision, cache: local.cache_revision,
      };
      const result: Record<string, unknown> = {
        user_id: userId, outcome, received_at: receivedAt, processed_at: this.wallNow(), trace_id: traceId,
        transaction_id: transactionId, reason, steps: localSteps, revisions, operation_key: operationKey,
        error_class: this.handlerErrorClass(error),
      };
      return this.finishHandler(profile, processingId, source, result, transactionId, fingerprint);
    }
  }

  private appendReadbackSteps(steps: unknown[], state: Record<string, unknown>, projectionMatches: boolean,
    gateAllowed: unknown, timedOut: boolean): void {
    steps.push({ name: "projection_readback", status: "completed", owner: "lumen",
      result: projectionMatches ? "matched" : "mismatched", revision: state.projection_revision,
      ...(!projectionMatches ? { reason_code: "projection_mismatch" } : {}) });
    steps.push({ name: "gate_readback", status: gateAllowed === undefined ? "unknown" : "completed", owner: "lumen",
      revision: state.cache_revision,
      result: gateAllowed === true ? "allowed" : gateAllowed === false ? "denied" : "unknown",
      ...(timedOut ? { reason_code: "timeout_after_commit" }
        : gateAllowed === false ? { reason_code: "gate_denied" }
          : gateAllowed === undefined ? { reason_code: "readback_unknown", gap: true } : {}) });
  }

  private revisionsFrom(state: Record<string, unknown>): Record<string, unknown> {
    return { identity: state.identity_revision, policy: state.policy_revision,
      projection: state.projection_revision, cache: state.cache_revision };
  }

  private handlerErrorClass(error: unknown): string {
    if (error instanceof SourceReadUnavailable) return "SourceReadUnavailable";
    if (error instanceof HandlerTimeoutError) return "TimeoutError";
    if (error instanceof LumenError) return `recovery_http_${error.status}`;
    if (error instanceof InternalHTTPError) return `internal_http_${error.status}`;
    if (error instanceof TypeError || error instanceof RangeError || error instanceof SyntaxError) return error.name;
    return "OperationalError";
  }

  private emitHandlerCompleted(profile: Record<string, unknown>, processingId: string,
    source: Record<string, unknown>, result: Record<string, unknown>): boolean {
    const entitlement = isRecord(profile.entitlement) ? profile.entitlement : {};
    const transactionId = entitlement.transaction_id;
    if (!this.sdk || !validId(profile.source_fingerprint) || !validId(transactionId)) return false;
    const outcome = result.outcome === "diagnostic_only" ? "unknown" : result.outcome === "completed" ? "completed" : "failed";
    const details = {
      event_type: "source_entitlement_observed", handler_version: "lumen-handler-v2",
      received_at: result.received_at ?? source.occurred_at, processed_at: result.processed_at ?? source.occurred_at,
      outcome, reason_code: outcome === "unknown" ? "source_unavailable" : outcome === "failed" ? "handler_failure" : "handler_completed",
      projection_version: "lumen-handler-v2", adapter_version: "adapty-profile-read-v1",
      transaction_id: transactionId, source_hash: profile.source_fingerprint, processing_id: processingId,
      trace_id: result.trace_id, steps: result.steps, revisions: result.revisions,
    };
    try {
      const receipt = this.sdk.emit("handler_completed", String(profile.user_id), String(details.processed_at), details,
        { schemaVersion: 2, eventId: `handler:${processingId}`, sourceEventId: String(source.event_id),
          correlationId: String(result.trace_id) });
      return receipt.accepted || receipt.queued;
    } catch { return false; }
  }

  private finishHandler(profile: Record<string, unknown>, processingId: string, source: Record<string, unknown>,
    result: Record<string, unknown>, transactionId: string, fingerprint: string): Record<string, unknown> {
    result.processed_at = this.wallNow();
    result.telemetry_gap = !this.emitHandlerCompleted(profile, processingId, source, result);
    const saved = saveLiveHandlerResult(this.options.dbPath, {
      processing_id: processingId, user_id: String(profile.user_id), transaction_id: transactionId,
      source_fingerprint: fingerprint, outcome: String(result.outcome),
      result, recorded_at: String(result.received_at ?? result.processed_at),
    });
    return saved.result;
  }

  private advanceClock(body: unknown): Record<string, unknown> {
    if (!this.options.demo || !isRecord(body) || Object.keys(body).length !== 1
        || !Number.isSafeInteger(body.seconds) || Number(body.seconds) < 1 || Number(body.seconds) > 86400) {
      throw new LumenError("Advance fields do not match the contract", 400);
    }
    const db = openDatabase(this.options.dbPath);
    try {
      db.exec("BEGIN IMMEDIATE");
      const elapsed = Number(readMeta(db, "logical_elapsed_seconds", 0)) + Number(body.seconds);
      writeMeta(db, "logical_elapsed_seconds", elapsed);
      const logicalNow = new Date(Date.parse(String(readMeta(db, "scenario_now"))) + elapsed * 1000)
        .toISOString().replace(/\.\d{3}Z$/u, "Z");
      writeMeta(db, "last_advance_at", logicalNow);
      db.exec("COMMIT");
      return { logical_now: logicalNow };
    } catch (error) { db.exec("ROLLBACK"); throw error; }
    finally { db.close(); }
  }

  private wallNow(): string {
    return new Date(this.now()).toISOString().replace(/\.\d{3}Z$/u, "Z");
  }
}

function parseLimit(value: string | null): number {
  if (value === null) return 500;
  if (!/^\d+$/u.test(value)) throw new LumenError("Invalid limit", 400);
  const limit = Number(value);
  if (!Number.isInteger(limit) || limit < 1 || limit > 1000) throw new LumenError("Invalid limit", 400);
  return limit;
}

async function readRequest(request: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let length = 0;
  for await (const chunk of request) {
    const buffer = Buffer.from(chunk);
    length += buffer.length;
    if (length > BODY_LIMIT) throw new LumenError("Request body too large", 413);
    chunks.push(buffer);
  }
  return Buffer.concat(chunks, length);
}

function writeResponse(response: ServerResponse, status: number, body: unknown): void {
  const raw = Buffer.from(JSON.stringify(body) ?? "{}", "utf8");
  response.writeHead(status, { "Content-Type": "application/json", "Content-Length": String(raw.byteLength), "Cache-Control": "no-store" });
  response.end(raw);
}

export async function createLumenService(options: LumenOptions): Promise<LumenService> {
  return LumenService.create(options);
}
