import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { closeSync, openSync } from 'node:fs';
import { lstat, mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { semanticDigest, semanticJson } from '../../infrastructure/json.js';
import { SQLiteStorage } from '../../infrastructure/sqlite.js';

type Row = Record<string, any>;
type Headers = Record<string, string | string[] | undefined>;
const MARKER = 'reconcile-legacy-access-v1';
const APP = 'mock-lumen-access', ENVIRONMENT = 'Production', FEATURE = 'premium_export';
const POLICY_VERSION = 'access-policy-v1', ADAPTER_VERSION = 'lumen-adapter-v1';
const PROJECTION_VERSION = 'lumen-projection-v1', CACHE_VERSION = 'lumen-cache-v1';
const FAULTY_HANDLER = 'cancel-handler-v1', FIXED_HANDLER = 'cancel-handler-v2';
const TTL = 900, PLAN_TTL = 300;
const SCENARIO_NOW = '2026-11-03T00:12:04Z', DEFAULT_START = '2026-11-03T00:05:00Z';
const DEFAULT_END = '2026-11-03T00:10:00Z';
const PROVENANCE = 'synthetic reconstruction from the supplied incident document; no downloaded or live source ledger';
const AFFECTED = ['u00000','u00295','u00308','u00315','u00348','u00420','u00426','u00436','u00591','u00663','u00773','u00798',
  'u00950','u00998','u01029','u01064','u01078','u01217','u01223','u01224','u01238','u01256','u01367','u01459'];
const KINDS = ['webhook_received','handler_completed','access_projection_changed','feature_access_decided',
  'resync_requested','resync_completed','verification_completed','source_entitlement_observed'];
const DETAIL_FIELDS = ['transaction_id','original_transaction_id','currency','amount','starts_at','expires_at','source_hash',
  'handler_version','projection_version','cache_version','before','after','feature','decision','reason_code','action_id',
  'outcome','policy_version','adapter_version','initiator','received_at','processed_at','event_type','expected_revision',
  'actual_revision','cache_invalidated'];
const STATE_FIELDS = ['active','premium','expires_at','revision','cache_revision','projection_revision','source_hash','invalidated','cached_at'];
const EVENT_FIELDS = ['event_id','run_id','app','environment','app_user_id','kind','occurred_at','correlation_id','source_event_id','details'];
const URL_NAMESPACE = Buffer.from('6ba7b8119dad11d180b400c04fd430c8', 'hex');

export class AccessDemoError extends Error {
  constructor(message: string, readonly status = 400) { super(message); }
}

export interface AccessDemoOptions {
  /** A dedicated fresh SQLite file, or `:memory:` for one isolated demo instance. */
  databasePath: string;
}

export interface AccessDemoResponse {
  status: number;
  contentType: string;
  /** JSON routes return objects. */
  body: unknown;
}

function isRecord(value: unknown): value is Row { return typeof value === 'object' && value !== null && !Array.isArray(value); }
function clone<T>(value: T): T { return JSON.parse(semanticJson(value)) as T; }
function digest(value: unknown): string { return semanticDigest(value); }
function validText(value: unknown, name: string, limit = 256): string {
  if (typeof value !== 'string' || !value.trim() || value.length > limit) throw new AccessDemoError(`Invalid collector ${name}`);
  return value;
}
function iso(value: Date): string { return value.toISOString().replace(/\.\d{3}Z$/, 'Z'); }
function parseTime(value: unknown, label: string): Date {
  if (typeof value !== 'string' || !value.trim() || !/(?:Z|[+-]\d{2}:\d{2})$/i.test(value.trim())) {
    throw new AccessDemoError(`Invalid ${label}`);
  }
  const timestamp = Date.parse(value.trim());
  if (!Number.isFinite(timestamp)) throw new AccessDemoError(`Invalid ${label}`);
  return new Date(timestamp);
}
function now(state: Row): Date { return new Date(Date.parse(state.manifest.scenario_now) + state.logical_elapsed_seconds * 1000); }
function nowText(state: Row): string { return iso(now(state)); }
function eventUuid(state: Row, name: string, userId: string): string {
  const sequence = state.event_seq++;
  const hash = createHash('sha1').update(URL_NAMESPACE).update(`${state.manifest.run_id}/lumen/${sequence}/${name}/${userId}`).digest();
  const bytes = Buffer.from(hash.subarray(0, 16));
  bytes[6] = (bytes[6]! & 0x0f) | 0x50; bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0,8)}-${hex.slice(8,12)}-${hex.slice(12,16)}-${hex.slice(16,20)}-${hex.slice(20)}`;
}

function validateEvent(event: unknown, state: Row): asserts event is Row {
  if (!isRecord(event) || Object.keys(event).sort().join(',') !== [...EVENT_FIELDS].sort().join(',')) {
    throw new AccessDemoError('Collector event fields do not match the metadata contract');
  }
  for (const key of EVENT_FIELDS.filter(item => item !== 'details')) validText(event[key], key);
  if (event.run_id !== state.manifest.run_id || event.app !== APP || event.environment !== ENVIRONMENT) {
    throw new AccessDemoError('Collector scope mismatch');
  }
  if (!KINDS.includes(event.kind)) throw new AccessDemoError('Unsupported collector event kind');
  parseTime(event.occurred_at, 'occurrence timestamp');
  if (!isRecord(event.details) || Object.keys(event.details).some(key => !DETAIL_FIELDS.includes(key))) {
    throw new AccessDemoError('Only allowlisted subscription/access metadata is accepted');
  }
  for (const [key, value] of Object.entries(event.details)) {
    if (key === 'before' || key === 'after') {
      if (!isRecord(value) || Object.keys(value).some(name => !STATE_FIELDS.includes(name))) throw new AccessDemoError('Invalid client-state metadata');
      if (Object.values(value).some(item => !scalar(item))) throw new AccessDemoError('Collector metadata must be scalar');
    } else if (!scalar(value)) throw new AccessDemoError('Collector metadata must be scalar');
  }
  if (Buffer.byteLength(semanticJson(event)) > 16 * 1024) throw new AccessDemoError('Collector event is too large');
}
function scalar(value: unknown): boolean {
  return value === null || typeof value === 'string' || typeof value === 'boolean'
    || (typeof value === 'number' && Number.isFinite(value));
}
function sign(key: string, envelope: unknown): string {
  return createHmac('sha256', Buffer.from(key, 'hex')).update(semanticJson(envelope)).digest('hex');
}
function ingest(state: Row, envelope: unknown, signature: unknown, atSeconds = Date.now() / 1000): Row {
  if (!isRecord(envelope) || Object.keys(envelope).sort().join(',') !== 'event,sent_at') throw new AccessDemoError('Invalid collector envelope');
  if (!Number.isSafeInteger(envelope.sent_at) || Math.abs(atSeconds - envelope.sent_at) > 300) throw new AccessDemoError('Collector signature expired', 401);
  let body: string;
  try { body = semanticJson(envelope); } catch { throw new AccessDemoError('Invalid collector envelope'); }
  if (Buffer.byteLength(body) > 20 * 1024) throw new AccessDemoError('Invalid collector envelope');
  const expected = Buffer.from(sign(state._collector_key, envelope), 'hex');
  if (typeof signature !== 'string' || !/^[a-f0-9]{64}$/.test(signature)
      || !timingSafeEqual(expected, Buffer.from(signature, 'hex'))) throw new AccessDemoError('Invalid collector signature', 401);
  validateEvent(envelope.event, state);
  const event = clone(envelope.event), eventHash = digest(event);
  const hasPrevious = Object.hasOwn(state.collector.seen, event.event_id), previous = state.collector.seen[event.event_id];
  if (hasPrevious) {
    if (previous !== eventHash) throw new AccessDemoError('Collector event ID already has a different payload', 409);
    return { accepted: true, duplicate: true, event_id: event.event_id, event_hash: eventHash };
  }
  const recorded = { ...event, payload_hash: eventHash, recorded_at_wall: iso(new Date()), signature_verified: true, provenance: 'client_simulator' };
  state.collector.events.push(recorded);
  Object.defineProperty(state.collector.seen, event.event_id, { value: eventHash, enumerable: true, writable: true, configurable: true });
  return { accepted: true, duplicate: false, event_id: event.event_id, event_hash: eventHash };
}
function emit(state: Row, kind: string, userId: string, occurredAt: string, details: Row, options: Row = {}): Row {
  const id = options.event_id ?? eventUuid(state, kind, userId);
  const event = { event_id: id, run_id: state.manifest.run_id, app: APP, environment: ENVIRONMENT,
    app_user_id: userId, kind, occurred_at: occurredAt,
    correlation_id: options.correlation_id ?? id, source_event_id: options.source_event_id ?? id, details };
  const envelope = { event, sent_at: Math.floor(Date.now() / 1000) };
  return ingest(state, envelope, sign(state._collector_key, envelope));
}

function sourceCurrent(source: Row | null | undefined, at: Date): boolean {
  if (!source || source.period_type !== 'annual' || source.product_id !== 'premium.annual'
      || source.environment !== ENVIRONMENT || source.status !== 'active') return false;
  try { const starts = parseTime(source.starts_at, 'source starts_at'), expires = parseTime(source.expires_at, 'source expires_at');
    return starts <= at && at < expires; } catch { return false; }
}
function freshness(source: Row | null | undefined, at: Date): string {
  if (!source) return 'unavailable';
  try { const seconds = (at.getTime() - parseTime(source.observed_at, 'source observed_at').getTime()) / 1000;
    return seconds >= 0 && seconds <= TTL ? 'fresh' : 'stale'; } catch { return 'unavailable'; }
}
function identityStatus(state: Row, userId: string): string {
  const mapping = state.mappings[userId];
  if (!mapping || mapping.status !== 'mapped') return mapping?.status ?? 'unavailable';
  const providerId = mapping.provider_user_id;
  if (typeof providerId !== 'string' || !providerId) return 'unavailable';
  const source = state.source_entitlements[userId];
  if (source && source.provider_user_id !== providerId) return 'source_mismatch';
  const owners = Object.values(state.mappings).filter((item: any) => item.status === 'mapped' && item.provider_user_id === providerId);
  return owners.length === 1 ? 'mapped' : 'ambiguous';
}
function sourceForUser(state: Row, userId: string): Row | null {
  return identityStatus(state, userId) === 'mapped' ? clone(state.source_entitlements[userId] ?? null) : null;
}
function snapshot(value: Row | null | undefined): Row {
  if (!value) return {};
  return Object.fromEntries(STATE_FIELDS.filter(key => key in value).map(key => [key, value[key]]));
}
function projectionFromSource(source: Row | null, at: Date): Row {
  const active = sourceCurrent(source, at);
  return { active, premium: active, expires_at: source?.expires_at ?? null, revision: 1, projection_revision: 1,
    source_hash: source?.source_hash ?? 'unavailable' };
}
function cacheFromProjection(projection: Row, at: Date): Row {
  return { active: projection.active, premium: projection.premium, expires_at: projection.expires_at,
    cache_revision: 1, projection_revision: projection.projection_revision, source_hash: projection.source_hash,
    invalidated: false, cached_at: iso(at) };
}
function assessGate(state: Row, userId: string, feature = FEATURE): Row {
  const at = now(state), identity = identityStatus(state, userId);
  if (identity !== 'mapped') return { allowed: false, reason: identity === 'ambiguous' ? 'identity_ambiguous'
    : identity === 'source_mismatch' ? 'identity_mismatch' : 'identity_unavailable', projection_revision: 0, cache_revision: 0 };
  const policy = state.feature_policy[userId] ?? {};
  if (!policy.enabled || policy.feature !== feature) return { allowed: false, reason: 'policy_restricted',
    projection_revision: state.projection[userId]?.projection_revision ?? 0, cache_revision: state.cache[userId]?.cache_revision ?? 0 };
  const projection = state.projection[userId], cache = state.cache[userId];
  if (!cache || !projection) return { allowed: false, reason: 'cache_unavailable', projection_revision: 0, cache_revision: 0 };
  const revisions = { projection_revision: projection.projection_revision, cache_revision: cache.cache_revision };
  if (cache.invalidated || cache.projection_revision !== projection.projection_revision) return { allowed: false, reason: 'cache_stale', ...revisions };
  if (!cache.expires_at || cache.expires_at <= iso(at)) return { allowed: false, reason: 'subscription_expired', ...revisions };
  if (!cache.active || !cache.premium) return { allowed: false, reason: 'subscription_inactive', ...revisions };
  return { allowed: true, reason: 'allowed', ...revisions };
}
function gate(state: Row, userId: string, initiator = 'customer_demo', feature = FEATURE): Row {
  const result = assessGate(state, userId, feature);
  const details = { feature, decision: result.allowed ? 'allow' : 'deny', reason_code: result.reason,
    projection_version: PROJECTION_VERSION, cache_version: CACHE_VERSION, policy_version: POLICY_VERSION,
    adapter_version: ADAPTER_VERSION, initiator };
  const eventId = eventUuid(state, 'feature_access_decided', userId);
  const receipt = emit(state, 'feature_access_decided', userId, nowText(state), details,
    { event_id: eventId, source_event_id: eventId, correlation_id: eventId });
  return { ...result, preview: result.allowed ? 'Lumen Premium export preview' : null,
    event_id: receipt.event_id, event_hash: receipt.event_hash };
}

function cancellation(state: Row, userId: string, occurredAt = nowText(state)): Row {
  if (!state.registry.some((row: Row) => row.app_user_id === userId)) throw new AccessDemoError('Unknown Lumen account');
  const handler = state.consumer.handler_version, sourceEventId = eventUuid(state, 'subscription_renewal_cancelled', userId);
  const common = { event_type: 'subscription_renewal_cancelled', handler_version: handler,
    received_at: occurredAt, processed_at: occurredAt, outcome: 'accepted' };
  emit(state, 'webhook_received', userId, occurredAt, common,
    { event_id: sourceEventId, source_event_id: sourceEventId, correlation_id: sourceEventId });
  const before = clone(state.projection[userId] ?? {}), source = sourceForUser(state, userId);
  let after: Row;
  if (handler === FAULTY_HANDLER) after = { ...before, active: false, premium: false,
    revision: (before.revision ?? 0) + 1, projection_revision: (before.projection_revision ?? 0) + 1 };
  else {
    const current = sourceCurrent(source, now(state));
    after = { ...before, active: current, premium: current, expires_at: source?.expires_at ?? null,
      source_hash: source?.source_hash ?? 'unavailable', revision: (before.revision ?? 0) + 1,
      projection_revision: (before.projection_revision ?? 0) + 1 };
  }
  state.projection[userId] = after;
  state.cache[userId] = cacheFromProjection(after, now(state));
  state.cache[userId].cache_revision = (before.revision ?? 0) + 1;
  const transition = { event_type: 'subscription_renewal_cancelled', handler_version: handler,
    projection_version: PROJECTION_VERSION, cache_version: CACHE_VERSION,
    source_hash: after.source_hash ?? 'unavailable', before: snapshot(before), after: snapshot(after),
    processed_at: occurredAt, reason_code: 'renewal_cancelled', cache_invalidated: true };
  emit(state, 'access_projection_changed', userId, occurredAt, transition,
    { source_event_id: sourceEventId, correlation_id: sourceEventId });
  emit(state, 'handler_completed', userId, occurredAt, { ...common, outcome: 'completed', reason_code: 'handler_completed' },
    { source_event_id: sourceEventId, correlation_id: sourceEventId });
  state.processed_cancellations.push({ app_user_id: userId, source_event_id: sourceEventId,
    event_type: 'subscription_renewal_cancelled', handler_version: handler, received_at: occurredAt,
    processed_at: occurredAt, outcome: 'completed' });
  return { event_id: sourceEventId, handler_version: handler, projection_revision: after.projection_revision };
}

function population(variant: number): Row {
  if (variant !== 0 && variant !== 1) throw new AccessDemoError('variant must be 0 or 1');
  const others = Array.from({ length: 76 }, (_, index) => `u${String(2000 + index).padStart(5, '0')}`);
  const ids = variant === 0 ? [...AFFECTED, ...others] : [...AFFECTED, ...others].map(id => `v1-${id}`);
  const affected = variant === 0 ? [...AFFECTED] : others.slice(0, 24).map(id => `v1-${id}`);
  const remaining = ids.filter(id => !affected.includes(id));
  const expired = new Set(remaining.slice(0, 6)), restricted = new Set(remaining.slice(6, 10));
  const ambiguous = new Set(remaining.slice(10, 13)), unavailable = new Set(remaining.slice(13, 14));
  const stale = new Set(remaining.slice(14, 16));
  const registry: Row[] = [], mappings: Row = {}, sources: Row = {}, policies: Row = {};
  for (const userId of ids) {
    registry.push({ app_user_id: userId, environment: ENVIRONMENT });
    mappings[userId] = { status: 'mapped', provider_user_id: userId };
    if (ambiguous.has(userId)) mappings[userId] = { status: 'ambiguous', provider_user_ids: [`${userId}-a`, `${userId}-b`] };
    policies[userId] = { feature: FEATURE, enabled: !restricted.has(userId), policy_version: POLICY_VERSION };
    if (unavailable.has(userId)) continue;
    const expires = expired.has(userId) ? '2026-11-02T00:00:00Z' : '2027-08-04T00:00:00Z';
    const source: Row = { provider_user_id: userId, product_id: 'premium.annual', subscription_group: 'premium',
      period_type: 'annual', environment: ENVIRONMENT, status: expired.has(userId) ? 'expired' : 'active',
      starts_at: '2026-08-04T00:00:00Z', expires_at: expires,
      observed_at: stale.has(userId) ? '2026-11-02T23:00:00Z' : SCENARIO_NOW };
    source.source_hash = digest(source); sources[userId] = source;
  }
  return { registry, mappings, source_entitlements: sources, feature_policy: policies, affected_ids: affected };
}

function freshState(variant = 0): Row {
  const data = population(variant), runId = `mock-lumen-access-20261103-v${variant}`;
  const manifest = { run_id: runId, app: APP, environment: ENVIRONMENT, scenario_now: SCENARIO_NOW,
    policy_version: POLICY_VERSION, adapter_version: ADAPTER_VERSION, provenance: PROVENANCE };
  const at = new Date(Date.parse(SCENARIO_NOW));
  const projection: Row = {}, cache: Row = {};
  for (const row of data.registry) {
    const userId = row.app_user_id, value = projectionFromSource(data.source_entitlements[userId] ?? null, at);
    projection[userId] = value; cache[userId] = cacheFromProjection(value, at);
  }
  const state: Row = { manifest, logical_elapsed_seconds: 0, registry: data.registry, mappings: data.mappings,
    source_entitlements: data.source_entitlements, feature_policy: data.feature_policy, projection, cache,
    consumer: { mode: 'faulty', handler_version: FAULTY_HANDLER }, event_seq: 0, processed_cancellations: [],
    _fault_controls: { skip_cache_once: true }, _collector_key: randomBytes(32).toString('hex'),
    collector: { events: [], seen: {} }, incident: null, last_scan: null, scan_sequence: 0, plans: {}, approvals: {},
    actions: {}, verification: {}, recovery_target_ids: [], latest_plan_id: null, history: [] };
  const start = Date.parse(DEFAULT_START);
  for (const [index, userId] of data.affected_ids.entries()) cancellation(state, userId, iso(new Date(start + index * 1000)));
  return state;
}

function parseIncident(body: unknown, state: Row): Row {
  if (!isRecord(body)) throw new AccessDemoError('Request body must be an object');
  const manifest = state.manifest;
  if ((body.run_id === undefined ? manifest.run_id : body.run_id) !== manifest.run_id) throw new AccessDemoError('Unknown run; refresh the access report', 409);
  if ((body.app === undefined ? APP : body.app) !== APP || (body.environment === undefined ? ENVIRONMENT : body.environment) !== ENVIRONMENT) {
    throw new AccessDemoError('Unknown app or environment scope');
  }
  const eventType = body.event_type === undefined ? 'subscription_renewal_cancelled' : body.event_type;
  const handler = body.handler_version === undefined ? FAULTY_HANDLER : body.handler_version;
  const feature = body.feature === undefined ? FEATURE : body.feature;
  if (eventType !== 'subscription_renewal_cancelled') throw new AccessDemoError('Unsupported incident event type');
  if (![FAULTY_HANDLER, FIXED_HANDLER].includes(handler)) throw new AccessDemoError('Unsupported handler version');
  if (feature !== FEATURE) throw new AccessDemoError('Unsupported feature');
  const start = parseTime(body.window_start === undefined ? DEFAULT_START : body.window_start, 'window_start');
  const end = parseTime(body.window_end === undefined ? DEFAULT_END : body.window_end, 'window_end');
  if (start >= end) throw new AccessDemoError('Incident window must end after it starts');
  if (end.getTime() - start.getTime() > 90 * 86400 * 1000) throw new AccessDemoError('Incident window exceeds the supported 90 day limit');
  const material = { run_id: manifest.run_id, app: APP, environment: ENVIRONMENT,
    window_start: iso(start), window_end: iso(end), event_type: eventType,
    handler_version: handler, feature };
  return { id: `incident-${digest(material).slice(0, 20)}`, ...material };
}
function inWindow(value: unknown, start: Date, end: Date): boolean {
  try { const parsed = parseTime(value, 'event timestamp'); return parsed >= start && parsed < end; } catch { return false; }
}
function scanCausalEvents(state: Row, incident: Row): Row {
  const start = parseTime(incident.window_start, 'window_start'), end = parseTime(incident.window_end, 'window_end');
  const candidates: Row = {};
  for (const event of state.collector.events) {
    const details = event.details;
    if (event.run_id !== incident.run_id || event.app !== incident.app || details.event_type !== incident.event_type
        || details.handler_version !== incident.handler_version || !inWindow(event.occurred_at, start, end)) continue;
    if (!['webhook_received', 'handler_completed', 'access_projection_changed'].includes(event.kind)) continue;
    const user = event.app_user_id, sourceId = event.source_event_id;
    candidates[user] ??= {};
    candidates[user][sourceId] ??= { candidate: false, completed: false, transition: false, source_event_id: sourceId };
    if (event.kind === 'webhook_received') candidates[user][sourceId].candidate = true;
  }
  for (const event of state.collector.events) {
    const byUser = candidates[event.app_user_id] ?? {}, ref = byUser[event.source_event_id];
    if (!ref || !inWindow(event.occurred_at, start, end) || event.details.handler_version !== incident.handler_version) continue;
    if (event.kind === 'handler_completed' && event.details.outcome === 'completed'
        && inWindow(event.details.processed_at, start, end)) ref.completed = true;
    if (event.kind === 'access_projection_changed' && event.details.event_type === incident.event_type
        && inWindow(event.details.processed_at, start, end) && semanticJson(event.details.before) !== semanticJson(event.details.after)) ref.transition = true;
  }
  return candidates;
}
function bestCandidate(candidates: Row | undefined): Row | null {
  if (!candidates) return null;
  if (typeof candidates.candidate === 'boolean') return candidates;
  const records = Object.values(candidates) as Row[];
  records.sort((a, b) => Number(b.completed) - Number(a.completed) || Number(b.transition) - Number(a.transition));
  return records[0] ?? null;
}
function customerDenial(state: Row, userId: string): boolean {
  return state.collector.events.some((event: Row) => event.kind === 'feature_access_decided' && event.app_user_id === userId
    && event.details.initiator === 'customer_demo' && event.details.decision === 'deny');
}
function verificationCurrent(state: Row, userId: string, verification: Row, gateState: Row): boolean {
  const source = state.source_entitlements[userId], policy = state.feature_policy[userId] ?? {};
  if (!source || !sourceCurrent(source, now(state)) || freshness(source, now(state)) !== 'fresh') return false;
  return verification.run_id === state.manifest.run_id && verification.app === APP && verification.environment === ENVIRONMENT
    && verification.source_hash === source.source_hash && verification.mapping_hash === mappingDigest(state, userId)
    && semanticJson(verification.policy) === semanticJson(policy)
    && verification.policy_version === state.manifest.policy_version && verification.adapter_version === state.manifest.adapter_version
    && verification.projection_revision === gateState.projection_revision && verification.cache_revision === gateState.cache_revision
    && verification.allowed && gateState.allowed;
}
function accountRows(state: Row): Row[] {
  const scan = state.last_scan, perUser = scan?.causal ?? {}, targetIds = new Set(state.recovery_target_ids);
  const at = now(state);
  return state.registry.map((row: Row) => {
    const userId = row.app_user_id, identity = identityStatus(state, userId), source = state.source_entitlements[userId];
    const sourceFreshness = freshness(source, at), sourceActive = sourceCurrent(source, at);
    const gateState = assessGate(state, userId, state.incident?.feature ?? FEATURE);
    const candidateEvent = bestCandidate(perUser[userId]);
    const candidate = Boolean(candidateEvent?.candidate);
    const processingComplete = Boolean(candidateEvent?.completed && candidateEvent?.transition);
    const policy = state.feature_policy[userId] ?? {}, latest = state.verification[userId];
    let status: string, reason: string, eligible = false;
    if (targetIds.has(userId)) {
      const verified = Boolean(latest?.allowed && gateState.allowed);
      if (verified && verificationCurrent(state, userId, latest, gateState)) { status = 'restored'; reason = 'access_verified_through_gate'; }
      else {
        status = 'pending_verification';
        reason = latest?.allowed ? 'verification_context_stale' : latest ? 'verification_gate_denied' : 'awaiting_verification';
        eligible = Boolean(latest && !latest.allowed && identity === 'mapped' && sourceFreshness === 'fresh'
          && sourceActive && policy.enabled && !gateState.allowed
          && ['subscription_inactive', 'cache_stale'].includes(gateState.reason) && processingComplete);
      }
    } else if (!scan) { status = 'outside_incident'; reason = 'detection_required'; }
    else if (identity !== 'mapped') {
      status = 'inconclusive'; reason = identity === 'ambiguous' ? 'ambiguous_or_many_to_one_identity_mapping'
        : identity === 'source_mismatch' ? 'mapping_source_identity_mismatch' : 'ambiguous_or_unavailable_identity_mapping';
    } else if (sourceFreshness !== 'fresh' || !source) { status = 'inconclusive'; reason = 'source_unavailable_or_stale'; }
    else if (source.period_type !== 'annual' || source.product_id !== 'premium.annual' || source.environment !== ENVIRONMENT) {
      status = 'inconclusive'; reason = 'unsupported_entitlement_shape';
    } else if (!sourceActive) {
      const starts = parseTime(source.starts_at, 'source starts_at'), expires = parseTime(source.expires_at, 'source expires_at');
      if (starts <= at && expires <= at) { status = 'legitimate_denial'; reason = 'source_entitlement_expired'; }
      else { status = 'inconclusive'; reason = 'source_entitlement_not_current'; }
    } else if (!policy.enabled || policy.feature !== FEATURE) { status = 'policy_denial'; reason = 'feature_policy_denies_access'; }
    else if (processingComplete && !gateState.allowed && ['subscription_inactive', 'cache_stale'].includes(gateState.reason)) {
      status = 'confirmed'; reason = 'active_entitlement_denied_after_cancellation'; eligible = true;
    } else if (gateState.allowed) { status = 'healthy'; reason = 'premium_gate_allows_access'; }
    else if (candidate && !processingComplete) { status = 'inconclusive'; reason = 'cancellation_processing_incomplete'; }
    else if (candidate) { status = 'inconclusive'; reason = 'cancellation_did_not_cause_subscription_denial'; }
    else { status = 'inconclusive'; reason = 'active_entitlement_denied_without_incident_evidence'; }
    return { id: userId, status, reason, source_active: sourceActive, source_expires_at: source?.expires_at ?? null,
      source_freshness: sourceFreshness, gate: Object.fromEntries(['allowed','reason','projection_revision','cache_revision'].map(key => [key, gateState[key]])),
      observed_customer_denial: customerDenial(state, userId), candidate, eligible };
  });
}
function planSummaries(state: Row): Row[] {
  return Object.values(state.plans).map((plan: any) => {
    const applied = Object.values(state.actions).some((action: any) => action.plan_id === plan.id);
    return { id: plan.id, plan_hash: plan.plan_hash, created_at: plan.created_at, expires_at: plan.expires_at,
      status: applied ? 'applied' : state.approvals[plan.id] ? 'approved' : 'previewed', target_count: plan.entries.length,
      retry_of: plan.retry_of ?? null, entries: plan.entries.map((entry: Row) => ({ account_id: entry.account_id })) };
  });
}
function report(state: Row): Row {
  const accounts = accountRows(state), counts: Row = {};
  for (const account of accounts) counts[account.status] = (counts[account.status] ?? 0) + 1;
  const targetIds: string[] = state.recovery_target_ids, byId = Object.fromEntries(accounts.map((item: Row) => [item.id, item]));
  const verified = targetIds.filter(id => byId[id]?.status === 'restored').length, unresolved = Math.max(0, targetIds.length - verified);
  const incident = state.incident ?? { id: null, window_start: DEFAULT_START, window_end: DEFAULT_END,
    event_type: 'subscription_renewal_cancelled', handler_version: FAULTY_HANDLER, feature: FEATURE };
  const kinds: Row = {};
  for (const event of state.collector.events) kinds[event.kind] = (kinds[event.kind] ?? 0) + 1;
  const eventKinds = [...KINDS].sort();
  return { mode: 'FULL_MOCK', manifest: { ...clone(state.manifest), logical_now: nowText(state),
    time_basis: 'deterministic scenario clock; demo advance changes logical_now' },
    consumer: clone(state.consumer), incident: clone(incident),
    summary: { in_scope: state.registry.length, evaluated: state.last_scan ? accounts.length - (counts.inconclusive ?? 0) : 0,
      confirmed: counts.confirmed ?? 0, healthy: counts.healthy ?? 0, legitimate_denial: counts.legitimate_denial ?? 0,
      policy_denial: counts.policy_denial ?? 0, inconclusive: counts.inconclusive ?? 0, restored: counts.restored ?? 0,
      unresolved, pending_verification: counts.pending_verification ?? 0 },
    recovery: { target_count: targetIds.length, verified_count: verified, unresolved_count: unresolved,
      root_cause_status: state.consumer.mode === 'faulty' ? 'pending' : 'resolved', latest_plan_id: state.latest_plan_id,
      unresolved_ids: targetIds.filter(id => byId[id]?.eligible) }, accounts, plans: planSummaries(state), history: clone(state.history),
    collector: { event_count: state.collector.events.length, kinds: Object.fromEntries(eventKinds.map(kind => [kind, kinds[kind] ?? 0])) } };
}
function selectedIds(value: unknown): string[] {
  if (!Array.isArray(value) || !value.length || value.length > 100) throw new AccessDemoError('ids must be a non-empty list of eligible account IDs');
  if (value.some(id => typeof id !== 'string' || !id.trim())) throw new AccessDemoError('ids must contain account IDs');
  if (new Set(value).size !== value.length) throw new AccessDemoError('Duplicate account ID');
  return value as string[];
}
function mappingDigest(state: Row, userId: string): string { return digest(state.mappings[userId]); }
function planCurrent(state: Row, plan: Row): boolean {
  if (!state.last_scan || !state.incident || plan.incident_id !== state.incident.id) return false;
  if (plan.run_id !== state.manifest.run_id || plan.app !== APP || plan.environment !== ENVIRONMENT
      || plan.policy_version !== state.manifest.policy_version || plan.adapter_version !== state.manifest.adapter_version) return false;
  if (now(state) >= parseTime(plan.expires_at, 'plan expires_at')) return false;
  for (const entry of plan.entries) {
    const userId = entry.account_id, source = state.source_entitlements[userId], mapping = state.mappings[userId];
    if (!source || !mapping || mapping.status !== 'mapped' || identityStatus(state, userId) !== 'mapped') return false;
    if (semanticJson(source) !== semanticJson(entry.source_observation) || semanticJson(mapping) !== semanticJson(entry.mapping_observation)) return false;
    if (source.source_hash !== entry.source_hash || mappingDigest(state, userId) !== entry.mapping_hash || source.expires_at !== entry.source_expires_at) return false;
    if (!sourceCurrent(source, now(state)) || freshness(source, now(state)) !== 'fresh') return false;
    const policy = state.feature_policy[userId] ?? {};
    if (!policy.enabled || policy.feature !== plan.feature || policy.policy_version !== plan.policy_version
        || semanticJson(policy) !== semanticJson(entry.policy)) return false;
    if (semanticJson(snapshot(state.projection[userId])) !== semanticJson(entry.before.projection)
        || semanticJson(snapshot(state.cache[userId])) !== semanticJson(entry.before.cache)) return false;
  }
  return true;
}
function history(state: Row, action: string, details: Row = {}): void {
  state.history.push({ action, at: nowText(state), ...details });
  if (state.history.length > 20) state.history.splice(0, state.history.length - 20);
}

function detect(state: Row, body: unknown): Row {
  const incident = parseIncident(body, state), candidates = scanCausalEvents(state, incident);
  for (const row of state.registry) {
    const userId = row.app_user_id, source = sourceForUser(state, userId), observedAt = nowText(state);
    emit(state, 'source_entitlement_observed', userId, observedAt, {
      source_hash: source?.source_hash ?? 'unavailable', starts_at: source?.starts_at ?? null,
      expires_at: source?.expires_at ?? null, adapter_version: ADAPTER_VERSION,
      outcome: source ? 'observed' : 'unavailable',
      reason_code: source ? 'none' : identityStatus(state, userId) === 'mapped' ? 'source_unavailable' : `identity_${identityStatus(state, userId)}` });
    gate(state, userId, 'reconcile_probe', incident.feature);
  }
  state.incident = incident; state.scan_sequence++;
  const candidateIds = Object.keys(candidates).filter(userId => Object.values(candidates[userId]).some((item: any) => item.candidate)).sort();
  state.last_scan = { incident_id: incident.id, scanned_at: nowText(state), sequence: state.scan_sequence,
    candidate_ids: candidateIds, causal: Object.fromEntries(Object.entries(candidates).map(([userId, values]) => [userId, bestCandidate(values)])) };
  history(state, 'detection_completed', { evaluated: state.registry.length, candidates: candidateIds.length, incident_id: incident.id });
  return report(state);
}
function preview(state: Row, body: unknown): Row {
  if (!isRecord(body)) throw new AccessDemoError('Request body must be an object');
  const ids = selectedIds(body.ids);
  if (!state.last_scan) throw new AccessDemoError('Run detection before previewing a recovery plan', 409);
  const accounts = Object.fromEntries(accountRows(state).map(account => [account.id, account]));
  const retryOf = body.retry_of === undefined ? null : body.retry_of;
  let eligible: Set<string>;
  if (retryOf !== null) {
    const original = state.plans[retryOf];
    if (!original || !Object.values(state.actions).some((action: any) => action.plan_id === retryOf)) {
      throw new AccessDemoError('retry_of must identify an applied plan', 409);
    }
    eligible = new Set(report(state).recovery.unresolved_ids);
  } else eligible = new Set(Object.entries(accounts).filter(([, account]: any) => account.status === 'confirmed' && account.eligible).map(([id]) => id));
  if (ids.some(userId => !eligible.has(userId))) throw new AccessDemoError('Every selected account must be currently eligible for this repair', 409);
  const at = now(state), entries: Row[] = [];
  for (const userId of ids) {
    const source = state.source_entitlements[userId], policy = clone(state.feature_policy[userId]);
    const projection = clone(state.projection[userId]), cache = clone(state.cache[userId]);
    const afterProjection = { ...projection, active: true, premium: true, expires_at: source.expires_at,
      source_hash: source.source_hash, revision: projection.revision + 1, projection_revision: projection.projection_revision + 1 };
    const afterCache = { active: true, premium: true, expires_at: source.expires_at,
      cache_revision: cache.cache_revision + 1, projection_revision: afterProjection.projection_revision,
      source_hash: source.source_hash, invalidated: false, cached_at: nowText(state) };
    entries.push({ account_id: userId, before: { projection: snapshot(projection), cache: snapshot(cache) },
      after: { projection: snapshot(afterProjection), cache: snapshot(afterCache) }, source_hash: source.source_hash,
      source_expires_at: source.expires_at, source_observation: clone(source), mapping_hash: mappingDigest(state, userId),
      mapping_observation: clone(state.mappings[userId]), policy, target_revision: afterProjection.projection_revision,
      cache_revision: afterCache.cache_revision, policy_version: state.manifest.policy_version,
      adapter_version: state.manifest.adapter_version, reason: 'resync_current_annual_entitlement_and_refresh_cache' });
  }
  const plan: Row = { id: `plan-${randomBytes(8).toString('hex')}`, run_id: state.manifest.run_id, app: APP,
    environment: ENVIRONMENT, incident_id: state.incident.id, feature: state.incident.feature, created_at: nowText(state),
    expires_at: iso(new Date(at.getTime() + PLAN_TTL * 1000)), policy_version: state.manifest.policy_version,
    adapter_version: state.manifest.adapter_version, retry_of: retryOf, entries, exclusions: [] };
  plan.plan_hash = digest(plan); state.plans[plan.id] = plan;
  history(state, 'recovery_previewed', { plan_id: plan.id, selected: entries.length, retry_of: retryOf });
  return { ...clone(plan), plan: clone(plan), report: report(state) };
}
function requirePlan(state: Row, body: Row): Row {
  const planId = body.plan_id, planHash = body.plan_hash;
  if (typeof planId !== 'string' || typeof planHash !== 'string') throw new AccessDemoError('plan_id and plan_hash are required');
  const plan = state.plans[planId];
  if (!plan || plan.plan_hash !== planHash) throw new AccessDemoError('Unknown plan or stale plan hash', 409);
  return plan;
}
function approve(state: Row, body: unknown): Row {
  if (!isRecord(body)) throw new AccessDemoError('Request body must be an object');
  const plan = requirePlan(state, body), actor = body.actor;
  if (typeof actor !== 'string' || !actor.trim() || actor.trim().length > 128) throw new AccessDemoError('actor must be a non-empty human review identity');
  if (now(state) >= parseTime(plan.expires_at, 'plan expires_at')) throw new AccessDemoError('Plan has expired; run a fresh preview', 409);
  if (state.approvals[plan.id]) {
    const existing = state.approvals[plan.id];
    if (existing.actor === actor.trim() && existing.plan_hash === plan.plan_hash) return {
      approval: clone(existing), plan_id: plan.id, duplicate: true, report: report(state) };
    throw new AccessDemoError('Plan already has a different approval', 409);
  }
  const approval = { plan_id: plan.id, plan_hash: plan.plan_hash, actor: actor.trim(), approved_at: nowText(state), decision: 'approved' };
  state.approvals[plan.id] = approval; history(state, 'recovery_approved', { plan_id: plan.id, actor: approval.actor });
  return { approval: clone(approval), plan_id: plan.id, duplicate: false, report: report(state) };
}
function resync(state: Row, userId: string, source: Row, actionId: string, skipCache: boolean): Row {
  if (identityStatus(state, userId) !== 'mapped' || !sourceCurrent(source, now(state))) throw new AccessDemoError('Only a current supported entitlement can be resynced');
  const before = clone(state.projection[userId]), beforeCache = clone(state.cache[userId]), sourceHash = source.source_hash;
  const sourceEventId = eventUuid(state, 'resync', userId);
  const base = { action_id: actionId, source_hash: sourceHash, expected_revision: before.revision,
    policy_version: POLICY_VERSION, adapter_version: ADAPTER_VERSION, projection_version: PROJECTION_VERSION,
    cache_version: CACHE_VERSION, outcome: 'requested', reason_code: 'approved_resync' };
  const receipts = [emit(state, 'resync_requested', userId, nowText(state), base,
    { event_id: sourceEventId, source_event_id: sourceEventId, correlation_id: sourceEventId })];
  const after = { ...before, active: true, premium: true, expires_at: source.expires_at, source_hash: sourceHash,
    revision: before.revision + 1, projection_revision: before.projection_revision + 1 };
  state.projection[userId] = after;
  if (!skipCache) state.cache[userId] = { active: after.active, premium: after.premium, expires_at: after.expires_at,
    cache_revision: beforeCache.cache_revision + 1, projection_revision: after.projection_revision,
    source_hash: sourceHash, invalidated: false, cached_at: nowText(state) };
  receipts.push(emit(state, 'access_projection_changed', userId, nowText(state), { ...base, outcome: 'projection_updated',
    before: snapshot(before), after: snapshot(after), cache_invalidated: !skipCache },
  { source_event_id: sourceEventId, correlation_id: sourceEventId }));
  receipts.push(emit(state, 'resync_completed', userId, nowText(state), { ...base, outcome: 'accepted',
    reason_code: skipCache ? 'cache_refresh_skipped' : 'resync_completed', processed_at: nowText(state),
    cache_invalidated: !skipCache, actual_revision: after.revision },
  { source_event_id: sourceEventId, correlation_id: sourceEventId }));
  return { transport_accepted: true, cache_refreshed: !skipCache,
    before: { projection: snapshot(before), cache: snapshot(beforeCache) },
    after: { projection: snapshot(after), cache: snapshot(state.cache[userId]) }, receipts };
}
function apply(state: Row, body: unknown): Row {
  if (!isRecord(body)) throw new AccessDemoError('Request body must be an object');
  const plan = requirePlan(state, body);
  if (!state.approvals[plan.id]) throw new AccessDemoError('Human approval is required before applying this plan', 409);
  const actionIds = plan.entries.map((entry: Row) => `${state.manifest.run_id}:${plan.id}:${entry.account_id}:resync`);
  if (actionIds.every((id: string) => Boolean(state.actions[id]))) return { plan_id: plan.id, writes_accepted: 0,
    receipts: actionIds.map((id: string) => clone(state.actions[id].receipt)), duplicate: true, report: report(state) };
  if (!planCurrent(state, plan)) throw new AccessDemoError('Plan preconditions changed; detect and preview again', 409);
  const receipts: Row[] = [], pending: Row[] = [];
  for (let index = 0; index < plan.entries.length; index++) {
    const entry = plan.entries[index], actionId = actionIds[index];
    if (state.actions[actionId]) continue;
    const userId = entry.account_id, source = state.source_entitlements[userId];
    const skipCache = Boolean(state._fault_controls.skip_cache_once);
    if (skipCache) state._fault_controls.skip_cache_once = false;
    const result = resync(state, userId, source, actionId, skipCache);
    const receipt = { action_id: actionId, plan_id: plan.id, account_id: userId, status: 'transport_accepted',
      event_receipts: result.receipts, before: result.before, after: result.after };
    pending.push({ action_id: actionId, record: { plan_id: plan.id, account_id: userId, receipt, recorded_at: nowText(state) } });
    receipts.push(receipt);
  }
  for (const item of pending) state.actions[item.action_id] = item.record;
  state.recovery_target_ids = state.recovery_target_ids.length
    ? [...new Set([...state.recovery_target_ids, ...plan.entries.map((entry: Row) => entry.account_id)])]
    : plan.entries.map((entry: Row) => entry.account_id);
  state.latest_plan_id = plan.id; history(state, 'recovery_applied', { plan_id: plan.id, writes_accepted: receipts.length });
  return { plan_id: plan.id, writes_accepted: receipts.length, receipts: clone(receipts), duplicate: false, report: report(state) };
}
function verify(state: Row, body: unknown): Row {
  if (!isRecord(body)) throw new AccessDemoError('Request body must be an object');
  const planId = body.plan_id || state.latest_plan_id;
  if (typeof planId !== 'string' || !state.plans[planId]) throw new AccessDemoError('A previously applied plan is required for verification', 409);
  if (!Object.values(state.actions).some((action: any) => action.plan_id === planId)) throw new AccessDemoError('Apply the approved plan before verification', 409);
  const observations: Row[] = [];
  for (const userId of state.recovery_target_ids) {
    const userActions = Object.values(state.actions).filter((action: any) => action.account_id === userId) as Row[];
    if (!userActions.length) throw new AccessDemoError('Recovery target has no accepted resync action', 409);
    const action = userActions[userActions.length - 1]!;
    const actionId = action.receipt.action_id;
    const gateState = gate(state, userId, 'reconcile_probe', FEATURE);
    const verificationId = eventUuidFor(`${state.manifest.run_id}/${planId}/${userId}/verification/${state.event_seq}`);
    const details = { feature: FEATURE, decision: gateState.allowed ? 'allow' : 'deny', outcome: gateState.allowed ? 'verified' : 'failed',
      reason_code: gateState.reason, action_id: actionId, policy_version: state.manifest.policy_version,
      adapter_version: state.manifest.adapter_version, projection_version: PROJECTION_VERSION,
      cache_version: CACHE_VERSION, actual_revision: gateState.projection_revision };
    const receipt = emit(state, 'verification_completed', userId, nowText(state), details,
      { event_id: verificationId, source_event_id: gateState.event_id, correlation_id: gateState.event_id });
    state.verification[userId] = { plan_id: planId, allowed: gateState.allowed, reason: gateState.reason,
      verified_at: nowText(state), run_id: state.manifest.run_id, app: APP, environment: ENVIRONMENT,
      source_hash: state.source_entitlements[userId]?.source_hash ?? null, mapping_hash: mappingDigest(state, userId),
      policy: clone(state.feature_policy[userId] ?? {}), policy_version: state.manifest.policy_version,
      adapter_version: state.manifest.adapter_version, projection_revision: gateState.projection_revision,
      cache_revision: gateState.cache_revision, action_id: actionId, applied_plan_id: action.plan_id,
      gate_event_id: gateState.event_id, gate_event_hash: gateState.event_hash,
      event_id: receipt.event_id, event_hash: receipt.event_hash };
    observations.push({ account_id: userId, allowed: gateState.allowed, reason: gateState.reason, response_ref: receipt.event_id });
  }
  history(state, 'verification_completed', { plan_id: planId, verified: observations.filter(row => row.allowed).length,
    unresolved: observations.filter(row => !row.allowed).length });
  const current = report(state);
  return { plan_id: planId, verified_count: current.recovery.verified_count, unresolved_count: current.recovery.unresolved_count,
    unresolved_ids: current.recovery.unresolved_ids, observations, report: current };
}
function eventUuidFor(value: string): string {
  const hash = createHash('sha1').update(URL_NAMESPACE).update(value).digest(), bytes = Buffer.from(hash.subarray(0, 16));
  bytes[6] = (bytes[6]! & 0x0f) | 0x50; bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString('hex'); return `${hex.slice(0,8)}-${hex.slice(8,12)}-${hex.slice(12,16)}-${hex.slice(16,20)}-${hex.slice(20)}`;
}

function findAccount(state: Row, userId: unknown): string {
  if (typeof userId !== 'string' || !userId.trim()) throw new AccessDemoError('user_id is required');
  if (!state.registry.some((row: Row) => row.app_user_id === userId)) throw new AccessDemoError('Unknown Lumen account', 404);
  return userId;
}
function publicGate(state: Row, userId: unknown): Row {
  const result = gate(state, findAccount(state, userId));
  return Object.fromEntries(['allowed','reason','projection_revision','cache_revision','preview','event_id','event_hash']
    .map(key => [key, result[key]]));
}
function evidence(state: Row, userIdValue: unknown): Row {
  const userId = findAccount(state, userIdValue), source = state.source_entitlements[userId] ?? null;
  const events = state.collector.events.filter((event: Row) => event.app_user_id === userId).map((event: Row) => clone(event));
  const actions = Object.values(state.actions).filter((action: any) => action.account_id === userId).map((item: any) => clone(item));
  const gateOutcomes = events.filter((event: Row) => event.kind === 'feature_access_decided');
  return { manifest: { ...clone(state.manifest), logical_now: nowText(state),
    time_basis: 'deterministic scenario clock; demo advance changes logical_now' }, account_id: userId,
    native_source_entitlement: clone(source), mapping: clone(state.mappings[userId] ?? null),
    source_hash: source?.source_hash ?? null, projection: snapshot(state.projection[userId]), cache: snapshot(state.cache[userId]),
    consumer_and_access_journal: events, gate_outcomes: gateOutcomes, repair_receipts: actions,
    verification: clone(state.verification[userId] ?? null), provenance: state.manifest.provenance };
}
function audit(state: Row): Row {
  const current = report(state);
  return { manifest: { ...clone(state.manifest), logical_now: nowText(state),
    time_basis: 'deterministic scenario clock; demo advance changes logical_now' }, incident: clone(current.incident),
    findings: clone(current.accounts), native_source_entitlements: clone(state.source_entitlements), mappings: clone(state.mappings),
    current_projection: Object.fromEntries(Object.entries(state.projection).map(([id, value]) => [id, snapshot(value as Row)])),
    current_cache: Object.fromEntries(Object.entries(state.cache).map(([id, value]) => [id, snapshot(value as Row)])),
    plans: clone(Object.values(state.plans)), approvals: clone(Object.values(state.approvals)), actions: clone(Object.values(state.actions)),
    before_after_observations: Object.values(state.actions).map((action: any) => ({ action_id: action.receipt.action_id,
      account_id: action.account_id, before: clone(action.receipt.before), after: clone(action.receipt.after) })),
    verification: clone(Object.values(state.verification)), collector_events: clone(state.collector.events), provenance: state.manifest.provenance };
}
function registry(state: Row): Row {
  return { manifest: clone(state.manifest), accounts: state.registry.map((row: Row) => ({ id: row.app_user_id,
    mapping_status: identityStatus(state, row.app_user_id), source_freshness: freshness(state.source_entitlements[row.app_user_id], now(state)) })) };
}
function journal(state: Row, query: URLSearchParams): Row {
  const userId = query.get('user_id'), kind = query.get('kind');
  if (userId !== null) findAccount(state, userId);
  if (kind !== null && !KINDS.includes(kind)) throw new AccessDemoError('Unsupported collector event kind');
  const rawLimit = query.get('limit') ?? '200';
  if (!/^-?\d+$/.test(rawLimit)) throw new AccessDemoError('Invalid journal limit');
  const limit = Number(rawLimit);
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000) throw new AccessDemoError('limit must be an integer from 1 to 1000');
  const filtered = state.collector.events.filter((event: Row) => (userId === null || event.app_user_id === userId)
    && (kind === null || event.kind === kind));
  return { events: clone(filtered.slice(-limit)), total: filtered.length };
}
function setHandler(state: Row, mode: unknown): Row {
  if (mode !== 'faulty' && mode !== 'fixed') throw new AccessDemoError('mode must be faulty or fixed');
  state.consumer = { mode, handler_version: mode === 'faulty' ? FAULTY_HANDLER : FIXED_HANDLER };
  return clone(state.consumer);
}
function demoAction(state: Row, body: unknown): Row {
  if (!isRecord(body)) throw new AccessDemoError('Request body must be an object');
  const action = body.action;
  if (action === 'seed' || action === 'reset') {
    const variant = body.variant === undefined ? 0 : body.variant;
    if (typeof variant !== 'number' || !Number.isInteger(variant) || (variant !== 0 && variant !== 1)) throw new AccessDemoError('variant must be 0 or 1');
    const replacement = freshState(variant);
    for (const key of Object.keys(state)) delete state[key];
    Object.assign(state, replacement);
    return report(state);
  }
  if (action === 'handler') {
    const consumer = setHandler(state, body.mode);
    history(state, 'handler_mode_changed', { mode: consumer.mode, handler_version: consumer.handler_version });
    return { consumer, report: report(state) };
  }
  if (action === 'cancel') {
    const ids = selectedIds(body.ids);
    for (const userId of ids) findAccount(state, userId);
    const cancellations = ids.map(userId => cancellation(state, userId));
    history(state, 'demo_cancellation_sent', { accounts: ids.length });
    return { cancellations, report: report(state) };
  }
  if (action === 'advance') {
    const seconds = body.seconds;
    if (typeof seconds !== 'number' || !Number.isSafeInteger(seconds) || seconds < 0 || seconds > 86400) {
      throw new AccessDemoError('seconds must be an integer from 0 to 86400');
    }
    state.logical_elapsed_seconds += seconds;
    history(state, 'scenario_clock_advanced', { seconds, now: nowText(state) });
    return { scenario_now: nowText(state), report: report(state) };
  }
  throw new AccessDemoError('Unsupported demo action');
}

function fileErrorCode(error: unknown): string | undefined {
  return typeof error === 'object' && error !== null && 'code' in error ? String((error as { code: unknown }).code) : undefined;
}
async function ensureSafeDatabasePath(path: string): Promise<boolean> {
  if (path === ':memory:') return true;
  const absolute = resolve(path);
  await mkdir(dirname(absolute), { recursive: true, mode: 0o700 });
  let stat;
  try { stat = await lstat(absolute); } catch (error) { if (fileErrorCode(error) !== 'ENOENT') throw error; }
  if (stat) {
    if (stat.isSymbolicLink() || !stat.isFile()) throw new Error('Access database path must be a regular, non-symlink file');
    let db: DatabaseSync | undefined;
    try {
      db = new DatabaseSync(absolute, { readOnly: true });
      const marker = db.prepare('SELECT value FROM legacy_access_meta WHERE key = ?').get('scope') as { value: string } | undefined;
      if (marker?.value !== MARKER) throw new Error('Refusing an existing SQLite file without the legacy access marker');
    } catch (error) {
      if (error instanceof Error && error.message.includes('legacy access marker')) throw error;
      throw new Error('Refusing an existing SQLite file without the legacy access marker');
    } finally { db?.close(); }
    return false;
  }
  const descriptor = openSync(absolute, 'wx', 0o600); closeSync(descriptor); return true;
}

/**
 * In-process adapter for the retained paid-access Demo Lab contract. The monolith
 * owns HTTP, loopback same-origin write checks, JSON content-type and body limits;
 * this class receives parsed bodies plus request headers for the signed collector.
 */
export class AccessDemo {
  private serial: Promise<void> = Promise.resolve();
  private constructor(private readonly storage: SQLiteStorage) {}

  static async create(options: AccessDemoOptions): Promise<AccessDemo> {
    if (typeof options?.databasePath !== 'string' || !options.databasePath.trim()) throw new Error('A dedicated access databasePath is required');
    const fresh = await ensureSafeDatabasePath(options.databasePath), storage = new SQLiteStorage(options.databasePath === ':memory:' ? options.databasePath : resolve(options.databasePath));
    const adapter = new AccessDemo(storage);
    try {
      const initial = fresh ? freshState() : undefined, initialText = initial ? semanticJson(initial) : undefined;
      await storage.transaction([
        { mode: 'run', sql: 'CREATE TABLE IF NOT EXISTS legacy_access_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)' },
        { mode: 'run', sql: 'CREATE TABLE IF NOT EXISTS legacy_access_state (id INTEGER PRIMARY KEY CHECK(id=1), revision INTEGER NOT NULL, payload TEXT NOT NULL, digest TEXT NOT NULL)' },
        { mode: 'run', sql: "INSERT OR IGNORE INTO legacy_access_meta (key,value) VALUES ('scope',?)", params: [MARKER] },
        ...(initial ? [{ mode: 'run' as const, sql: 'INSERT OR IGNORE INTO legacy_access_state (id,revision,payload,digest) VALUES (1,0,?,?)',
          params: [initialText!, semanticDigest(initial)] }] : [])
      ]);
      const marker = await storage.statement({ mode: 'get', sql: 'SELECT value FROM legacy_access_meta WHERE key=?', params: ['scope'] }) as { value: string } | null;
      if (marker?.value !== MARKER) throw new Error('Access database marker mismatch');
      const row = await storage.statement({ mode: 'get', sql: 'SELECT payload,digest FROM legacy_access_state WHERE id=1' }) as { payload: string; digest: string } | null;
      if (!row || semanticDigest(JSON.parse(row.payload)) !== row.digest) throw new Error('Access database state is missing or corrupt');
      return adapter;
    } catch (error) { await storage.close(); throw error; }
  }

  async close(): Promise<void> { await this.storage.close(); }

  private async state(): Promise<{ value: Row; revision: number }> {
    const row = await this.storage.statement({ mode: 'get', sql: 'SELECT revision,payload,digest FROM legacy_access_state WHERE id=1' }) as
      { revision: number; payload: string; digest: string } | null;
    if (!row) throw new Error('Access database state is missing');
    const value = JSON.parse(row.payload) as Row;
    if (semanticDigest(value) !== row.digest) throw new Error('Access database integrity check failed');
    return { value, revision: row.revision };
  }
  private async update<T>(operation: (state: Row) => T): Promise<T> {
    for (let attempt = 0; attempt < 12; attempt++) {
      const loaded = await this.state(), result = operation(loaded.value);
      const payload = semanticJson(loaded.value), stateDigest = semanticDigest(loaded.value);
      const values = await this.storage.transaction([
        { mode: 'run', sql: 'UPDATE legacy_access_state SET revision=revision+1,payload=?,digest=? WHERE id=1 AND revision=?',
          params: [payload, stateDigest, loaded.revision] },
        { mode: 'get', sql: 'SELECT revision FROM legacy_access_state WHERE id=1' }
      ]) as [{ changes?: number | bigint } | null, { revision: number } | null];
      if (Number(values[0]?.changes ?? 0) === 1 && values[1]?.revision === loaded.revision + 1) return result;
    }
    throw new Error('Access state changed concurrently; retry the request');
  }

  private async route(method: string, rawUrl: string, body: unknown, headers: Headers): Promise<AccessDemoResponse> {
    const json = (value: unknown, status = 200): AccessDemoResponse => ({ status, contentType: 'application/json', body: value });
    let url: URL;
    try { url = new URL(rawUrl, 'http://127.0.0.1'); } catch { return json({ error: 'bad request' }, 400); }
    const path = url.pathname, query = url.searchParams;
    try {
      if (method === 'GET') {
        const state = await this.state();
        if (path === '/api/access/report') return json(report(state.value));
        if (path === '/api/access/audit') return json(audit(state.value));
        if (path === '/api/access/registry') return json(registry(state.value));
        if (path === '/api/access/evidence') return json(evidence(state.value, query.get('user')));
        if (path === '/api/access/journal') return json(journal(state.value, query));
        return json({ error: 'not found' }, 404);
      }
      if (method !== 'POST') return json({ error: 'not found' }, 404);
      if (!path.startsWith('/api/access/') && path !== '/api/collector/events' && path !== '/mock/lumen/export') return json({ error: 'not found' }, 404);
      if (!isRecord(body)) return json({ error: 'Object required' }, 400);
      if (path === '/api/access/detect') return json(await this.update(state => detect(state, body)));
      if (path === '/api/access/preview') return json(await this.update(state => preview(state, body)));
      if (path === '/api/access/approve') return json(await this.update(state => approve(state, body)));
      if (path === '/api/access/apply') return json(await this.update(state => apply(state, body)));
      if (path === '/api/access/verify') return json(await this.update(state => verify(state, body)));
      if (path === '/api/access/demo') return json(await this.update(state => demoAction(state, body)));
      if (path === '/api/collector/events') {
        const signatureValue = Object.entries(headers).find(([key]) => key.toLowerCase() === 'x-reconcile-signature')?.[1];
        const signature = Array.isArray(signatureValue) ? signatureValue[0] : signatureValue;
        return json(await this.update(state => ingest(state, body, signature)));
      }
      if (path === '/mock/lumen/export') {
        if (body.feature !== undefined && body.feature !== FEATURE) return json({ error: 'Unsupported feature' }, 400);
        const result = await this.update(state => publicGate(state, body.user_id));
        return json(result, result.allowed ? 200 : 403);
      }
      return json({ error: 'not found' }, 404);
    } catch (error) {
      const status = error instanceof AccessDemoError ? error.status : 500;
      return json({ error: error instanceof AccessDemoError ? error.message : 'internal error' }, status);
    }
  }

  /** Handle a legacy access route using parsed request data; no HTTP or provider call is made here. */
  handle(method: string, url: string, parsedBody?: unknown, headers: Headers = {}): Promise<AccessDemoResponse> {
    const execute = (): Promise<AccessDemoResponse> => this.route(method.toUpperCase(), url, parsedBody, headers);
    const current = this.serial.then(execute, execute);
    this.serial = current.then(() => undefined, () => undefined);
    return current;
  }
}
