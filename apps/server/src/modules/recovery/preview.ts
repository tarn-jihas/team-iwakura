import { randomUUID } from 'node:crypto';
import { semanticDigest } from '../../infrastructure/json.js';
import { classifyFulfillment } from '../fulfillment/classification.js';
import type { CurrentTarget, RecoveryAction, RecoveryTarget } from './preflight.js';
import type { ResyncRequest } from '../client/lumen-adapter.js';

/** Builds a preview only from independently observed, individually eligible accounts. */
export function prepareRecovery(appId:string, current:ReadonlyMap<string,CurrentTarget>, selected:readonly string[], now:Date,
  modes:ReadonlyMap<string,'resync' | 'probe'> = new Map()): {
  targets:RecoveryTarget[]; actions:RecoveryAction[]; evidence:unknown[];
} {
  const selectedSet = new Set(selected);
  if (!appId || !Number.isFinite(now.getTime()) || !selected.length || selected.length > 10_000
      || selectedSet.size !== selected.length || [...modes].some(([userId,mode]) =>
        !selectedSet.has(userId) || !['resync','probe'].includes(mode))) throw new Error('Invalid recovery selection');
  const targets:RecoveryTarget[] = [], actions:RecoveryAction[] = [], evidence:unknown[] = [];
  for (const userId of selected) {
    const item = current.get(userId), observation = item?.observation, entitlement = observation?.entitlement;
    const mode = modes.get(userId) ?? 'resync';
    const assessment = observation && classifyFulfillment({ ...observation,now });
    if (!item || !observation || !entitlement || observation.appId !== appId || observation.userId !== userId
        || item.customerId !== userId || !entitlement.transaction_id || !entitlement.product_id
        || entitlement.user_id !== userId || entitlement.provider_customer_id !== userId
        || entitlement.store !== item.store || entitlement.source_environment !== item.sourceEnvironment
        || entitlement.source_fingerprint !== item.sourceFingerprint
        || !['app_store','play_store'].includes(entitlement.store) || !assessment
        || (mode === 'resync' ? !assessment.eligible : assessment.status !== 'healthy')) throw new Error('Account is not eligible for recovery');
    const target:RecoveryTarget = { userId,mode,customerId:item.customerId,transactionId:entitlement.transaction_id,
      store:item.store,sourceEnvironment:item.sourceEnvironment,sourceFingerprint:item.sourceFingerprint,
      entitlementHash:entitlement.entitlement_hash,identityRevision:item.identityRevision,
      policyRevision:item.policyRevision,projectionRevision:item.projectionRevision };
    const operationKey = randomUUID();
    const request:ResyncRequest = { schema_version:2,user_id:userId,expected_provider_customer_id:item.customerId,
      expected_identity_revision:item.identityRevision,expected_policy_revision:item.policyRevision,
      expected_projection_revision:item.projectionRevision,operation_key:operationKey,
      processing_id:randomUUID(),trace_id:randomUUID(),entitlement:{ product_id:entitlement.product_id,
        expires_at:entitlement.expires_at,entitlement_hash:entitlement.entitlement_hash,
        transaction_id:entitlement.transaction_id,source_fingerprint:entitlement.source_fingerprint,
        store:entitlement.store as 'app_store' | 'play_store',source_environment:entitlement.source_environment,
        ...(entitlement.original_transaction_id ? { original_transaction_id:entitlement.original_transaction_id } : {}) } };
    const probe = { user_id:userId,feature:'premium_export' as const,initiator:'reconcile_probe' as const };
    targets.push(target);
    if (mode === 'resync') actions.push({ operationKey,userId,kind:'resync_access',request,requestHash:semanticDigest(request) });
    actions.push({ operationKey:randomUUID(),userId,kind:'verify_gate',request:probe,requestHash:semanticDigest(probe) });
    evidence.push({ userId,observedAt:now.toISOString(),
      source:{ appId:entitlement.app_id,userId:entitlement.user_id,customerId:entitlement.provider_customer_id,
        transactionId:entitlement.transaction_id,originalTransactionId:entitlement.original_transaction_id ?? null,
        productId:entitlement.product_id,store:entitlement.store,environment:entitlement.source_environment,
        startsAt:entitlement.starts_at,expiresAt:entitlement.expires_at,sourceFingerprint:entitlement.source_fingerprint,
        entitlementHash:entitlement.entitlement_hash },
      client:observation.client && { active:observation.client.access_active,expiresAt:observation.client.access_expires_at,
        entitlementHash:observation.client.entitlement_hash,gateAllowed:observation.client.gate.allowed,
        gateReason:['allowed','policy_restricted','cache_stale','subscription_inactive','subscription_expired']
          .includes(observation.client.gate.reason) ? observation.client.gate.reason : 'unrecognized' },
      sourceObservedAt:observation.profile?.observed_at ?? null });
  }
  return { targets,actions,evidence };
}
