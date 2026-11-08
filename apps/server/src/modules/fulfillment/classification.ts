import { parseTimestamp } from '../../infrastructure/time.js';

export type FulfillmentStatus = 'inconclusive' | 'legitimate_denial' | 'policy_denial'
  | 'potential' | 'confirmed' | 'healthy';

export interface SourceProfile {
  user_id: string;
  app_id: string;
  identity_match: boolean;
  observed_at: string;
  status: 'active' | 'inactive' | 'unknown';
  reason: string;
}

export interface Entitlement {
  app_id: string;
  user_id: string;
  provider_customer_id: string;
  transaction_id: string | null;
  product_id: string;
  original_transaction_id?: string | null;
  store: string;
  source_environment: string;
  source_fingerprint: string;
  starts_at: string;
  expires_at: string;
  is_in_grace_period: boolean;
  entitlement_hash: string;
}

export interface ClientAccess {
  provider_customer_id: string;
  identity_status: string;
  policy_enabled: boolean;
  access_active: boolean;
  access_expires_at: string | null;
  entitlement_hash: string | null;
  gate: { allowed: boolean | null; reason: string };
}

export interface FulfillmentObservation {
  appId: string;
  userId: string;
  now: Date;
  complete: boolean;
  sourceScopeMatches: boolean;
  provider: { provider_customer_id: string; identity_status: string } | null;
  profile: SourceProfile | null;
  entitlement: Entitlement | null;
  client: ClientAccess | null;
  ownedByOtherIncident: boolean;
  normalProcessingWindow: boolean;
  explicitHandlerFailure: boolean;
}

export interface Classification {
  status: FulfillmentStatus;
  reason: string;
  eligible: boolean;
  projectionMatches: boolean;
}

/** Compare source evidence, client identity and the observed gate independently. */
export function classifyFulfillment(input: FulfillmentObservation): Classification {
  const result = (status: FulfillmentStatus, reason: string, eligible = false, projectionMatches = false): Classification =>
    ({ status, reason, eligible, projectionMatches });
  const { provider, client, profile, entitlement, userId, appId } = input;
  if (!input.complete) return result('inconclusive', 'coverage_incomplete');
  if (!provider || !client || !profile || provider.identity_status !== 'mapped'
      || client.identity_status !== 'mapped' || provider.provider_customer_id !== userId
      || client.provider_customer_id !== userId || !profile.identity_match
      || profile.user_id !== userId || profile.app_id !== appId) {
    return result('inconclusive', 'identity_unknown');
  }
  if (!input.sourceScopeMatches) return result('inconclusive', 'source_scope_mismatch');
  const now = input.now.getTime();
  const age = now - parseTimestamp(profile.observed_at);
  if (!Number.isFinite(now) || !Number.isFinite(age) || age < 0 || age > 300_000) {
    return result('inconclusive', 'adapty_profile_stale');
  }
  if (profile.status !== 'active' || !entitlement) {
    if (profile.status === 'inactive' && ['premium_entitlement_absent', 'subscription_not_started',
      'subscription_expired'].includes(profile.reason)) return result('legitimate_denial', profile.reason);
    return result('inconclusive', profile.reason || 'premium_entitlement_inactive');
  }
  const start = parseTimestamp(entitlement.starts_at), expiry = parseTimestamp(entitlement.expires_at);
  if (entitlement.app_id !== appId || entitlement.user_id !== userId
      || entitlement.provider_customer_id !== userId) return result('inconclusive', 'identity_unknown');
  if (entitlement.is_in_grace_period !== false) return result('inconclusive', 'grace_period');
  if (!Number.isFinite(start) || !Number.isFinite(expiry)) return result('inconclusive', 'period_unavailable');
  if (start > now || now >= expiry) {
    return result('legitimate_denial', 'premium_entitlement_not_current');
  }
  if (!entitlement.transaction_id) return result('inconclusive', 'transaction_link_missing');
  if (!client.policy_enabled || client.gate.reason === 'policy_restricted') return result('policy_denial', 'policy_restricted');
  const matches = client.access_active && client.access_expires_at === entitlement.expires_at
    && client.entitlement_hash === entitlement.entitlement_hash;
  if (matches && client.gate.allowed === true) return result('healthy', 'source_period_and_gate_match', false, true);
  if (input.ownedByOtherIncident) return result('potential', 'owned_by_open_incident');
  const waiting = input.normalProcessingWindow && !input.explicitHandlerFailure;
  if (!matches) return waiting ? result('potential', 'normal_processing_window')
    : result('confirmed', 'projection_mismatch', true);
  if (client.gate.allowed === null) return result('inconclusive', 'gate_unobserved', false, true);
  if (['cache_stale', 'subscription_inactive', 'subscription_expired'].includes(client.gate.reason)) {
    return waiting ? result('potential', 'normal_processing_window', false, true)
      : result('confirmed', 'gate_denied_despite_matching_projection', true, true);
  }
  return result('potential', 'gate_denial_not_explained_by_projection', false, true);
}
