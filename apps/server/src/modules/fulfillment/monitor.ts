import { randomUUID } from 'node:crypto';
import { LumenAdapter } from '../client/lumen-adapter.js';
import { ProviderAdapter } from '../source/provider-adapter.js';
import { Reporting, type Provenance } from '../reporting/export.js';
import { RecoveryRepository } from '../recovery/repository.js';
import { RecoveryExecution } from '../recovery/execution.js';
import { ExternalResolution } from '../recovery/external-resolution.js';
import { prepareRecovery } from '../recovery/preview.js';
import { PreflightError, type CurrentTarget, type RecoveryPlan } from '../recovery/preflight.js';
import { parseTimestamp } from '../../infrastructure/time.js';
import { Expectations } from './expectations.js';
import { FulfillmentRegistry } from './registry.js';
import { persistScan } from './persist-scan.js';
import { scanFulfillments, type ScanResult } from './scan.js';
import { classifyFulfillment } from './classification.js';

export interface MonitorScope { appId:string; environment:string; sourceEnvironment:string; policyRevision:number; provenance:Provenance }

/** Proactive diagnosis and policy-authorized recovery, with all source writes excluded. */
export class FulfillmentMonitor {
  private cache = new Map<string,Record<string,unknown>>();
  private running:Promise<void> | null = null;
  private lastError:string | null = null;
  private lastSourceAt:number | null = null;
  private sourceReady = false;
  private readonly external:ExternalResolution;

  constructor(private readonly scope:MonitorScope, private readonly lumen:LumenAdapter, private readonly provider:ProviderAdapter,
    private readonly expectations:Expectations, private readonly registry:FulfillmentRegistry,
    private readonly repository:RecoveryRepository, private readonly reporting:Reporting,
    private readonly clock:() => Date = () => new Date()) {
    this.external = new ExternalResolution(repository,lumen,clock);
  }

  status():{ lastError:string | null; cachedAccounts:number; sourceReady:boolean; sourceFresh:boolean } {
    const age = this.lastSourceAt === null ? Infinity : this.clock().getTime() - this.lastSourceAt;
    return { lastError:this.lastError,cachedAccounts:this.cache.size,sourceReady:this.sourceReady,
      sourceFresh:this.sourceReady && age >= 0 && age <= 120_000 };
  }

  async pass(readSource:boolean):Promise<void> {
    if (this.running) return this.running;
    this.lastError = null;
    this.running = this.runPass(readSource).catch(() => { this.lastError = 'monitor_unavailable'; if (readSource) this.sourceReady = false; });
    try { await this.running; } finally { this.running = null; }
  }

  private async owned(userId:string,incidentId?:string):Promise<boolean> {
    const [claim,action] = await Promise.all([
      this.registry.ownedByAnother(this.scope.appId,this.scope.environment,userId,incidentId),
      this.repository.ownedByAnother(this.scope.appId,this.scope.environment,userId,incidentId)
    ]);
    return claim || action;
  }

  private async scan(reader:Pick<ProviderAdapter,'profile'>, users?:readonly string[], incidentId?:string):Promise<ScanResult> {
    return scanFulfillments(this.lumen,reader,this.expectations,this.scope.appId,this.scope.sourceEnvironment,
      this.clock,userId => this.owned(userId,incidentId),users ? new Set(users) : undefined,
      (userId,entitlement) => this.registry.wasVerified({ app:this.scope.appId,environment:this.scope.environment,
        store:entitlement.store,transactionId:entitlement.transaction_id,userId,accessLevel:'premium' },
        entitlement.source_fingerprint,entitlement.entitlement_hash));
  }

  private remember(scan:ScanResult):void {
    const next = new Map<string,Record<string,unknown>>();
    for (const observation of scan.observations) {
      const { profile,provider,entitlement } = observation;
      if (!profile || !provider) continue;
      next.set(observation.userId,{ ...profile,provider_customer_id:provider.provider_customer_id,
        source_fingerprint:entitlement?.source_fingerprint ?? null,entitlement });
    }
    this.cache = next;
  }

  private async persist(scan:ScanResult):Promise<{ identityHash:string; userId:string; episodeNo:number }[]> {
    return persistScan(this.registry,scan,this.scope.appId,this.scope.environment,
      (incidentId,current) => this.external.resolve(incidentId,this.scope.appId,this.scope.environment,current));
  }

  private async runPass(readSource:boolean):Promise<void> {
    if (!readSource && !this.cache.size) return;
    const reader = readSource ? this.provider : { profile:async (userId:string) => {
      const profile = this.cache.get(userId);
      if (!profile) throw new Error('Source observation unavailable');
      return profile;
    } };
    const scan = await this.scan(reader);
    if (readSource) this.remember(scan);
    await this.reporting.updateCoverage(scan.coverage,this.scope.provenance);
    const pending = await this.persist(scan);
    if (readSource) {
      this.sourceReady = !scan.coverage.sourceStopped && scan.coverage.sourceRead === scan.coverage.registered;
      if (this.sourceReady) this.lastSourceAt = this.clock().getTime();
    }
    if (pending.length) {
      await this.registry.claimIncident(randomUUID(),this.scope.appId,this.scope.environment,
        pending.map(item => item.identityHash),this.clock().toISOString());
    }
    const claims = await this.registry.openClaims(this.scope.appId,this.scope.environment);
    const incidents = new Map<string,string[]>();
    for (const claim of claims) incidents.set(claim.incidentId,[...(incidents.get(claim.incidentId) ?? []),claim.userId]);
    for (const [incidentId,users] of incidents) {
      try { await this.processIncident(incidentId,[...new Set(users)]); }
      catch { this.lastError = 'incident_processing_failed'; }
    }
  }

  private async processIncident(incidentId:string, users:string[]):Promise<void> {
    const observe = async (ids:readonly string[]):Promise<ReadonlyMap<string,CurrentTarget>> =>
      (await this.scan(this.provider,ids,incidentId)).current;
    const executor = new RecoveryExecution(this.repository,this.lumen,observe,this.clock);
    for (const request of await this.repository.pendingWriteRequests(incidentId)) await executor.resolveWrite(request);
    const latest = await this.repository.latestPlan(incidentId);
    if (latest) {
      const states = await Promise.all(latest.plan.actions.map(action => this.repository.readAction(action.operationKey)));
      const failure = states.some(state => state && ['failed','blocked','awaiting_client_action'].includes(state.status));
      const unexpired = this.clock().getTime() < parseTimestamp(latest.plan.expiresAt);
      if (!failure && unexpired) {
        if (!await this.repository.hasApproval(latest.plan.id,latest.hash)) {
          await this.repository.approve(randomUUID(),latest.plan.id,latest.hash,'automatic-policy-v2',this.clock().toISOString());
        }
        try {
          await executor.execute(latest.plan.id,this.scope);
          const pendingUsers = await Promise.all(users.map(userId => this.repository.hasPendingOwnVerification(incidentId,userId)));
          const gateActions = latest.plan.actions.filter(action => action.kind === 'verify_gate');
          const gateStates = await Promise.all(gateActions.map(action => this.repository.readAction(action.operationKey)));
          const covered = new Set(gateActions.filter((_,index) => !gateStates[index]
            || ['accepted','unknown_outcome'].includes(gateStates[index]!.status)).map(action => action.userId));
          if (!users.some((userId,index) => pendingUsers[index] && !covered.has(userId))) return;
        }
        catch (error) { if (!(error instanceof PreflightError)) throw error; }
      }
    }
    const allowWriteRetry = await this.repository.automaticAttemptCount(incidentId) < 2;
    const fresh = await this.scan(this.provider,users,incidentId);
    await this.persist(fresh);
    const eligible:string[] = [], modes = new Map<string,'resync' | 'probe'>();
    for (const userId of users) {
      if (await this.repository.hasAmbiguousWrite(incidentId,userId)) continue;
      const current = fresh.current.get(userId);
      if (!current) continue;
      const assessment = classifyFulfillment({ ...current.observation,now:this.clock() });
      if (assessment.eligible && allowWriteRetry) { eligible.push(userId); modes.set(userId,'resync'); }
      else if (assessment.status === 'healthy' && await this.repository.hasPendingOwnVerification(incidentId,userId)) {
        eligible.push(userId); modes.set(userId,'probe');
      }
    }
    if (!eligible.length) return;
    const preview = prepareRecovery(this.scope.appId,fresh.current,eligible,this.clock(),modes);
    const createdAt = this.clock(), planId = randomUUID(), snapshotId = randomUUID();
    const snapshotHash = await this.repository.saveSnapshot(snapshotId,incidentId,{ appId:this.scope.appId,
      environment:this.scope.environment,targets:preview.targets,evidence:preview.evidence,coverage:fresh.coverage },createdAt.toISOString());
    const plan:RecoveryPlan = { id:planId,incidentId,snapshotId,snapshotHash,appId:this.scope.appId,
      environment:this.scope.environment,policyRevision:this.scope.policyRevision,createdAt:createdAt.toISOString(),
      expiresAt:new Date(createdAt.getTime()+300_000).toISOString(),targets:preview.targets,actions:preview.actions };
    const hash = await this.repository.savePlan(planId,incidentId,snapshotId,plan,plan.createdAt,plan.expiresAt);
    await this.repository.approve(randomUUID(),planId,hash,'automatic-policy-v2',this.clock().toISOString());
    await executor.execute(planId,this.scope);
  }
}
