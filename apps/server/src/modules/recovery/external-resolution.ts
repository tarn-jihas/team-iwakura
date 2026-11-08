import { LumenAdapter } from '../client/lumen-adapter.js';
import { classifyFulfillment } from '../fulfillment/classification.js';
import type { CurrentTarget } from './preflight.js';
import { RecoveryRepository } from './repository.js';

/** A self-healed account releases ownership only after source and actual gate readback agree. */
export class ExternalResolution {
  constructor(private readonly repository:RecoveryRepository, private readonly lumen:LumenAdapter,
    private readonly now:() => Date = () => new Date()) {}

  async resolve(incidentId:string,appId:string,environment:string,current:CurrentTarget):Promise<boolean> {
    const observation = current.observation, entitlement = observation.entitlement, at = this.now();
    if (await this.repository.ownedByAnother(appId,environment,observation.userId,incidentId)) return false;
    if (await this.repository.hasAmbiguousWrite(incidentId,observation.userId)) return false;
    if (await this.repository.hasPendingOwnVerification(incidentId,observation.userId)) return false;
    const age = at.getTime() - observation.now.getTime();
    if (!entitlement || !Number.isFinite(age) || age < 0 || age > 30_000 || observation.appId !== appId
        || current.customerId !== observation.userId || entitlement.user_id !== observation.userId
        || entitlement.provider_customer_id !== observation.userId || current.store !== entitlement.store
        || current.sourceEnvironment !== entitlement.source_environment || current.sourceFingerprint !== entitlement.source_fingerprint
        || classifyFulfillment({ ...observation,now:at }).status !== 'healthy') return false;
    try {
      const gate = await this.lumen.probeAccess(observation.userId);
      if (gate.user_id !== observation.userId || gate.allowed !== true || gate.active !== true || gate.identity_revision !== current.identityRevision
          || gate.policy_revision !== current.policyRevision || gate.projection_revision !== current.projectionRevision
          || gate.cache_revision !== current.projectionRevision || gate.expires_at !== entitlement.expires_at
          || gate.entitlement_hash !== entitlement.entitlement_hash) return false;
    } catch { return false; }
    const recorded = await this.repository.recordExternalVerification(incidentId,appId,environment,observation.userId,entitlement.transaction_id!,
      current.sourceFingerprint,entitlement.entitlement_hash,current.identityRevision,current.policyRevision,current.projectionRevision,at.toISOString());
    return recorded;
  }
}
