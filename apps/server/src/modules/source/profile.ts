import { parseTimestamp } from '../../infrastructure/time.js';
import { semanticDigest, semanticJson } from '../../infrastructure/json.js';

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
type RecordValue = Record<string, unknown>;

const isRecord = (value: unknown): value is RecordValue =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const text = (value: unknown): value is string =>
  typeof value === 'string' && value.length > 0 && value === value.trim();

function instant(value: unknown): Date | null {
  const valueMs = parseTimestamp(value);
  return Number.isFinite(valueMs) ? new Date(valueMs) : null;
}

const isoSeconds = (date: Date): string => date.toISOString().replace(/\.\d{3}Z$/, 'Z');

export interface SourceProfileResult {
  user_id: string;
  provider_customer_id: string;
  app_id: unknown;
  profile_id: unknown;
  source_fingerprint: string;
  source_revision: string;
  observed_at: string;
  raw_source_profile: Json;
  identity_match: boolean;
  status: 'active' | 'inactive' | 'unknown';
  reason: string;
  entitlement: RecordValue | null;
  provenance: 'official_synthetic_seed';
  payment_verification: 'not_independently_verified';
}

/** Normalize a current Adapty profile without treating it as payment proof. */
export function normalizeProfile(raw: unknown, appId: string, customerId: string,
  now = new Date()): SourceProfileResult {
  if (!isRecord(raw) || !text(appId) || !text(customerId) || !Number.isFinite(now.getTime())) {
    throw new Error('Invalid source profile input');
  }
  const { timestamp: _timestamp, observed_at: _observed, ...fingerprintSource } = raw;
  const sourceFingerprint = semanticDigest(fingerprintSource);
  // Check the entire payload, including fields excluded from the fingerprint.
  const sourceProfile = JSON.parse(semanticJson(raw)) as Json;
  const observedAt = isoSeconds(now);
  const identityMatch = raw.app_id === appId && raw.customer_user_id === customerId && text(raw.profile_id);
  const result: SourceProfileResult = {
    user_id: customerId, provider_customer_id: customerId, app_id: raw.app_id ?? null,
    profile_id: raw.profile_id ?? null, source_fingerprint: sourceFingerprint,
    source_revision: sourceFingerprint, observed_at: observedAt, raw_source_profile: sourceProfile,
    identity_match: identityMatch, status: 'unknown', reason: 'source_profile_uncertain',
    entitlement: null, provenance: 'official_synthetic_seed',
    payment_verification: 'not_independently_verified'
  };
  if (!identityMatch) return { ...result, reason: 'identity_scope_mismatch' };
  if (!Array.isArray(raw.access_levels) || !Array.isArray(raw.subscriptions)) return result;
  const levels = raw.access_levels.filter(isRecord).filter(item => item.access_level_id === 'premium');
  if (!levels.length) return { ...result, status: 'inactive', reason: 'premium_entitlement_absent' };
  const evaluated: { eligible: boolean; expiry: Date; reason: string; level: RecordValue;
    subscription: RecordValue; start: Date }[] = [];
  for (const level of levels) {
    const transactionId = level.store_transaction_id, productId = level.store_product_id, store = level.store;
    if (!text(productId) || !['app_store', 'play_store'].includes(String(store))
        || typeof level.is_in_grace_period !== 'boolean') continue;
    const start = instant(level.starts_at || level.purchased_at), expiry = instant(level.expires_at);
    if (!start || !expiry || expiry <= start) continue;
    const matches = raw.subscriptions.filter(isRecord).filter(item => item.store_product_id === productId
      && item.store === store && (!text(transactionId) || item.store_transaction_id === transactionId)
      && item.environment === 'Production');
    const subscription = text(transactionId) ? matches[0] : matches.length === 1 ? matches[0] : undefined;
    if (!subscription || typeof subscription.is_in_grace_period !== 'boolean') continue;
    const hazards = ['billing_issue_detected_at', 'refunded_at', 'revoked_at', 'chargeback_at'];
    if (hazards.some(key => subscription[key] != null || level[key] != null)) continue;
    const subscriptionExpiry = instant(subscription.expires_at);
    if (!subscriptionExpiry || subscriptionExpiry.getTime() !== expiry.getTime()) continue;
    const status = String(subscription.status ?? '').toLowerCase();
    if (status && !['active', 'expired', 'cancelled', 'canceled', 'renewal_cancelled'].includes(status)) continue;
    const offer = (item: unknown): string => String(isRecord(item) ? item.type ?? '' : item ?? '').toLowerCase();
    const trial = subscription.is_trial_period === true || subscription.is_trial === true
      || ['trial', 'trialing'].includes(status) || `${offer(level.offer)} ${offer(subscription.offer)}`.includes('trial');
    const grace = level.is_in_grace_period || subscription.is_in_grace_period;
    const allowedCancellation = new Set(['', 'voluntarily_cancelled', 'canceled_by_customer',
      'cancelled_by_customer', 'user_cancelled']);
    if ([level, subscription].some(item => !allowedCancellation.has(String(item.cancellation_reason || '').toLowerCase()))) continue;
    const eligible = start <= now && now < expiry && !trial && !grace;
    const reason = trial ? 'trial_period' : grace ? 'grace_period' : start > now ? 'subscription_not_started'
      : expiry <= now ? 'subscription_expired' : 'active';
    evaluated.push({ eligible, expiry, reason, level, subscription, start });
  }
  if (!evaluated.length) return { ...result, reason: 'premium_source_binding_uncertain' };
  const active = evaluated.filter(item => item.eligible);
  const chosen = (active.length ? active : evaluated).reduce((best, item) => item.expiry > best.expiry ? item : best);
  const { level, subscription, start, expiry, reason, eligible } = chosen;
  const original = level.store_original_transaction_id || level.original_transaction_id
    || subscription.store_original_transaction_id || subscription.original_transaction_id;
  const expiresAt = isoSeconds(expiry);
  const entitlement = {
    user_id: customerId, provider_customer_id: customerId, app_id: appId, profile_id: raw.profile_id,
    access_level_id: 'premium', product_id: level.store_product_id,
    transaction_id: text(level.store_transaction_id) ? level.store_transaction_id : null,
    original_transaction_id: text(original) ? original : null, store: level.store,
    source_environment: subscription.environment, starts_at: isoSeconds(start),
    purchased_at: level.purchased_at ?? null, expires_at: expiresAt,
    is_in_grace_period: level.is_in_grace_period, subscription_environment: subscription.environment,
    source_fingerprint: sourceFingerprint, source_revision: sourceFingerprint, observed_at: observedAt,
    provenance: result.provenance, payment_verification: result.payment_verification,
    raw_source_profile: sourceProfile,
    entitlement_hash: semanticDigest({ user_id: customerId, product_id: level.store_product_id, expires_at: expiresAt })
  };
  return { ...result, status: eligible ? 'active' : 'inactive', reason, entitlement };
}
