import { classifyFulfillment } from './classification.js';
import { FulfillmentRegistry } from './registry.js';
import type { ScanResult } from './scan.js';
import type { CurrentTarget } from '../recovery/preflight.js';

/** Persists independent account assessments, not simulator fault annotations. */
export async function persistScan(registry:FulfillmentRegistry, scan:ScanResult, app:string, environment:string,
  resolveExternal:(incidentId:string,current:CurrentTarget) => Promise<boolean>):Promise<
  { identityHash:string; userId:string; episodeNo:number }[]> {
  const pending:{ identityHash:string; userId:string; episodeNo:number }[] = [];
  for (const observation of scan.observations) {
    const at = observation.now.toISOString(), entitlement = observation.entitlement;
    if (!observation.complete || !observation.sourceScopeMatches || observation.appId !== app || !entitlement
        || entitlement.app_id !== app || entitlement.user_id !== observation.userId
        || entitlement.provider_customer_id !== observation.userId
        || !/^[0-9a-f]{64}$/.test(entitlement.source_fingerprint) || !/^[0-9a-f]{64}$/.test(entitlement.entitlement_hash)) {
      await registry.markCoverageGap(app,environment,observation.userId,at);
      continue;
    }
    const classification = classifyFulfillment(observation);
    if (classification.status === 'healthy') {
      const incidentIds = await registry.openIncidents(app,environment,observation.userId);
      const current = scan.current.get(observation.userId);
      let resolved = true;
      for (const incidentId of incidentIds) {
        if (!current || !await resolveExternal(incidentId,current)) { resolved = false; break; }
        await registry.closeSuperseded(incidentId,{ app,environment,store:entitlement.store,
          transactionId:entitlement.transaction_id,userId:observation.userId,accessLevel:'premium' },at);
      }
      if (!resolved) { await registry.markCoverageGap(app,environment,observation.userId,at); continue; }
    }
    const state = await registry.observe({ app,environment,store:entitlement.store,transactionId:entitlement.transaction_id,
      userId:observation.userId,accessLevel:'premium' },classification,entitlement.source_fingerprint,entitlement.entitlement_hash,at);
    if (classification.eligible && state.status === 'discrepancy' && state.episodeOpen && !state.incidentId
        && scan.current.has(observation.userId)) pending.push({ identityHash:state.identityHash,userId:observation.userId,episodeNo:state.episodeNo });
  }
  return pending;
}
