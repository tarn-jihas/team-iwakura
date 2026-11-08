// Browser prototype over bounded, schema-based fixtures. No oracle is imported.
export const SCENARIOS = [
  { id: 'zero_net_two_errors', title: 'Equal totals. Two unresolved operations.', description: 'The same net amount can hide a missing charge and an extra analytics event.', tag: 'Hidden discrepancy' },
  { id: 'missing_refund', title: 'A refund did not reach analytics', description: 'Trace the refund from the Adapty projection to the downstream export.', tag: 'Missing operation' },
  { id: 'double_tracking', title: 'One charge, two analytics events', description: 'Separate event identities refer to the same economic operation.', tag: 'Duplicate event' },
  { id: 'repeated_delivery', title: 'A retry that is not a second charge', description: 'The documented delivery key identifies a repeated delivery.', tag: 'Delivery retry' },
  { id: 'price_unit_error', title: 'An amount needs investigation', description: 'Compare the reported USD amount against the reference operation.', tag: 'Amount mismatch' },
  { id: 'clean', title: 'A complete, matching fixture', description: 'Every operation matches within this explicitly bounded synthetic scope.', tag: 'Clean reference' },
];

type AnyObject = Record<string, any>;
type FixtureLoader = (name: string) => Promise<string>;
const RULES = 'browser-demo-1.0';
const CASH_EVENTS = new Map([['trial_converted', 'charge'], ['subscription_renewed', 'charge'], ['subscription_started', 'charge'], ['subscription_refunded', 'refund']]);
const COV = new Set(['declared_complete', 'partial', 'unknown']);
const cleanObject = (value: unknown): value is AnyObject => Boolean(value && typeof value === 'object' && !Array.isArray(value));
const sum = (ops: AnyObject[]) => ops.reduce((value, op) => value + BigInt(op.amountMinor), 0n);

function required(value: unknown, name: string, line: number) {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`Record ${line}: ${name} is required.`);
  return value;
}
function date(value: unknown, name: string, line: number) {
  const v = required(value, name, line);
  if (!/^\d{4}-\d{2}-\d{2}T.*(?:Z|[+-]\d{2}:\d{2})$/.test(v) || !Number.isFinite(Date.parse(v))) throw new Error(`Record ${line}: ${name} must be an ISO timestamp with a timezone.`);
  return new Date(v).toISOString();
}
function minor(value: unknown, line: number) {
  if (typeof value !== 'string' && !(typeof value === 'number' && Number.isFinite(value))) throw new Error(`Record ${line}: price_usd must be a decimal string or numeric literal.`);
  const valueText = String(value);
  if (valueText.length > 40 || !/^\d+(?:\.\d{1,2}0*)?$/.test(valueText)) throw new Error(`Record ${line}: expected a non-negative USD decimal with at most two meaningful fraction digits.`);
  const [whole, fraction = ''] = valueText.split('.');
  return BigInt(whole) * 100n + BigInt((fraction + '00').slice(0, 2));
}
function googleMoney(money: AnyObject, line: number) {
  if (!cleanObject(money) || money.currencyCode !== 'USD') throw new Error(`Record ${line}: this prototype supports USD only.`);
  if (money.units !== undefined && typeof money.units !== 'string') throw new Error(`Record ${line}: Google Money.units must be an int64 string.`);
  const units = String(money.units ?? '0'), nanos = money.nanos ?? 0;
  if (units.length > 30 || !/^\d+$/.test(units) || !Number.isSafeInteger(nanos) || nanos < 0 || nanos >= 1e9 || nanos % 1e7 !== 0) throw new Error(`Record ${line}: Google Money must contain exact, non-negative USD cents.`);
  return BigInt(units) * 100n + BigInt(nanos / 1e7);
}
function fingerprint(text: string) {
  // Human-readable demo fingerprint, not a cryptographic verification claim.
  let hash = 2166136261;
  for (let i = 0; i < text.length; i++) { hash ^= text.charCodeAt(i); hash = Math.imul(hash, 16777619); }
  return `demo-${(hash >>> 0).toString(16).padStart(8, '0')}`;
}
function deliverySignature(op: AnyObject) {
  return JSON.stringify([op.transactionId, op.type, op.amountMinor, op.timestamp, op.store, op.environment, op.productId]);
}
function sourceWithStats(source: AnyObject): AnyObject {
  const deliveries = new Map<string, AnyObject>(), unique: AnyObject[] = [], duplicates: AnyObject[][] = [], conflicts: AnyObject[][] = [];
  for (const op of source.operations) {
    const key = op.deliveryKey;
    if (!key || !deliveries.has(key)) { if (key) deliveries.set(key, op); unique.push(op); continue; }
    const original = deliveries.get(key)!;
    if (deliverySignature(original) === deliverySignature(op)) duplicates.push([original, op]);
    else throw new Error(`Conflicting financial payloads share one delivery key at ${original.locator} and ${op.locator}. This prototype blocks that source instead of selecting an amount.`);
  }
  return { ...source, recordCount: source.records.length, rawCount: source.operations.length, dedupCount: unique.length,
    rawTotalMinor: sum(source.operations).toString(), totalMinor: sum(unique).toString(), uniqueOperations: unique,
    deliveryDuplicates: duplicates, deliveryConflicts: conflicts };
}

function parseWithDecimalLexemes(text: string): any {
  // Keep exact money tokens while scanning JSON, without rewriting text inside strings.
  let out = '', i = 0;
  while (i < text.length) {
    if (text[i] !== '"') { out += text[i++]; continue; }
    const start = i++;
    while (i < text.length) {
      if (text[i] === '\\') { i += 2; continue; }
      if (text[i++] === '"') break;
    }
    const token = text.slice(start, i); out += token;
    let name: unknown;
    try { name = JSON.parse(token); } catch { continue; }
    if (name !== 'price_usd') continue;
    const match = text.slice(i).match(/^(\s*:\s*)(-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?)(?=\s*[,}\]])/);
    if (match) { out += match[1] + JSON.stringify(match[2]); i += match[0].length; }
  }
  return JSON.parse(out);
}

export function parseSource(text: string, provider: string) {
  if (!['adapty', 'mixpanel', 'google_play'].includes(provider)) throw new Error('Choose a supported source format.');
  if (typeof text !== 'string' || !text.trim()) throw new Error('The selected file is empty.');
  if (new TextEncoder().encode(text).length > 10 * 1024 * 1024) throw new Error('The browser prototype accepts files up to 10 MiB.');
  let records: AnyObject[] = [], rawTexts: string[] = [], positions: string[] = [];
  try {
    if (provider === 'google_play' || text.trimStart().startsWith('[')) {
      const parsed = parseWithDecimalLexemes(text);
      records = Array.isArray(parsed) ? parsed : Array.isArray(parsed?.orders) ? parsed.orders : parsed?.orderId ? [parsed] : [];
      if (!records.length) throw new Error('Expected a Google order, an orders array or a JSON array of event objects.');
      rawTexts = records.map(record => JSON.stringify(record, null, 2));
      positions = records.map((_, i) => provider === 'google_play' ? (Array.isArray(parsed?.orders) ? `/orders/${i}` : Array.isArray(parsed) ? `/${i}` : '/') : `/${i}`);
    } else {
      text.split(/\r?\n/).forEach((line, i) => {
        if (!line.trim()) return;
        try { records.push(parseWithDecimalLexemes(line)); } catch { throw new Error(`Invalid JSON at line ${i + 1}.`); }
        rawTexts.push(line); positions.push(`line ${i + 1}`);
      });
    }
  } catch (error) { throw new Error(`Cannot read ${provider}: ${(error as Error).message}`); }
  if (records.length > 5000) throw new Error('The browser prototype supports at most 5,000 source records per file.');
  const operations: AnyObject[] = [], warnings: string[] = [];
  const emit = (raw: AnyObject, index: number, props: AnyObject) => operations.push({ ...props, operationId: `${provider}:${index + 1}:${props.type}`, raw, rawText: rawTexts[index], locator: positions[index], recordIndex: index });
  records.forEach((raw, i) => {
    const line = i + 1;
    if (!cleanObject(raw)) throw new Error(`Record ${line}: expected a JSON object.`);
    if (provider === 'google_play') {
      const transactionId = required(raw.orderId, 'orderId', line), history = raw.orderHistory;
      if (!cleanObject(history) || !history.processedEvent) throw new Error(`Record ${line}: a processedEvent is required; the adapter never infers a charge from the final order state.`);
      const unsupportedHistory = Object.keys(history).filter(key => !['processedEvent', 'refundEvent'].includes(key) && history[key] != null && !(Array.isArray(history[key]) && history[key].length === 0));
      if (unsupportedHistory.length) throw new Error(`Record ${line}: unsupported order history ${unsupportedHistory.join(', ')}. Partial refunds and cancellations require another adapter.`);
      const amount = googleMoney(raw.total, line);
      const productId = required(raw.lineItems?.[0]?.productId, 'lineItems[0].productId', line);
      if (raw.lineItems.length !== 1) throw new Error(`Record ${line}: multi-item orders require a separate mapping and are not supported in this prototype.`);
      const props = { transactionId, store: 'google_play', environment: 'production', currency: 'USD', productId };
      emit(raw, i, { ...props, type: 'charge', amountMinor: amount.toString(), timestamp: date(history.processedEvent.eventTime, 'processedEvent.eventTime', line), deliveryKey: `order:${transactionId}:processed` });
      if (history.refundEvent) {
        const refund = googleMoney(history.refundEvent.refundDetails?.total, line);
        emit(raw, i, { ...props, type: 'refund', amountMinor: (-refund).toString(), timestamp: date(history.refundEvent.eventTime, 'refundEvent.eventTime', line), deliveryKey: `order:${transactionId}:refund:${history.refundEvent.eventTime}` });
      }
      if (raw.state === 'REFUNDED' && !history.refundEvent) throw new Error(`Record ${line}: REFUNDED state has no refund event with an amount.`);
      return;
    }
    const props = provider === 'adapty' ? raw.event_properties : raw.properties;
    if (!cleanObject(props)) throw new Error(`Record ${line}: ${provider === 'adapty' ? 'event_properties' : 'properties'} is required.`);
    const event = required(provider === 'adapty' ? raw.event_type : raw.event, 'event type', line);
    const type = CASH_EVENTS.get(event);
    if (!type) throw new Error(`Record ${line}: ${event} is outside the supported cash-event subset.`);
    const transactionId = required(props.transaction_id, 'transaction_id', line);
    if (props.currency !== 'USD') throw new Error(`Record ${line}: this prototype supports USD only; currency conversion is not inferred.`);
    if (!['play_store', 'google_play'].includes(props.store)) throw new Error(`Record ${line}: this prototype supports the Google Play fixture namespace only.`);
    const environment = String(props.environment || '').toLowerCase();
    if (!['production', 'sandbox'].includes(environment)) throw new Error(`Record ${line}: explicit Production or Sandbox environment is required.`);
    const magnitude = minor(props.price_usd, line), timestamp = date(provider === 'adapty' ? raw.event_datetime : props.event_datetime, 'event_datetime', line);
    const productId = required(props.vendor_product_id, 'vendor_product_id', line);
    let deliveryKey: string;
    if (provider === 'mixpanel') {
      required(props.distinct_id, 'distinct_id', line); required(props.$insert_id, '$insert_id', line);
      if (!Number.isSafeInteger(props.time) || props.time < 0 || props.time > 9999999999) throw new Error(`Record ${line}: properties.time must be Unix seconds in this export contract.`);
      deliveryKey = JSON.stringify([event, props.distinct_id, props.time, props.$insert_id]);
    } else deliveryKey = required(props.profile_event_id, 'profile_event_id', line);
    emit(raw, i, { transactionId, type, amountMinor: (type === 'refund' ? -magnitude : magnitude).toString(), timestamp, store: 'google_play', environment, currency: 'USD', productId, deliveryKey });
  });
  const scope = new Set(operations.map(operation => `${operation.store}|${operation.environment}`));
  if (scope.size !== 1) throw new Error('Mixed store/environment scopes must be split before comparison.');
  if (provider === 'google_play') warnings.push('The fixture adapter uses the explicitly declared production scope; the raw order object does not establish that scope.');
  warnings.push('USD-only, one app namespace. Adapty/Mixpanel use price_usd; refunds use the declared positive-magnitude fixture convention.');
  return sourceWithStats({ provider, filename: `${provider}.${provider === 'google_play' ? 'json' : 'jsonl'}`, records, operations, rawText: text, bytes: new TextEncoder().encode(text).length, warnings, provenance: 'user_supplied' });
}

function evidence(op: AnyObject, side: string, provider: string) {
  return { id: `${side}-${op.operationId}`, side, provider, locator: op.locator, raw: op.rawText, operationId: op.operationId, amountMinor: op.amountMinor, timestamp: op.timestamp, transactionId: op.transactionId };
}
function group(ops: AnyObject[]) {
  const map = new Map<string, AnyObject[]>();
  for (const op of ops) {
    const key = [op.store, op.environment, op.transactionId, op.type].join('|');
    if (!map.has(key)) map.set(key, []);
    map.get(key)!.push(op);
  }
  return map;
}

export function reconcile(leftInput: AnyObject, rightInput: AnyObject, options: AnyObject = {}) {
  const coverage = options.coverage || 'unknown';
  if (!COV.has(coverage)) throw new Error('Choose declared_complete, partial or unknown coverage.');
  const left = sourceWithStats(leftInput), right = sourceWithStats(rightInput);
  const scopes = new Set([...left.operations, ...right.operations].map((op: AnyObject) => `${op.store}|${op.environment}|${op.currency}`));
  if (scopes.size !== 1) throw new Error('Both sources must use the same store, environment and currency.');
  const leftGroups = group(left.uniqueOperations), rightGroups = group(right.uniqueOperations);
  const findings: AnyObject[] = [], operations: AnyObject[] = [];
  function finding(kind: string, severity: string, certainty: string, title: string, description: string, delta: bigint | null, transactionId: string, rawEvidence: AnyObject[]) {
    findings.push({ id: `finding-${findings.length + 1}`, kind, severity, certainty, title, description, deltaMinor: delta === null ? null : delta.toString(), transactionId, evidence: rawEvidence });
  }
  for (const [side, source] of [['left', left], ['right', right]] as const) {
    for (const [first, repeated] of source.deliveryDuplicates) finding('repeated_delivery', 'info', 'proven', 'Repeated delivery, counted once', 'The same delivery key and financial payload appeared twice. One copy is excluded from the normalised total. This is not evidence of a second store charge.', 0n, first.transactionId, [evidence(first, side, source.provider), evidence(repeated, side, source.provider)]);
    for (const [first, conflicting] of source.deliveryConflicts) finding('identity_conflict', 'inconclusive', 'inconclusive', 'One delivery key, conflicting payloads', 'The same delivery identity carries different financial fields. Both observations are retained; this prototype cannot establish an authoritative amount.', null, first.transactionId, [evidence(first, side, source.provider), evidence(conflicting, side, source.provider)]);
  }
  const keys = [...new Set([...leftGroups.keys(), ...rightGroups.keys()])].sort();
  for (const key of keys) {
    const l = leftGroups.get(key) || [], r = rightGroups.get(key) || [], op = l[0] || r[0];
    const lv = sum(l), rv = sum(r), delta = rv - lv;
    const le = l.map(operation => evidence(operation, 'left', left.provider)), re = r.map(operation => evidence(operation, 'right', right.provider));
    let status = 'matched';
    const attributes = new Set([...l, ...r].map(operation => JSON.stringify([operation.productId, operation.timestamp])));
    if (attributes.size > 1) {
      status = 'mismatch';
      finding('identity_conflict', 'inconclusive', 'inconclusive', 'Matched ID, conflicting attributes', 'The transaction identity is shared, but product or effective timestamp differs. Review the source contract before asserting an amount mismatch or duplicate operation.', null, op.transactionId, [...le, ...re]);
    } else if (!l.length || !r.length) {
      status = !r.length ? 'missing' : 'extra';
      const bounded = coverage === 'declared_complete';
      finding(!r.length ? 'missing_operation' : 'extra_operation', bounded ? 'issue' : 'inconclusive', bounded ? 'proven' : 'inconclusive', !r.length ? `Missing downstream ${op.type}` : `Unmatched downstream ${op.type}`, bounded ? `This ${op.type} has no counterpart within the declared comparison scope. The finding describes these files, not an unobserved provider account.` : `No counterpart exists in the imported files. ${coverage === 'partial' ? 'Partial' : 'Unknown'} coverage prevents a conclusion that the provider operation is missing.`, bounded ? delta : null, op.transactionId, [...le, ...re]);
    } else if (l.length !== 1 || r.length !== 1) {
      status = 'duplicate';
      if (op.type === 'refund') finding('ambiguous_match', 'inconclusive', 'inconclusive', 'Multiple refund candidates', 'Several refund observations share the transaction. Independent partial refunds require operation identities; they are not collapsed into a duplicate.', null, op.transactionId, [...le, ...re]);
      else finding('economic_duplicate', 'issue', 'proven', 'Multiple events for one charge', `${l.length} reference observation(s) and ${r.length} downstream observation(s) refer to this charge with distinct delivery identities. Duplicate instrumentation is a hypothesis; these records do not prove a second store payment.`, delta, op.transactionId, [...le, ...re]);
    } else if (delta !== 0n) {
      status = 'mismatch';
      const factor100 = lv !== 0n && (rv === lv * 100n || lv === rv * 100n);
      finding('amount_mismatch', 'issue', 'proven', 'Reported amounts differ', factor100 ? 'The downstream amount is a factor of 100 apart from the reference. A major/minor-unit mistake is a candidate explanation; the amount difference itself is directly observable.' : 'The operation identities match, but the reported USD amounts differ.', delta, op.transactionId, [...le, ...re]);
    }
    operations.push({ key, transactionId: op.transactionId, type: op.type, timestamp: op.timestamp, leftMinor: l.length ? lv.toString() : null, rightMinor: r.length ? rv.toString() : null, deltaMinor: delta.toString(), status, leftEvidence: le, rightEvidence: re });
  }
  if (coverage !== 'declared_complete') finding('coverage_gap', 'inconclusive', 'inconclusive', 'Comparison coverage is not complete', 'The engine compares the imported records only. Equal totals cannot establish that all provider events were exported.', null, '', []);
  const counts = { issues: findings.filter(item => item.severity === 'issue').length, info: findings.filter(item => item.severity === 'info').length, inconclusive: findings.filter(item => item.severity === 'inconclusive').length, matched: operations.filter(item => item.status === 'matched').length };
  const fp = fingerprint(`${RULES}|${coverage}|${left.provider}|${left.rawText}|${right.provider}|${right.rawText}`);
  const source = left.provenance === 'synthetic' && right.provenance === 'synthetic' ? 'synthetic' : 'user_supplied';
  return { id: fp, title: options.label || 'Imported comparison', description: 'Compare explicit source snapshots and investigate their evidence.', source, currency: 'USD', coverage, computed_at: new Date().toISOString(), contract: { currency: 'USD', timezone: 'UTC', money_basis: 'Reported USD charges less refunds, before fees and tax adjustments', orientation: 'right − left', store: 'google_play', environment: left.operations[0]?.environment || 'unknown', scope: 'Explicit single-app namespace', rules: RULES }, left, right, deltaMinor: (BigInt(right.totalMinor) - BigInt(left.totalMinor)).toString(), rawDeltaMinor: (BigInt(right.rawTotalMinor) - BigInt(left.rawTotalMinor)).toString(), findings, operations, counts, verdict: counts.issues ? 'issues' : counts.inconclusive ? 'inconclusive' : 'matched', fingerprint: fp };
}

async function loadSource(file: string, provider: string, loader: FixtureLoader) {
  const source = parseSource(await loader(file), provider);
  source.filename = file; source.provenance = 'synthetic';
  return source;
}
export async function loadCase(id: string, loader: FixtureLoader, options: AnyObject = {}) {
  const scenario = SCENARIOS.find(item => item.id === id);
  if (!scenario) throw new Error('Unknown demo scenario.');
  const [left, right] = await Promise.all([loadSource('adapty.jsonl', 'adapty', loader), loadSource(`${id}.jsonl`, 'mixpanel', loader)]);
  return { ...reconcile(left, right, { coverage: 'declared_complete', ...options, label: scenario.title }), id, title: scenario.title, description: scenario.description };
}
export async function loadStoreCase(loader: FixtureLoader, options: AnyObject = {}) {
  const [left, right] = await Promise.all([loadSource('google_orders.json', 'google_play', loader), loadSource('adapty.jsonl', 'adapty', loader)]);
  return { ...reconcile(left, right, { coverage: 'declared_complete', ...options, label: 'Google Play → Adapty cash operations' }), id: 'store_reference', title: 'Google Play → Adapty cash operations', description: 'Eight synthetic order objects produce eight charges and one refund.' };
}
export function formatMoney(value: string | number | bigint | null | undefined, currency = 'USD') {
  if (value === null || value === undefined) return '—';
  const amount = BigInt(value), abs = amount < 0n ? -amount : amount;
  return `${amount < 0n ? '−' : ''}${currency === 'USD' ? '$' : currency + ' '}${(abs / 100n).toLocaleString('en-GB')}.${(abs % 100n).toString().padStart(2, '0')}`;
}
export function exportReport(result: AnyObject) {
  return { schema_version: 'reconcile-browser-demo/1', generated_at: new Date().toISOString(), implementation: 'Browser prototype; no hosted reconciliation backend, provider connection, model or MCP transport is active.', provenance: result.source, case_id: result.id, fingerprint: result.fingerprint, fingerprint_algorithm: 'FNV-1a demonstration identifier, not a cryptographic digest', contract: result.contract, coverage: result.coverage, verdict: result.verdict, delta_minor: result.deltaMinor, counts: result.counts, sources: [result.left, result.right].map(source => ({ provider: source.provider, filename: source.filename, provenance: source.provenance, record_count: source.recordCount, raw_operations: source.rawCount, deduplicated_operations: source.dedupCount, total_minor: source.totalMinor, raw_text: source.rawText })), findings: result.findings, operations: result.operations };
}
