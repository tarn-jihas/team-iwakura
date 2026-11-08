import { createHash } from 'node:crypto';
import { gunzipSync } from 'node:zlib';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { semanticDigest } from '@reconcile/server/infrastructure/json';

const DEFAULT_FIXTURE_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '../../..',
  'reconcile-mock-first-kit/fixtures/hackathon');
const DEFAULT_APP_ID = 'mock-lumen-activation';
const FIXTURE_FILE = 'lumen_dataset.json.gz';

type FixtureTransaction = Record<string, unknown> & {
  purchase_type: string;
  product: string;
  t?: number;
  exp?: number;
};

type FixtureUser = Record<string, unknown> & { i: number; platform: string; tx: FixtureTransaction[] };

export interface ProviderAccountSeed {
  user_id: string;
  provider_customer_id: string;
  source_user_id: string;
  identity_status: 'mapped';
  provenance: 'official_hackathon_synthetic' | 'official_synthetic_seed';
}

export interface MockProfileSeed {
  user_id: string;
  source_user_id: string;
  raw_profile: Record<string, unknown>;
}

export interface OfficialFixtureSeed {
  manifest: Record<string, unknown>;
  accounts: ProviderAccountSeed[];
  profiles: MockProfileSeed[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function fixtureUser(value: unknown): FixtureUser {
  if (!isRecord(value) || !Number.isSafeInteger(value.i) || Number(value.i) < 0
      || typeof value.platform !== 'string' || !Array.isArray(value.tx)
      || value.tx.some((item) => !isRecord(item) || typeof item.purchase_type !== 'string'
        || typeof item.product !== 'string'
        || (item.purchase_type === 'subscription' && (!Number.isSafeInteger(item.t) || !Number.isSafeInteger(item.exp))))) {
    throw new Error('Official Lumen fixture has an invalid user row');
  }
  return value as FixtureUser;
}

function shiftedTimestamp(anchorMs: number, replayDeltaMs: number, offsetSeconds: number): string {
  return new Date(anchorMs + replayDeltaMs + offsetSeconds * 1000).toISOString().replace(/\.000Z$/u, 'Z');
}

function offsetTimestamp(value: unknown, anchorMs: number, replayDeltaMs: number): string | null {
  return Number.isSafeInteger(value) ? shiftedTimestamp(anchorMs, replayDeltaMs, Number(value)) : null;
}

function syntheticRawProfile(user: FixtureUser, sourceUserId: string, customerId: string,
  appId: string, sourceRevision: string, anchorMs: number, replayNow: Date): Record<string, unknown> {
  const replayDeltaMs = replayNow.getTime() - anchorMs;
  const accessLevels: Record<string, unknown>[] = [];
  const subscriptions: Record<string, unknown>[] = [];
  for (let index = 0; index < user.tx.length; index += 1) {
    const tx = user.tx[index]!;
    if (tx.purchase_type !== 'subscription') continue;
    if (!Number.isSafeInteger(tx.t) || !Number.isSafeInteger(tx.exp)) {
      throw new Error('Official subscription fixture is missing its period');
    }
    const purchasedOffset = Number(tx.t);
    const expiryOffset = Number(tx.exp);
    const store = user.platform === 'iOS' ? 'app_store' : user.platform === 'Android' ? 'play_store' : null;
    if (!store) throw new Error('Official fixture contains an unsupported platform');
    const productId = `com.synthetic.lumen.${tx.product}`;
    const transactionId = `fixture-txn-${semanticDigest({ sourceRevision, sourceUserId, tx, index }).slice(0, 32)}`;
    const originalTransactionId = `fixture-orig-${semanticDigest({ sourceRevision, sourceUserId,
      product: tx.product, original: tx.orig ?? purchasedOffset }).slice(0, 32)}`;
    const purchasedAt = shiftedTimestamp(anchorMs, replayDeltaMs, purchasedOffset);
    const expiresAt = shiftedTimestamp(anchorMs, replayDeltaMs, expiryOffset);
    const refundedAt = tx.refunded === null || tx.refunded === undefined
      ? null : offsetTimestamp(tx.refunded, anchorMs, replayDeltaMs);
    const billingIssueAt = tx.billing === null || tx.billing === undefined
      ? null : offsetTimestamp(tx.billing, anchorMs, replayDeltaMs);
    const base = {
      access_level_id: 'premium', store, store_product_id: productId,
      store_transaction_id: transactionId, store_original_transaction_id: originalTransactionId,
      starts_at: purchasedAt, purchased_at: purchasedAt, expires_at: expiresAt,
      is_in_grace_period: false, cancellation_reason: typeof tx.reason === 'string' ? tx.reason : '',
      ...(refundedAt ? { refunded_at: refundedAt } : {}),
      ...(billingIssueAt ? { billing_issue_detected_at: billingIssueAt } : {}),
    };
    accessLevels.push(base);
    subscriptions.push({
      store, store_product_id: productId, store_transaction_id: transactionId,
      store_original_transaction_id: originalTransactionId, environment: 'Production',
      expires_at: expiresAt, status: Date.parse(expiresAt) > replayNow.getTime() ? 'active' : 'expired',
      is_in_grace_period: false, is_trial_period: String(tx.offer ?? '').toLowerCase().includes('trial'),
      cancellation_reason: typeof tx.reason === 'string' ? tx.reason : '',
      ...(refundedAt ? { refunded_at: refundedAt } : {}),
      ...(billingIssueAt ? { billing_issue_detected_at: billingIssueAt } : {}),
    });
  }
  return {
    app_id: appId,
    profile_id: `fixture-profile-${semanticDigest({ sourceRevision, sourceUserId }).slice(0, 24)}`,
    customer_user_id: customerId,
    source_user_id: sourceUserId,
    timestamp: Math.floor(replayNow.getTime() / 1000),
    access_levels: accessLevels,
    subscriptions,
    non_subscriptions: [],
  };
}

function safeRunId(value: string): string {
  if (!/^[A-Za-z0-9._-]{1,96}$/u.test(value)) throw new Error('Invalid provider run ID');
  return value.replace(/[.-]/gu, '_');
}

/** Load a pinned official fixture and make a deterministic, provenance-carrying 100-user sample. */
export function loadOfficialFixture(options: { directory?: string; runId: string; sampleSize?: number;
  appId?: string; now?: Date; activeOverlay?:boolean }): OfficialFixtureSeed {
  const directory = resolve(options.directory ?? DEFAULT_FIXTURE_DIR);
  const declared = JSON.parse(readFileSync(resolve(directory, 'manifest.json'), 'utf8')) as unknown;
  if (!isRecord(declared) || declared.schema_version !== 1
      || declared.provenance !== 'official_hackathon_synthetic' || !isRecord(declared.files)
      || !isRecord(declared.files[FIXTURE_FILE]) || typeof declared.scenario_anchor !== 'string'
      || typeof declared.revision !== 'string') throw new Error('Official fixture manifest is invalid');
  const spec = declared.files[FIXTURE_FILE] as Record<string, unknown>;
  if (typeof spec.sha256 !== 'string' || !/^[a-f0-9]{64}$/u.test(spec.sha256)
      || !Number.isSafeInteger(spec.users) || Number(spec.users) < 1) throw new Error('Official fixture metadata is invalid');
  const compressed = readFileSync(resolve(directory, FIXTURE_FILE));
  const actualHash = createHash('sha256').update(compressed).digest('hex');
  if (actualHash !== spec.sha256) throw new Error('Official fixture checksum mismatch');
  const dataset = JSON.parse(gunzipSync(compressed).toString('utf8')) as unknown;
  if (!isRecord(dataset) || dataset.version !== 1 || !Array.isArray(dataset.users)
      || dataset.users.length !== spec.users) throw new Error('Official fixture dataset is invalid');
  const sampleSize = options.sampleSize ?? 100;
  if (!Number.isInteger(sampleSize) || sampleSize < 1 || sampleSize > 1000 || sampleSize > dataset.users.length) {
    throw new Error('Fixture sample size must be from 1 to 1000');
  }
  const runId = safeRunId(options.runId);
  const appId = options.appId ?? DEFAULT_APP_ID;
  const replayNow = options.now ?? new Date();
  const anchorMs = Date.parse(declared.scenario_anchor);
  if (!Number.isFinite(anchorMs) || !appId.trim() || !Number.isFinite(replayNow.getTime())) {
    throw new Error('Invalid fixture replay scope');
  }
  const users = dataset.users.slice(0, sampleSize).map(fixtureUser);
  const seen = new Set<number>();
  const accounts: ProviderAccountSeed[] = [];
  const profiles: MockProfileSeed[] = [];
  for (const user of users) {
    if (seen.has(user.i)) throw new Error('Official fixture has duplicate user IDs');
    seen.add(user.i);
    const sourceUserId = `u${String(user.i).padStart(5, '0')}`;
    const customerId = `lumen_${runId}_${String(user.i).padStart(5, '0')}`;
    const rawProfile = syntheticRawProfile(user, sourceUserId, customerId, appId,
      declared.revision, anchorMs, replayNow);
    if (options.activeOverlay) {
      const store = user.platform === 'iOS' ? 'app_store' : 'play_store';
      const transactionId = `synthetic-overlay-${semanticDigest({ runId,sourceUserId }).slice(0,32)}`;
      const startsAt = new Date(replayNow.getTime()-86_400_000).toISOString().replace(/\.\d{3}Z$/,'Z');
      const expiresAt = new Date(replayNow.getTime()+365*86_400_000).toISOString().replace(/\.\d{3}Z$/,'Z');
      const common = { store,store_product_id:'com.synthetic.lumen.demo.premium',store_transaction_id:transactionId,
        store_original_transaction_id:transactionId,starts_at:startsAt,purchased_at:startsAt,expires_at:expiresAt,
        is_in_grace_period:false,cancellation_reason:'' };
      (rawProfile.access_levels as Record<string,unknown>[]).push({ ...common,access_level_id:'premium' });
      (rawProfile.subscriptions as Record<string,unknown>[]).push({ ...common,environment:'Production',status:'active',is_trial_period:false });
      rawProfile.synthetic_active_overlay = true;
    }
    accounts.push({ user_id: customerId, provider_customer_id: customerId,
      source_user_id: sourceUserId, identity_status: 'mapped',
      provenance: 'official_hackathon_synthetic' });
    profiles.push({ user_id: customerId, source_user_id: sourceUserId, raw_profile: rawProfile });
  }
  const sourceUserIds = profiles.map((profile) => profile.source_user_id);
  const sanitizedPrefix = runId;
  return {
    manifest: {
      app: appId, app_id: appId, app_title: String(dataset.app ?? 'Lumen'),
      environment: 'Production', scenario: 'adapty_synthetic_fixture', variant: 0,
      run_id: `activation-offline-${declared.revision.slice(0, 8)}-${sanitizedPrefix}`,
      scenario_now: replayNow.toISOString().replace(/\.\d{3}Z$/u, 'Z'),
      provenance: declared.provenance, source_revision: declared.revision,
      source_user_count: dataset.users.length, customer_count: sampleSize,
      sample_source_user_ids: sourceUserIds,
      source_file_checksums: { [FIXTURE_FILE]: actualHash },
      payment_verification: 'unverified_synthetic_history',
      synthetic_active_overlay:options.activeOverlay === true,
      customer_id_mapping: `${sourceUserIds[0]} -> lumen_${sanitizedPrefix}_${String(users[0]!.i).padStart(5, '0')}`,
    },
    accounts,
    profiles,
  };
}
