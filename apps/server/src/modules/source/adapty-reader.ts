import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { SQLiteStorage } from '../../infrastructure/sqlite.js';
import { InvalidResponseEncoding, readResponseText, ResponseTooLarge } from '../../infrastructure/http-body.js';
import { normalizeProfile, type SourceProfileResult } from './profile.js';

const API_URL = 'https://api.adapty.io/api/v2/server-side-api/profile/';
const MAX_PROFILE_BYTES = 1024 * 1024;

export class SourceUnavailable extends Error {
  constructor(readonly code: string, readonly retryAfterMs?: number) {
    super(`Adapty source unavailable (${code})`);
  }
}

export async function loadPrivateApiKey(path: string): Promise<string> {
  let file;
  try {
    file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const info = await file.stat();
    if (!info.isFile() || (info.mode & 0o077) !== 0 || info.size > 4096) throw new Error('invalid');
    const buffer = Buffer.alloc(4097);
    let size = 0;
    while (size < buffer.length) {
      const { bytesRead } = await file.read(buffer, size, buffer.length - size, size);
      if (!bytesRead) break;
      size += bytesRead;
    }
    if (size > 4096) throw new Error('invalid');
    const key = new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, size)).trim();
    if (!key || /[\u0000-\u001f\u007f]/.test(key)) throw new Error('invalid');
    return key;
  } catch {
    throw new Error('Adapty key must be a private regular file');
  } finally {
    await file?.close();
  }
}

function retryDelayMs(header: string | null, now: number): number {
  if (header === null || header.trim() === '') return 1000;
  const value = header.trim();
  if (/^\d+$/.test(value)) {
    const seconds = Number(value);
    return Number.isSafeInteger(seconds) && seconds <= Number.MAX_SAFE_INTEGER / 1000
      ? seconds * 1000 : Number.MAX_SAFE_INTEGER;
  }
  const date = /^[A-Za-z]{3,9}(?:,|\s)/.test(value) ? Date.parse(value) : Number.NaN;
  return Number.isFinite(date) ? Math.max(0, date - now) : 1000;
}

/** One reader per source process serializes HTTP and shares a durable cooldown. */
export class AdaptyReader {
  private tail: Promise<void> = Promise.resolve();

  private constructor(private readonly storage: SQLiteStorage, private readonly appId: string,
    private readonly customerIds: ReadonlySet<string>, private readonly key: string,
    private readonly fetcher: typeof fetch, private readonly now: () => number) {}

  static async create(options: { storage: SQLiteStorage; appId: string; customerIds: ReadonlySet<string>;
    apiKey: string; fetcher?: typeof fetch; now?: () => number }): Promise<AdaptyReader> {
    if (!options.appId.trim() || !options.apiKey.trim() || /[\r\n]/.test(options.apiKey)
        || !options.customerIds.size || [...options.customerIds].some(id =>
          typeof id !== 'string' || !id || id !== id.trim() || id.length > 256 || /[\r\n]/.test(id))) {
      throw new Error('Invalid Adapty reader configuration');
    }
    await options.storage.statement({ mode: 'run', sql:
      'CREATE TABLE IF NOT EXISTS source_state (key TEXT PRIMARY KEY, value INTEGER NOT NULL)' });
    return new AdaptyReader(options.storage, options.appId, new Set(options.customerIds), options.apiKey,
      options.fetcher ?? fetch, options.now ?? Date.now);
  }

  async notBefore(): Promise<number> {
    const row = await this.storage.statement({ mode: 'get',
      sql: 'SELECT value FROM source_state WHERE key=?', params: ['not_before'] }) as { value: number } | null;
    return row?.value ?? 0;
  }

  async requestsAttempted(): Promise<number> {
    const row = await this.storage.statement({ mode: 'get',
      sql: 'SELECT value FROM source_state WHERE key=?', params: ['requests_attempted'] }) as { value: number } | null;
    return row?.value ?? 0;
  }

  read(customerId: string): Promise<SourceProfileResult> {
    const operation = this.tail.then(() => this.readSerial(customerId));
    this.tail = operation.then(() => undefined, () => undefined);
    return operation;
  }

  private async readSerial(customerId: string, attempt = 0): Promise<SourceProfileResult> {
    if (!this.customerIds.has(customerId)) throw new SourceUnavailable('identity_scope_mismatch');
    const now = this.now();
    if (!Number.isFinite(now)) throw new SourceUnavailable('clock_unavailable');
    const remaining = (await this.notBefore()) - now;
    if (remaining > 0) throw new SourceUnavailable('rate_limited', remaining);
    await this.storage.statement({ mode: 'run',
      sql: 'INSERT INTO source_state (key,value) VALUES (?,1) ON CONFLICT(key) DO UPDATE SET value=value+1',
      params: ['requests_attempted'] });
    let response: Response;
    try {
      response = await this.fetcher(API_URL, { method: 'GET', redirect: 'error',
        signal: AbortSignal.timeout(5000), headers: { Authorization: `Api-Key ${this.key}`,
          'adapty-customer-user-id': customerId, Accept: 'application/json' } });
    } catch {
      throw new SourceUnavailable('transport_error');
    }
    if (response.status === 429) {
      const delay = retryDelayMs(response.headers.get('retry-after'), this.now());
      const deadline = Math.min(Number.MAX_SAFE_INTEGER, Math.ceil(this.now() + delay));
      await this.storage.statement({ mode: 'run',
        sql: 'INSERT INTO source_state (key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=MAX(value,excluded.value)',
        params: ['not_before', deadline] });
      await response.body?.cancel().catch(() => undefined);
      if (delay < 2000 && attempt < 2) {
        if (delay > 0) await new Promise(resolve => setTimeout(resolve, Math.ceil(delay) + 1));
        return this.readSerial(customerId, attempt + 1);
      }
      throw new SourceUnavailable('rate_limited', Math.max(0, deadline - this.now()));
    }
    if (response.status !== 200) {
      await response.body?.cancel().catch(() => undefined);
      throw new SourceUnavailable(`http_${response.status}`);
    }
    let payload: string;
    try { payload = await readResponseText(response, MAX_PROFILE_BYTES); }
    catch (error) {
      if (error instanceof ResponseTooLarge) throw new SourceUnavailable('response_too_large');
      if (error instanceof InvalidResponseEncoding) throw new SourceUnavailable('invalid_profile');
      throw new SourceUnavailable('transport_error');
    }
    try {
      const parsed: unknown = JSON.parse(payload);
      const data = typeof parsed === 'object' && parsed !== null && 'data' in parsed
        && typeof parsed.data === 'object' && parsed.data !== null ? parsed.data : parsed;
      return normalizeProfile(data, this.appId, customerId, new Date(this.now()));
    } catch {
      throw new SourceUnavailable('invalid_profile');
    }
  }
}
