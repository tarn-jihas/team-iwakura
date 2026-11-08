import { classifyFulfillment, type FulfillmentObservation } from '../fulfillment/classification.js';
import { parseTimestamp } from '../../infrastructure/time.js';
import { semanticDigest } from '../../infrastructure/json.js';
import { validResyncRequest, type ResyncRequest } from '../client/lumen-adapter.js';

export interface RecoveryTarget {
  userId: string;
  mode: 'resync' | 'probe';
  customerId: string;
  transactionId: string;
  store: string;
  sourceEnvironment: string;
  sourceFingerprint: string;
  entitlementHash: string;
  identityRevision: number;
  policyRevision: number;
  projectionRevision: number;
}

export interface RecoveryPlan {
  id: string;
  incidentId: string;
  snapshotId: string;
  snapshotHash: string;
  appId: string;
  environment: string;
  policyRevision: number;
  createdAt: string;
  expiresAt: string;
  targets: RecoveryTarget[];
  actions: RecoveryAction[];
}

export type RecoveryAction = { operationKey: string; userId: string; requestHash: string } & (
  | { kind: 'resync_access'; request: ResyncRequest }
  | { kind: 'verify_gate'; request: { user_id: string; feature: 'premium_export'; initiator: 'reconcile_probe' } }
);

export interface CurrentTarget {
  observation: FulfillmentObservation;
  customerId: string;
  store: string;
  sourceEnvironment: string;
  sourceFingerprint: string;
  identityRevision: number;
  policyRevision: number;
  projectionRevision: number;
}

export class PreflightError extends Error {
  constructor(readonly code: string, readonly userId?: string) {
    super(userId ? `${code}: ${userId}` : code);
  }
}

const nonempty = (value: unknown): value is string =>
  typeof value === 'string' && value.length > 0 && value.length <= 256 && value === value.trim()
    && !/[\u0000-\u001f\u007f]/.test(value);
const revision = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
const hash = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);

export function validatePlanActions(plan: RecoveryPlan): void {
  if (!Array.isArray(plan.targets) || !plan.targets.length || plan.targets.length > 10_000
      || new Set(plan.targets.map(target => target.userId)).size !== plan.targets.length
      || !Array.isArray(plan.actions) || !plan.actions.length || plan.actions.length > 20_000
      || new Set(plan.actions.map(action => action.operationKey)).size !== plan.actions.length) {
    throw new PreflightError('invalid_plan_actions');
  }
  const targets = new Map(plan.targets.map(target => [target.userId, target]));
  const counts = new Map<string, { resync: number; probe: number }>();
  for (const target of plan.targets) {
    if (!nonempty(target.userId) || target.customerId !== target.userId || !nonempty(target.transactionId)
        || !['app_store','play_store'].includes(target.store) || !nonempty(target.sourceEnvironment)
        || !hash(target.sourceFingerprint) || !hash(target.entitlementHash)
        || !revision(target.identityRevision) || target.identityRevision < 1
        || !revision(target.policyRevision) || target.policyRevision < 1
        || !revision(target.projectionRevision) || target.projectionRevision < 1
        || !['resync','probe'].includes(target.mode)) throw new PreflightError('invalid_target',target.userId);
  }
  for (const action of plan.actions) {
    const target = targets.get(action.userId);
    if (!target || !nonempty(action.operationKey) || !hash(action.requestHash)
        || semanticDigest(action.request) !== action.requestHash) throw new PreflightError('invalid_plan_actions');
    if (action.kind === 'resync_access') {
      const request = action.request;
      if (target.mode !== 'resync' || !validResyncRequest(request, target.sourceEnvironment)
          || request.operation_key !== action.operationKey || request.user_id !== target.userId
          || request.expected_provider_customer_id !== target.customerId
          || request.expected_identity_revision !== target.identityRevision
          || request.expected_policy_revision !== target.policyRevision
          || request.expected_projection_revision !== target.projectionRevision
          || request.entitlement.transaction_id !== target.transactionId
          || request.entitlement.store !== target.store
          || request.entitlement.source_fingerprint !== target.sourceFingerprint
          || request.entitlement.entitlement_hash !== target.entitlementHash) throw new PreflightError('invalid_plan_actions');
    } else if (action.kind !== 'verify_gate' || action.request?.user_id !== target.userId
        || action.request.feature !== 'premium_export' || action.request.initiator !== 'reconcile_probe'
        || Object.keys(action.request).sort().join(',') !== 'feature,initiator,user_id') {
      throw new PreflightError('invalid_plan_actions');
    }
    const count = counts.get(target.userId) ?? { resync:0, probe:0 };
    if (action.kind === 'resync_access') count.resync++; else count.probe++;
    counts.set(target.userId, count);
  }
  for (const target of plan.targets) {
    const count = counts.get(target.userId);
    if (!count || count.probe !== 1 || count.resync !== (target.mode === 'resync' ? 1 : 0)) {
      throw new PreflightError('invalid_plan_actions');
    }
  }
}

/** The caller must first load the persisted, hash-verified plan and immutable snapshot. */
export function preflightPlan(plan: RecoveryPlan, scope: { appId: string; environment: string;
  policyRevision: number }, current: ReadonlyMap<string, CurrentTarget>, now: Date): void {
  const created = parseTimestamp(plan.createdAt), expires = parseTimestamp(plan.expiresAt), at = now.getTime();
  if (!nonempty(plan.id) || !nonempty(plan.incidentId) || !nonempty(plan.snapshotId) || !hash(plan.snapshotHash)
      || !nonempty(plan.appId) || !nonempty(plan.environment) || !revision(plan.policyRevision)
      || !Number.isFinite(created) || !Number.isFinite(expires) || !Number.isFinite(at)
      || expires <= created || expires - created > 300_000 || at < created || at >= expires) {
    throw new PreflightError('invalid_or_expired_plan');
  }
  if (scope.appId !== plan.appId || scope.environment !== plan.environment
      || scope.policyRevision !== plan.policyRevision) throw new PreflightError('scope_changed');
  if (!Array.isArray(plan.targets) || !plan.targets.length || plan.targets.length > 10_000
      || new Set(plan.targets.map(target => target.userId)).size !== plan.targets.length) {
    throw new PreflightError('invalid_targets');
  }
  validatePlanActions(plan);
  const writes = new Map(plan.actions.filter(action => action.kind === 'resync_access')
    .map(action => [action.userId, action]));
  for (const target of plan.targets) {
    if (!nonempty(target.userId) || !nonempty(target.customerId) || target.customerId !== target.userId
        || !nonempty(target.transactionId)
        || !nonempty(target.store) || !nonempty(target.sourceEnvironment)
        || !hash(target.sourceFingerprint) || !hash(target.entitlementHash)
        || !revision(target.identityRevision) || !revision(target.policyRevision)
        || !revision(target.projectionRevision) || !['resync', 'probe'].includes(target.mode)) {
      throw new PreflightError('invalid_target', target.userId);
    }
    const actual = current.get(target.userId);
    if (!actual || actual.customerId !== target.customerId || actual.store !== target.store
        || actual.sourceEnvironment !== target.sourceEnvironment
        || actual.sourceFingerprint !== target.sourceFingerprint
        || actual.identityRevision !== target.identityRevision || actual.policyRevision !== target.policyRevision
        || actual.projectionRevision !== target.projectionRevision
        || actual.observation.appId !== plan.appId || actual.observation.userId !== target.userId
        || actual.observation.entitlement?.transaction_id !== target.transactionId
        || actual.observation.entitlement?.store !== target.store
        || actual.observation.entitlement?.source_environment !== target.sourceEnvironment
        || actual.observation.entitlement?.source_fingerprint !== target.sourceFingerprint
        || actual.observation.entitlement?.entitlement_hash !== target.entitlementHash) {
      throw new PreflightError('source_or_revision_changed', target.userId);
    }
    const assessment = classifyFulfillment({ ...actual.observation, now });
    const write = writes.get(target.userId);
    const entitlement = actual.observation.entitlement;
    if (write?.kind === 'resync_access' && (!entitlement
        || write.request.entitlement.product_id !== entitlement.product_id
        || write.request.entitlement.expires_at !== entitlement.expires_at
        || (write.request.entitlement.original_transaction_id ?? null) !== (entitlement.original_transaction_id ?? null))) {
      throw new PreflightError('source_or_revision_changed', target.userId);
    }
    if (target.mode === 'resync' && !(assessment.status === 'confirmed' && assessment.eligible)
        || target.mode === 'probe' && assessment.status !== 'healthy') {
      throw new PreflightError('account_not_eligible', target.userId);
    }
  }
}
