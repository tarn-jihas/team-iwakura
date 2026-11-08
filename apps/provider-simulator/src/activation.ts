import { createHash } from 'node:crypto';
import { chmodSync, closeSync, constants, lstatSync, mkdirSync, openSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gunzipSync } from 'node:zlib';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { semanticDigest, semanticJson } from '@reconcile/server/infrastructure/json';

export const ACTIVATION_APP = 'mock-lumen-activation';
export const ACTIVATION_ENVIRONMENT = 'Production';
export const ACTIVATION_FEATURE = 'premium_export';
export const ACTIVATION_SCENARIO_NOW = '2026-11-07T12:00:00Z';
export type ActivationScenario = 'stripe' | 'paddle' | 'custom' | 'apple' | 'google' | 'offline';
type Row = Record<string, any>;

const SCENARIOS = new Set<ActivationScenario>(['stripe', 'paddle', 'custom', 'apple', 'google', 'offline']);
const PROVENANCE = 'synthetic_extension';
const FRESHNESS_TTL_SECONDS = 900;
const DATABASE_MARKER = 'reconcile-provider-activation-node-ts-v1';
const DEFAULT_FIXTURE_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '../../..',
  'reconcile-mock-first-kit/fixtures/hackathon');

export class ActivationProviderError extends Error {
  constructor(message: string, readonly status = 400) { super(message); }
}

export interface ActivationProviderOptions {
  databasePath: string;
  scenario?: ActivationScenario;
  variant?: number;
  runId?: string;
  reset?: boolean;
  fixtureDirectory?: string;
}

export interface ActivationValidationRequest {
  method: 'POST';
  path: string;
  content_type: string;
  body: Row;
}

export interface ActivationProviderValidation {
  provider: string;
  transaction_id: string;
  user_id: string;
  operation_key: string;
  contract_trace: {
    provider: string;
    method: string;
    path: string;
    content_type: string;
    body: Row;
  };
}

interface SyntheticSeed {
  manifest: Row;
  accounts: Row[];
  evidence: Row[];
  profiles: Row[];
  catalog: Row[];
}

interface OfflineSeed {
  manifest: Row;
  users: Row[];
  transactions: Row[];
}

const isRecord = (value: unknown): value is Row => typeof value === 'object' && value !== null && !Array.isArray(value);
const hasExactKeys = (value: Row, keys: string[]): boolean =>
  Object.keys(value).length === keys.length && Object.keys(value).every(key => keys.includes(key));

function fail(message: string, status = 400): never { throw new ActivationProviderError(message, status); }

function digest(value: unknown): string { return semanticDigest(value); }

function iso(milliseconds: number): string {
  return new Date(milliseconds).toISOString().replace(/\.\d{3}Z$/u, 'Z');
}

function timestamp(value: unknown, name: string): number {
  if (typeof value !== 'string' || !/(?:Z|[+-]\d{2}:\d{2})$/u.test(value)) fail(`Invalid ${name}`);
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds)) fail(`Invalid ${name}`);
  return milliseconds;
}

function text(value: unknown, name: string, maximum = 256): string {
  if (typeof value !== 'string' || !value.trim() || value.length > maximum) fail(`Invalid ${name}`);
  return value;
}

function operationKey(value: unknown): string {
  const key = text(value, 'operation_key');
  if (![...key].every(char => /[\p{L}\p{N}._:-]/u.test(char))) fail('Invalid operation_key');
  return key;
}

function validateScenario(scenario: unknown, variant: unknown): asserts scenario is ActivationScenario {
  if (typeof scenario !== 'string' || !SCENARIOS.has(scenario as ActivationScenario)) {
    fail('Unsupported recovery scenario');
  }
  if (typeof variant !== 'number' || !Number.isInteger(variant)
      || (scenario === 'offline' ? variant !== 0 : variant !== 0 && variant !== 1)) {
    fail(scenario === 'offline' ? 'variant must be 0 for the offline scenario or 0 or 1 otherwise'
      : 'variant must be 0 or 1');
  }
}

function validateRunId(value: unknown): string {
  if (typeof value !== 'string' || !value || value.length > 96
      || !/^[\p{L}\p{N}._-]+$/u.test(value)) fail('Invalid run_id');
  return value;
}

function buildSyntheticScenario(scenario: Exclude<ActivationScenario, 'offline'>, variant: 0 | 1,
  runId?: string): SyntheticSeed {
  const base = Date.parse(ACTIVATION_SCENARIO_NOW);
  const day = 86_400_000;
  const prefix = variant ? 'v1-' : '';
  const accounts: Row[] = [], evidence: Row[] = [], profiles: Row[] = [];
  for (let index = 0; index < 100; index += 1) {
    const userId = `${prefix}u${String(index).padStart(5, '0')}`;
    const cohort = variant ? (index * 37) % 100 : index;
    const kind = cohort < 24 ? 'activation_missing' : cohort < 84 ? 'healthy'
      : cohort < 90 ? 'expired' : cohort < 94 ? 'policy_denial'
        : cohort < 97 ? 'identity_unknown' : cohort === 97 ? 'stale' : 'unavailable';
    const customerId = `cust-${prefix}u${String(index).padStart(5, '0')}`;
    const identity = kind === 'identity_unknown' ? 'unknown' : 'mapped';
    accounts.push({ user_id: userId, provider_customer_id: customerId,
      identity_status: identity, provenance: PROVENANCE });
    const hasEvidence = kind !== 'unavailable';
    const paid = kind !== 'identity_unknown';
    if (hasEvidence && paid) {
      const affected = kind === 'activation_missing', expired = kind === 'expired';
      const starts = base - (affected ? (120 + index % 90) * 1000 : (expired ? 365 : 30) * day);
      const expires = expired ? base - day : base + 335 * day;
      const observed = base - (kind === 'stale' ? 1200 : 20) * 1000;
      const occurred = affected ? base - (120 + index % 90) * 1000
        : kind === 'policy_denial' ? base - 60_000 : starts;
      const item: Row = {
        transaction_id: `txn-${prefix}u${String(index).padStart(5, '0')}`,
        original_transaction_id: `orig-${prefix}u${String(index).padStart(5, '0')}`,
        provider_customer_id: customerId, user_id: identity === 'mapped' ? userId : null,
        product_id: 'premium.annual', price_id: affected ? 'price_annual_new' : 'price_annual_current',
        payment_state: 'paid', access_basis: 'paid_period', starts_at: iso(starts), expires_at: iso(expires),
        amount_minor: 999, currency: 'USD', refund_state: 'none', occurred_at: iso(occurred),
        observed_at: iso(observed), evidence_ref: `provider://${scenario}/${userId}`, provenance: PROVENANCE,
      };
      evidence.push({ ...item, evidence_hash: digest(item) });
    }
    const active = kind === 'healthy' || kind === 'policy_denial';
    const expiry = base + 335 * day;
    const profile: Row = { user_id: userId, status: active ? 'active' : 'missing',
      product_id: active ? 'premium.annual' : null, expires_at: active ? iso(expiry) : null,
      transaction_id: null, revision: 1, updated_at: ACTIVATION_SCENARIO_NOW,
      entitlement_hash: active ? digest({ user_id: userId, product_id: 'premium.annual', expires_at: iso(expiry) }) : null };
    profiles.push(profile);
  }
  return {
    manifest: { app: ACTIVATION_APP, environment: ACTIVATION_ENVIRONMENT,
      scenario, variant, run_id: runId ?? `activation-${scenario}-20261107-v${variant}`,
      scenario_now: ACTIVATION_SCENARIO_NOW, provenance: PROVENANCE },
    accounts, evidence, profiles,
    catalog: [{ provider: scenario, product_id: 'premium.annual', price_id: 'price_annual_current', status: 'mapped', revision: 1 }],
  };
}

function parseCsv(value: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [], field = '', quoted = false;
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index]!;
    if (quoted) {
      if (character === '"' && value[index + 1] === '"') { field += '"'; index += 1; }
      else if (character === '"') quoted = false;
      else field += character;
    } else if (character === '"' && field.length === 0) quoted = true;
    else if (character === ',') { row.push(field); field = ''; }
    else if (character === '\n' || character === '\r') {
      if (character === '\r' && value[index + 1] === '\n') index += 1;
      row.push(field); field = '';
      if (row.some(cell => cell.length)) rows.push(row);
      row = [];
    } else field += character;
  }
  if (quoted) fail('Invalid official fixture CSV');
  if (field.length || row.length) { row.push(field); rows.push(row); }
  return rows;
}

function csvObjects(compressed: Buffer): Row[] {
  const source = gunzipSync(compressed, { maxOutputLength: 32 * 1024 * 1024 }).toString('utf8');
  const rows = parseCsv(source);
  const headers = rows.shift();
  if (!headers || new Set(headers).size !== headers.length || headers.some(name => !name)) fail('Invalid official fixture CSV header');
  return rows.map(cells => {
    if (cells.length !== headers.length) fail('Invalid official fixture CSV row');
    return Object.fromEntries(headers.map((header, index) => [header, cells[index]!]));
  });
}

function normalizedPrice(value: unknown): string {
  if (typeof value !== 'string' || !/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/u.test(value)) {
    fail('Invalid fixture price');
  }
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) fail('Fixture price must be finite and nonnegative');
  const [mantissa, rawExponent = '0'] = value.toLowerCase().split('e');
  const exponent = Number(rawExponent);
  if (!Number.isInteger(exponent) || Math.abs(exponent) > 100) fail('Invalid fixture price');
  const sign = mantissa!.startsWith('-') ? '-' : '';
  const unsigned = mantissa!.replace(/^[+-]/u, '');
  const [whole = '0', fraction = ''] = unsigned.split('.');
  const digits = whole + fraction;
  const decimalAt = whole.length + exponent;
  if (decimalAt <= 0) return `${sign}0.${'0'.repeat(-decimalAt)}${digits}`;
  if (decimalAt >= digits.length) return `${sign}${digits}${'0'.repeat(decimalAt - digits.length)}`;
  return `${sign}${digits.slice(0, decimalAt)}.${digits.slice(decimalAt)}`;
}

function parseOfflineFixture(directory: string, runId?: string): OfflineSeed {
  const root = resolve(directory);
  const manifest = JSON.parse(readFileSync(resolve(root, 'manifest.json'), 'utf8')) as unknown;
  if (!isRecord(manifest) || manifest.schema_version !== 1 || manifest.provenance !== 'official_hackathon_synthetic'
      || typeof manifest.revision !== 'string' || typeof manifest.scenario_anchor !== 'string' || !isRecord(manifest.files)) {
    fail('Official offline fixture manifest is invalid');
  }
  for (const name of ['lumen_dataset.json.gz', 'users.csv.gz', 'transactions.csv.gz']) {
    const spec = manifest.files[name];
    if (!isRecord(spec) || typeof spec.sha256 !== 'string' || !/^[a-f0-9]{64}$/u.test(spec.sha256)) {
      fail('Official offline fixture metadata is invalid');
    }
    const bytes = readFileSync(resolve(root, name));
    if (createHash('sha256').update(bytes).digest('hex') !== spec.sha256) fail(`Fixture checksum mismatch: ${name}`);
  }
  const id = validateRunId(runId ?? `activation-offline-${manifest.revision.slice(0, 8)}`);
  const prefix = `lumen_${id.replace(/[.-]/gu, '_')}`;
  const users = csvObjects(readFileSync(resolve(root, 'users.csv.gz')));
  const rawTransactions = csvObjects(readFileSync(resolve(root, 'transactions.csv.gz')));
  const declaredUsers = (manifest.files['users.csv.gz'] as Row).rows;
  const declaredTransactions = (manifest.files['transactions.csv.gz'] as Row).rows;
  if (users.length !== declaredUsers || rawTransactions.length !== declaredTransactions) fail('Fixture row count mismatch');
  const seen = new Set<string>();
  const normalizedUsers = users.map(row => {
    const userId = row.user_id;
    if (typeof userId !== 'string' || !userId || !['iOS', 'Android'].includes(String(row.platform))
        || !Number.isFinite(timestamp(row.install_at, 'fixture install_at'))) fail('Invalid fixture account');
    if (seen.has(userId)) fail('Duplicate fixture account');
    seen.add(userId);
    return { user_id: userId, platform: row.platform, raw: semanticJson(row) };
  });
  const normalizedTransactions = rawTransactions.map(row => {
    for (const field of ['user_id', 'seq', 'purchase_type', 'product', 'store_product_id', 'currency']) {
      if (typeof row[field] !== 'string' || !String(row[field]).trim()) fail(`Missing fixture field: ${field}`);
    }
    if (!/^\d+$/u.test(String(row.seq)) || !['subscription', 'one_time_purchase'].includes(String(row.purchase_type))) {
      fail('Invalid fixture transaction');
    }
    const currency = String(row.currency);
    if (currency.length !== 3 || !/^[A-Z]{3}$/u.test(currency)) fail('Invalid currency');
    const purchased = timestamp(row.purchased_at, 'purchased_at');
    for (const field of ['expires_at', 'originally_purchased_at', 'renew_status_changed_at', 'billing_issue_detected_at', 'refunded_at']) {
      if (row[field]) timestamp(row[field], field);
    }
    if (row.expires_at && timestamp(row.expires_at, 'expires_at') < purchased) fail('Expiry precedes purchase');
    if (row.renew_status && !['true', 'false'].includes(String(row.renew_status))) fail('Invalid renewal status');
    const normalized: Row = { ...row, seq: Number(row.seq), price_local: normalizedPrice(row.price_local),
      provenance: 'official_hackathon_synthetic', payment_verification: 'unverified_synthetic_history' };
    if (!seen.has(String(row.user_id))) fail('Unknown account in fixture');
    return normalized;
  });
  return {
    manifest: { app: ACTIVATION_APP, environment: ACTIVATION_ENVIRONMENT, scenario: 'offline', variant: 0,
      run_id: id, scenario_now: manifest.scenario_anchor, provenance: manifest.provenance,
      source_revision: manifest.revision, source_user_count: declaredUsers,
      source_transaction_count: declaredTransactions,
      source_file_checksums: Object.fromEntries(Object.entries(manifest.files).map(([name, spec]) => [name, (spec as Row).sha256])),
      payment_verification: 'unverified_synthetic_history', adapty_coverage: 'not_observed',
      client_gate_coverage: 'not_observed', customer_id_mapping: `offline u00042 -> ${prefix}_00042` },
    users: normalizedUsers.map(row => ({ ...row, provider_customer_id: `${prefix}_${String(row.user_id).slice(1)}`,
      identity_status: 'unknown', provenance: 'official_hackathon_synthetic' })),
    transactions: normalizedTransactions,
  };
}

const SCHEMA = [
  'CREATE TABLE IF NOT EXISTS activation_runtime(id INTEGER PRIMARY KEY CHECK(id=1),marker TEXT NOT NULL,scenario TEXT NOT NULL,variant INTEGER NOT NULL,run_id TEXT NOT NULL)',
  'CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY,value TEXT NOT NULL)',
  'CREATE TABLE IF NOT EXISTS provider_accounts(user_id TEXT PRIMARY KEY,provider_customer_id TEXT NOT NULL UNIQUE,identity_status TEXT NOT NULL,provenance TEXT NOT NULL)',
  'CREATE TABLE IF NOT EXISTS provider_evidence(transaction_id TEXT PRIMARY KEY,original_transaction_id TEXT NOT NULL,provider_customer_id TEXT NOT NULL,user_id TEXT,product_id TEXT NOT NULL,price_id TEXT NOT NULL,payment_state TEXT NOT NULL,access_basis TEXT NOT NULL,starts_at TEXT NOT NULL,expires_at TEXT NOT NULL,amount_minor INTEGER NOT NULL,currency TEXT NOT NULL,refund_state TEXT NOT NULL,occurred_at TEXT NOT NULL,observed_at TEXT NOT NULL,evidence_ref TEXT NOT NULL,evidence_hash TEXT NOT NULL,provenance TEXT NOT NULL)',
  'CREATE TABLE IF NOT EXISTS provider_observations(id INTEGER PRIMARY KEY AUTOINCREMENT,transaction_id TEXT NOT NULL,observed_at TEXT NOT NULL,evidence_hash TEXT NOT NULL,evidence_json TEXT NOT NULL)',
  'CREATE TABLE IF NOT EXISTS catalog(provider TEXT NOT NULL,product_id TEXT NOT NULL,price_id TEXT NOT NULL,status TEXT NOT NULL,revision INTEGER NOT NULL,PRIMARY KEY(provider,price_id))',
  'CREATE TABLE IF NOT EXISTS profiles(user_id TEXT PRIMARY KEY,status TEXT NOT NULL,product_id TEXT,expires_at TEXT,transaction_id TEXT,revision INTEGER NOT NULL,updated_at TEXT NOT NULL,entitlement_hash TEXT)',
  'CREATE TABLE IF NOT EXISTS operations(operation_key TEXT PRIMARY KEY,kind TEXT NOT NULL,request_hash TEXT NOT NULL,result TEXT NOT NULL,created_at TEXT NOT NULL)',
  'CREATE TABLE IF NOT EXISTS source_users(user_id TEXT PRIMARY KEY,platform TEXT NOT NULL,raw TEXT NOT NULL)',
  'CREATE TABLE IF NOT EXISTS source_transactions(user_id TEXT NOT NULL,seq INTEGER NOT NULL,raw TEXT NOT NULL,PRIMARY KEY(user_id,seq),FOREIGN KEY(user_id) REFERENCES source_users(user_id))',
];

function preflightDatabase(path: string): void {
  let info;
  try { info = lstatSync(path); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new Error('Activation provider database is unavailable');
    let descriptor: number;
    try { descriptor = openSync(path, constants.O_CREAT | constants.O_EXCL | constants.O_RDWR | constants.O_NOFOLLOW, 0o600); }
    catch (createError) {
      if ((createError as NodeJS.ErrnoException).code === 'EEXIST') return preflightDatabase(path);
      throw new Error('Activation provider database cannot be created safely');
    }
    closeSync(descriptor);
    return;
  }
  if (info.isSymbolicLink() || !info.isFile() || info.size === 0) {
    throw new Error('Activation provider database must be an owned TypeScript runtime database');
  }
  let db: DatabaseSync;
  try { db = new DatabaseSync(path, { readOnly: true }); }
  catch { throw new Error('Activation provider database must be an owned TypeScript runtime database'); }
  try {
    const row = db.prepare('SELECT marker FROM activation_runtime WHERE id=1').get() as { marker: string } | undefined;
    if (row?.marker !== DATABASE_MARKER) throw new Error('Activation provider database marker mismatch');
  } catch { throw new Error('Activation provider database must be an owned TypeScript runtime database'); }
  finally { db.close(); }
  const after = lstatSync(path);
  if (after.isSymbolicLink() || !after.isFile() || after.dev !== info.dev || after.ino !== info.ino) {
    throw new Error('Activation provider database path changed during preflight');
  }
}

function openDatabase(path: string): DatabaseSync {
  const db = new DatabaseSync(path);
  db.exec('PRAGMA busy_timeout=15000; PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL');
  return db;
}

function meta(db: DatabaseSync, name: string, fallback?: unknown): unknown {
  const row = db.prepare('SELECT value FROM meta WHERE key=?').get(name) as { value: string } | undefined;
  return row ? JSON.parse(row.value) as unknown : fallback;
}

function setMeta(db: DatabaseSync, name: string, value: unknown): void {
  db.prepare('INSERT INTO meta(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value')
    .run(name, semanticJson(value));
}

function inTransaction<T>(db: DatabaseSync, operation: () => T): T {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = operation();
    db.exec('COMMIT');
    return result;
  } catch (error) {
    if (db.isTransaction) db.exec('ROLLBACK');
    throw error;
  }
}

function logicalNow(db: DatabaseSync): number {
  return timestamp(meta(db, 'scenario_now'), 'scenario_now') + Number(meta(db, 'logical_elapsed_seconds', 0)) * 1000;
}

function manifestFrom(db: DatabaseSync): Row {
  const rows = db.prepare('SELECT key,value FROM meta').all() as { key: string; value: string }[];
  return Object.fromEntries(rows.filter(row => !['logical_elapsed_seconds', 'last_advance_at', 'initialized'].includes(row.key))
    .map(row => [row.key, JSON.parse(row.value) as unknown]));
}

function validatePage(cursor: unknown, limit: unknown): { offset: number; limit: number } {
  if (typeof limit !== 'number' || !Number.isInteger(limit) || limit < 1 || limit > 1000) {
    fail('limit must be an integer from 1 to 1000');
  }
  if (cursor === undefined || cursor === null || cursor === '') return { offset: 0, limit };
  if (typeof cursor !== 'string' || !/^\d+$/u.test(cursor)) fail('Invalid cursor');
  const offset = Number(cursor);
  if (!Number.isSafeInteger(offset)) fail('Invalid cursor');
  return { offset, limit };
}

function paged(db: DatabaseSync, query: string, countQuery: string,
  params: SQLInputValue[], page: { offset: number; limit: number }): Row {
  const items = db.prepare(query).all(...params, page.limit, page.offset) as Row[];
  const countParams = params.slice(0, query.includes('WHERE') ? params.length : 0);
  const totalRow = db.prepare(countQuery).get(...countParams) as { total: number | bigint };
  const total = Number(totalRow.total);
  return { items, next_cursor: page.offset + items.length < total ? String(page.offset + items.length) : null, total };
}

/** Local-only provider adapter; callers must guard reset/fault controls behind demo mode. */
export class ActivationProvider {
  private closed = false;

  private constructor(private readonly db: DatabaseSync, private readonly options: ActivationProviderOptions) {}

  static async create(options: ActivationProviderOptions): Promise<ActivationProvider> {
    const scenario = options?.scenario ?? 'stripe';
    const variant = options?.variant ?? 0;
    validateScenario(scenario, variant);
    if (!options || typeof options.databasePath !== 'string' || !options.databasePath) {
      throw new TypeError('A dedicated activation provider SQLite path is required');
    }
    const path = options.databasePath === ':memory:' ? options.databasePath : resolve(options.databasePath);
    if (path !== ':memory:') { mkdirSync(dirname(path), { recursive: true }); preflightDatabase(path); }
    const db = openDatabase(path);
    try {
      for (const sql of SCHEMA) db.exec(sql);
      const service = new ActivationProvider(db, options);
      await service.initialize(scenario, variant as 0 | 1, options.runId, options.reset === true);
      if (path !== ':memory:') {
        for (const file of [path, `${path}-wal`, `${path}-shm`]) {
          try { chmodSync(file, 0o600); } catch { /* Some filesystems do not support mode changes. */ }
        }
      }
      return service;
    } catch (error) { db.close(); throw error; }
  }

  private async initialize(scenario: ActivationScenario, variant: 0 | 1, runId: string | undefined,
    reset: boolean): Promise<void> {
    let seed: SyntheticSeed | OfflineSeed;
    if (scenario === 'offline') seed = parseOfflineFixture(this.options.fixtureDirectory ?? DEFAULT_FIXTURE_DIR, runId);
    else seed = buildSyntheticScenario(scenario, variant, runId === undefined ? undefined : validateRunId(runId));
    const manifest = seed.manifest;
    const actualRunId = String(manifest.run_id);
    const current = this.db.prepare('SELECT marker,scenario,variant,run_id FROM activation_runtime WHERE id=1').get() as
      { marker: string; scenario: string; variant: number; run_id: string } | undefined;
    if (current && current.marker !== DATABASE_MARKER) fail('Activation provider database marker mismatch');
    if (current && !reset) {
      if (current.scenario !== scenario || current.variant !== variant || current.run_id !== actualRunId) {
        fail('Activation provider database scope changed; reset must be explicit', 409);
      }
      return;
    }
    inTransaction(this.db, () => {
      for (const table of ['provider_observations', 'provider_evidence', 'provider_accounts', 'profiles',
        'catalog', 'operations', 'source_transactions', 'source_users', 'meta']) {
        this.db.prepare(`DELETE FROM ${table}`).run();
      }
      this.db.prepare(`INSERT INTO activation_runtime(id,marker,scenario,variant,run_id) VALUES(1,?,?,?,?)
        ON CONFLICT(id) DO UPDATE SET marker=excluded.marker,scenario=excluded.scenario,
        variant=excluded.variant,run_id=excluded.run_id`).run(DATABASE_MARKER, scenario, variant, actualRunId);
      for (const [key, value] of Object.entries(manifest)) setMeta(this.db, key, value);
      setMeta(this.db, 'logical_elapsed_seconds', 0);
      setMeta(this.db, 'initialized', true);
      setMeta(this.db, 'fault_provider_outage', false);
      setMeta(this.db, 'fault_validation_timeout_remaining', false);
      setMeta(this.db, 'fault_rate_limit_remaining', 0);
      setMeta(this.db, 'fault_rate_limit_retry_after', 1);
      if ('accounts' in seed) {
        const addAccount = this.db.prepare('INSERT INTO provider_accounts VALUES(?,?,?,?)');
        for (const account of seed.accounts) addAccount.run(account.user_id, account.provider_customer_id,
          account.identity_status, account.provenance);
        const addEvidence = this.db.prepare('INSERT INTO provider_evidence VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)');
        const addObservation = this.db.prepare('INSERT INTO provider_observations(transaction_id,observed_at,evidence_hash,evidence_json) VALUES(?,?,?,?)');
        for (const item of seed.evidence) {
          addEvidence.run(item.transaction_id, item.original_transaction_id, item.provider_customer_id, item.user_id,
            item.product_id, item.price_id, item.payment_state, item.access_basis, item.starts_at, item.expires_at,
            item.amount_minor, item.currency, item.refund_state, item.occurred_at, item.observed_at,
            item.evidence_ref, item.evidence_hash, item.provenance);
          addObservation.run(item.transaction_id, item.observed_at, item.evidence_hash, semanticJson(item));
        }
        const addProfile = this.db.prepare('INSERT INTO profiles VALUES(?,?,?,?,?,?,?,?)');
        for (const item of seed.profiles) addProfile.run(item.user_id, item.status, item.product_id, item.expires_at,
          item.transaction_id, item.revision, item.updated_at, item.entitlement_hash);
        const addCatalog = this.db.prepare('INSERT INTO catalog VALUES(?,?,?,?,?)');
        for (const item of seed.catalog) addCatalog.run(item.provider, item.product_id, item.price_id, item.status, item.revision);
      } else {
        const addUser = this.db.prepare('INSERT INTO source_users VALUES(?,?,?)');
        const addAccount = this.db.prepare('INSERT INTO provider_accounts VALUES(?,?,?,?)');
        for (const user of seed.users) {
          addUser.run(user.user_id, user.platform, user.raw);
          addAccount.run(user.user_id, user.provider_customer_id, user.identity_status, user.provenance);
        }
        const addTransaction = this.db.prepare('INSERT INTO source_transactions VALUES(?,?,?)');
        for (const item of seed.transactions) addTransaction.run(item.user_id, item.seq, semanticJson(item));
        setMeta(this.db, 'official_import', { users: seed.users.length, transactions: seed.transactions.length,
          revision: manifest.source_revision });
      }
    });
  }

  manifest(): Row { this.assertOpen(); return manifestFrom(this.db); }

  async reset(scenario: ActivationScenario, variant: number, runId?: string): Promise<Row> {
    this.assertOpen();
    validateScenario(scenario, variant);
    await this.initialize(scenario, variant as 0 | 1, runId, true);
    return this.manifest();
  }

  advanceClock(seconds: unknown): Row {
    this.assertOpen();
    if (typeof seconds !== 'number' || !Number.isInteger(seconds) || seconds < 1 || seconds > 86400) {
      fail('seconds must be an integer from 1 to 86400');
    }
    return inTransaction(this.db, () => {
      const elapsed = Number(meta(this.db, 'logical_elapsed_seconds', 0)) + seconds;
      setMeta(this.db, 'logical_elapsed_seconds', elapsed);
      const now = iso(logicalNow(this.db));
      setMeta(this.db, 'last_advance_at', now);
      return { logical_now: now };
    });
  }

  providerAccounts(cursor?: string | null, limit = 500): Row {
    this.assertOpen();
    const page = validatePage(cursor, limit);
    return paged(this.db,
      'SELECT user_id,provider_customer_id,identity_status,provenance FROM provider_accounts ORDER BY user_id LIMIT ? OFFSET ?',
      'SELECT COUNT(*) AS total FROM provider_accounts', [], page);
  }

  providerEvidence(userId?: string | null, cursor?: string | null, limit = 500): Row {
    this.assertOpen();
    const page = validatePage(cursor, limit);
    if (userId !== undefined && userId !== null) {
      return paged(this.db,
        'SELECT * FROM provider_evidence WHERE user_id=? ORDER BY occurred_at,transaction_id LIMIT ? OFFSET ?',
        'SELECT COUNT(*) AS total FROM provider_evidence WHERE user_id=?', [userId], page);
    }
    return paged(this.db, 'SELECT * FROM provider_evidence ORDER BY transaction_id LIMIT ? OFFSET ?',
      'SELECT COUNT(*) AS total FROM provider_evidence', [], page);
  }

  providerObservations(userId?: string | null): Row[] {
    this.assertOpen();
    const rows = userId === undefined || userId === null
      ? this.db.prepare('SELECT * FROM provider_observations ORDER BY id').all() as Row[]
      : this.db.prepare(`SELECT * FROM provider_observations WHERE transaction_id IN
        (SELECT transaction_id FROM provider_evidence WHERE user_id=?) ORDER BY id`).all(userId) as Row[];
    return rows.map(({ evidence_json: evidenceJson, ...row }) => ({ ...row, evidence: JSON.parse(evidenceJson) as Row }));
  }

  providerHistory(userId?: string | null, cursor?: string | null, limit = 500): Row {
    this.assertOpen();
    if (meta(this.db, 'scenario') !== 'offline') fail('Source history is available only in the offline scenario');
    const page = validatePage(cursor, limit);
    const result = userId === undefined || userId === null
      ? paged(this.db, 'SELECT user_id,seq,raw FROM source_transactions ORDER BY user_id,seq LIMIT ? OFFSET ?',
        'SELECT COUNT(*) AS total FROM source_transactions', [], page)
      : paged(this.db, 'SELECT user_id,seq,raw FROM source_transactions WHERE user_id=? ORDER BY seq LIMIT ? OFFSET ?',
        'SELECT COUNT(*) AS total FROM source_transactions WHERE user_id=?', [userId], page);
    const items = (result.items as Row[]).map(row => {
      const transaction = JSON.parse(String(row.raw)) as Row;
      return { source_user_id: row.user_id,
        source_transaction_id: `${String(row.user_id)}:${String(row.seq)}`,
        payment_verification: 'unverified_synthetic_history', transaction };
    });
    return { ...result, items };
  }

  adaptyProfiles(userId?: string | null, cursor?: string | null, limit = 500): Row | null {
    this.assertOpen();
    if (userId !== undefined && userId !== null) {
      return this.db.prepare('SELECT * FROM profiles WHERE user_id=?').get(userId) as Row | undefined ?? null;
    }
    const page = validatePage(cursor, limit);
    return paged(this.db, 'SELECT * FROM profiles ORDER BY user_id LIMIT ? OFFSET ?',
      'SELECT COUNT(*) AS total FROM profiles', [], page);
  }

  adaptyCatalog(): Row {
    this.assertOpen();
    const items = this.db.prepare('SELECT * FROM catalog ORDER BY provider,price_id').all() as Row[];
    const revision = this.db.prepare('SELECT COALESCE(MAX(revision),0) AS revision FROM catalog').get() as { revision: number };
    return { items, revision: Number(revision.revision) };
  }

  repairCatalog(body: unknown): Row {
    this.assertOpen();
    const required = ['provider', 'product_id', 'price_id', 'operation_key'];
    if (!isRecord(body) || !hasExactKeys(body, required)) fail('Catalog repair fields do not match the contract');
    for (const name of required) text(body[name], name);
    const key = operationKey(body.operation_key);
    return inTransaction(this.db, () => {
      const scenario = meta(this.db, 'scenario');
      if (body.provider !== scenario) fail('Provider does not match this scenario');
      const requestHash = digest(body);
      const previous = this.db.prepare('SELECT request_hash,result FROM operations WHERE operation_key=?').get(key) as
        { request_hash: string; result: string } | undefined;
      if (previous) {
        if (previous.request_hash !== requestHash) fail('Operation key already has a different request');
        return { ...(JSON.parse(previous.result) as Row), duplicate: true };
      }
      const conflict = this.db.prepare('SELECT product_id,revision FROM catalog WHERE provider=? AND price_id=?')
        .get(body.provider, body.price_id) as { product_id: string; revision: number } | undefined;
      if (conflict && conflict.product_id !== body.product_id) fail('Price is already mapped to another product');
      const revision = conflict ? Number(conflict.revision)
        : Number((this.db.prepare('SELECT COALESCE(MAX(revision),0)+1 AS revision FROM catalog').get() as { revision: number }).revision);
      if (!conflict) this.db.prepare('INSERT INTO catalog VALUES(?,?,?,?,?)')
        .run(body.provider, body.product_id, body.price_id, 'mapped', revision);
      const result: Row = { accepted: true, provider: body.provider,
        product_id: body.product_id, price_id: body.price_id, catalog_revision: revision };
      this.recordOperation(key, 'catalog_repair', requestHash, result);
      return { ...result, duplicate: false };
    });
  }

  providerValidate(body: unknown): Row {
    this.assertOpen();
    const required = ['provider', 'transaction_id', 'user_id', 'operation_key', 'contract_trace'];
    if (!isRecord(body) || !hasExactKeys(body, required)) fail('Validation fields do not match the contract');
    for (const name of ['provider', 'transaction_id', 'user_id', 'operation_key']) text(body[name], name);
    const key = operationKey(body.operation_key);
    const trace = body.contract_trace;
    if (!isRecord(trace) || !hasExactKeys(trace, ['provider', 'method', 'path', 'content_type', 'body'])
        || trace.provider !== body.provider || !['method', 'path', 'content_type'].every(name =>
          typeof trace[name] === 'string' && !!trace[name]) || !isRecord(trace.body)) {
      fail('Invalid provider request contract trace');
    }
    return inTransaction(this.db, () => {
      const scenario = String(meta(this.db, 'scenario'));
      if (body.provider !== scenario) fail('Provider does not match this scenario');
      if (!['stripe', 'paddle', 'custom'].includes(scenario)) fail('awaiting_client_action', 409);
      const requestHash = digest(body);
      const previous = this.db.prepare('SELECT request_hash,result FROM operations WHERE operation_key=?').get(key) as
        { request_hash: string; result: string } | undefined;
      if (previous) {
        if (previous.request_hash !== requestHash) fail('Operation key already has a different request');
        return { ...(JSON.parse(previous.result) as Row), duplicate: true };
      }
      const expected = activationValidationRequest(scenario as 'stripe' | 'paddle' | 'custom',
        String(body.user_id), String(body.transaction_id));
      const expectedTrace = { provider: scenario, ...expected };
      if (digest(trace) !== digest(expectedTrace)) fail('Provider validation request is not bound to this user and transaction');
      const evidence = this.db.prepare('SELECT * FROM provider_evidence WHERE transaction_id=?').get(body.transaction_id) as Row | undefined;
      if (!evidence) fail('Provider transaction not found');
      const account = this.db.prepare('SELECT identity_status FROM provider_accounts WHERE user_id=?').get(body.user_id) as
        { identity_status: string } | undefined;
      if (!account || account.identity_status !== 'mapped' || evidence.user_id !== body.user_id) {
        fail('Provider transaction identity does not match the requested user');
      }
      const now = logicalNow(this.db);
      if (evidence.payment_state !== 'paid' || evidence.access_basis !== 'paid_period'
          || Number(evidence.amount_minor) <= 0 || evidence.refund_state !== 'none'
          || timestamp(evidence.starts_at, 'starts_at') > now || timestamp(evidence.expires_at, 'expires_at') <= now) {
        fail('Provider transaction is not a current paid period');
      }
      const age = (now - timestamp(evidence.observed_at, 'observed_at')) / 1000;
      if (age < 0 || age > FRESHNESS_TTL_SECONDS) fail('Provider evidence is stale');
      const mapping = this.db.prepare('SELECT * FROM catalog WHERE provider=? AND price_id=?')
        .get(scenario, evidence.price_id) as Row | undefined;
      if (!mapping || mapping.status !== 'mapped' || mapping.product_id !== evidence.product_id) {
        fail('Provider product and price are not mapped in the Adapty catalog');
      }
      const entitlementHash = digest({ user_id: body.user_id, product_id: evidence.product_id,
        expires_at: evidence.expires_at });
      const priorProfile = this.db.prepare('SELECT revision FROM profiles WHERE user_id=?').get(body.user_id) as
        { revision: number } | undefined;
      const profileRevision = priorProfile ? Number(priorProfile.revision) + 1 : 1;
      const result: Row = { accepted: true, user_id: body.user_id,
        transaction_id: evidence.transaction_id, product_id: evidence.product_id, price_id: evidence.price_id,
        expires_at: evidence.expires_at, evidence_hash: evidence.evidence_hash,
        entitlement_hash: entitlementHash, request_contract: trace, profile_revision: profileRevision };
      this.db.prepare(`INSERT INTO profiles(user_id,status,product_id,expires_at,transaction_id,revision,updated_at,entitlement_hash)
        VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(user_id) DO UPDATE SET status=excluded.status,
        product_id=excluded.product_id,expires_at=excluded.expires_at,transaction_id=excluded.transaction_id,
        revision=profiles.revision+1,updated_at=excluded.updated_at,entitlement_hash=excluded.entitlement_hash`)
        .run(body.user_id, 'active', evidence.product_id, evidence.expires_at, evidence.transaction_id,
          profileRevision, iso(now), entitlementHash);
      this.recordOperation(key, 'validate', requestHash, result);
      return { ...result, duplicate: false };
    });
  }

  adaptyOperation(operationKeyValue: unknown): Row | null {
    this.assertOpen();
    const key = text(operationKeyValue, 'operation_key');
    const row = this.db.prepare('SELECT result FROM operations WHERE operation_key=?').get(key) as
      { result: string } | undefined;
    return row ? JSON.parse(row.result) as Row : null;
  }

  providerDemoFault(fault: unknown, options: { active?: unknown; userId?: unknown; state?: unknown } = {}): Row {
    this.assertOpen();
    return inTransaction(this.db, () => this.applyProviderFault(fault, options));
  }

  /** Apply the provider and profile effects of `different_cause` atomically. */
  demoFault(fault: unknown, options: { active?: unknown; userId?: unknown; state?: unknown } = {}): Row {
    this.assertOpen();
    return inTransaction(this.db, () => {
      const result = this.applyProviderFault(fault, options);
      if (fault === 'different_cause') result.adapty = this.applyAdaptyFault(fault, options.userId);
      return result;
    });
  }

  adaptyDemoFault(fault: unknown, userId: unknown): Row {
    this.assertOpen();
    return inTransaction(this.db, () => this.applyAdaptyFault(fault, userId));
  }

  providerFaultActive(name: string): boolean {
    this.assertOpen();
    return Boolean(meta(this.db, name, false));
  }

  consumeProviderFault(name: string): { active: boolean; retry_after?: number } {
    this.assertOpen();
    return inTransaction(this.db, () => {
      if (name === 'fault_rate_limit_remaining') {
        const remaining = Number(meta(this.db, name, 0));
        if (remaining > 0) {
          setMeta(this.db, name, remaining - 1);
          return { active: true, retry_after: Number(meta(this.db, 'fault_rate_limit_retry_after', 1)) };
        }
        return { active: false };
      }
      const active = Boolean(meta(this.db, name, false));
      if (active) setMeta(this.db, name, false);
      return { active };
    });
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.db.close();
  }

  private recordOperation(key: string, kind: string, requestHash: string, result: Row): void {
    this.db.prepare('INSERT INTO operations VALUES(?,?,?,?,?)')
      .run(key, kind, requestHash, semanticJson(result), iso(logicalNow(this.db)));
  }

  private applyProviderFault(faultValue: unknown, options: { active?: unknown; userId?: unknown; state?: unknown }): Row {
    const fault = text(faultValue, 'fault');
    const active = options.active ?? true;
    if (['provider_outage', 'validation_timeout_after_commit', 'rate_limit'].includes(fault)) {
      if (typeof active !== 'boolean') fail('active must be a boolean');
      if (fault === 'provider_outage') setMeta(this.db, 'fault_provider_outage', active);
      else if (fault === 'validation_timeout_after_commit') setMeta(this.db, 'fault_validation_timeout_remaining', active);
      else {
        setMeta(this.db, 'fault_rate_limit_remaining', active ? 1 : 0);
        setMeta(this.db, 'fault_rate_limit_retry_after', 1);
      }
      return { fault, active };
    }
    let state = options.state;
    if (fault === 'source_stale') state = 'stale';
    else if (fault === 'refund') state = 'refunded';
    if (!['source_stale', 'refund', 'lifecycle', 'identity', 'different_cause'].includes(fault)) {
      fail('Unsupported provider demo fault');
    }
    if (typeof options.userId !== 'string' || !options.userId) fail('user_id is required');
    if (fault === 'lifecycle' && !['pending', 'trial', 'grace', 'manual', 'refunded', 'expired'].includes(String(state))) {
      fail('Unsupported lifecycle state');
    }
    const userId = options.userId;
    const account = this.db.prepare('SELECT * FROM provider_accounts WHERE user_id=?').get(userId) as Row | undefined;
    if (!account) fail('Unknown account', 404);
    if (fault === 'identity') {
      if (state !== 'mapped' && state !== 'unknown') fail('identity state must be mapped or unknown');
      this.db.prepare('UPDATE provider_accounts SET identity_status=? WHERE user_id=?').run(state, userId);
      return { fault, user_id: userId, status: state };
    }
    const row = this.db.prepare('SELECT * FROM provider_evidence WHERE user_id=? ORDER BY occurred_at DESC LIMIT 1')
      .get(userId) as Row | undefined;
    if (!row) fail('No provider evidence exists for this account');
    const item: Row = { ...row };
    const now = logicalNow(this.db);
    if (fault === 'source_stale') item.observed_at = iso(now - 1800_000);
    else if (fault === 'different_cause') {
      item.price_id = 'price_annual_other';
      item.occurred_at = iso(now - 60_000);
      item.observed_at = iso(now - 20_000);
    } else if (state === 'pending') item.payment_state = 'pending';
    else if (['trial', 'grace', 'manual'].includes(String(state))) item.access_basis = state;
    else if (state === 'refunded') item.refund_state = 'refunded';
    else if (state === 'expired') item.expires_at = iso(now - 1000);
    delete item.evidence_hash;
    const evidenceHash = digest(item);
    item.evidence_hash = evidenceHash;
    this.db.prepare(`UPDATE provider_evidence SET original_transaction_id=?,provider_customer_id=?,user_id=?,product_id=?,price_id=?,
      payment_state=?,access_basis=?,starts_at=?,expires_at=?,amount_minor=?,currency=?,refund_state=?,occurred_at=?,
      observed_at=?,evidence_ref=?,evidence_hash=?,provenance=? WHERE transaction_id=?`)
      .run(item.original_transaction_id, item.provider_customer_id, item.user_id, item.product_id, item.price_id,
        item.payment_state, item.access_basis, item.starts_at, item.expires_at, item.amount_minor, item.currency,
        item.refund_state, item.occurred_at, item.observed_at, item.evidence_ref, evidenceHash, item.provenance, item.transaction_id);
    this.db.prepare('INSERT INTO provider_observations(transaction_id,observed_at,evidence_hash,evidence_json) VALUES(?,?,?,?)')
      .run(item.transaction_id, item.observed_at, evidenceHash, semanticJson(item));
    return { fault, user_id: userId, state: state ?? fault, evidence_hash: evidenceHash };
  }

  private applyAdaptyFault(fault: unknown, userIdValue: unknown): Row {
    if (fault !== 'different_cause' || typeof userIdValue !== 'string' || !userIdValue) fail('Unsupported Adapty demo fault');
    const result = this.db.prepare(`UPDATE profiles SET status='missing',product_id=NULL,expires_at=NULL,transaction_id=NULL,
      revision=revision+1,updated_at=?,entitlement_hash=NULL WHERE user_id=?`)
      .run(iso(logicalNow(this.db)), userIdValue);
    if (Number(result.changes) === 0) fail('Unknown account', 404);
    return { fault, user_id: userIdValue, status: 'missing' };
  }

  private assertOpen(): void { if (this.closed) throw new Error('Activation provider is closed'); }
}

export function activationValidationRequest(provider: 'stripe' | 'paddle' | 'custom', userIdValue: string,
  transactionIdValue: string): ActivationValidationRequest {
  const userId = validationReference(userIdValue), transactionId = validationReference(transactionIdValue);
  if (provider === 'custom') return { method: 'POST', path: '/custom-store/transactions/validate',
    content_type: 'application/json', body: { customer_user_id: userId, transaction_id: transactionId } };
  const suffix = createHash('sha256').update(transactionId, 'utf8').digest('hex');
  if (provider === 'stripe') return { method: 'POST', path: '/api/v1/sdk/purchase/stripe/token/validate/',
    content_type: 'application/vnd.api+json', body: { data: { type: 'stripe_receipt_validation_result',
      attributes: { customer_user_id: userId, stripe_token: `sub_mock_${suffix}` } } } };
  return { method: 'POST', path: '/api/v2/server-side-api/purchase/paddle/token/validate/',
    content_type: 'application/json', body: { customer_user_id: userId, paddle_token: `txn_mock_${suffix}` } };
}

export function validateActivationValidationRequest(provider: 'stripe' | 'paddle' | 'custom', userId: string,
  transactionId: string, request: unknown): ActivationValidationRequest {
  const expected = activationValidationRequest(provider, userId, transactionId);
  if (!isRecord(request) || digest(request) !== digest(expected)) fail('Validation transport contract mismatch');
  return expected;
}

function validationReference(value: unknown): string {
  if (typeof value !== 'string' || !value || value !== value.trim() || value.length > 256
      || /[\u0000-\u001f]/u.test(value)) fail('Invalid validation reference');
  return value;
}
