import { createHash } from 'node:crypto';
import { closeSync, openSync } from 'node:fs';
import { lstat, mkdir, readFile, readdir, realpath } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { semanticDigest, semanticJson } from '../../infrastructure/json.js';
import { SQLiteStorage } from '../../infrastructure/sqlite.js';

type Row = Record<string, any>;
type Decimal = { coefficient: bigint; scale: number };
type State = Row & { source: Row[]; mixpanel: Row[]; clock: number; journal: Row[] };
const ID = 'mock-run-20261107', APP = 'mock-lumen', T0 = 1794042000;
const MARKER = 'reconcile-legacy-analytics-v1';
const URL_NAMESPACE = Buffer.from('6ba7b8119dad11d180b400c04fd430c8', 'hex');

class AnalyticsRequestError extends Error {
  constructor(message: string, readonly status = 400) { super(message); }
}

export interface AnalyticsDemoOptions {
  /** A dedicated fresh SQLite file, or `:memory:` for an isolated test/demo instance. */
  databasePath: string;
  /** Defaults to `<cwd>/reconcile-mock-first-kit/reference`. */
  referenceDirectory?: string;
}

export interface AnalyticsDemoResponse {
  status: number;
  contentType: string;
  /** JSON routes return objects; NDJSON routes return UTF-8 text. */
  body: unknown;
}

function decimal(value: unknown): Decimal {
  if (typeof value === 'boolean' || value === null || value === undefined) {
    throw new AnalyticsRequestError('Money must be a finite decimal amount');
  }
  const raw = typeof value === 'number' ? (Number.isFinite(value) ? String(value) : '')
    : typeof value === 'string' ? value.trim() : '';
  const match = /^([+-]?)(?:(\d+)(?:\.(\d*))?|\.(\d+))(?:[eE]([+-]?\d+))?$/.exec(raw);
  if (!match) throw new AnalyticsRequestError('Money must be a finite decimal amount');
  const sign = match[1] === '-' ? -1n : 1n;
  const whole = match[2] ?? '0', fraction = match[3] ?? match[4] ?? '';
  const exponent = Number(match[5] ?? 0);
  if (!Number.isSafeInteger(exponent) || Math.abs(exponent) > 1000) {
    throw new AnalyticsRequestError('Money amount out of range');
  }
  let coefficient = BigInt((whole + fraction).replace(/^0+(?=\d)/, '') || '0') * sign;
  let scale = fraction.length - exponent;
  if (scale < 0) { coefficient *= 10n ** BigInt(-scale); scale = 0; }
  return { coefficient, scale };
}

function cents(value: unknown): bigint {
  const parsed = decimal(value);
  let result: bigint;
  if (parsed.scale <= 2) result = parsed.coefficient * 10n ** BigInt(2 - parsed.scale);
  else {
    const divisor = 10n ** BigInt(parsed.scale - 2), magnitude = parsed.coefficient < 0n ? -parsed.coefficient : parsed.coefficient;
    let quotient = magnitude / divisor;
    const remainder = magnitude % divisor;
    if (remainder * 2n > divisor || (remainder * 2n === divisor && quotient % 2n === 1n)) quotient++;
    result = parsed.coefficient < 0n ? -quotient : quotient;
  }
  if ((result < 0n ? -result : result).toString().length > 28) throw new AnalyticsRequestError('Money amount out of range');
  return result;
}

function amount(value: unknown): string {
  let valueCents: bigint;
  try { valueCents = cents(value); }
  catch (error) {
    if (error instanceof Error && error.message === 'Money amount out of range') throw error;
    throw new AnalyticsRequestError('Money must be a finite decimal amount');
  }
  const negative = valueCents < 0n, absolute = negative ? -valueCents : valueCents;
  return `${negative ? '-' : ''}${absolute / 100n}.${(absolute % 100n).toString().padStart(2, '0')}`;
}

function decimalToNumber(value: Decimal): number {
  return Number(`${value.coefficient}e-${value.scale}`);
}

function uid(value: string): string {
  const digest = createHash('sha1').update(URL_NAMESPACE).update(`reconcile-mock-20261107/${value}`).digest();
  const bytes = Buffer.from(digest.subarray(0, 16));
  bytes[6] = (bytes[6]! & 0x0f) | 0x50;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function hashv(value: unknown): string { return semanticDigest(value); }
function clone<T>(value: T): T {
  try { return JSON.parse(semanticJson(value)) as T; }
  catch { throw new AnalyticsRequestError('Invalid JSON value'); }
}
function isRecord(value: unknown): value is Row { return typeof value === 'object' && value !== null && !Array.isArray(value); }
function cmp(left: string, right: string): number {
  const a = Array.from(left, item => item.codePointAt(0)!), b = Array.from(right, item => item.codePointAt(0)!);
  for (let index = 0; index < Math.min(a.length, b.length); index++) if (a[index] !== b[index]) return a[index]! - b[index]!;
  return a.length - b.length;
}
function tuple(...values: unknown[]): string { return semanticJson(values); }
function validText(value: unknown, label: string, limit = 256): string {
  if (typeof value !== 'string' || !value.trim() || value.length > limit) throw new AnalyticsRequestError(`Invalid ${label}`);
  return value.trim();
}
function selectedIds(value: unknown): string[] {
  if (!Array.isArray(value) || !value.length || value.some(item => typeof item !== 'string' || !item)) {
    throw new AnalyticsRequestError('ids must be a non-empty list of group classes');
  }
  if (new Set(value).size !== value.length) throw new AnalyticsRequestError('Duplicate group class');
  return value;
}
function sourceKind(event: Row): 'purchase' | 'refund' {
  return event.event_type === 'subscription_refunded' ? 'refund' : 'purchase';
}
function transactionKey(tx: string, user: string, environment: string, currency: string): string {
  return tuple(tx, user, environment, currency);
}
function sourceIdentity(event: Row): string {
  const properties = event.event_properties;
  return transactionKey(properties.transaction_id, event.customer_user_id, properties.environment, properties.currency);
}
function destinationIdentity(event: Row): string {
  const properties = event.properties;
  return transactionKey(properties.transaction_id, properties.distinct_id, properties.environment, properties.currency);
}

function seed(): State {
  const state: State = { manifest: { run_id: ID, seed: 20261107, mode: 'FULL_MOCK', source_provenance: 'synthetic',
    clock_utc_epoch_seconds: T0, currency_aggregation: 'per_currency_only', environment: 'Production', app: APP,
    project: 'mock-mixpanel-eu', region: 'EU', project_timezone: 'America/New_York', complete_account_registry: true,
    source_amount_authority: 'synthetic Adapty-shaped event log; NOT GET /profile/' }, clock: 0, source: [], mixpanel: [],
    mappings: { subscription_started: 'purchase', subscription_refunded: 'refund' }, approvals: {}, actions: {}, journal: [], history: [], history_seq: 0 };
  const src = (tx: string, user: string, currency: string, price: string, kind = 'purchase', environment = 'Production'): Row => {
    const iso = '2026-11-07T09:00:00Z', local = decimal(price);
    const rate = currency === 'USD' ? { coefficient: 100n, scale: 2 } : { coefficient: 110n, scale: 2 };
    const usd: Decimal = { coefficient: local.coefficient * rate.coefficient, scale: local.scale + rate.scale };
    const event: Row = { profile_id: uid(`profile/${user}`), customer_user_id: user,
      event_type: kind === 'refund' ? 'subscription_refunded' : 'subscription_started', event_datetime: iso,
      event_properties: { store: 'play_store', environment, currency, price_local: decimalToNumber(local), price_usd: decimalToNumber(usd),
        transaction_id: tx, original_transaction_id: tx, vendor_product_id: 'mock.monthly',
        profile_event_id: uid(`source/${tx}/${kind}`), purchase_date: iso }, event_api_version: 1 };
    state.source.push(event); return event;
  };
  const mp = (source: Row, name?: string, price?: string, insert?: string): Row => {
    const properties = source.event_properties, user = source.customer_user_id;
    const kind = source.event_type === 'subscription_refunded' ? 'refund' : 'purchase';
    const event: Row = { event: name ?? source.event_type, properties: { distinct_id: user, time: T0 + state.mixpanel.length,
      '$insert_id': insert ?? uid(`mp/${properties.transaction_id}/${kind}/${state.mixpanel.length}`),
      transaction_id: properties.transaction_id, original_transaction_id: properties.original_transaction_id,
      currency: properties.currency, price_local: amount(price ?? properties.price_local), environment: 'Production', store: 'play_store' } };
    state.mixpanel.push({ payload: event, visible_at: 0, receipt: { http_status: 200, simulated: true } }); return event;
  };
  src('txn_missing_purchase', 'u00001', 'USD', '9.99');
  const refundPurchase = src('txn_missing_refund', 'u00002', 'USD', '6.99'); mp(refundPurchase);
  src('txn_missing_refund', 'u00002', 'USD', '6.99', 'refund');
  const duplicate = src('txn_duplicate', 'u00003', 'USD', '12.99'); mp(duplicate); mp(duplicate);
  const mismatch = src('txn_price', 'u00004', 'EUR', '9.99'); mp(mismatch, undefined, '999.00');
  const renamed = src('txn_renamed', 'u00005', 'EUR', '14.99'); mp(renamed, 'premium_paid_v2');
  const healthyUsd = src('txn_healthy_usd', 'u00006', 'USD', '6.99'); mp(healthyUsd);
  const healthyEur = src('txn_healthy_eur', 'u00007', 'EUR', '6.99'); mp(healthyEur);
  src('txn_sandbox', 'u00008', 'USD', '4.99', 'purchase', 'Sandbox');
  const ghost = { event: 'subscription_started', properties: { distinct_id: 'u00009', time: T0 + 9, '$insert_id': uid('ghost'),
    transaction_id: 'txn_ghost', original_transaction_id: 'txn_ghost', currency: 'USD', price_local: '11.98', environment: 'Production', store: 'play_store' } };
  state.mixpanel.push({ payload: ghost, visible_at: 0, receipt: { http_status: 200, simulated: true } });
  state.journal.push({ type: 'SEEDED', run_id: ID, clock: 0, source_events: state.source.length, raw_mp_events: state.mixpanel.length });
  return state;
}

function sourceEvents(state: State): Row[] { return state.source.filter((event: Row) => event.event_properties.environment === 'Production'); }
function actionRows(state: State): Row[] { return Object.values(state.actions as Record<string, Row>); }
function getMoney(event: Row): bigint {
  const value = cents(event.event_properties.price_local);
  return event.event_type === 'subscription_refunded' ? -value : value;
}
function eventClass(state: State, event: Row): string | null {
  const properties = event.properties, name = event.event;
  if (name === 'reconcile_correction') return 'correction';
  if (state.mappings[name]) return state.mappings[name];
  const explicit = properties.event_class ?? properties.reconcile_event_class;
  return explicit === 'purchase' || explicit === 'refund' ? explicit : null;
}
function visibleRows(state: State): Row[] { return state.mixpanel.filter((item: Row) => item.visible_at <= state.clock).map((item: Row) => item.payload); }
function pendingRows(state: State): Row[] { return state.mixpanel.filter((item: Row) => item.visible_at > state.clock); }
function normalizedDestination(state: State): Row[] {
  const seen = new Map<string, Row>();
  for (const event of visibleRows(state)) {
    const properties = event.properties;
    seen.set(tuple(event.event, properties.distinct_id, properties.time, properties['$insert_id']), event);
  }
  return [...seen.values()];
}
function destinationAssignments(state: State, normalized: Row[]): { byIdentity: Map<string, Row[]>; assigned: Map<Row, string>; ambiguous: Set<string> } {
  const byIdentity = new Map<string, Row[]>();
  for (const event of normalized) { const key = destinationIdentity(event); byIdentity.set(key, [...(byIdentity.get(key) ?? []), event]); }
  const sourceKinds = new Map<string, Set<string>>();
  for (const event of sourceEvents(state)) {
    const key = sourceIdentity(event), kinds = sourceKinds.get(key) ?? new Set<string>(); kinds.add(sourceKind(event)); sourceKinds.set(key, kinds);
  }
  const assigned = new Map<Row, string>(), ambiguous = new Set<string>();
  for (const [identity, rows] of byIdentity) {
    const candidates = sourceKinds.get(identity) ?? new Set<string>();
    const known = new Set(rows.map(event => eventClass(state, event)).filter((kind): kind is string => kind === 'purchase' || kind === 'refund'));
    const unknown = rows.filter(event => eventClass(state, event) === null), remaining = [...candidates].filter(kind => !known.has(kind));
    if (unknown.length && remaining.length === 1) for (const event of unknown) assigned.set(event, remaining[0]!);
    else if (unknown.length && candidates.size === 1) for (const event of unknown) assigned.set(event, [...candidates][0]!);
    else if (unknown.length && candidates.size) ambiguous.add(identity);
  }
  return { byIdentity, assigned, ambiguous };
}
function mpMoney(state: State, event: Row, kind?: string): bigint {
  const value = cents(event.properties.price_local);
  return (kind ?? eventClass(state, event)) === 'refund' ? -(value < 0n ? -value : value) : value;
}
function makeFind(cls: string, transaction: string, kind: string, currency: string, difference: bigint, user: string,
  evidence: string, environment = 'Production', evidenceId = ''): Row {
  let id = `${cls}|${transaction}|${kind}|${user}|${environment}|${currency}|${ID}|${APP}`;
  if (evidenceId) id += `|${evidenceId}`;
  return { id, cls, txn: transaction, user, event_class: kind, currency, environment, delta: amountFromCents(difference), evidence,
    note: 'Synthetic observations; no provider calls', provenance: 'FULL_MOCK' };
}
function amountFromCents(value: bigint): string {
  const negative = value < 0n, absolute = negative ? -value : value;
  return `${negative ? '-' : ''}${absolute / 100n}.${(absolute % 100n).toString().padStart(2, '0')}`;
}
function planPayload(state: State, cls: string, finding: Row, evidenceVersion?: string): Row {
  const source = state.source.find((event: Row) => sourceIdentity(event) === transactionKey(finding.txn, finding.user, finding.environment, finding.currency)
    && sourceKind(event) === finding.event_class);
  if (!source) throw new AnalyticsRequestError(`Missing source for ${finding.id}`);
  const properties = source.event_properties, sourceAmount = getMoney(source);
  const missing = cls === 'MISSING_IN_MIXPANEL';
  const event = missing ? source.event_type : 'reconcile_correction';
  const sumAmount = missing ? sourceAmount : -cents(finding.delta);
  const corrects = missing ? null : finding.event_class;
  const version = evidenceVersion ?? findingEvidenceHash(state, cls, [finding]);
  const payloadProperties: Row = { distinct_id: finding.user, time: T0 + 1000,
    '$insert_id': uid(`apply/${finding.id}/${finding.delta}/${version}`), transaction_id: finding.txn,
    original_transaction_id: properties.original_transaction_id, currency: finding.currency, price_local: amountFromCents(sumAmount),
    environment: finding.environment, store: 'play_store', reconcile_run_id: ID };
  if (corrects) Object.assign(payloadProperties, { corrects_class: cls, corrects_event_class: corrects, reason: 'synthetic approved correction' });
  return { event, properties: payloadProperties };
}
function findingEvidence(state: State, cls: string, items: Row[]): Row {
  const txs = new Set(items.map(item => item.txn)), users = new Set(items.map(item => item.user));
  const source = state.source.filter((event: Row) => txs.has(event.event_properties.transaction_id) && users.has(event.customer_user_id));
  const destination = state.mixpanel.filter((item: Row) => txs.has(item.payload.properties.transaction_id) && users.has(item.payload.properties.distinct_id));
  const names = new Set<string>();
  for (const item of destination) names.add(item.payload.event);
  for (const event of source) names.add(event.event_type);
  return { run: state.manifest.run_id, app: state.manifest.app, class: cls, findings: items, source, destination,
    mappings: Object.fromEntries([...names].sort(cmp).map(name => [name, state.mappings[name] ?? null])) };
}
function findingEvidenceHash(state: State, cls: string, items: Row[]): string { return hashv(findingEvidence(state, cls, items)); }
function groupHash(state: State, cls: string, items: Row[], evidenceVersion?: string): string {
  const version = evidenceVersion ?? findingEvidenceHash(state, cls, items);
  const plan = ['MISSING_IN_MIXPANEL', 'PRICE_MISMATCH', 'DUPLICATE_IN_MIXPANEL'].includes(cls)
    ? items.map(item => planPayload(state, cls, item, version)) : [];
  return hashv({ evidence_hash: version, plan });
}

function groupState(state: State, cls: string, items: Row[]): string {
  if (cls === 'EXTRA_IN_MIXPANEL') return 'manual';
  if (cls === 'SANDBOX_EXPECTED') return 'expected';
  if (cls === 'UNMAPPED_EVENT_NAME') {
    const mapped = new Set(state.journal.filter((item: Row) => item.type === 'MAPPING_APPROVED' && ['purchase', 'refund'].includes(state.mappings[item.event]))
      .map((item: Row) => item.event));
    const present = new Set(visibleRows(state).map((event: Row) => event.event));
    return !items.length && [...mapped].some(name => present.has(name)) ? 'mapped' : 'open';
  }
  if (!['MISSING_IN_MIXPANEL', 'PRICE_MISMATCH', 'DUPLICATE_IN_MIXPANEL'].includes(cls)) return items.length ? 'manual' : 'open';
  if (!items.length) return actionRows(state).some(action => action.group === cls) ? 'verified' : 'open';
  if (actionRows(state).some(action => action.group === cls && (action.visible_at_tick ?? 0) > state.clock)) return 'pending';
  const approval = state.approvals[cls];
  return approval && approval.group_hash === groupHash(state, cls, items) ? 'approved' : 'open';
}

function verification(state: State): Row {
  const visible = visibleRows(state), statuses = Object.entries(state.actions as Record<string, Row>).sort(([a], [b]) => cmp(a, b)).map(([actionId, action]) => {
    const payload = visible.find((event: Row) => event.properties?.['$insert_id'] === action.insert_id && hashv(event) === action.payload_hash);
    const matched = payload !== undefined;
    const status = matched ? 'verified' : action.visible_at_tick > state.clock ? 'pending_visibility' : 'missing_readback';
    return { action_id: actionId, group: action.group, finding: action.finding, status, insert_id: action.insert_id, readback: matched ? payload : null };
  });
  let status = 'not_run';
  if (statuses.length) status = statuses.some((item: Row) => item.status === 'pending_visibility') ? 'pending_visibility'
    : statuses.every((item: Row) => item.status === 'verified') ? 'verified' : 'readback_failed';
  return { status, tick: state.clock, actions: statuses };
}

function detect(state: State): Row {
  const normalized = normalizedDestination(state), { byIdentity, assigned, ambiguous } = destinationAssignments(state, normalized), findings: Row[] = [];
  const byTransaction = new Map<string, Row[]>();
  for (const event of normalized) { const key = event.properties.transaction_id; byTransaction.set(key, [...(byTransaction.get(key) ?? []), event]); }
  const sourceByIdentity = new Map<string, Row[]>();
  for (const event of sourceEvents(state)) { const key = sourceIdentity(event); sourceByIdentity.set(key, [...(sourceByIdentity.get(key) ?? []), event]); }
  for (const [identity, sourceGroup] of sourceByIdentity) {
    const source = sourceGroup[0]!, properties = source.event_properties, tx = properties.transaction_id, user = source.customer_user_id;
    const environment = properties.environment, currency = properties.currency, related = byTransaction.get(tx) ?? [];
    const kinds = sourceGroup.map(sourceKind);
    if (new Set(kinds).size !== kinds.length) {
      findings.push(makeFind('AMBIGUOUS_IDENTITY', tx, 'unknown', currency, 0n, user,
        'Multiple source events share the same transaction, user, environment and currency; automatic repair blocked', environment));
      continue;
    }
    if (related.some((event: Row) => { const parts = JSON.parse(destinationIdentity(event)); return parts[1] !== user || parts[2] !== environment; })) {
      findings.push(makeFind('AMBIGUOUS_IDENTITY', tx, 'unknown', currency, 0n, user,
        'Transaction exists under another user or environment; automatic repair blocked', environment));
      continue;
    }
    if (related.some((event: Row) => JSON.parse(destinationIdentity(event))[3] !== currency)) {
      findings.push(makeFind('CURRENCY_MISMATCH', tx, 'unknown', currency, 0n, user,
        'Transaction currency differs from source; automatic repair blocked', environment));
      continue;
    }
    if (ambiguous.has(identity)) {
      findings.push(makeFind('AMBIGUOUS_EVENT_CLASS', tx, 'unknown', currency, 0n, user,
        'Unmapped event could represent multiple event classes; automatic repair blocked', environment));
      continue;
    }
    const exact = byIdentity.get(identity) ?? [];
    for (const sourceEvent of sourceGroup) {
      const kind = sourceKind(sourceEvent), expected = getMoney(sourceEvent);
      const kindRows = exact.filter((event: Row) => eventClass(state, event) === kind || assigned.get(event) === kind);
      const unknown = exact.filter((event: Row) => eventClass(state, event) === null && assigned.get(event) === kind);
      if (unknown.length) {
        findings.push(makeFind('UNMAPPED_EVENT_NAME', tx, kind, currency, 0n, user,
          'Known transaction and identity present under an unmapped event name; do not backfill', environment));
        continue;
      }
      if (!kindRows.length) {
        findings.push(makeFind('MISSING_IN_MIXPANEL', tx, kind, currency, -expected, user,
          'Source has event; destination lacks matching class in declared scope', environment));
        continue;
      }
      let actual = 0n;
      for (const event of kindRows) if (eventClass(state, event) !== 'correction') actual += mpMoney(state, event, assigned.get(event));
      for (const event of exact) if (eventClass(state, event) === 'correction' && event.properties.corrects_event_class === kind) actual += cents(event.properties.price_local);
      if (amountFromCents(actual) !== amountFromCents(expected)) {
        const count = kindRows.filter((event: Row) => eventClass(state, event) === kind).length;
        const cls = count > 1 ? 'DUPLICATE_IN_MIXPANEL' : 'PRICE_MISMATCH';
        findings.push(makeFind(cls, tx, kind, currency, actual - expected, user,
          `${kindRows.length} effective destination events, source=${amountFromCents(expected)}, destination+corrections=${amountFromCents(actual)}`, environment));
      }
    }
  }
  for (const event of state.source) if (event.event_properties.environment === 'Sandbox') {
    const properties = event.event_properties;
    findings.push(makeFind('SANDBOX_EXPECTED', properties.transaction_id, 'purchase', properties.currency, 0n,
      event.customer_user_id, 'Sandbox excluded by metric contract', 'Sandbox', properties.profile_event_id));
  }
  const productionIds = new Set(sourceEvents(state).map((event: Row) => event.event_properties.transaction_id));
  for (const [tx, rows] of byTransaction) if (!productionIds.has(tx)) for (const event of rows) {
    const properties = event.properties;
    if (properties.environment !== 'Production' || eventClass(state, event) === 'correction') continue;
    const kind = eventClass(state, event) ?? assigned.get(event) ?? 'purchase';
    findings.push(makeFind('EXTRA_IN_MIXPANEL', tx, kind, properties.currency, mpMoney(state, event), properties.distinct_id,
      'Destination event without source transaction in known production population', properties.environment, properties['$insert_id']));
  }
  const sourceTotals = new Map<string, bigint>(), destinationTotals = new Map<string, bigint>();
  for (const event of sourceEvents(state)) {
    const currency = event.event_properties.currency;
    sourceTotals.set(currency, (sourceTotals.get(currency) ?? 0n) + getMoney(event));
  }
  for (const event of normalized) {
    const properties = event.properties;
    if (properties.environment !== 'Production') continue;
    const currency = properties.currency;
    destinationTotals.set(currency, (destinationTotals.get(currency) ?? 0n) + mpMoney(state, event, assigned.get(event)));
  }
  const currencies = [...new Set([...sourceTotals.keys(), ...destinationTotals.keys()])].sort(cmp);
  const gaps = Object.fromEntries(currencies.map(currency => [currency,
    amountFromCents((destinationTotals.get(currency) ?? 0n) - (sourceTotals.get(currency) ?? 0n))]));
  const groupsByClass = new Map<string, Row[]>();
  for (const finding of findings) groupsByClass.set(finding.cls, [...(groupsByClass.get(finding.cls) ?? []), finding]);
  const actions: Record<string, string> = { MISSING_IN_MIXPANEL: 'backfill_mixpanel', PRICE_MISMATCH: 'post_correction',
    DUPLICATE_IN_MIXPANEL: 'post_correction', UNMAPPED_EVENT_NAME: 'map_event_name', EXTRA_IN_MIXPANEL: 'investigate',
    SANDBOX_EXPECTED: 'none', AMBIGUOUS_IDENTITY: 'investigate', CURRENCY_MISMATCH: 'investigate', AMBIGUOUS_EVENT_CLASS: 'investigate' };
  const groups = [...groupsByClass.keys()].sort(cmp).map(cls => {
    const items = groupsByClass.get(cls)!, money = new Map<string, bigint>();
    for (const item of items) money.set(item.currency, (money.get(item.currency) ?? 0n) + cents(item.delta));
    const writes = ['MISSING_IN_MIXPANEL', 'PRICE_MISMATCH', 'DUPLICATE_IN_MIXPANEL'].includes(cls), stateName = groupState(state, cls, items);
    const evidenceHash = findingEvidenceHash(state, cls, items);
    return { cls, action: actions[cls], writes, confidence: 'deterministic/mock', risk: writes ? 'requires preview and approval' : 'none',
      why: `${items.length} synthetic finding(s); deterministic rule`, delta: Object.fromEntries([...money].map(([cur, value]) => [cur, amountFromCents(value)])),
      users: [...new Set(items.map(item => item.user))].sort(cmp), findings: items, evidence_hash: evidenceHash,
      group_hash: groupHash(state, cls, items, evidenceHash), state: stateName };
  });
  const classes = ['MISSING_IN_MIXPANEL', 'PRICE_MISMATCH', 'DUPLICATE_IN_MIXPANEL', 'UNMAPPED_EVENT_NAME', 'EXTRA_IN_MIXPANEL',
    'SANDBOX_EXPECTED', 'AMBIGUOUS_IDENTITY', 'CURRENCY_MISMATCH', 'AMBIGUOUS_EVENT_CLASS'];
  const groupStates = Object.fromEntries(classes.map(cls => [cls, groupState(state, cls, groupsByClass.get(cls) ?? [])]));
  const pending = pendingRows(state).length, verify = verification(state);
  let verificationStatus = verify.status;
  const active = groups.filter(group => !['EXTRA_IN_MIXPANEL', 'SANDBOX_EXPECTED'].includes(group.cls));
  if (pending) verificationStatus = 'pending_visibility';
  else if (Object.keys(state.actions).length && active.length) verificationStatus = 'open_findings';
  return { run: state.manifest.run_id, mode: 'FULL_MOCK', manifest: state.manifest, clock: state.clock, source_provenance: 'synthetic',
    destination_provenance: 'synthetic/stateful', source_totals: Object.fromEntries([...sourceTotals].map(([key, value]) => [key, amountFromCents(value)])),
    destination_effective_totals: Object.fromEntries([...destinationTotals].map(([key, value]) => [key, amountFromCents(value)])), gap: gaps,
    groups, group_states: groupStates, raw_event_count: visibleRows(state).length, query_event_count: normalized.length,
    pending_count: pending, approval_count: Object.keys(state.approvals).length, action_count: Object.keys(state.actions).length,
    verification_status: verificationStatus };
}

function preview(state: State, ids?: string[]): Row {
  const report = detect(state), groups = report.groups.filter((group: Row) => group.writes && (!ids || ids.includes(group.cls)));
  return { run: report.run, mode: 'FULL_MOCK', groups: groups.map((group: Row) => ({ class: group.cls, action: group.action,
    finding_ids: group.findings.map((finding: Row) => finding.id),
    expected_signed_gap_change: Object.fromEntries(Object.entries(group.delta).map(([currency, value]) => [currency, amountFromCents(-cents(value))])),
    approval_hash: group.group_hash, group_hash: group.group_hash, evidence_hash: group.evidence_hash,
    row_count: group.findings.length, payloads: group.findings.map((finding: Row) => planPayload(state, group.cls, finding, group.evidence_hash)),
    source_data: 'synthetic' })), notes: 'Preview is deterministic and cannot call any real provider' };
}

function approve(state: State, rawIds: unknown, actorValue: unknown = 'demo-operator', hashes: unknown = undefined): Row {
  const ids = selectedIds(rawIds), actor = validText(actorValue, 'actor', 100);
  if (pendingRows(state).length) throw new AnalyticsRequestError('Pending writes must be visible before approval');
  const report = detect(state), groups = new Map<string, Row>(report.groups.map((group: Row) => [group.cls, group]));
  const selected: Row[] = [];
  if (hashes !== undefined && !isRecord(hashes)) throw new AnalyticsRequestError('hashes must be an object');
  for (const cls of ids) {
    const group = groups.get(cls);
    if (!group || !group.writes) throw new AnalyticsRequestError(`Not an eligible repair group: ${cls}`);
    if (hashes !== undefined && (hashes as Row)[cls] !== group.group_hash) throw new AnalyticsRequestError(`Stale approval hash: ${cls}`);
    selected.push(group);
  }
  for (const group of selected) {
    const cls = group.cls;
    state.approvals[cls] = { actor, group_hash: group.group_hash, evidence_hash: group.evidence_hash,
      approved_at_tick: state.clock, findings: group.findings.map((finding: Row) => finding.id) };
    state.journal.push({ type: 'APPROVAL', cls, actor, tick: state.clock, hash: group.group_hash });
  }
  return { approved: [...ids] };
}

function doApply(state: State, rawIds: unknown): Row {
  const ids = selectedIds(rawIds), report = detect(state), groups = new Map<string, Row>(report.groups.map((group: Row) => [group.cls, group]));
  const plans: { cls: string; approval: Row; pending: { finding: Row; actionId: string }[] }[] = [];
  let newCount = 0;
  for (const cls of ids) {
    const approval = state.approvals[cls];
    if (!approval) throw new AnalyticsRequestError(`Approval required for ${cls}`);
    const group = groups.get(cls);
    if (!group) {
      if (actionRows(state).some(action => action.group === cls)) continue;
      throw new AnalyticsRequestError(`No outstanding approved group: ${cls}`);
    }
    if (!group.writes) throw new AnalyticsRequestError(`Read-only class: ${cls}`);
    const version = approval.evidence_hash ?? group.evidence_hash;
    const pending = group.findings.map((finding: Row) => ({ finding,
      actionId: uid(`action/${finding.id}/${finding.delta}/${version}`) }))
      .filter((item: { finding: Row; actionId: string }) => !state.actions[item.actionId]);
    if (!pending.length) continue;
    if (group.group_hash !== approval.group_hash) throw new AnalyticsRequestError(`Stale approval, re-run preview: ${cls}`);
    plans.push({ cls, approval, pending }); newCount += pending.length;
  }
  if (newCount && pendingRows(state).length) throw new AnalyticsRequestError('Pending writes must be visible before new repairs');
  if (!newCount) return { writes_accepted: 0, state: 'no_op', report };
  let accepted = 0;
  for (const { cls, approval, pending } of plans) for (const { finding, actionId } of pending) {
    const version = approval.evidence_hash ?? findingEvidenceHash(state, cls, groups.get(cls)!.findings);
    const payload = planPayload(state, cls, finding, version), visibleAt = state.clock + 1;
    state.mixpanel.push({ payload, visible_at: visibleAt, receipt: { http_status: 200, accepted: 1, simulated: true } });
    state.actions[actionId] = { group: cls, finding: finding.id, txn: finding.txn, user: finding.user,
      event_class: finding.event_class, currency: finding.currency, environment: finding.environment, delta: finding.delta,
      evidence_hash: version, payload_hash: hashv(payload), insert_id: payload.properties['$insert_id'],
      accepted_at_tick: state.clock, visible_at_tick: visibleAt, approval_actor: approval.actor };
    state.journal.push({ type: 'WRITE_ACCEPTED_MOCK', cls, finding: finding.id, action_id: actionId, tick: state.clock,
      destination_visible_at: visibleAt, payload });
    accepted++;
  }
  return { writes_accepted: accepted, state: 'pending_visibility', report: detect(state) };
}

function mapName(state: State, eventValue: unknown, classValue: unknown, actorValue: unknown): Row {
  const event = validText(eventValue, 'event name', 128), actor = validText(actorValue, 'actor', 100);
  if (event === 'reconcile_correction' || (classValue !== 'purchase' && classValue !== 'refund')) throw new AnalyticsRequestError('Bad event class');
  if (pendingRows(state).length) throw new AnalyticsRequestError('Pending writes must be visible before mapping changes');
  const previous = state.mappings[event]; state.mappings[event] = classValue;
  state.journal.push({ type: 'MAPPING_APPROVED', actor, event, from: previous ?? null, to: classValue, tick: state.clock });
  return { event, event_class: classValue, approved_by: actor };
}

function advance(state: State, countValue: unknown = 1): Row {
  const count = typeof countValue === 'string' && /^\d+$/.test(countValue) ? Number(countValue) : countValue;
  if (typeof count !== 'number' || !Number.isInteger(count) || count <= 0 || count > 100) throw new AnalyticsRequestError('Tick must be 1..100');
  state.clock += count; state.journal.push({ type: 'MOCK_CLOCK_ADVANCED', tick: state.clock });
  return detect(state);
}

function profile(state: State, user: string): Row | null {
  const events = state.source.filter((event: Row) => event.customer_user_id === user);
  if (!events.length) return null;
  const environment = events[0]!.event_properties.environment;
  let revenue: Decimal = { coefficient: 0n, scale: 0 };
  for (const event of events) {
    const value = decimal(event.event_properties.price_usd), sign = event.event_type === 'subscription_refunded' ? -1n : 1n;
    const scale = Math.max(revenue.scale, value.scale);
    revenue = { coefficient: revenue.coefficient * 10n ** BigInt(scale - revenue.scale)
      + sign * value.coefficient * 10n ** BigInt(scale - value.scale), scale };
  }
  const first = events[0]!, transaction = first.event_properties.transaction_id;
  return { data: { app_id: APP, profile_id: first.profile_id, customer_user_id: user,
    total_revenue_usd: decimalToNumber(revenue), timestamp: 1794042000000,
    custom_attributes: [{ key: 'seed_source', value: 'mock_first' }],
    access_levels: environment === 'Sandbox' ? [] : [{ access_level_id: 'premium', store: 'play_store',
      store_transaction_id: transaction, expires_at: '2026-12-01T00:00:00Z' }],
    subscriptions: environment === 'Sandbox' ? [] : [{ store: 'play_store', store_product_id: 'mock.monthly',
      store_transaction_id: transaction, environment, expires_at: '2026-12-01T00:00:00Z' }], non_subscriptions: [] } };
}

function operations(state: State): Row {
  const normalized = normalizedDestination(state), { assigned, ambiguous } = destinationAssignments(state, normalized);
  const pending = pendingRows(state).map((item: Row) => item.payload), sources = new Map<string, bigint>(), destinations = new Map<string, bigint>();
  const pendingKeys = new Set<string>();
  const key = (tx: string, user: string, environment: string, currency: string, kind: string): string => tuple(tx, user, environment, currency, kind);
  for (const event of state.source) {
    const properties = event.event_properties, kind = sourceKind(event), k = key(properties.transaction_id, event.customer_user_id, properties.environment, properties.currency, kind);
    const value = properties.environment === 'Production' ? getMoney(event) : 0n;
    sources.set(k, (sources.get(k) ?? 0n) + value);
  }
  for (const event of normalized) {
    const properties = event.properties, classified = eventClass(state, event);
    let kind: string | null = classified, value: bigint;
    if (classified === 'correction') {
      const corrects = properties.corrects_event_class;
      if (corrects !== 'purchase' && corrects !== 'refund') continue;
      kind = corrects; value = cents(properties.price_local);
    }
    else { kind = kind ?? assigned.get(event) ?? 'purchase'; value = mpMoney(state, event, kind); }
    const k = key(properties.transaction_id, properties.distinct_id, properties.environment, properties.currency, kind!);
    if (properties.environment === 'Production') destinations.set(k, (destinations.get(k) ?? 0n) + value);
  }
  for (const event of pending) {
    const properties = event.properties, classified = eventClass(state, event);
    let kind = classified === 'correction' ? properties.corrects_event_class : classified;
    kind = kind ?? assigned.get(event) ?? 'purchase';
    pendingKeys.add(key(properties.transaction_id, properties.distinct_id, properties.environment, properties.currency, kind));
  }
  const allKeys = new Set([...sources.keys(), ...destinations.keys()]), rows: Row[] = [];
  for (const k of allKeys) {
    const [tx, user, environment, currency, kind] = JSON.parse(k) as string[];
    const identity = transactionKey(tx!, user!, environment!, currency!), sourceAmount = sources.get(k) ?? 0n, destination = destinations.get(k) ?? 0n;
    const related = normalized.filter((event: Row) => event.properties.transaction_id === tx);
    const sourceDuplicates = state.source.filter((event: Row) => sourceIdentity(event) === identity && sourceKind(event) === kind).length > 1;
    const manual = sourceDuplicates || related.some((event: Row) => {
      const parts = JSON.parse(destinationIdentity(event)); return parts[1] !== user || parts[2] !== environment;
    }) || related.some((event: Row) => JSON.parse(destinationIdentity(event))[3] !== currency) || ambiguous.has(identity);
    const unmapped = normalized.some((event: Row) => eventClass(state, event) === null && assigned.get(event) === kind && destinationIdentity(event) === identity);
    let status: string;
    if (environment === 'Sandbox') status = 'expected';
    else if (manual || !sources.has(k)) status = 'manual';
    else if (pendingKeys.has(k)) status = 'pending';
    else if (unmapped) status = 'unmapped';
    else if (amountFromCents(destination) === amountFromCents(sourceAmount)) {
      status = actionRows(state).some(action => action.txn === tx && action.user === user && action.environment === environment
        && action.currency === currency && action.event_class === kind) ? 'verified' : 'healthy';
    } else status = 'open';
    rows.push({ txn: tx, user, event_class: kind, currency, source_amount: amountFromCents(environment === 'Sandbox' ? 0n : sourceAmount),
      destination_amount: amountFromCents(environment === 'Sandbox' ? 0n : destination),
      delta: amountFromCents(environment === 'Sandbox' ? 0n : destination - sourceAmount), status, environment });
  }
  rows.sort((a, b) => cmp(a.txn, b.txn) || cmp(a.user, b.user) || cmp(a.environment, b.environment)
    || cmp(a.event_class, b.event_class) || cmp(a.currency, b.currency));
  return { operations: rows, mode: 'FULL_MOCK' };
}

function recordHistory(state: State, kind: string, report: Row): Row {
  const sequence = (state.history_seq ?? 0) + 1; state.history_seq = sequence;
  state.history.push({ id: `${ID}-${kind}-${String(sequence).padStart(6, '0')}`, kind, tick: state.clock, report });
  state.history = state.history.slice(-20);
  return { runs: [...state.history].reverse() };
}

function audit(state: State): Row {
  return { run: ID, mode: 'FULL_MOCK', manifest: state.manifest, journal: state.journal, actions: state.actions,
    approvals: state.approvals, verification: verification(state) };
}

function evidence(state: State, transaction: string): Row {
  const source = state.source.filter((event: Row) => event.event_properties.transaction_id === transaction);
  const destination: Row[] = [], pending: Row[] = [], correctionReceipts: Row[] = [];
  for (const item of state.mixpanel) {
    const payload = item.payload;
    if (payload.properties.transaction_id !== transaction) continue;
    if (item.visible_at <= state.clock) {
      destination.push(payload);
      if (eventClass(state, payload) === 'correction') correctionReceipts.push({ payload, receipt: item.receipt, visible_at_tick: item.visible_at });
    } else pending.push({ payload, receipt: item.receipt, visible_at_tick: item.visible_at });
  }
  return { txn: transaction, source, destination, pending_destination: pending, correction_receipts: correctionReceipts, mode: 'FULL_MOCK' };
}

function validateImportEvent(event: unknown, manifest: Row): Row {
  if (!isRecord(event) || !isRecord(event.properties)) throw new AnalyticsRequestError('Every import row must be an event object');
  const clean = clone(event), properties = event.properties, cleanProperties = clean.properties;
  clean.event = validText(event.event, 'event name', 128);
  for (const name of ['distinct_id', '$insert_id', 'transaction_id', 'currency', 'environment']) {
    cleanProperties[name] = validText(properties[name], name, 256);
  }
  if (typeof properties.time !== 'number' || !Number.isInteger(properties.time) || properties.time < 0) throw new AnalyticsRequestError('Invalid time');
  if (!['USD', 'EUR'].includes(cleanProperties.currency)) throw new AnalyticsRequestError('Unsupported currency for this mock project');
  if (!['Production', 'Sandbox'].includes(cleanProperties.environment)) throw new AnalyticsRequestError('Invalid environment');
  if (clean.event === 'reconcile_correction' && !['purchase', 'refund'].includes(properties.corrects_event_class)) {
    throw new AnalyticsRequestError('Correction requires corrects_event_class');
  }
  for (const key of ['app_id', 'app']) {
    if (key in event && event[key] !== manifest.app) throw new AnalyticsRequestError('Wrong app for mock project');
    if (key in properties && properties[key] !== manifest.app) throw new AnalyticsRequestError('Wrong app for mock project');
  }
  if (!('price_local' in properties)) throw new AnalyticsRequestError('Missing property: price_local');
  const money = decimal(properties.price_local), normalized = amount(properties.price_local);
  if (money.scale > 2 && money.coefficient % (10n ** BigInt(money.scale - 2)) !== 0n) {
    throw new AnalyticsRequestError('price_local supports two decimal places in this mock project');
  }
  cleanProperties.price_local = normalized;
  return clean;
}

function fileErrorCode(error: unknown): string | undefined {
  return typeof error === 'object' && error !== null && 'code' in error ? String((error as { code: unknown }).code) : undefined;
}

async function ensureSafeDatabasePath(path: string): Promise<boolean> {
  if (path === ':memory:') return true;
  if (!path) return false;
  const absolute = resolve(path);
  await mkdir(dirname(absolute), { recursive: true, mode: 0o700 });
  let stat;
  try { stat = await lstat(absolute); }
  catch (error) {
    if (fileErrorCode(error) !== 'ENOENT') throw error;
  }
  if (stat) {
    if (stat.isSymbolicLink() || !stat.isFile()) throw new Error('Analytics database path must be a regular, non-symlink file');
    let db: DatabaseSync | undefined;
    try {
      db = new DatabaseSync(absolute, { readOnly: true });
      const marker = db.prepare('SELECT value FROM legacy_analytics_meta WHERE key = ?').get('scope') as { value: string } | undefined;
      if (marker?.value !== MARKER) throw new Error('Refusing an existing SQLite file without the legacy analytics marker');
    } catch (error) {
      if (error instanceof Error && error.message.includes('legacy analytics marker')) throw error;
      throw new Error('Refusing an existing SQLite file without the legacy analytics marker');
    } finally { db?.close(); }
    return false;
  }
  // Reserve the path so a pre-existing file cannot be opened and modified between preflight and worker startup.
  const descriptor = openSync(absolute, 'wx', 0o600);
  closeSync(descriptor);
  return true;
}

/**
 * The monolith calls this adapter with a method, URL and already parsed JSON body.
 * It owns only analytics demo routes. The HTTP layer remains responsible for loopback
 * write-origin checks, JSON content type and bounded request-body parsing.
 */
export class AnalyticsDemo {
  private serial: Promise<void> = Promise.resolve();
  private constructor(private readonly storage: SQLiteStorage, private readonly referenceDirectory: string) {}

  static async create(options: AnalyticsDemoOptions): Promise<AnalyticsDemo> {
    if (typeof options?.databasePath !== 'string' || !options.databasePath.trim()) throw new Error('A dedicated analytics databasePath is required');
    const fresh = await ensureSafeDatabasePath(options.databasePath);
    const storage = new SQLiteStorage(options.databasePath);
    const adapter = new AnalyticsDemo(storage, resolve(options.referenceDirectory ?? resolve(process.cwd(), 'reconcile-mock-first-kit/reference')));
    try {
      await storage.transaction([
        { mode: 'run', sql: 'CREATE TABLE IF NOT EXISTS legacy_analytics_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)' },
        { mode: 'run', sql: 'CREATE TABLE IF NOT EXISTS legacy_analytics_state (id INTEGER PRIMARY KEY CHECK (id = 1), revision INTEGER NOT NULL, payload TEXT NOT NULL, digest TEXT NOT NULL)' },
        { mode: 'run', sql: 'INSERT OR IGNORE INTO legacy_analytics_meta (key,value) VALUES (\'scope\',?)', params: [MARKER] },
        ...(fresh ? [{ mode: 'run' as const, sql: 'INSERT OR IGNORE INTO legacy_analytics_state (id,revision,payload,digest) VALUES (1,0,?,?)',
          params: [semanticJson(seed()), semanticDigest(seed())] }] : [])
      ]);
      const marker = await storage.statement({ mode: 'get', sql: 'SELECT value FROM legacy_analytics_meta WHERE key = ?', params: ['scope'] }) as { value: string } | null;
      if (marker?.value !== MARKER) throw new Error('Analytics database marker mismatch');
      const row = await storage.statement({ mode: 'get', sql: 'SELECT payload,digest FROM legacy_analytics_state WHERE id = 1' }) as { payload: string; digest: string } | null;
      if (!row || semanticDigest(JSON.parse(row.payload)) !== row.digest) throw new Error('Analytics database state is missing or corrupt');
      return adapter;
    } catch (error) {
      await storage.close();
      throw error;
    }
  }

  async close(): Promise<void> { await this.serial; await this.storage.close(); }

  private async state(): Promise<{ value: State; revision: number }> {
    const row = await this.storage.statement({ mode: 'get', sql: 'SELECT revision,payload,digest FROM legacy_analytics_state WHERE id = 1' }) as
      { revision: number; payload: string; digest: string } | null;
    if (!row) throw new Error('Analytics database state is missing');
    const value = JSON.parse(row.payload) as State;
    if (semanticDigest(value) !== row.digest) throw new Error('Analytics database integrity check failed');
    return { value, revision: row.revision };
  }

  private async update<T>(operation: (state: State) => T): Promise<T> {
    const loaded = await this.state(), result = operation(loaded.value);
    const payload = semanticJson(loaded.value), digest = semanticDigest(loaded.value);
    const values = await this.storage.transaction([
      { mode: 'run', sql: 'UPDATE legacy_analytics_state SET revision = revision + 1, payload = ?, digest = ? WHERE id = 1 AND revision = ?',
        params: [payload, digest, loaded.revision] },
      { mode: 'get', sql: 'SELECT revision FROM legacy_analytics_state WHERE id = 1' }
    ]) as [unknown, { revision: number }];
    if (values[1]?.revision !== loaded.revision + 1) throw new Error('Analytics state changed concurrently; retry the request');
    return result;
  }

  private async sampleIndex(): Promise<Row> {
    let root: string;
    try { root = await realpath(this.referenceDirectory); }
    catch (error) { if (fileErrorCode(error) === 'ENOENT') return { samples: [] }; throw error; }
    const samples: Row[] = [];
    const visit = async (directory: string): Promise<void> => {
      for (const entry of await readdir(directory, { withFileTypes: true })) {
        const full = resolve(directory, entry.name), stat = await lstat(full);
        if (stat.isSymbolicLink()) continue;
        if (stat.isDirectory()) await visit(full);
        else if (stat.isFile()) {
          const relativePath = relative(root, full).split(sep).join('/');
          samples.push({ path: relativePath, provider: relativePath.includes('/') ? relativePath.split('/', 1)[0] : 'reference', bytes: stat.size });
        }
      }
    };
    await visit(root);
    samples.sort((left, right) => cmp(left.path, right.path));
    return { samples };
  }

  private async readSample(name: string): Promise<Row> {
    if (typeof name !== 'string' || !name || name.startsWith('/') || name.includes('\\') || name.includes('\0')) throw new AnalyticsRequestError('Invalid sample path');
    const parts = name.split('/');
    if (parts.some(part => !part || part === '.' || part === '..' || part.startsWith('.'))) throw new AnalyticsRequestError('Invalid sample path');
    let root: string;
    try { root = await realpath(this.referenceDirectory); }
    catch (error) {
      if (fileErrorCode(error) === 'ENOENT') throw new AnalyticsRequestError('Unknown sample', 404);
      throw error;
    }
    const target = resolve(root, ...parts);
    let stat;
    try { stat = await lstat(target); }
    catch (error) { if (fileErrorCode(error) === 'ENOENT') throw new AnalyticsRequestError('Unknown sample', 404); throw error; }
    if (stat.isSymbolicLink() || !stat.isFile()) throw new AnalyticsRequestError('Unknown sample', 404);
    const resolvedTarget = await realpath(target), relativePath = relative(root, resolvedTarget);
    if (relativePath === '..' || relativePath.startsWith(`..${sep}`) || isAbsolute(relativePath)) throw new AnalyticsRequestError('Unknown sample', 404);
    return { path: relativePath.split(sep).join('/'), content: (await readFile(resolvedTarget, 'utf8')).replace(/\r\n?/g, '\n'), mode: 'FULL_MOCK' };
  }

  private async route(method: string, rawUrl: string, body: unknown): Promise<AnalyticsDemoResponse> {
    const json = (bodyValue: unknown, status = 200): AnalyticsDemoResponse => ({ status, contentType: 'application/json', body: bodyValue });
    const text = (bodyValue: string, contentType: string): AnalyticsDemoResponse => ({ status: 200, contentType, body: bodyValue });
    let url: URL;
    try { url = new URL(rawUrl, 'http://127.0.0.1'); }
    catch { return json({ error: 'bad request' }, 400); }
    const path = url.pathname, query = url.searchParams;
    try {
      if (method === 'GET') {
        if (path === '/api/report') {
          if ((query.get('run') ?? ID) !== ID) return json({ error: 'unknown run' }, 404);
          return json(detect((await this.state()).value));
        }
        if (path === '/api/preview') return json(preview((await this.state()).value));
        if (path === '/api/verify') {
          const { value } = await this.state(), report = detect(value); report.verification = verification(value); return json(report);
        }
        if (path === '/api/evidence') return json(evidence((await this.state()).value, query.get('txn') ?? ''));
        if (path === '/api/audit') return json(audit((await this.state()).value));
        if (path === '/api/manifest') return json((await this.state()).value.manifest);
        if (path === '/api/history') return json({ runs: [...(await this.state()).value.history].reverse() });
        if (path === '/api/operations') return json(operations((await this.state()).value));
        if (path === '/api/samples') return json(await this.sampleIndex());
        if (path === '/api/sample') {
          try { return json(await this.readSample(query.get('path') ?? '')); }
          catch (error) { return json({ error: error instanceof Error ? error.message : 'Unknown sample' },
            error instanceof AnalyticsRequestError ? error.status : 500); }
        }
        if (path === '/mock/adapty/api/v2/server-side-api/profile/') {
          const user = query.has('customer_user_id') ? query.get('customer_user_id') ?? '' : query.get('adapty-customer-user-id') ?? '';
          const result = profile((await this.state()).value, user);
          return result ? json(result) : json({ error: 'profile_does_not_exist' }, 404);
        }
        if (path === '/mock/adapty/events/export') {
          const source = (await this.state()).value.source;
          return text(`${source.map((event: Row) => semanticJson(event)).join('\n')}\n`, 'application/x-ndjson');
        }
        if (path === '/mock/mixpanel/api/2.0/export') {
          const events = visibleRows((await this.state()).value);
          return text(`${events.map((event: Row) => semanticJson(event)).join('\n')}\n`, 'application/x-ndjson');
        }
        if (path === '/mock/mixpanel/query') {
          const report = detect((await this.state()).value);
          return json({ totals: report.destination_effective_totals, gap: report.gap,
            metric: 'source-like events PLUS reconcile_correction; MOCK ONLY' });
        }
        return json({ error: 'not found' }, 404);
      }
      if (method !== 'POST') return json({ error: 'not found' }, 404);
      if (path === '/api/reset') {
        if (!isRecord(body)) return json({ error: 'Object required' }, 400);
        return json(await this.update(state => {
          const baseline = seed(); Object.keys(state).forEach(key => delete state[key]); Object.assign(state, baseline);
          return { mode: 'FULL_MOCK', manifest: state.manifest, report: detect(state) };
        }));
      }
      if (path === '/api/detect' || path === '/api/verify') {
        if (!isRecord(body)) return json({ error: 'Object required' }, 400);
        return json(await this.update(state => {
          const report = detect(state);
          if (path === '/api/verify') report.verification = verification(state);
          recordHistory(state, path.endsWith('detect') ? 'detect' : 'verify', report);
          return report;
        }));
      }
      if (path === '/api/approve') {
        if (!isRecord(body)) return json({ error: 'Object required' }, 400);
        if ((body.run === undefined ? ID : body.run) !== ID) return json({ error: 'unknown run' }, 404);
        const hashes = body.hashes === undefined ? body.group_hashes : body.hashes;
        return json(await this.update(state => approve(state, body.ids, body.actor === undefined ? 'demo-operator' : body.actor, hashes ?? undefined)));
      }
      if (path === '/api/apply') {
        if (!isRecord(body)) return json({ error: 'Object required' }, 400);
        if ((body.run === undefined ? ID : body.run) !== ID) return json({ error: 'unknown run' }, 404);
        return json(await this.update(state => doApply(state, body.ids)));
      }
      if (path === '/api/map') {
        if (!isRecord(body)) return json({ error: 'Object required' }, 400);
        return json(await this.update(state => mapName(state, body.event, body.cls,
          body.actor === undefined ? 'demo-operator' : body.actor)));
      }
      if (path === '/api/reset-mappings') {
        if (!isRecord(body)) return json({ error: 'Object required' }, 400);
        return json(await this.update(state => {
          if (pendingRows(state).length) throw new AnalyticsRequestError('Pending writes must be visible before mapping changes');
          state.mappings = { subscription_started: 'purchase', subscription_refunded: 'refund' };
          state.journal.push({ type: 'MAPPING_RESET', actor: validText(body.actor === undefined ? 'demo-operator' : body.actor, 'actor', 100), tick: state.clock });
          return { mappings: state.mappings, mode: 'FULL_MOCK' };
        }));
      }
      if (path === '/api/advance-clock') {
        if (!isRecord(body)) return json({ error: 'Object required' }, 400);
        return json(await this.update(state => advance(state, body.ticks === undefined ? 1 : body.ticks)));
      }
      if (path === '/mock/mixpanel/import') {
        if (!Array.isArray(body)) return json({ error: 'list required' }, 400);
        if (!body.length) return json({ error: 'Import rows must be non-empty' }, 400);
        const loaded = (await this.state()).value, clean = body.map(event => validateImportEvent(event, loaded.manifest));
        if ((query.get('region') ?? 'eu') === 'us') return json({ status: 'accepted_transport_but_dropped_mock', num_records_imported: 0 });
        return json(await this.update(state => {
          for (const event of clean) state.mixpanel.push({ payload: event, visible_at: state.clock + 1,
            receipt: { simulated: true, http_status: 200, accepted: 1 } });
          return { code: 200, status: 'success_mock', num_records_imported: clean.length };
        }));
      }
      return json({ error: 'not found' }, 404);
    } catch (error) {
      const requestError = error instanceof AnalyticsRequestError;
      return json({ error: requestError ? error.message : 'internal error' },
        requestError ? error.status : 500);
    }
  }

  /** Serialize a request against the adapter state and return a JSON or NDJSON response. */
  handle(method: string, url: string, parsedBody?: unknown): Promise<AnalyticsDemoResponse> {
    const execute = (): Promise<AnalyticsDemoResponse> => this.route(method.toUpperCase(), url, parsedBody);
    const current = this.serial.then(execute, execute);
    this.serial = current.then(() => undefined, () => undefined);
    return current;
  }
}
