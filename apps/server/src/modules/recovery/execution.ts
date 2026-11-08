import { LumenAdapter, LumenAdapterError, type ResyncRequest } from '../client/lumen-adapter.js';
import { PreflightError, preflightPlan, type CurrentTarget, type RecoveryAction, type RecoveryPlan, type RecoveryTarget } from './preflight.js';
import { RecoveryRepository, type ActionStatus } from './repository.js';
import { semanticDigest } from '../../infrastructure/json.js';
import { classifyFulfillment } from '../fulfillment/classification.js';

type Scope = { appId:string; environment:string; policyRevision:number };
type Observe = (userIds:readonly string[]) => Promise<ReadonlyMap<string,CurrentTarget>>;

/** Execution receives fresh observations from the source integration, never from the client SDK. */
export class RecoveryExecution {
  constructor(private readonly repository: RecoveryRepository, private readonly lumen: LumenAdapter,
    private readonly observe: Observe, private readonly now: () => Date = () => new Date()) {}

  async execute(planId: string, scope: Scope): Promise<{ operationKey:string; status:ActionStatus }[]> {
    const saved = await this.repository.readPlan(planId);
    if (!saved) throw new Error('Plan unavailable');
    const { plan } = saved;
    if (plan.appId !== scope.appId || plan.environment !== scope.environment) {
      throw new PreflightError('scope_changed');
    }
    const snapshot = await this.repository.readSnapshot(plan.snapshotId);
    if (!snapshot || snapshot.incidentId !== plan.incidentId || snapshot.hash !== plan.snapshotHash) {
      throw new Error('Plan snapshot changed');
    }
    const existing = await Promise.all(plan.actions.map(action => this.repository.readAction(action.operationKey)));
    for (let index = 0; index < plan.actions.length; index++) {
      const action = plan.actions[index]!, row = existing[index];
      if (action.kind === 'verify_gate' && row?.status === 'verified' && row.planId === plan.id
          && row.incidentId === plan.incidentId && row.requestHash === action.requestHash) {
        await this.repository.releaseVerifiedOwnership(plan.incidentId,action.userId,this.now().toISOString());
      }
    }
    if (plan.policyRevision !== scope.policyRevision) throw new PreflightError('scope_changed');
    if (existing.every((row,index) => row && row.requestHash === plan.actions[index]?.requestHash
        && row.planId === plan.id && row.incidentId === plan.incidentId
        && ['verified','failed','blocked','awaiting_client_action'].includes(row.status))) {
      return plan.actions.map((action,index) => ({ operationKey:action.operationKey,status:existing[index]!.status }));
    }
    const byUser = new Map<string,RecoveryAction[]>();
    for (const action of plan.actions) byUser.set(action.userId,[...(byUser.get(action.userId) ?? []),action]);
    const byOperation = new Map(plan.actions.map((action,index) => [action.operationKey,existing[index]]));
    const terminal = (action:RecoveryAction): boolean => {
      const row = byOperation.get(action.operationKey);
      return !!row && row.planId === plan.id && row.incidentId === plan.incidentId
        && row.requestHash === action.requestHash && ['verified','failed','blocked','awaiting_client_action'].includes(row.status);
    };
    const unfinished = plan.targets.filter(target => !(byUser.get(target.userId) ?? []).every(terminal));
    const unwritten = unfinished.filter(target => {
      const write = byUser.get(target.userId)?.find(action => action.kind === 'resync_access');
      return !write || !byOperation.get(write.operationKey);
    });
    if (unwritten.length) {
      const users = new Set(unwritten.map(target => target.userId));
      const remaining:RecoveryPlan = { ...plan,targets:unwritten,actions:plan.actions.filter(action => users.has(action.userId)) };
      preflightPlan(remaining,scope,await this.observe([...users]),this.now());
    }
    await this.repository.acquirePlanOwnership(plan.incidentId,plan.appId,plan.environment,plan.id,saved.hash,
      unfinished.map(target => target.userId),this.now().toISOString());
    const results:{ operationKey:string; status:ActionStatus }[] = [];
    for (const target of plan.targets) {
      const actions = byUser.get(target.userId) ?? [];
      if (actions.every(terminal)) {
        for (const action of actions) {
          const status = byOperation.get(action.operationKey)!.status;
          results.push({ operationKey:action.operationKey,status });
        }
        continue;
      }
      const write = actions.find(action => action.kind === 'resync_access');
      if (!write || !byOperation.get(write.operationKey)) {
        const single:RecoveryPlan = { ...plan, targets:[target], actions };
        preflightPlan(single,scope,await this.observe([target.userId]),this.now());
      }
      if (write) {
        await this.repository.reserveAutomaticAttempt(plan.incidentId,plan.id,this.now().toISOString());
        const status = await this.apply(plan,write);
        results.push({ operationKey:write.operationKey,status });
        if (status !== 'verified') continue;
      }
      const probe = actions.find(action => action.kind === 'verify_gate');
      if (!probe) throw new Error('Plan verification missing');
      const current = (await this.observe([target.userId])).get(target.userId);
      this.checkProbeSource(plan,target,write,current);
      const status = await this.verify(plan,probe,target.entitlementHash,
        write?.kind === 'resync_access' ? write.request.entitlement.expires_at :
          current?.observation.entitlement?.expires_at,
        target.identityRevision,target.policyRevision);
      results.push({ operationKey:probe.operationKey,status });
      if (status === 'verified') await this.repository.releaseVerifiedOwnership(plan.incidentId,target.userId,this.now().toISOString());
    }
    return results;
  }

  private checkProbeSource(plan:RecoveryPlan, target:RecoveryTarget, write:RecoveryAction | undefined,
    current:CurrentTarget | undefined): void {
    const observation = current?.observation, entitlement = observation?.entitlement;
    const assessment = observation && classifyFulfillment({ ...observation,now:this.now() });
    if (!current || !observation || !entitlement || !assessment
        || !['healthy','confirmed','potential'].includes(assessment.status) || observation.ownedByOtherIncident
        || observation.appId !== plan.appId || observation.userId !== target.userId
        || current.customerId !== target.customerId || current.identityRevision !== target.identityRevision
        || current.policyRevision !== target.policyRevision || current.store !== target.store
        || current.sourceEnvironment !== target.sourceEnvironment || current.sourceFingerprint !== target.sourceFingerprint
        || entitlement.transaction_id !== target.transactionId || entitlement.entitlement_hash !== target.entitlementHash
        || entitlement.source_fingerprint !== target.sourceFingerprint || entitlement.source_environment !== target.sourceEnvironment
        || entitlement.store !== target.store
        || (write?.kind === 'resync_access' && (entitlement.product_id !== write.request.entitlement.product_id
          || entitlement.expires_at !== write.request.entitlement.expires_at
          || (entitlement.original_transaction_id ?? null) !== (write.request.entitlement.original_transaction_id ?? null)))) {
      throw new Error('Fresh source or identity changed before gate verification');
    }
  }

  private async apply(plan:RecoveryPlan, action:RecoveryAction): Promise<ActionStatus> {
    if (action.kind !== 'resync_access') throw new Error('Invalid write action');
    const now = this.now().toISOString();
    const record = await this.repository.recordAction(action.operationKey,plan.incidentId,plan.id,action.request,now);
    if (record.status === 'verified' || record.status === 'failed' || record.status === 'blocked'
        || record.status === 'awaiting_client_action') return record.status;
    if (record.created) {
      try { await this.lumen.resyncAccess(action.request); }
      catch (error) {
        if (error instanceof LumenAdapterError && error.outcome === 'rejected') {
          await this.repository.finishAction(action.operationKey,'blocked',{ reason:'client_rejected_or_unavailable' },this.now().toISOString());
          return (await this.repository.readAction(action.operationKey))?.status ?? 'unknown_outcome';
        }
      }
    }
    return this.resolveWrite(action.request);
  }

  /** Safe to call after restart even when the original plan has expired. */
  async resolveWrite(request:ResyncRequest): Promise<ActionStatus> {
    const record = await this.repository.readAction(request.operation_key);
    if (!record) throw new Error('Action unavailable');
    if (record.requestHash !== semanticDigest(request)) throw new Error('Action payload does not match the recorded operation');
    if (record.status !== 'accepted' && record.status !== 'unknown_outcome') return record.status;
    try {
      const outcome = await this.lumen.readAction(request.operation_key);
      const access = await this.lumen.readAccess(request.user_id);
      if (outcome?.schema_version === 2 && outcome.user_id === request.user_id
          && outcome.processing_id === request.processing_id && outcome.trace_id === request.trace_id
          && typeof outcome.projection_revision === 'number' && outcome.projection_revision > request.expected_projection_revision
          && access.active === true && access.expires_at === request.entitlement.expires_at
          && access.identity_revision === request.expected_identity_revision
          && access.policy_revision === request.expected_policy_revision
          && access.entitlement_hash === request.entitlement.entitlement_hash) {
        await this.repository.finishAction(request.operation_key,'verified',
          { evidence_ref:`lumen-action:${request.operation_key}` },this.now().toISOString());
        return (await this.repository.readAction(request.operation_key))?.status ?? 'unknown_outcome';
      }
    } catch { /* A failed readback cannot establish whether the write took effect. */ }
    await this.repository.finishAction(request.operation_key,'unknown_outcome',
      { reason:'readback_unavailable_or_mismatched' },this.now().toISOString());
    return (await this.repository.readAction(request.operation_key))?.status ?? 'unknown_outcome';
  }

  private async verify(plan:RecoveryPlan, action:RecoveryAction, entitlementHash:string, expiresAt:string | undefined,
    identityRevision:number, policyRevision:number): Promise<ActionStatus> {
    const record = await this.repository.recordAction(action.operationKey,plan.incidentId,plan.id,action.request,this.now().toISOString());
    if (record.status === 'verified' || record.status === 'failed' || record.status === 'blocked'
        || record.status === 'awaiting_client_action') return record.status;
    try {
      const access = await this.lumen.readAccess(action.userId);
      const gate = await this.lumen.probeAccess(action.userId);
      const verified = !!expiresAt && access.active === true && access.expires_at === expiresAt
        && access.entitlement_hash === entitlementHash && gate.allowed === true
        && access.identity_revision === identityRevision && access.policy_revision === policyRevision
        && gate.identity_revision === identityRevision && gate.policy_revision === policyRevision
        && gate.active === true && gate.expires_at === expiresAt && gate.entitlement_hash === entitlementHash
        && gate.projection_revision === access.projection_revision && gate.cache_revision === access.projection_revision;
      const status = verified ? 'verified' : 'failed';
      await this.repository.finishAction(action.operationKey,status,
        verified ? { evidence_ref:`lumen-gate:${action.operationKey}` } :
          { reason:'projection_or_gate_mismatch',evidence_ref:`lumen-gate:${action.operationKey}` },this.now().toISOString());
      return (await this.repository.readAction(action.operationKey))?.status ?? status;
    } catch {
      await this.repository.finishAction(action.operationKey,'unknown_outcome',{ reason:'gate_readback_unavailable' },this.now().toISOString());
      return (await this.repository.readAction(action.operationKey))?.status ?? 'unknown_outcome';
    }
  }
}
