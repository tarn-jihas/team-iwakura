import { randomUUID } from 'node:crypto';
import { stat } from 'node:fs/promises';
import { semanticDigest, semanticJson } from '../../infrastructure/json.js';
import { parseTimestamp } from '../../infrastructure/time.js';
import { SQLiteStorage, type Statement } from '../../infrastructure/sqlite.js';
import { LumenAdapter, LumenAdapterError, type DemoInjection } from '../client/lumen-adapter.js';
import { FulfillmentMonitor } from '../fulfillment/monitor.js';
import { FulfillmentRegistry } from '../fulfillment/registry.js';
import { RecoveryRepository } from '../recovery/repository.js';
import { ProviderAdapter } from '../source/provider-adapter.js';

export type SimulationAction = 'start' | 'once' | 'bootstrap' | 'continuous' | 'stop';
export type SimulationStatusValue = 'idle' | 'queued' | 'running' | 'waiting' | 'completed' | 'stopped' | 'failed';
export interface SimulationScope { appId:string; environment:string; sourceEnvironment:string }
export interface SimulationCommand { action:SimulationAction; operation_key?:string }
export interface SimulationSummary {
  status:SimulationStatusValue;
  available:boolean;
  continuous:boolean;
  waiting_reason:string | null;
  completed:number;
  total:number;
  error:string | null;
  job_id:string | null;
  last_result?:Record<string,unknown> | null;
}
export interface SimulationCommandResult extends SimulationSummary { duplicate:boolean }

export class SimulationError extends Error {
  constructor(readonly statusCode:number, message:string) { super(message); }
}

export interface SimulationRunnerOptions {
  storage:SQLiteStorage;
  engineDatabasePath:string;
  scope:SimulationScope;
  lumen:Pick<LumenAdapter,'listAccounts' | 'readAccess' | 'collectorCoverage' | 'injectDemo' | 'readInjection'>;
  provider:Pick<ProviderAdapter,'accounts' | 'profiles' | 'status'>;
  monitor:Pick<FulfillmentMonitor,'pass' | 'status'>;
  registry:Pick<FulfillmentRegistry,'list' | 'openClaims' | 'ownedByAnother'>;
  repository:Pick<RecoveryRepository,'ownedByAnother' | 'latestPlan' | 'readAction' | 'automaticAttemptCount'>;
  handlerVersion:string;
  configVersion:string;
  clock?:() => Date;
  sleep?:(milliseconds:number) => Promise<void>;
  wakeMonitor?:() => void | Promise<void>;
}

type JobRow = {
  job_id:string; operation_key:string; request_hash:string; action:Exclude<SimulationAction,'stop'>;
  status:SimulationStatusValue; continuous:number; stop_requested:number; completed:number; total:number;
  waiting_reason:string | null; error:string | null; last_result_json:string | null;
};
type EpisodeRow = {
  job_id:string; cycle_no:number; operation_key:string; request_hash:string; request_json:string;
  selected_json:string; user_ids_json:string; fault_kind:DemoInjection['fault_kind'];
  repair_failure_user:string; injection_status:'intent' | 'requested' | 'injected' | 'unknown' | 'rejected';
  injection_json:string | null; result_json:string | null; updated_at:string;
};
type SelectedAccount = { user_id:string; transaction_id:string; entitlement_hash:string; store:string;
  expires_at:string; identity_revision:number; policy_revision:number };
type AccountPage = { items:Record<string,unknown>[]; total:number; next_cursor:string | null };
type ProviderAccountPage = { items:Record<string,unknown>[]; total:number; next_cursor:string | null };
type SourcePage = { items:Record<string,unknown>[]; total:number; next_cursor:string | null };

const validId = (value:unknown):value is string => typeof value === 'string' && value.length > 0
  && value.length <= 256 && value.trim() === value && !/[\u0000-\u001f\u007f]/.test(value);
const isRecord = (value:unknown):value is Record<string,unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const delay = (milliseconds:number):Promise<void> => new Promise(resolve => setTimeout(resolve,milliseconds));
const RUNNING = "status IN ('queued','running','waiting')";
const MAX_DB_BYTES = 512 * 1024 * 1024;
const MAX_PENDING_OUTBOX = 800;

/**
 * Persists a demo episode before calling Lumen. It chooses candidates from current provider rights and
 * current Lumen gates; injected IDs and fault metadata are never passed into the monitor.
 */
export class SimulationRunner {
  private readonly clock:() => Date;
  private readonly sleep:(milliseconds:number) => Promise<void>;
  private readonly wake:() => void | Promise<void>;
  private readonly tasks = new Map<string,Promise<void>>();
  private closed = false;

  private constructor(private readonly options:SimulationRunnerOptions) {
    this.clock = options.clock ?? (() => new Date());
    this.sleep = options.sleep ?? delay;
    this.wake = options.wakeMonitor ?? (() => { void options.monitor.pass(true); });
    if (![options.scope.appId,options.scope.environment,options.scope.sourceEnvironment,
      options.handlerVersion,options.configVersion].every(validId) || !validId(options.engineDatabasePath)) {
      throw new Error('Invalid simulation configuration');
    }
  }

  static async create(options:SimulationRunnerOptions):Promise<SimulationRunner> {
    const runner = new SimulationRunner(options);
    await runner.initialize();
    return runner;
  }

  private async initialize():Promise<void> {
    const statements:Statement[] = [
      { mode:'run',sql:`CREATE TABLE IF NOT EXISTS simulation_jobs (
        job_id TEXT PRIMARY KEY, operation_key TEXT NOT NULL UNIQUE, request_hash TEXT NOT NULL,
        action TEXT NOT NULL CHECK(action IN ('start','once','bootstrap','continuous')),
        status TEXT NOT NULL CHECK(status IN ('queued','running','waiting','completed','stopped','failed')),
        continuous INTEGER NOT NULL CHECK(continuous IN (0,1)), stop_requested INTEGER NOT NULL DEFAULT 0,
        completed INTEGER NOT NULL DEFAULT 0, total INTEGER NOT NULL, waiting_reason TEXT, error TEXT,
        last_result_json TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)` },
      { mode:'run',sql:`CREATE TABLE IF NOT EXISTS simulation_episodes (
        job_id TEXT NOT NULL REFERENCES simulation_jobs(job_id), cycle_no INTEGER NOT NULL,
        operation_key TEXT NOT NULL UNIQUE, request_hash TEXT NOT NULL, request_json TEXT NOT NULL,
        selected_json TEXT NOT NULL, user_ids_json TEXT NOT NULL, fault_kind TEXT NOT NULL,
        repair_failure_user TEXT NOT NULL,
        injection_status TEXT NOT NULL CHECK(injection_status IN ('intent','requested','injected','unknown','rejected')),
        injection_json TEXT, result_json TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
        PRIMARY KEY(job_id,cycle_no))` },
      { mode:'run',sql:`UPDATE simulation_jobs SET status='stopped',stop_requested=1,
        waiting_reason='interrupted_by_server_restart',error=COALESCE(error,'interrupted_by_server_restart'),updated_at=? WHERE ${RUNNING}`,
        params:[this.clock().toISOString()] }
    ];
    await this.options.storage.transaction(statements);
  }

  /** Current concise simulation state for the recovery monitor. */
  async status():Promise<SimulationSummary> {
    const row = await this.options.storage.statement({ mode:'get',sql:'SELECT * FROM simulation_jobs ORDER BY rowid DESC LIMIT 1' }) as JobRow | null;
    if (!row) return { status:'idle',available:true,continuous:false,waiting_reason:null,completed:0,total:0,
      error:null,job_id:null,last_result:null };
    let lastResult:Record<string,unknown> | null = null;
    if (row.last_result_json) {
      const parsed:unknown = JSON.parse(row.last_result_json);
      if (isRecord(parsed)) lastResult = parsed;
    }
    return { status:row.status,available:true,continuous:!!row.continuous,waiting_reason:row.waiting_reason,
      completed:row.completed,total:row.total,error:row.error,job_id:row.job_id,last_result:lastResult };
  }

  /** Starts, queries through status(), or stops the one active simulation job. */
  async command(input:unknown):Promise<SimulationCommandResult> {
    if (this.closed) throw new SimulationError(503,'Simulation runner is closed');
    if (!isRecord(input) || !['start','once','bootstrap','continuous','stop'].includes(String(input.action))) {
      throw new SimulationError(400,'Invalid simulation action');
    }
    const action = input.action as SimulationAction;
    if (action === 'stop') {
      if (Object.keys(input).length !== 1) throw new SimulationError(400,'Stop accepts only an action');
      const now = this.clock().toISOString();
      const [active] = await this.options.storage.transaction([
        { mode:'get',sql:`SELECT job_id,status FROM simulation_jobs WHERE ${RUNNING} ORDER BY rowid DESC LIMIT 1` },
        { mode:'run',sql:`UPDATE simulation_jobs SET stop_requested=1,updated_at=? WHERE ${RUNNING}`,params:[now] }
      ]) as [{ job_id:string; status:SimulationStatusValue } | null,unknown];
      if (!active) return { ...(await this.status()),duplicate:false };
      const status = await this.status();
      return { ...status,job_id:active.job_id,duplicate:false };
    }
    if (Object.keys(input).length !== 2 || !validId(input.operation_key) || input.operation_key.length > 128) {
      throw new SimulationError(400,'Simulation action requires an operation_key');
    }
    const operationKey = input.operation_key;
    const requestHash = semanticDigest({ action,operation_key:operationKey });
    const jobId = `simulation-${randomUUID()}`, at = this.clock().toISOString();
    const [previous,active,inserted,current] = await this.options.storage.transaction([
      { mode:'get',sql:'SELECT * FROM simulation_jobs WHERE operation_key=?',params:[operationKey] },
      { mode:'get',sql:`SELECT job_id FROM simulation_jobs WHERE ${RUNNING} ORDER BY rowid DESC LIMIT 1` },
      { mode:'run',sql:`INSERT INTO simulation_jobs(job_id,operation_key,request_hash,action,status,continuous,
        stop_requested,completed,total,waiting_reason,error,last_result_json,created_at,updated_at)
        SELECT ?,?,?,?,'queued',?,0,0,?,NULL,NULL,NULL,?,? WHERE NOT EXISTS
        (SELECT 1 FROM simulation_jobs WHERE ${RUNNING}) ON CONFLICT(operation_key) DO NOTHING`,
        params:[jobId,operationKey,requestHash,action,Number(action === 'continuous'),action === 'continuous' ? 0 : 1,at,at] },
      { mode:'get',sql:'SELECT * FROM simulation_jobs WHERE operation_key=?',params:[operationKey] }
    ]) as [JobRow | null,{ job_id:string } | null,{ changes:number | bigint },JobRow | null];
    if (previous) {
      if (previous.request_hash !== requestHash) throw new SimulationError(409,'Operation key is already bound to different input');
      return { ...this.toSummary(previous),duplicate:true };
    }
    if (!inserted.changes || !current) {
      if (active) throw new SimulationError(409,'A simulation is already active');
      throw new SimulationError(409,'Simulation request was not accepted');
    }
    this.launch(current.job_id);
    return { ...this.toSummary(current),duplicate:false };
  }

  private toSummary(row:JobRow):SimulationSummary {
    let lastResult:Record<string,unknown> | null = null;
    if (row.last_result_json) {
      const parsed:unknown = JSON.parse(row.last_result_json);
      if (isRecord(parsed)) lastResult = parsed;
    }
    return { status:row.status,available:true,continuous:!!row.continuous,waiting_reason:row.waiting_reason,
      completed:row.completed,total:row.total,error:row.error,job_id:row.job_id,last_result:lastResult };
  }

  private launch(jobId:string):void {
    const task = Promise.resolve().then(() => this.run(jobId)).catch(async () => {
      await this.updateJob(jobId,{ status:'failed',error:'simulation_failed',waiting_reason:null }).catch(() => undefined);
    }).finally(() => this.tasks.delete(jobId));
    this.tasks.set(jobId,task);
  }

  private async run(jobId:string):Promise<void> {
    await this.updateJob(jobId,{ status:'running',waiting_reason:null,error:null });
    const initial = await this.job(jobId);
    if (!initial) return;
    if (initial.action === 'bootstrap') {
      await this.wake();
      await this.options.monitor.pass(true);
    }
    while (!await this.stopRequested(jobId)) {
      const row = await this.job(jobId);
      if (!row) return;
      if (!await this.waitForReadiness(jobId)) break;
      const cycle = row.completed + 1;
      let episode = await this.episode(jobId,cycle);
      if (!episode) {
        let selected:SelectedAccount[];
        try { selected = await this.healthyCandidates(row.operation_key,cycle); }
        catch {
          await this.wait(jobId,'source_or_client_unavailable');
          await this.sleep(1000);
          continue;
        }
        if (selected.length < 2) {
          await this.wait(jobId,'fewer_than_two_healthy_accounts');
          await this.sleep(1000);
          continue;
        }
        episode = await this.persistEpisode(row,cycle,selected);
      }
      const injection = await this.ensureInjected(episode);
      if (!injection) {
        await this.wait(jobId,'injection_outcome_unknown');
        await this.sleep(1000);
        continue;
      }
      const confirmedEpisode = await this.episode(jobId,cycle);
      if (!confirmedEpisode || confirmedEpisode.injection_status !== 'injected') {
        await this.wait(jobId,'injection_outcome_unknown');
        await this.sleep(1000);
        continue;
      }
      await this.wake();
      const result = await this.waitForOutcomes(jobId,confirmedEpisode);
      if (!result) break;
      await this.finishEpisode(jobId,episode,result);
      const current = await this.job(jobId);
      if (!current || !current.continuous || current.stop_requested) break;
      await this.waitBetweenEpisodes(jobId);
    }
    const final = await this.job(jobId);
    if (final && final.status !== 'failed' && final.status !== 'completed') {
      await this.updateJob(jobId,{ status:'stopped',waiting_reason:null });
    }
  }

  private async waitForReadiness(jobId:string):Promise<boolean> {
    while (!await this.stopRequested(jobId)) {
      const reason = await this.waitReason();
      if (!reason) { await this.updateJob(jobId,{ status:'running',waiting_reason:null }); return true; }
      await this.wait(jobId,reason);
      if (reason === 'source_gap' || reason === 'source_status_unavailable') await Promise.resolve(this.wake()).catch(() => undefined);
      await this.sleep(500);
    }
    return false;
  }

  private async waitReason():Promise<string | null> {
    let source:Record<string,unknown>;
    try { source = await this.options.provider.status(); }
    catch { return 'source_status_unavailable'; }
    if (typeof source.not_before_ms !== 'number' || !Number.isFinite(source.not_before_ms)) return 'source_status_unavailable';
    const now = this.clock().getTime();
    if (source.not_before_ms > now) return 'source_cooldown';
    const monitor = this.options.monitor.status();
    if (!monitor.sourceReady || !monitor.sourceFresh) return 'source_gap';
    let coverage:Record<string,unknown>;
    try { coverage = await this.options.lumen.collectorCoverage(); }
    catch { return 'collector_status_unavailable'; }
    if (typeof coverage.queued !== 'number' || !Number.isSafeInteger(coverage.queued)) return 'collector_status_unavailable';
    if (coverage.queued > MAX_PENDING_OUTBOX) return 'outbox_backpressure';
    let bytes = 0;
    for (const [index,path] of [this.options.engineDatabasePath,`${this.options.engineDatabasePath}-wal`].entries()) {
      try { bytes += (await stat(path)).size; }
      catch (error) {
        if (index === 1 && (error as NodeJS.ErrnoException).code === 'ENOENT') continue;
        return 'engine_storage_status_unavailable';
      }
    }
    if (bytes >= MAX_DB_BYTES) return 'engine_storage_limit';
    return null;
  }

  private async healthyCandidates(operationKey:string,cycle:number):Promise<SelectedAccount[]> {
    const [accounts,providerAccounts,profiles,claims] = await Promise.all([
      this.allAccounts(),this.allProviderAccounts(),this.allProfiles(),
      this.options.registry.openClaims(this.options.scope.appId,this.options.scope.environment)
    ]);
    const accountByUser = new Map(accounts.map(account => [String(account.user_id),account]));
    const officialIds = new Set(providerAccounts.filter(account => account.identity_status === 'mapped'
      && ['official_hackathon_synthetic','official_synthetic_seed'].includes(String(account.provenance))
      && account.provider_customer_id === account.user_id).map(account => String(account.user_id)));
    const excluded = new Set(claims.map(claim => claim.userId));
    const now = this.clock().getTime(), candidates:SelectedAccount[] = [];
    for (const profile of profiles) {
      const userId = profile.user_id, entitlement = profile.entitlement;
      if (!validId(userId) || !officialIds.has(userId) || !isRecord(entitlement) || excluded.has(userId)
          || profile.status !== 'active' || profile.identity_match !== true || profile.app_id !== this.options.scope.appId
          || profile.provider_customer_id !== userId || entitlement.app_id !== this.options.scope.appId
          || entitlement.user_id !== userId || entitlement.provider_customer_id !== userId
          || entitlement.source_environment !== this.options.scope.sourceEnvironment
          || !validId(entitlement.transaction_id) || entitlement.is_in_grace_period !== false
          || !validId(entitlement.entitlement_hash) || !validId(entitlement.starts_at) || !validId(entitlement.expires_at)) continue;
      const start = parseTimestamp(entitlement.starts_at), expires = parseTimestamp(entitlement.expires_at);
      const observed = parseTimestamp(String(profile.observed_at ?? ''));
      if (!Number.isFinite(start) || !Number.isFinite(expires) || !Number.isFinite(observed)
          || start > now || now >= expires || observed > now || now - observed > 300_000) continue;
      const account = accountByUser.get(userId);
      if (!account || account.provider_customer_id !== userId || account.identity_status !== 'mapped'
          || account.policy_enabled !== true || !revision(account.identity_revision)
          || !revision(account.policy_revision) || !revision(account.projection_revision)) continue;
      if (await this.options.registry.ownedByAnother(this.options.scope.appId,this.options.scope.environment,userId)
          || await this.options.repository.ownedByAnother(this.options.scope.appId,this.options.scope.environment,userId)) continue;
      let access:Record<string,unknown>;
      try { access = await this.options.lumen.readAccess(userId); } catch { continue; }
      if (access.user_id !== userId || access.identity_revision !== account.identity_revision
          || access.policy_revision !== account.policy_revision || access.projection_revision !== account.projection_revision
          || access.active !== true || access.allowed !== true || access.expires_at !== entitlement.expires_at
          || access.entitlement_hash !== entitlement.entitlement_hash) continue;
      if (!validId(entitlement.store)) continue;
      candidates.push({ user_id:userId,transaction_id:entitlement.transaction_id,entitlement_hash:entitlement.entitlement_hash,
        store:entitlement.store,expires_at:entitlement.expires_at,identity_revision:account.identity_revision,
        policy_revision:account.policy_revision });
    }
    const seeded = candidates.sort((a,b) => {
      const left = semanticDigest([operationKey,cycle,a.user_id]), right = semanticDigest([operationKey,cycle,b.user_id]);
      return left.localeCompare(right) || a.user_id.localeCompare(b.user_id);
    }).slice(0,24);
    return seeded;
  }

  private async allAccounts():Promise<Record<string,unknown>[]> {
    const items:Record<string,unknown>[] = [], seen = new Set<string>(), cursors = new Set<string>();
    let cursor:string | null = null, total:number | null = null;
    do {
      const page = await this.options.lumen.listAccounts(cursor,500) as AccountPage;
      if (!Array.isArray(page.items) || !Number.isSafeInteger(page.total) || page.total < 0
          || (total !== null && total !== page.total)) throw new Error('Incomplete Lumen account registry');
      total = page.total;
      for (const item of page.items) {
        if (!isRecord(item) || !validId(item.user_id) || seen.has(item.user_id)) throw new Error('Invalid Lumen account registry');
        seen.add(item.user_id); items.push(item);
      }
      cursor = page.next_cursor;
      if (cursor !== null && (!/^\d+$/.test(cursor) || cursors.has(cursor))) throw new Error('Invalid Lumen cursor');
      if (cursor !== null) cursors.add(cursor);
    } while (cursor !== null);
    if (items.length !== total) throw new Error('Incomplete Lumen account registry');
    return items;
  }

  private async allProfiles():Promise<Record<string,unknown>[]> {
    const items:Record<string,unknown>[] = [], seen = new Set<string>(), cursors = new Set<string>();
    let cursor:string | null = null, total:number | null = null;
    do {
      const page = await this.options.provider.profiles(cursor,500) as SourcePage;
      if (!Array.isArray(page.items) || !Number.isSafeInteger(page.total) || page.total < 0
          || (total !== null && total !== page.total)) throw new Error('Incomplete provider profile registry');
      total = page.total;
      for (const item of page.items) {
        if (!isRecord(item) || !validId(item.user_id) || seen.has(item.user_id)) throw new Error('Invalid provider profile registry');
        seen.add(item.user_id); items.push(item);
      }
      cursor = page.next_cursor;
      if (cursor !== null && (!/^\d+$/.test(cursor) || cursors.has(cursor))) throw new Error('Invalid provider cursor');
      if (cursor !== null) cursors.add(cursor);
    } while (cursor !== null);
    if (items.length !== total) throw new Error('Incomplete provider profile registry');
    return items;
  }

  private async allProviderAccounts():Promise<Record<string,unknown>[]> {
    const items:Record<string,unknown>[] = [], seen = new Set<string>(), cursors = new Set<string>();
    let cursor:string | null = null, total:number | null = null;
    do {
      const page = await this.options.provider.accounts(cursor,500) as ProviderAccountPage;
      if (!Array.isArray(page.items) || !Number.isSafeInteger(page.total) || page.total < 0
          || (total !== null && total !== page.total)) throw new Error('Incomplete provider account registry');
      total = page.total;
      for (const item of page.items) {
        if (!isRecord(item) || !validId(item.user_id) || seen.has(item.user_id)) throw new Error('Invalid provider account registry');
        seen.add(item.user_id); items.push(item);
      }
      cursor = page.next_cursor;
      if (cursor !== null && (!/^\d+$/.test(cursor) || cursors.has(cursor))) throw new Error('Invalid provider account cursor');
      if (cursor !== null) cursors.add(cursor);
    } while (cursor !== null);
    if (items.length !== total) throw new Error('Incomplete provider account registry');
    return items;
  }

  private async persistEpisode(job:JobRow,cycle:number,selected:SelectedAccount[]):Promise<EpisodeRow> {
    const operationKey = `simulation:${semanticDigest([job.operation_key,cycle])}`;
    const faultKinds:DemoInjection['fault_kind'][] = ['stale_cache','missed_projection','out_of_order'];
    const seed = semanticDigest([job.operation_key,cycle,'fault']);
    const faultKind = faultKinds[Number.parseInt(seed.slice(0,8),16) % faultKinds.length]!;
    const injection:DemoInjection = { user_ids:selected.map(item => item.user_id),handler_version:this.options.handlerVersion,
      config_version:this.options.configVersion,occurred_at:this.clock().toISOString(),fault_kind:faultKind,
      operation_key:operationKey,repair_failure_user:selected[0]!.user_id };
    const requestJson = semanticJson(injection), requestHash = semanticDigest({
      userIds:injection.user_ids,handlerVersion:injection.handler_version,configVersion:injection.config_version,
      occurredAt:injection.occurred_at,faultKind:injection.fault_kind,repairFailureUser:injection.repair_failure_user
    });
    const at = this.clock().toISOString();
    await this.options.storage.transaction([
      { mode:'run',sql:`INSERT INTO simulation_episodes(job_id,cycle_no,operation_key,request_hash,request_json,
        selected_json,user_ids_json,fault_kind,repair_failure_user,injection_status,injection_json,result_json,created_at,updated_at)
        VALUES(?,?,?,?,?,?,?,?,?,'intent',NULL,NULL,?,?)`,
        params:[job.job_id,cycle,operationKey,requestHash,requestJson,semanticJson(selected),semanticJson(injection.user_ids),
          faultKind,selected[0]!.user_id,at,at] },
      { mode:'run',sql:'UPDATE simulation_jobs SET waiting_reason=NULL,status=\'running\',updated_at=? WHERE job_id=?',params:[at,job.job_id] }
    ]);
    const row = await this.episode(job.job_id,cycle);
    if (!row) throw new Error('Simulation intent was not persisted');
    return row;
  }

  private async ensureInjected(episode:EpisodeRow):Promise<Record<string,unknown> | null> {
    const body = JSON.parse(episode.request_json) as DemoInjection;
    if (episode.injection_status === 'injected' && episode.injection_json) return JSON.parse(episode.injection_json) as Record<string,unknown>;
    if (episode.injection_status === 'rejected') throw new SimulationError(502,'Lumen rejected the demo injection');
    if (episode.injection_status === 'unknown' || episode.injection_status === 'requested') {
      return this.readInjection(episode);
    }
    const reservation = await this.options.storage.statement({ mode:'run',sql:`UPDATE simulation_episodes
      SET injection_status='requested',updated_at=? WHERE job_id=? AND cycle_no=? AND injection_status='intent'
      AND EXISTS (SELECT 1 FROM simulation_jobs WHERE job_id=? AND stop_requested=0 AND status IN ('queued','running','waiting'))`,
      params:[this.clock().toISOString(),episode.job_id,episode.cycle_no,episode.job_id] }) as { changes:number | bigint };
    if (!reservation.changes) return null;
    try {
      const result = await this.options.lumen.injectDemo(body);
      await this.setEpisode(episode.job_id,episode.cycle_no,{ injection_status:'injected',injection_json:semanticJson(result) });
      return result;
    } catch (error) {
      if (error instanceof LumenAdapterError && error.outcome === 'rejected') {
        await this.setEpisode(episode.job_id,episode.cycle_no,{ injection_status:'rejected' });
        throw new SimulationError(502,'Lumen rejected the demo injection');
      }
      await this.setEpisode(episode.job_id,episode.cycle_no,{ injection_status:'unknown' });
      return this.readInjection(episode);
    }
  }

  private async readInjection(episode:EpisodeRow):Promise<Record<string,unknown> | null> {
    let readback:Record<string,unknown> | null;
    try { readback = await this.options.lumen.readInjection(episode.operation_key); }
    catch { return null; }
    if (!readback) return null;
    if (readback.operation_key !== episode.operation_key || readback.request_hash !== episode.request_hash
        || readback.injected !== true) throw new SimulationError(409,'Lumen injection readback does not match the saved intent');
    await this.setEpisode(episode.job_id,episode.cycle_no,{ injection_status:'injected',injection_json:semanticJson(readback) });
    return readback;
  }

  private async waitForOutcomes(jobId:string,episode:EpisodeRow):Promise<Record<string,unknown> | null> {
    const selected = JSON.parse(episode.selected_json) as SelectedAccount[];
    const injectedAt = parseTimestamp(episode.updated_at);
    while (!await this.stopRequested(jobId)) {
      const current = await this.outcomes(selected,injectedAt);
      if (current.terminal) return { cycle_no:episode.cycle_no,fault_kind:episode.fault_kind,
        selected:current.results,repaired:current.repaired,externally_restored:current.externallyRestored,unresolved:current.unresolved,
        unknown:current.unknown,partial:current.repaired > 0 && current.unresolved > 0 };
      await this.wait(jobId,current.waitingReason ?? 'recovery_pending');
      await Promise.resolve(this.wake()).catch(() => undefined);
      await this.sleep(500);
    }
    return null;
  }

  private async outcomes(selected:SelectedAccount[],injectedAt:number):Promise<{ terminal:boolean; repaired:number;
    externallyRestored:number; unresolved:number; unknown:number;
    waitingReason:string | null; results:Record<string,unknown>[] }> {
    const fulfillmentRows:Record<string,unknown>[] = [];
    let cursor = 0;
    do {
      const page = await this.options.registry.list(this.options.scope.appId,this.options.scope.environment,cursor,200);
      fulfillmentRows.push(...page.items as Record<string,unknown>[]);
      if (!page.next_cursor) break;
      const next = Number(page.next_cursor);
      if (!Number.isSafeInteger(next) || next <= cursor) throw new Error('Invalid fulfillment cursor');
      cursor = next;
    } while (true);
    const outcomes:Record<string,unknown>[] = [];
    let repaired = 0, externallyRestored = 0, unresolved = 0, unknown = 0, pending = 0;
    for (const target of selected) {
      const row = fulfillmentRows.find(item => isRecord(item.key) && item.key.customer_id === target.user_id
        && item.key.transaction_id === target.transaction_id);
      const identityHash = semanticDigest([this.options.scope.appId,this.options.scope.environment,target.store,
        target.transaction_id,target.user_id,'premium']);
      const persisted = await this.options.storage.statement({ mode:'get',sql:'SELECT last_checked_ms FROM fulfillment_current WHERE identity_hash=?',
        params:[identityHash] }) as { last_checked_ms:number } | null;
      if (!persisted || persisted.last_checked_ms <= injectedAt) {
        pending++; unknown++;
        outcomes.push({ user_id:target.user_id,status:'awaiting_post_injection_assessment' });
        continue;
      }
      let gate:Record<string,unknown>;
      try { gate = await this.options.lumen.readAccess(target.user_id); }
      catch {
        pending++; unknown++; outcomes.push({ user_id:target.user_id,status:'gate_readback_unavailable' }); continue;
      }
      const gateIdentityMatches = gate.user_id === target.user_id
        && gate.identity_revision === target.identity_revision && gate.policy_revision === target.policy_revision;
      if (!gateIdentityMatches) {
        pending++; unknown++; outcomes.push({ user_id:target.user_id,status:'gate_identity_changed' }); continue;
      }
      if (row?.status === 'verified_application' && gate.allowed === true && gate.active === true
          && gate.expires_at === target.expires_at && gate.entitlement_hash === target.entitlement_hash) {
        const incidentId = validId(row.incident_id) ? row.incident_id : null;
        const plan = incidentId ? await this.options.repository.latestPlan(incidentId) : null;
        const actions = plan?.plan.actions.filter(action => action.userId === target.user_id
          && action.kind === 'verify_gate') ?? [];
        const verifiedActions = await Promise.all(actions.map(action => this.options.repository.readAction(action.operationKey)));
        const ownRecoveryVerified = verifiedActions.some(state => state?.status === 'verified');
        if (ownRecoveryVerified) {
          repaired++;
          outcomes.push({ user_id:target.user_id,status:'repaired',evidence:'verified_recovery_gate_action',incident_id:incidentId });
        } else {
          let ownFollowup = false, externalVerification = false;
          if (incidentId) {
            const verification = await this.options.storage.statement({ mode:'get',sql:'SELECT kind FROM external_verifications WHERE incident_id=? AND user_id=? ORDER BY rowid DESC LIMIT 1',
              params:[incidentId,target.user_id] }) as { kind:string } | null;
            ownFollowup = verification?.kind === 'own_followup';
            externalVerification = verification?.kind === 'external';
          }
          if (ownFollowup) {
            repaired++;
            outcomes.push({ user_id:target.user_id,status:'repaired',evidence:'persisted_own_followup',incident_id:incidentId });
          } else {
            externallyRestored++;
            outcomes.push({ user_id:target.user_id,status:'externally_restored',
              evidence:externalVerification ? 'persisted_external_gate_verification' : 'post_injection_fulfillment_and_gate',incident_id:incidentId });
          }
        }
        continue;
      }
      const ownedPendingWrite = row?.status === 'awaiting_application' && row.reason === 'owned_by_open_incident';
      if ((row?.status !== 'discrepancy' && !ownedPendingWrite) || !validId(row.incident_id) || gate.allowed !== false) {
        pending++; unknown++;
        outcomes.push({ user_id:target.user_id,status:'pending' });
        continue;
      }
      const plan = await this.options.repository.latestPlan(row.incident_id);
      if (!plan) { pending++; unknown++; outcomes.push({ user_id:target.user_id,status:'pending' }); continue; }
      const actions = plan.plan.actions.filter(action => action.userId === target.user_id);
      const states = await Promise.all(actions.map(action => this.options.repository.readAction(action.operationKey)));
      const terminalStatuses = ['verified','failed','unknown_outcome','blocked','awaiting_client_action'];
      const stoppedWrite = actions.some((action,index) => action.kind === 'resync_access'
        && !!states[index] && ['failed','unknown_outcome','blocked','awaiting_client_action'].includes(states[index]!.status));
      const hasUnknown = actions.some((action,index) => states[index]?.status === 'accepted'
        || (!states[index] && !(action.kind === 'verify_gate' && stoppedWrite)));
      if (hasUnknown || !actions.length) {
        pending++;
        unknown += hasUnknown ? 1 : 0;
        outcomes.push({ user_id:target.user_id,status:hasUnknown ? 'unknown_write' : 'recovering',incident_id:row.incident_id });
        continue;
      }
      const hasDurableUnknown = states.some(state => state?.status === 'unknown_outcome');
      if (ownedPendingWrite && !hasDurableUnknown) {
        pending++; unknown++;
        outcomes.push({ user_id:target.user_id,status:'recovering',incident_id:row.incident_id });
        continue;
      }
      const terminal = actions.every((action,index) => states[index]
        ? terminalStatuses.includes(states[index]!.status)
        : action.kind === 'verify_gate' && stoppedWrite);
      if (!terminal || (!hasDurableUnknown && await this.options.repository.automaticAttemptCount(row.incident_id) < 2)) {
        pending++; unknown++; outcomes.push({ user_id:target.user_id,status:'pending' }); continue;
      }
      unresolved++;
      if (hasDurableUnknown) unknown++;
      outcomes.push({ user_id:target.user_id,status:hasDurableUnknown ? 'unresolved_unknown_outcome' : 'unresolved',incident_id:row.incident_id,
        actions:states.map(state => state?.status ?? 'unknown') });
    }
    return { terminal:pending === 0,repaired,externallyRestored,unresolved,unknown,
      waitingReason:unknown ? 'unknown_write_outcome' : null,results:outcomes };
  }

  private async finishEpisode(jobId:string,episode:EpisodeRow,result:Record<string,unknown>):Promise<void> {
    const at = this.clock().toISOString(), job = await this.job(jobId);
    if (!job) return;
    const completed = job.completed + 1, status = job.continuous ? 'running' : 'completed';
    await this.options.storage.transaction([
      { mode:'run',sql:'UPDATE simulation_episodes SET result_json=?,updated_at=? WHERE job_id=? AND cycle_no=?',
        params:[semanticJson(result),at,jobId,episode.cycle_no] },
      { mode:'run',sql:'UPDATE simulation_jobs SET completed=?,status=?,waiting_reason=NULL,last_result_json=?,updated_at=? WHERE job_id=?',
        params:[completed,status,semanticJson(result),at,jobId] }
    ]);
  }

  private async waitBetweenEpisodes(jobId:string):Promise<void> {
    const earliest = this.clock().getTime() + 10_000;
    while (!await this.stopRequested(jobId) && this.clock().getTime() < earliest) {
      await this.updateJob(jobId,{ status:'waiting',waiting_reason:'continuous_interval' });
      await this.sleep(Math.min(500,Math.max(1,earliest-this.clock().getTime())));
    }
  }

  private async wait(jobId:string,reason:string):Promise<void> {
    await this.updateJob(jobId,{ status:'waiting',waiting_reason:reason });
  }

  private async job(jobId:string):Promise<JobRow | null> {
    return await this.options.storage.statement({ mode:'get',sql:'SELECT * FROM simulation_jobs WHERE job_id=?',params:[jobId] }) as JobRow | null;
  }

  private async episode(jobId:string,cycle:number):Promise<EpisodeRow | null> {
    return await this.options.storage.statement({ mode:'get',sql:'SELECT * FROM simulation_episodes WHERE job_id=? AND cycle_no=?',params:[jobId,cycle] }) as EpisodeRow | null;
  }

  private async stopRequested(jobId:string):Promise<boolean> {
    const row = await this.options.storage.statement({ mode:'get',sql:'SELECT stop_requested FROM simulation_jobs WHERE job_id=?',params:[jobId] }) as { stop_requested:number } | null;
    return !row || !!row.stop_requested || this.closed;
  }

  private async updateJob(jobId:string,patch:{ status?:SimulationStatusValue; waiting_reason?:string | null;
    error?:string | null }):Promise<void> {
    const row = await this.job(jobId);
    if (!row) return;
    const status = patch.status ?? row.status, waiting = patch.waiting_reason === undefined ? row.waiting_reason : patch.waiting_reason;
    const error = patch.error === undefined ? row.error : patch.error;
    await this.options.storage.statement({ mode:'run',sql:'UPDATE simulation_jobs SET status=?,waiting_reason=?,error=?,updated_at=? WHERE job_id=?',
      params:[status,waiting,error,this.clock().toISOString(),jobId] });
  }

  private async setEpisode(jobId:string,cycle:number,patch:{ injection_status?:EpisodeRow['injection_status'];
    injection_json?:string | null }):Promise<void> {
    const row = await this.episode(jobId,cycle);
    if (!row) throw new Error('Simulation intent unavailable');
    await this.options.storage.statement({ mode:'run',sql:'UPDATE simulation_episodes SET injection_status=?,injection_json=?,updated_at=? WHERE job_id=? AND cycle_no=?',
      params:[patch.injection_status ?? row.injection_status,patch.injection_json === undefined ? row.injection_json : patch.injection_json,
        this.clock().toISOString(),jobId,cycle] });
  }

  /** Stops generation and waits for any current remote read/write to settle. Storage remains root-owned. */
  async close():Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await this.options.storage.statement({ mode:'run',sql:`UPDATE simulation_jobs SET stop_requested=1,updated_at=? WHERE ${RUNNING}`,
      params:[this.clock().toISOString()] });
    await Promise.all(this.tasks.values());
  }
}

function revision(value:unknown):value is number { return typeof value === 'number' && Number.isSafeInteger(value) && value >= 1; }
