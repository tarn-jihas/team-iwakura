import { loopbackUrl, signInternal } from '../../infrastructure/internal-auth.js';
import { readResponseText } from '../../infrastructure/http-body.js';

const validId = (value:unknown): value is string => typeof value === 'string' && value.length > 0
  && value.length <= 256 && value === value.trim() && !/[\u0000-\u001f\u007f]/.test(value);
const object = (value:unknown): value is Record<string,unknown> => !!value && typeof value === 'object' && !Array.isArray(value);

export class ProviderUnavailable extends Error {
  constructor(readonly status?:number) { super('Provider source unavailable'); }
}

/** All live reads go through the independent provider process and its shared cooldown. */
export class ProviderAdapter {
  private readonly base:URL;
  constructor(base:string, private readonly key:Uint8Array, private readonly fetcher:typeof fetch = fetch,
    private readonly now:() => number = Date.now) {
    this.base = loopbackUrl(base);
    if (key.byteLength < 32) throw new Error('Invalid provider adapter configuration');
  }

  private async get(path:string): Promise<Record<string,unknown>> {
    const timestamp = Math.floor(this.now() / 1000);
    const signature = signInternal(this.key,'GET',path,timestamp,Buffer.alloc(0));
    try {
      const response = await this.fetcher(new URL(path,this.base), { method:'GET',redirect:'error',
        signal:AbortSignal.timeout(60_000),headers:{ 'X-Recovery-Timestamp':String(timestamp),
          'X-Recovery-Signature':signature } });
      if (!response.ok) {
        await response.body?.cancel().catch(() => undefined);
        throw new ProviderUnavailable(response.status);
      }
      const value:unknown = JSON.parse(await readResponseText(response,1024 * 1024));
      if (!object(value)) throw new Error('Invalid provider response');
      return value;
    } catch (error) {
      if (error instanceof ProviderUnavailable) throw error;
      throw new ProviderUnavailable();
    }
  }

  async profile(userId:string): Promise<Record<string,unknown>> {
    if (!validId(userId)) throw new Error('Invalid account');
    const result = await this.get(`/internal/adapty/profile?${new URLSearchParams({ user:userId })}`);
    if (result.user_id !== userId || result.provider_customer_id !== userId || !validId(result.observed_at)
        || !['active','inactive','unknown'].includes(String(result.status)) || typeof result.identity_match !== 'boolean') {
      throw new ProviderUnavailable();
    }
    return result;
  }

  async manifest():Promise<Record<string,unknown>> {
    const result = await this.get('/internal/manifest');
    if (!validId(result.app) || !validId(result.environment) || !validId(result.run_id)) throw new ProviderUnavailable();
    return result;
  }

  async status():Promise<Record<string,unknown>> {
    const result = await this.get('/internal/live/status');
    if (!Number.isSafeInteger(result.not_before_ms) || Number(result.not_before_ms) < 0
        || !Number.isSafeInteger(result.source_requests_total) || Number(result.source_requests_total) < 0) throw new ProviderUnavailable();
    return result;
  }

  async accounts(cursor:string | null,limit = 500):Promise<Record<string,unknown>> {
    if (cursor !== null && !/^\d+$/.test(cursor) || !Number.isInteger(limit) || limit < 1 || limit > 1000) {
      throw new Error('Invalid provider page');
    }
    const query = new URLSearchParams({ limit:String(limit) });
    if (cursor !== null) query.set('cursor',cursor);
    const result = await this.get(`/internal/provider/accounts?${query}`);
    if (!Array.isArray(result.items) || !Number.isSafeInteger(result.total)
        || !(result.next_cursor === null || typeof result.next_cursor === 'string')) throw new ProviderUnavailable();
    return result;
  }

  async profiles(cursor:string | null,limit = 500): Promise<Record<string,unknown>> {
    if (cursor !== null && !/^\d+$/.test(cursor) || !Number.isInteger(limit) || limit < 1 || limit > 1000) {
      throw new Error('Invalid provider page');
    }
    const query = new URLSearchParams({ limit:String(limit) });
    if (cursor !== null) query.set('cursor',cursor);
    const result = await this.get(`/internal/adapty/profiles?${query}`);
    if (!Array.isArray(result.items) || !Number.isSafeInteger(result.total)
        || !(result.next_cursor === null || typeof result.next_cursor === 'string')) throw new ProviderUnavailable();
    return result;
  }
}
