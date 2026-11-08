import { semanticDigest, semanticJson } from '../../infrastructure/json.js';
import { parseTimestamp } from '../../infrastructure/time.js';
import { SQLiteStorage } from '../../infrastructure/sqlite.js';

export interface ExpectedAccess {
  appId: string;
  environment: string;
  store: string;
  transactionId: string;
  userId: string;
  accessLevel: string;
  startsAt: string;
  expiresAt: string;
  sourceFingerprint: string;
  entitlementHash: string;
}

const text = (value: unknown): value is string => typeof value === 'string' && value.length > 0
  && value.length <= 256 && value.trim() === value && !/[\u0000-\u001f\u007f]/.test(value);
const hash = (value: unknown): value is string => typeof value === 'string' && /^[0-9a-f]{64}$/.test(value);

/** Records observed source rights, never a payment inferred from client telemetry. */
export class Expectations {
  constructor(private readonly storage: SQLiteStorage) {}

  async initialize(): Promise<void> {
    await this.storage.transaction([
      { mode:'run', sql:'CREATE TABLE IF NOT EXISTS expectation_versions (version_hash TEXT PRIMARY KEY, identity_hash TEXT NOT NULL, payload TEXT NOT NULL, first_observed_at TEXT NOT NULL)' },
      { mode:'run', sql:'CREATE TABLE IF NOT EXISTS expectation_heads (identity_hash TEXT PRIMARY KEY, version_hash TEXT NOT NULL REFERENCES expectation_versions(version_hash), last_observed_at TEXT NOT NULL, last_observed_ms INTEGER NOT NULL)' },
      { mode:'run', sql:"CREATE TRIGGER IF NOT EXISTS expectation_versions_no_update BEFORE UPDATE ON expectation_versions BEGIN SELECT RAISE(ABORT,'Expectation versions are immutable'); END" },
      { mode:'run', sql:"CREATE TRIGGER IF NOT EXISTS expectation_versions_no_delete BEFORE DELETE ON expectation_versions BEGIN SELECT RAISE(ABORT,'Expectation versions are immutable'); END" }
    ]);
  }

  async observe(right: ExpectedAccess, observedAt: string): Promise<{ identityHash:string; versionHash:string; current:boolean; firstObservedAt:string }> {
    const start = parseTimestamp(right.startsAt), end = parseTimestamp(right.expiresAt), observed = parseTimestamp(observedAt);
    if (Object.keys(right).sort().join(',') !== 'accessLevel,appId,entitlementHash,environment,expiresAt,sourceFingerprint,startsAt,store,transactionId,userId'
        || ![right.appId,right.environment,right.store,right.transactionId,right.userId,right.accessLevel].every(text)
        || !hash(right.sourceFingerprint) || !hash(right.entitlementHash)
        || !Number.isFinite(start) || !Number.isFinite(end) || end <= start || !Number.isFinite(observed)) {
      throw new Error('Invalid source expectation');
    }
    const identityHash = semanticDigest([right.appId,right.environment,right.store,right.transactionId,right.userId,right.accessLevel]);
    const versionHash = semanticDigest(right), payload = semanticJson(right);
    const [, , head] = await this.storage.transaction([
      { mode:'run', sql:'INSERT OR IGNORE INTO expectation_versions VALUES (?,?,?,?)', params:[versionHash,identityHash,payload,observedAt] },
      { mode:'run', sql:'INSERT INTO expectation_heads VALUES (?,?,?,?) ON CONFLICT(identity_hash) DO UPDATE SET version_hash=excluded.version_hash,last_observed_at=excluded.last_observed_at,last_observed_ms=excluded.last_observed_ms WHERE excluded.last_observed_ms > expectation_heads.last_observed_ms OR (excluded.last_observed_ms = expectation_heads.last_observed_ms AND excluded.version_hash = expectation_heads.version_hash)',
        params:[identityHash,versionHash,observedAt,observed] },
      { mode:'get', sql:'SELECT h.version_hash,v.first_observed_at FROM expectation_heads h JOIN expectation_versions v ON v.version_hash=? WHERE h.identity_hash=?', params:[versionHash,identityHash] }
    ]) as [unknown,unknown,{ version_hash:string; first_observed_at:string }];
    return { identityHash, versionHash, current:head.version_hash === versionHash, firstObservedAt:head.first_observed_at };
  }

  async read(identityHash: string): Promise<{ right:ExpectedAccess; versionHash:string; lastObservedAt:string } | null> {
    if (!hash(identityHash)) throw new Error('Invalid expectation identity');
    const row = await this.storage.statement({ mode:'get', sql:'SELECT h.version_hash,h.last_observed_at,v.payload FROM expectation_heads h JOIN expectation_versions v ON v.version_hash=h.version_hash WHERE h.identity_hash=?', params:[identityHash] }) as
      { version_hash:string; last_observed_at:string; payload:string } | null;
    if (!row) return null;
    const right = JSON.parse(row.payload) as ExpectedAccess;
    if (semanticDigest(right) !== row.version_hash) throw new Error('Expectation integrity check failed');
    return { right, versionHash:row.version_hash, lastObservedAt:row.last_observed_at };
  }
}
