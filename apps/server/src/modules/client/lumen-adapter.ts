import { loopbackUrl, signInternal } from '../../infrastructure/internal-auth.js';
import { semanticDigest, semanticJson } from '../../infrastructure/json.js';
import { readResponseText } from '../../infrastructure/http-body.js';
import { parseTimestamp } from '../../infrastructure/time.js';

const FEATURE = 'premium_export';
const MAX_BODY_BYTES = 1024 * 1024;
const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const validId = (value: unknown): value is string =>
  typeof value === 'string' && value.length > 0 && value.length <= 256 && value === value.trim()
    && !/[\u0000-\u001f\u007f]/.test(value);
const revision = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
const positiveRevision = (value: unknown): value is number => revision(value) && value >= 1;
const hash = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);

export interface ResyncRequest {
  schema_version: 2;
  user_id: string;
  expected_provider_customer_id: string;
  expected_identity_revision: number;
  expected_policy_revision: number;
  expected_projection_revision: number;
  entitlement: { product_id: string; expires_at: string; entitlement_hash: string;
    transaction_id: string; source_fingerprint: string; store: 'app_store' | 'play_store';
    source_environment: string; original_transaction_id?: string };
  operation_key: string;
  processing_id: string;
  trace_id: string;
}

export interface DemoInjection {
  user_ids:string[]; handler_version:string; config_version:string; occurred_at:string;
  fault_kind:'stale_cache' | 'missed_projection' | 'out_of_order'; operation_key:string; repair_failure_user?:string;
}

export function injectionHash(body:DemoInjection):string {
  return semanticDigest({ userIds:body.user_ids,handlerVersion:body.handler_version,configVersion:body.config_version,
    occurredAt:body.occurred_at,faultKind:body.fault_kind,repairFailureUser:body.repair_failure_user ?? null });
}

export function validResyncRequest(value: unknown, sourceEnvironment: string): value is ResyncRequest {
  if (!isRecord(value)) return false;
  const entitlement = value.entitlement;
  return value.schema_version === 2 && validId(value.user_id)
    && value.expected_provider_customer_id === value.user_id
    && positiveRevision(value.expected_identity_revision) && positiveRevision(value.expected_policy_revision)
    && positiveRevision(value.expected_projection_revision) && validId(value.operation_key)
    && validId(value.processing_id) && validId(value.trace_id) && isRecord(entitlement)
    && validId(entitlement.product_id) && validId(entitlement.transaction_id)
    && hash(entitlement.entitlement_hash) && hash(entitlement.source_fingerprint)
    && ['app_store', 'play_store'].includes(String(entitlement.store))
    && entitlement.source_environment === sourceEnvironment && Number.isFinite(parseTimestamp(entitlement.expires_at))
    && (!('original_transaction_id' in entitlement) || validId(entitlement.original_transaction_id))
    && !Object.keys(entitlement).some(key => !['product_id','expires_at','entitlement_hash','transaction_id',
      'source_fingerprint','store','source_environment','original_transaction_id'].includes(key))
    && !Object.keys(value).some(key => !['schema_version','user_id','expected_provider_customer_id',
      'expected_identity_revision','expected_policy_revision','expected_projection_revision','entitlement',
      'operation_key','processing_id','trace_id'].includes(key));
}

export class LumenAdapterError extends Error {
  constructor(readonly outcome: 'rejected' | 'unavailable' | 'unknown_outcome', readonly status?: number) {
    super(`Lumen operation ${outcome}`);
  }
}

/** Signed transport only: recovery policy and source verification remain engine responsibilities. */
export class LumenAdapter {
  private readonly base: URL;

  constructor(base: string, private readonly key: Uint8Array, private readonly sourceEnvironment: string,
    private readonly fetcher: typeof fetch = fetch, private readonly now: () => number = Date.now) {
    this.base = loopbackUrl(base);
    if (key.byteLength < 32 || !validId(sourceEnvironment)) throw new Error('Invalid internal adapter configuration');
  }

  private async request(method: 'GET' | 'POST', path: string, body?: unknown,
    write = false, allowNull = false): Promise<Record<string, unknown> | null> {
    let raw: string;
    try { raw = body === undefined ? '' : semanticJson(body); }
    catch { throw new LumenAdapterError('rejected'); }
    if (Buffer.byteLength(raw) > MAX_BODY_BYTES) throw new LumenAdapterError('rejected');
    const timestamp = Math.floor(this.now() / 1000);
    const signature = signInternal(this.key, method, path, timestamp, Buffer.from(raw));
    let response: Response;
    try {
      response = await this.fetcher(new URL(path, this.base), { method, redirect:'error',
        signal:AbortSignal.timeout(write ? 65_000 : 15_000),
        headers:{ 'X-Recovery-Timestamp':String(timestamp), 'X-Recovery-Signature':signature,
          ...(body === undefined ? {} : { 'Content-Type':'application/json' }) },
        ...(body === undefined ? {} : { body:raw }) });
    } catch {
      throw new LumenAdapterError(write ? 'unknown_outcome' : 'unavailable');
    }
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      const unavailable = response.status >= 500 || response.status === 429;
      throw new LumenAdapterError(unavailable ? write ? 'unknown_outcome' : 'unavailable' : 'rejected', response.status);
    }
    try {
      const text = await readResponseText(response, MAX_BODY_BYTES);
      const value: unknown = text ? JSON.parse(text) : {};
      if (allowNull && value === null) return null;
      if (!isRecord(value)) throw new Error('Invalid response');
      return value;
    } catch {
      throw new LumenAdapterError(write ? 'unknown_outcome' : 'unavailable');
    }
  }

  async listAccounts(cursor: string | null, limit = 500): Promise<Record<string, unknown>> {
    if (cursor !== null && !/^\d+$/.test(cursor) || !Number.isInteger(limit) || limit < 1 || limit > 1000) {
      throw new LumenAdapterError('rejected');
    }
    const params = new URLSearchParams({ limit:String(limit) });
    if (cursor !== null) params.set('cursor', cursor);
    const result = await this.request('GET', `/internal/lumen/accounts?${params}`);
    if (!result || !Array.isArray(result.items) || !Number.isSafeInteger(result.total)
        || !(result.next_cursor === null || typeof result.next_cursor === 'string')) {
      throw new LumenAdapterError('unavailable');
    }
    return result;
  }

  async manifest():Promise<Record<string,unknown>> {
    const result = await this.request('GET','/internal/manifest');
    if (!result || !validId(result.app) || !validId(result.environment) || !validId(result.run_id)) {
      throw new LumenAdapterError('unavailable');
    }
    return result;
  }

  async readAccess(userId: string): Promise<Record<string, unknown>> {
    if (!validId(userId)) throw new LumenAdapterError('rejected');
    return this.validateGate(await this.request('GET', `/internal/lumen/access?${new URLSearchParams({ user:userId })}`), userId);
  }

  async probeAccess(userId: string): Promise<Record<string, unknown>> {
    if (!validId(userId)) throw new LumenAdapterError('rejected');
    return this.validateGate(await this.request('POST', '/internal/lumen/probe', {
      user_id:userId, feature:FEATURE, initiator:'reconcile_probe'
    }), userId);
  }

  private validateGate(result: Record<string, unknown> | null, userId: string): Record<string, unknown> {
    if (!result || result.user_id !== userId || typeof result.allowed !== 'boolean'
        || !revision(result.projection_revision) || !revision(result.cache_revision)) {
      throw new LumenAdapterError('unavailable');
    }
    return result;
  }

  async resyncAccess(body: ResyncRequest): Promise<Record<string, unknown>> {
    if (!validResyncRequest(body, this.sourceEnvironment)) {
      throw new LumenAdapterError('rejected');
    }
    const result = await this.request('POST', '/internal/lumen/resync', body, true);
    if (!result || result.accepted !== true || result.schema_version !== 2 || result.user_id !== body.user_id
        || result.operation_key !== body.operation_key || result.processing_id !== body.processing_id
        || result.trace_id !== body.trace_id || !revision(result.projection_revision)
        || result.projection_revision <= body.expected_projection_revision) {
      throw new LumenAdapterError('unknown_outcome');
    }
    return result;
  }

  async readAction(operationKey: string): Promise<Record<string, unknown> | null> {
    if (!validId(operationKey)) throw new LumenAdapterError('rejected');
    const result = await this.request('GET', `/internal/lumen/action?${new URLSearchParams({ operation_key:operationKey })}`, undefined, false, true);
    if (result && (result.accepted !== true || result.operation_key !== operationKey)) {
      throw new LumenAdapterError('unavailable');
    }
    return result;
  }

  async injectDemo(body:DemoInjection):Promise<Record<string,unknown>> {
    if (!Array.isArray(body.user_ids) || body.user_ids.length < 2 || body.user_ids.length > 24
        || body.user_ids.some(id => !validId(id)) || new Set(body.user_ids).size !== body.user_ids.length
        || !validId(body.handler_version) || !validId(body.config_version) || !validId(body.operation_key)
        || !Number.isFinite(parseTimestamp(body.occurred_at))
        || !['stale_cache','missed_projection','out_of_order'].includes(body.fault_kind)
        || (body.repair_failure_user !== undefined && !body.user_ids.includes(body.repair_failure_user))) {
      throw new LumenAdapterError('rejected');
    }
    const result = await this.request('POST','/internal/lumen/live/inject',body,true);
    if (!result || result.injected !== true || result.operation_key !== body.operation_key
        || result.request_hash !== injectionHash(body) || result.account_count !== body.user_ids.length) {
      throw new LumenAdapterError('unknown_outcome');
    }
    return result;
  }

  async readInjection(operationKey:string):Promise<Record<string,unknown> | null> {
    if (!validId(operationKey)) throw new LumenAdapterError('rejected');
    const result = await this.request('GET',`/internal/lumen/simulation/injection?${new URLSearchParams({ operation_key:operationKey })}`,
      undefined,false,true);
    if (result && (result.injected !== true || result.operation_key !== operationKey || !hash(result.request_hash))) {
      throw new LumenAdapterError('unavailable');
    }
    return result;
  }

  async collectorCoverage():Promise<Record<string,unknown>> {
    const result = await this.request('GET','/internal/lumen/collector-coverage');
    if (!result || !Number.isSafeInteger(result.queued) || Number(result.queued) < 0
        || !Number.isSafeInteger(result.receipt_backlog) || Number(result.receipt_backlog) < 0) {
      throw new LumenAdapterError('unavailable');
    }
    return result;
  }
}
