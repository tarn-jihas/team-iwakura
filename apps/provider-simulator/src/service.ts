import { chmodSync, closeSync, constants, lstatSync, mkdirSync, openSync } from 'node:fs';
import { dirname } from 'node:path';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import { AdaptyReader, SourceUnavailable } from '@reconcile/server/source/adapty-reader';
import { normalizeProfile, type SourceProfileResult } from '@reconcile/server/source/profile';
import { SQLiteStorage } from '@reconcile/server/infrastructure/sqlite';
import { semanticDigest, semanticJson } from '@reconcile/server/infrastructure/json';
import { verifyInternal } from '@reconcile/server/infrastructure/internal-auth';
import { loadOfficialFixture, type OfficialFixtureSeed, type ProviderAccountSeed } from './fixture.js';

const BODY_LIMIT = 1024 * 1024;
const RESPONSE_LIMIT = 4 * 1024 * 1024;
const DB_MARKER_KEY = 'provider_simulator_typescript_v1';
const DB_MARKER_VALUE = 'reconcile-provider-simulator-node-ts-v1';
const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const SCHEMA = [
  'CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY,value TEXT NOT NULL)',
  'CREATE TABLE IF NOT EXISTS accounts(user_id TEXT PRIMARY KEY,provider_customer_id TEXT NOT NULL UNIQUE,source_user_id TEXT,identity_status TEXT NOT NULL,provenance TEXT NOT NULL)',
  'CREATE TABLE IF NOT EXISTS profiles(user_id TEXT PRIMARY KEY,source_user_id TEXT NOT NULL,raw_profile_json TEXT NOT NULL)',
];

export type ProviderMode = 'mock' | 'live';

export interface LiveProviderConfig {
  appId: string;
  appTitle: string;
  environment: string;
  sourceEnvironment: string;
  seedRevision: string;
  seedRunPrefix: string;
  customerUserIds: string[];
}

export interface ProviderOptions {
  dbPath: string;
  key: Uint8Array;
  mode: ProviderMode;
  appId?: string;
  runId?: string;
  fixtureDirectory?: string;
  sampleSize?: number;
  activeOverlay?:boolean;
  liveConfig?: LiveProviderConfig;
  apiKey?: string;
  sourceFetcher?: typeof fetch;
  now?: () => number;
}

class HTTPError extends Error {
  constructor(readonly status: number, message: string, readonly retryAfter?: string) { super(message); }
}

type AccountRow = Omit<ProviderAccountSeed, 'identity_status' | 'provenance'> & {
  identity_status: string;
  provenance: string;
};

function mockManifest(seed: OfficialFixtureSeed): Record<string, unknown> {
  return { ...seed.manifest, mode: 'mock' };
}

function liveManifest(config: LiveProviderConfig, now: number): Record<string, unknown> {
  return {
    app: config.appId, app_id: config.appId, app_title: config.appTitle,
    environment: config.environment, source_environment: config.sourceEnvironment,
    scenario: 'live_adapty', run_id: config.seedRunPrefix,
    scenario_now: new Date(now).toISOString().replace(/\.\d{3}Z$/u, 'Z'),
    provenance: 'official_synthetic_seed', payment_verification: 'not_independently_verified',
    seed_revision: config.seedRevision, seed_run_prefix: config.seedRunPrefix,
    customer_count: config.customerUserIds.length,
    customer_ids_hash: semanticDigest([...config.customerUserIds].sort()), mode: 'live',
  };
}

function validateLiveConfig(config: LiveProviderConfig | undefined, apiKey: string | undefined): LiveProviderConfig {
  if (!config || !apiKey?.trim() || !config.appId.trim() || !config.appTitle.trim()
      || !config.environment.trim() || !config.sourceEnvironment.trim()
      || !config.seedRevision.trim() || !config.seedRunPrefix.trim()
      || config.customerUserIds.length !== 100 || new Set(config.customerUserIds).size !== 100
      || config.customerUserIds.some((id) => typeof id !== 'string' || !id || id !== id.trim()
        || id.length > 256 || /[\r\n\u0000]/u.test(id))) {
    throw new Error('Live provider scope must include 100 unique customer IDs and an API key');
  }
  return config;
}

function accountSeeds(config: LiveProviderConfig): ProviderAccountSeed[] {
  return config.customerUserIds.map((userId) => ({ user_id: userId, provider_customer_id: userId,
    source_user_id: userId, identity_status: 'mapped', provenance: 'official_synthetic_seed' }));
}

function preflightDatabase(path: string): void {
  let info;
  try { info = lstatSync(path); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new Error('Provider database path is unavailable');
    let descriptor: number;
    try {
      descriptor = openSync(path, constants.O_CREAT | constants.O_EXCL | constants.O_RDWR | constants.O_NOFOLLOW, 0o600);
    } catch (createError) {
      if ((createError as NodeJS.ErrnoException).code === 'EEXIST') return preflightDatabase(path);
      throw new Error('Provider database cannot be created safely');
    }
    closeSync(descriptor);
    return;
  }
  if (info.isSymbolicLink() || !info.isFile()) throw new Error('Provider database path must be a regular non-symlink file');
  let database: DatabaseSync;
  try { database = new DatabaseSync(path, { readOnly: true }); }
  catch { throw new Error('Provider database is not an owned TypeScript simulator database'); }
  try {
    const marker = database.prepare('SELECT value FROM meta WHERE key=?').get(DB_MARKER_KEY) as { value: string } | undefined;
    const manifest = database.prepare('SELECT value FROM meta WHERE key=?').get('manifest') as { value: string } | undefined;
    if (marker?.value !== DB_MARKER_VALUE || !manifest) {
      throw new Error('Provider database is not an owned TypeScript simulator database');
    }
    const scope: unknown = JSON.parse(manifest.value);
    if (!isRecord(scope) || !['mock', 'live'].includes(String(scope.mode))) {
      throw new Error('Provider database marker has no valid scope');
    }
  } catch {
    throw new Error('Provider database is not an owned TypeScript simulator database');
  } finally { database.close(); }
  const after = lstatSync(path);
  if (after.isSymbolicLink() || !after.isFile() || after.dev !== info.dev || after.ino !== info.ino) {
    throw new Error('Provider database path changed during preflight');
  }
}

async function initializeStorage(storage: SQLiteStorage, options: ProviderOptions,
  manifest: Record<string, unknown>, accounts: ProviderAccountSeed[], profiles: OfficialFixtureSeed['profiles']): Promise<void> {
  await storage.transaction(SCHEMA.map((sql) => ({ sql, mode: 'run' as const })));
  const existing = await storage.statement({ mode: 'get', sql: 'SELECT value FROM meta WHERE key=?', params: ['manifest'] }) as
    { value: string } | null;
  if (existing) {
    const previous = JSON.parse(existing.value) as Record<string, unknown>;
    const sameScope = previous.mode === manifest.mode && previous.run_id === manifest.run_id
      && previous.app_id === manifest.app_id && previous.source_revision === manifest.source_revision
      && previous.customer_ids_hash === manifest.customer_ids_hash
      && previous.synthetic_active_overlay === manifest.synthetic_active_overlay
      && previous.customer_count === manifest.customer_count;
    if (!sameScope) throw new Error('Provider database scope changed; refusing to reuse it');
    return;
  }
  const statements = [{ mode: 'run' as const, sql: 'INSERT INTO meta(key,value) VALUES(?,?)',
    params: [DB_MARKER_KEY, DB_MARKER_VALUE] },
  { mode: 'run' as const, sql: 'INSERT INTO meta(key,value) VALUES(?,?)',
    params: ['manifest', semanticJson(manifest)] }];
  for (const account of accounts) statements.push({ mode: 'run' as const,
    sql: 'INSERT INTO accounts(user_id,provider_customer_id,source_user_id,identity_status,provenance) VALUES(?,?,?,?,?)',
    params: [account.user_id, account.provider_customer_id, account.source_user_id,
      account.identity_status, account.provenance] });
  for (const profile of profiles) statements.push({ mode: 'run' as const,
    sql: 'INSERT INTO profiles(user_id,source_user_id,raw_profile_json) VALUES(?,?,?)',
    params: [profile.user_id, profile.source_user_id, semanticJson(profile.raw_profile)] });
  await storage.transaction(statements);
  try {
    chmodSync(options.dbPath, 0o600);
    chmodSync(`${options.dbPath}-wal`, 0o600);
    chmodSync(`${options.dbPath}-shm`, 0o600);
  } catch { /* Some filesystems do not support mode changes. */ }
}

export class ProviderService {
  readonly server: Server;
  private readonly storage: SQLiteStorage;
  private readonly mode: ProviderMode;
  private readonly appId: string;
  private readonly reader?: AdaptyReader;
  private readonly now: () => number;

  private constructor(private readonly options: ProviderOptions, storage: SQLiteStorage,
    liveConfig?: LiveProviderConfig, reader?: AdaptyReader) {
    this.storage = storage;
    this.mode = options.mode;
    this.reader = reader;
    this.appId = liveConfig?.appId ?? options.appId ?? 'mock-lumen-activation';
    this.now = options.now ?? Date.now;
    this.server = createServer((request, response) => { void this.handle(request, response); });
  }

  static async create(options: ProviderOptions): Promise<ProviderService> {
    if (options.key.byteLength < 32 || !options.dbPath || !['mock', 'live'].includes(options.mode)) {
      throw new Error('Invalid provider service configuration');
    }
    mkdirSync(dirname(options.dbPath), { recursive: true });
    preflightDatabase(options.dbPath);
    const storage = new SQLiteStorage(options.dbPath);
    try {
      let config: LiveProviderConfig | undefined;
      let manifest: Record<string, unknown>;
      let accounts: ProviderAccountSeed[];
      let profiles: OfficialFixtureSeed['profiles'] = [];
      if (options.mode === 'live') {
        config = validateLiveConfig(options.liveConfig, options.apiKey);
        manifest = liveManifest(config, (options.now ?? Date.now)());
        accounts = accountSeeds(config);
      } else {
        const seed = loadOfficialFixture({ directory: options.fixtureDirectory, runId: options.runId ?? 'offline-77d39ed8',
          sampleSize: options.sampleSize ?? 100, appId: options.appId, now: new Date((options.now ?? Date.now)()),
          activeOverlay:options.activeOverlay });
        manifest = mockManifest(seed);
        accounts = seed.accounts;
        profiles = seed.profiles;
      }
      await initializeStorage(storage, options, manifest, accounts, profiles);
      const reader = config ? await AdaptyReader.create({ storage, appId: config.appId,
        customerIds: new Set(config.customerUserIds), apiKey: options.apiKey!,
        fetcher: options.sourceFetcher, now: options.now }) : undefined;
      return new ProviderService(options, storage, config, reader);
    } catch (error) {
      await storage.close().catch(() => undefined);
      throw error;
    }
  }

  listen(port = 0): Promise<number> {
    return new Promise((resolve, reject) => {
      this.server.once('error', reject);
      this.server.listen(port, '127.0.0.1', () => {
        this.server.removeListener('error', reject);
        const address = this.server.address();
        if (!address || typeof address === 'string') return reject(new Error('Provider listener did not bind a TCP port'));
        resolve(address.port);
      });
    });
  }

  async close(): Promise<void> {
    if (this.server.listening) {
      await new Promise<void>((resolve, reject) => this.server.close((error) => error ? reject(error) : resolve()));
    }
    await this.storage.close();
  }

  private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    try {
      const raw = await readRequest(request);
      const path = request.url ?? '/';
      const timestamp = request.headers['x-recovery-timestamp'];
      const signature = request.headers['x-recovery-signature'];
      if (typeof timestamp !== 'string' || typeof signature !== 'string'
          || !verifyInternal(this.options.key, request.method ?? '', path, timestamp, raw, signature, this.now())) {
        writeResponse(response, 401, { error: 'Internal authentication failed' });
        return;
      }
      if ((request.method ?? '') !== 'GET') throw new HTTPError(405, 'Method not allowed');
      if (raw.length) throw new HTTPError(400, 'GET requests cannot contain a body');
      if (!path.startsWith('/') || path.startsWith('//') || /[\r\n#]/u.test(path)) throw new HTTPError(400, 'Invalid request path');
      const url = new URL(path, 'http://127.0.0.1');
      const result = await this.dispatch(url);
      writeResponse(response, 200, result);
    } catch (error) {
      if (response.headersSent || response.destroyed) return;
      if (error instanceof HTTPError) writeResponse(response, error.status, { error: error.message }, error.retryAfter);
      else if (error instanceof SourceUnavailable && error.code === 'rate_limited') {
        const seconds = Math.max(1, Math.ceil((error.retryAfterMs ?? 1000) / 1000));
        writeResponse(response, 429, { error: 'Source is in cooldown' }, String(seconds));
      } else if (error instanceof SourceUnavailable) writeResponse(response, 503, { error: 'Source profile is unavailable' });
      else writeResponse(response, 500, { error: 'Provider request failed' });
    }
  }

  private async dispatch(url: URL): Promise<Record<string, unknown>> {
    if (url.pathname === '/internal/manifest') {
      requireQuery(url, []);
      const row = await this.storage.statement({ mode: 'get', sql: 'SELECT value FROM meta WHERE key=?', params: ['manifest'] }) as
        { value: string } | null;
      if (!row) throw new HTTPError(500, 'Provider manifest is missing');
      return JSON.parse(row.value) as Record<string, unknown>;
    }
    if (url.pathname === '/internal/live/status') {
      requireQuery(url,[]);
      return { mode:this.mode,not_before_ms:this.reader ? await this.reader.notBefore() : 0,
        source_requests_total:this.reader ? await this.reader.requestsAttempted() : 0 };
    }
    if (url.pathname === '/internal/provider/accounts') {
      requireQuery(url, ['cursor', 'limit']);
      return this.accountPage(queryValue(url, 'cursor'), parseLimit(queryValue(url, 'limit')));
    }
    if (url.pathname === '/internal/adapty/profile') {
      requireQuery(url, ['user']);
      const userId = queryValue(url, 'user');
      if (!userId) throw new HTTPError(400, 'user query is required');
      const account = await this.accountByCustomerId(userId);
      if (!account) throw new HTTPError(404, 'Unknown provider customer');
      return this.profile(account);
    }
    if (url.pathname === '/internal/adapty/profiles') {
      requireQuery(url, ['cursor', 'limit']);
      const page = await this.accountPage(queryValue(url, 'cursor'), parseLimit(queryValue(url, 'limit')));
      const items: Record<string, unknown>[] = [];
      let profileBytes = 2;
      for (const account of page.items as AccountRow[]) {
        const profile = await this.profile(account);
        profileBytes += Buffer.byteLength(JSON.stringify(profile) ?? '') + (items.length ? 1 : 0);
        if (profileBytes > RESPONSE_LIMIT) throw new HTTPError(502, 'Provider response too large');
        items.push(profile);
      }
      return { items, next_cursor: page.next_cursor, total: page.total };
    }
    throw new HTTPError(404, 'Not found');
  }

  private async accountByCustomerId(customerId: string): Promise<AccountRow | null> {
    return await this.storage.statement({ mode: 'get',
      sql: 'SELECT user_id,provider_customer_id,source_user_id,identity_status,provenance FROM accounts WHERE provider_customer_id=?',
      params: [customerId] }) as AccountRow | null;
  }

  private async accountPage(cursor: string | null, limit: number): Promise<Record<string, unknown>> {
    if (cursor !== null && cursor !== '' && !/^\d+$/u.test(cursor)) throw new HTTPError(400, 'Invalid cursor');
    const offset = cursor ? Number(cursor) : 0;
    if (!Number.isSafeInteger(offset)) throw new HTTPError(400, 'Invalid cursor');
    const items = await this.storage.statement({ mode: 'all',
      sql: 'SELECT user_id,provider_customer_id,source_user_id,identity_status,provenance FROM accounts ORDER BY user_id LIMIT ? OFFSET ?',
      params: [limit, offset] }) as AccountRow[];
    const count = await this.storage.statement({ mode: 'get', sql: 'SELECT COUNT(*) AS total FROM accounts' }) as { total: number };
    const total = Number(count.total);
    return { items, next_cursor: offset + items.length < total ? String(offset + items.length) : null, total };
  }

  private async profile(account: AccountRow): Promise<Record<string, unknown>> {
    if (this.mode === 'live') {
      const profile: SourceProfileResult = await this.reader!.read(account.provider_customer_id);
      return profile as unknown as Record<string, unknown>;
    }
    const row = await this.storage.statement({ mode: 'get',
      sql: 'SELECT source_user_id,raw_profile_json FROM profiles WHERE user_id=?', params: [account.user_id] }) as
      { source_user_id: string; raw_profile_json: string } | null;
    if (!row) throw new HTTPError(404, 'Provider profile is missing');
    const normalized = normalizeProfile(JSON.parse(row.raw_profile_json), this.appId,
      account.provider_customer_id, new Date(this.now()));
    const entitlement = normalized.entitlement;
    return { ...normalized, source_user_id: row.source_user_id,
      product_id: entitlement?.product_id ?? null, expires_at: entitlement?.expires_at ?? null,
      transaction_id: entitlement?.transaction_id ?? null, entitlement_hash: entitlement?.entitlement_hash ?? null,
      revision: normalized.source_revision, updated_at: normalized.observed_at };
  }
}

function queryValue(url: URL, name: string): string | null {
  const values = url.searchParams.getAll(name);
  if (values.length > 1) throw new HTTPError(400, `Duplicate ${name} query`);
  return values[0] ?? null;
}

function requireQuery(url: URL, allowed: string[]): void {
  for (const key of url.searchParams.keys()) if (!allowed.includes(key)) throw new HTTPError(400, 'Unknown query field');
  for (const key of allowed) queryValue(url, key);
}

function parseLimit(value: string | null): number {
  if (value === null) return 500;
  if (!/^\d+$/u.test(value)) throw new HTTPError(400, 'Invalid limit');
  const limit = Number(value);
  if (!Number.isInteger(limit) || limit < 1 || limit > 1000) throw new HTTPError(400, 'Invalid limit');
  return limit;
}

async function readRequest(request: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let length = 0;
  for await (const chunk of request) {
    const buffer = Buffer.from(chunk);
    length += buffer.length;
    if (length > BODY_LIMIT) throw new HTTPError(413, 'Request body too large');
    chunks.push(buffer);
  }
  return Buffer.concat(chunks, length);
}

function writeResponse(response: ServerResponse, status: number, body: unknown, retryAfter?: string): void {
  let raw = Buffer.from(JSON.stringify(body) ?? '{}', 'utf8');
  if (raw.byteLength > RESPONSE_LIMIT) {
    status = 502;
    retryAfter = undefined;
    raw = Buffer.from('{"error":"Provider response too large"}', 'utf8');
  }
  response.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': String(raw.byteLength),
    'Cache-Control': 'no-store', ...(retryAfter ? { 'Retry-After': retryAfter } : {}) });
  response.end(raw);
}

export async function createProviderService(options: ProviderOptions): Promise<ProviderService> {
  return ProviderService.create(options);
}
