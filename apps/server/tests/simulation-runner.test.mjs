import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SQLiteStorage } from '../dist/infrastructure/sqlite.js';
import { FulfillmentRegistry } from '../dist/modules/fulfillment/registry.js';
import { RecoveryRepository } from '../dist/modules/recovery/repository.js';
import { LumenAdapterError, injectionHash } from '../dist/modules/client/lumen-adapter.js';
import { SimulationRunner } from '../dist/modules/simulation/runner.js';

const baseMs = Date.parse('2026-11-08T12:00:00.000Z');
const appId = 'synthetic-app', environment = 'sandbox', sourceEnvironment = 'Production';
const sourceFingerprint = 'c'.repeat(64);
const healthy = { status:'healthy',reason:'source_period_and_gate_match',eligible:false,projectionMatches:true };
const discrepancy = { status:'confirmed',reason:'projection_mismatch',eligible:true,projectionMatches:false };
const ownedPending = { status:'potential',reason:'owned_by_open_incident',eligible:false,projectionMatches:false };
const pause = milliseconds => new Promise(resolve => setTimeout(resolve,milliseconds));

async function until(check, message = 'condition timed out', timeout = 4000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await check()) return;
    await pause(5);
  }
  assert.fail(message);
}

async function createHarness({ count = 24, time = { ms:baseMs }, sleep, autoScan = 'partial', unknownInjection = false,
  notBefore = 0, queued = 0, sourceReady = true, preclaimed = [] } = {}) {
  const directory = await mkdtemp(join(tmpdir(),'reconcile-simulation-'));
  const databasePath = join(directory,'engine.sqlite3');
  const storage = new SQLiteStorage(databasePath);
  const registry = new FulfillmentRegistry(storage);
  const repository = new RecoveryRepository(storage);
  await repository.initialize();
  await registry.initialize();
  const users = Array.from({ length:count },(_,index) => {
    const userId = `fixture-user-${String(index).padStart(2,'0')}`;
    const transactionId = `fixture-transaction-${index}`;
    const entitlementHash = index.toString(16).padStart(64,'0');
    const expiresAt = '2026-12-01T00:00:00.000Z';
    return { userId,transactionId,entitlementHash,expiresAt,
      profile:{ user_id:userId,provider_customer_id:userId,app_id:appId,status:'active',identity_match:true,
        observed_at:new Date(time.ms-1000).toISOString(),
        entitlement:{ app_id:appId,user_id:userId,provider_customer_id:userId,transaction_id:transactionId,
          product_id:'premium',store:'app_store',source_environment:sourceEnvironment,source_fingerprint:sourceFingerprint,
          starts_at:'2026-11-08T11:00:00.000Z',expires_at:expiresAt,is_in_grace_period:false,
          entitlement_hash:entitlementHash } },
      providerAccount:{ user_id:userId,provider_customer_id:userId,source_user_id:`source-${index}`,
        identity_status:'mapped',provenance:'official_hackathon_synthetic' },
      account:{ user_id:userId,provider_customer_id:userId,identity_status:'mapped',policy_enabled:true,
        identity_revision:1,policy_revision:1,projection_revision:1,cache_revision:1,
        gate:{ allowed:true,reason:'allowed' } } };
  });
  const byUser = new Map(users.map(item => [item.userId,item]));
  const state = { time,injection:null,injections:[],readbacks:0,gateDenied:new Set(),plans:new Map(),actionStates:new Map(),
    notBefore,queued,sourceReady,autoScan };
  const healthyKey = user => ({ app:appId,environment,store:'app_store',transactionId:user.transactionId,
    userId:user.userId,accessLevel:'premium' });
  for (const user of users) {
    await registry.observe(healthyKey(user),healthy,sourceFingerprint,user.entitlementHash,
      new Date(time.ms-1000).toISOString());
  }
  for (const userId of preclaimed) {
    const user = byUser.get(userId);
    assert.ok(user);
    const observation = await registry.observe(healthyKey(user),discrepancy,sourceFingerprint,user.entitlementHash,
      new Date(time.ms-500).toISOString());
    assert.equal(await registry.claimIncident(`existing-${userId}`,appId,environment,[observation.identityHash],
      new Date(time.ms-500).toISOString()),true);
  }
  const actionsFor = userId => [
    { userId,kind:'resync_access',operationKey:`write-${userId}` },
    { userId,kind:'verify_gate',operationKey:`gate-${userId}` }
  ];
  state.applyPartialScan = async () => {
    const injection = state.injection;
    if (!injection) return;
    const selected = injection.user_ids.map(id => byUser.get(id)).filter(Boolean);
    const incidentId = `incident-${injection.operation_key}`;
    const fail = injection.repair_failure_user;
    state.gateDenied.add(fail);
    state.time.ms += 1000;
    const assessedAt = new Date(state.time.ms).toISOString();
    const identities = [];
    for (const user of selected) {
      const result = await registry.observe(healthyKey(user),discrepancy,sourceFingerprint,user.entitlementHash,assessedAt);
      identities.push(result.identityHash);
    }
    assert.equal(await registry.claimIncident(incidentId,appId,environment,identities,assessedAt),true);
    const actions = selected.flatMap(user => actionsFor(user.userId));
    state.plans.set(incidentId,{ plan:{ actions } });
    for (const user of selected) {
      state.actionStates.set(`write-${user.userId}`,{ status:user.userId === fail ? 'unknown_outcome' : 'verified' });
      if (user.userId !== fail) state.actionStates.set(`gate-${user.userId}`,{ status:'verified' });
    }
    state.time.ms += 1000;
    const recoveredAt = new Date(state.time.ms).toISOString();
    for (const user of selected) {
      await registry.observe(healthyKey(user),user.userId === fail ? ownedPending : healthy,
        sourceFingerprint,user.entitlementHash,recoveredAt);
    }
  };
  state.applyHealthyScan = async () => {
    state.time.ms += 1000;
    const at = new Date(state.time.ms).toISOString();
    const ids = state.injection?.user_ids ?? [];
    for (const userId of ids) {
      const user = byUser.get(userId);
      if (user) await registry.observe(healthyKey(user),healthy,sourceFingerprint,user.entitlementHash,at);
    }
  };
  const lumen = {
    async listAccounts() { return { items:users.map(user => user.account),total:users.length,next_cursor:null }; },
    async readAccess(userId) {
      const user = byUser.get(userId);
      assert.ok(user);
      return { user_id:userId,identity_revision:1,policy_revision:1,projection_revision:1,cache_revision:1,
        active:true,allowed:!state.gateDenied.has(userId),expires_at:user.expiresAt,entitlement_hash:user.entitlementHash };
    },
    async collectorCoverage() { return { queued:state.queued,receipt_backlog:0 }; },
    async injectDemo(body) {
      state.injections.push(body);
      state.injection = body;
      if (unknownInjection) throw new LumenAdapterError('unknown_outcome');
      return { injected:true,operation_key:body.operation_key,request_hash:injectionHash(body),account_count:body.user_ids.length };
    },
    async readInjection(operationKey) {
      state.readbacks++;
      if (!state.injection || state.injection.operation_key !== operationKey) return null;
      return { injected:true,operation_key:operationKey,request_hash:injectionHash(state.injection),account_count:state.injection.user_ids.length };
    }
  };
  const provider = {
    async status() { return { not_before_ms:state.notBefore,source_requests_total:0 }; },
    async accounts() { return { items:users.map(user => user.providerAccount),total:users.length,next_cursor:null }; },
    async profiles() { return { items:users.map(user => user.profile),total:users.length,next_cursor:null }; }
  };
  const monitor = { status:() => ({ lastError:null,cachedAccounts:users.length,sourceReady:state.sourceReady,sourceFresh:state.sourceReady }),
    async pass() {} };
  repository.latestPlan = async incidentId => state.plans.get(incidentId) ?? null;
  repository.readAction = async operationKey => state.actionStates.get(operationKey) ?? null;
  repository.automaticAttemptCount = async () => 2;
  const options = { storage,engineDatabasePath:databasePath,scope:{ appId,environment,sourceEnvironment },lumen,provider,
    monitor,registry,repository,handlerVersion:'handler-v1',configVersion:'demo-v1',clock:() => new Date(time.ms),
    sleep:sleep ?? pause,wakeMonitor:async () => {
      if (!state.injection) return;
      if (state.autoScan === 'partial') await state.applyPartialScan();
      else if (state.autoScan === 'healthy') await state.applyHealthyScan();
    } };
  const runner = await SimulationRunner.create(options);
  return { runner,storage,registry,repository,state,users,directory,options };
}

async function cleanup(harness) {
  await harness.runner?.close();
  await harness.storage?.close();
  await rm(harness.directory,{ recursive:true,force:true });
}

test('coalesces concurrent operation keys, recovers injection timeout by readback, and reports a 23/24 partial result', async () => {
  const h = await createHarness({ unknownInjection:true });
  try {
    const [first,duplicate] = await Promise.all([
      h.runner.command({ action:'once',operation_key:'sim-partial' }),
      h.runner.command({ action:'once',operation_key:'sim-partial' })
    ]);
    assert.equal(first.job_id,duplicate.job_id);
    assert.deepEqual([first.duplicate,duplicate.duplicate].sort(),[false,true]);
    await assert.rejects(h.runner.command({ action:'continuous',operation_key:'sim-partial' }),
      error => error.statusCode === 409);
    await until(async () => (await h.runner.status()).status === 'completed','simulation did not complete');
    const status = await h.runner.status();
    assert.equal(status.completed,1);
    assert.equal(status.total,1);
    assert.equal(status.last_result.repaired,23);
    assert.equal(status.last_result.unresolved,1);
    assert.equal(status.last_result.unknown,1);
    assert.equal(status.last_result.partial,true);
    assert.equal(h.state.injections.length,1);
    assert.equal(h.state.readbacks,1);
    assert.equal(h.state.injection.user_ids.length,24);
    assert.equal(h.state.injection.repair_failure_user,h.state.injection.user_ids[0]);
    const unresolved = status.last_result.selected.find(item => item.status === 'unresolved_unknown_outcome');
    assert.equal(unresolved.user_id,h.state.injection.repair_failure_user);
    assert.deepEqual(unresolved.actions,['unknown_outcome','unknown']);
  } finally { await cleanup(h); }
});

test('does not count pre-injection healthy rows as a repair before a fresh monitor assessment', async () => {
  const h = await createHarness({ autoScan:false });
  try {
    const accepted = await h.runner.command({ action:'bootstrap',operation_key:'sim-bootstrap' });
    await until(async () => (await h.runner.status()).waiting_reason === 'unknown_write_outcome',
      'runner did not wait for a post-injection assessment');
    assert.equal((await h.runner.status()).completed,0);
    assert.equal(h.state.injections.length,1);
    await h.state.applyHealthyScan();
    await until(async () => (await h.runner.status()).status === 'completed','bootstrap did not settle after assessment');
    const status = await h.runner.status();
    assert.equal(status.job_id,accepted.job_id);
    assert.equal(status.last_result.repaired,0);
    assert.equal(status.last_result.externally_restored,24);
    assert.equal(status.last_result.selected.every(item => item.status === 'externally_restored'),true);
  } finally { await cleanup(h); }
});

test('waits visibly on provider cooldown, source gap and collector outbox backpressure', async () => {
  for (const [label,options,reason] of [
    ['cooldown',{ notBefore:baseMs+60_000 },'source_cooldown'],
    ['source gap',{ sourceReady:false },'source_gap'],
    ['outbox',{ queued:801 },'outbox_backpressure']
  ]) {
    const h = await createHarness(options);
    try {
      await h.runner.command({ action:'once',operation_key:`wait-${label}` });
      await until(async () => (await h.runner.status()).waiting_reason === reason,`${label} was not reported`);
      assert.equal(h.state.injections.length,0);
      await h.runner.command({ action:'stop' });
      await until(async () => (await h.runner.status()).status === 'stopped',`${label} job did not stop`);
    } finally { await cleanup(h); }
  }
});

test('stop during candidate reads prevents a new injection', async () => {
  const h = await createHarness();
  let release, entered = false;
  const original = h.options.provider.profiles;
  h.options.provider.profiles = async (...args) => {
    entered = true;
    await new Promise(resolve => { release = resolve; });
    return original(...args);
  };
  try {
    await h.runner.command({ action:'once',operation_key:'stop-during-candidates' });
    await until(() => entered,'candidate read did not start');
    await h.runner.command({ action:'stop' });
    release();
    await until(async () => (await h.runner.status()).status === 'stopped','simulation did not stop');
    assert.equal(h.state.injections.length,0);
  } finally { release?.(); await cleanup(h); }
});

test('excludes accounts with existing open incidents from the selected cohort', async () => {
  const excluded = 'fixture-user-00';
  const h = await createHarness({ preclaimed:[excluded] });
  try {
    await h.runner.command({ action:'once',operation_key:'sim-exclusion' });
    await until(async () => (await h.runner.status()).status === 'completed','simulation did not complete');
    assert.equal(h.state.injection.user_ids.length,23);
    assert.equal(h.state.injection.user_ids.includes(excluded),false);
    assert.equal(h.state.injection.user_ids.includes(h.state.injection.repair_failure_user),true);
  } finally { await cleanup(h); }
});

test('continuous mode observes the ten second minimum and remains stopped after runner restart', async () => {
  const time = { ms:baseMs }, sleepers = [];
  const sleep = milliseconds => new Promise(resolve => sleepers.push({ milliseconds,release:() => {
    time.ms += milliseconds; resolve();
  } }));
  const h = await createHarness({ time,sleep });
  let restarted;
  try {
    await h.runner.command({ action:'continuous',operation_key:'sim-continuous' });
    await until(() => h.state.injections.length === 1,'first continuous episode did not inject');
    await until(async () => (await h.runner.status()).waiting_reason === 'continuous_interval',
      'continuous loop did not enter its spacing interval');
    let elapsed = 0;
    for (let index = 0; index < 20; index++) {
      await until(() => sleepers.length > 0,'continuous interval stopped waiting');
      const pending = sleepers.shift();
      assert.equal(h.state.injections.length,1,'a second episode started before the interval elapsed');
      elapsed += pending.milliseconds;
      pending.release();
    }
    assert.ok(elapsed >= 10_000);
    await until(() => h.state.injections.length === 2,'continuous loop did not start the next episode');
    await h.runner.command({ action:'stop' });
    for (const pending of sleepers.splice(0)) pending.release();
    await until(async () => (await h.runner.status()).status === 'stopped','continuous job did not stop');
    await h.runner.close();
    restarted = await SimulationRunner.create(h.options);
    const afterRestart = await restarted.status();
    assert.equal(afterRestart.status,'stopped');
    assert.equal(afterRestart.continuous,true);
  } finally {
    for (const pending of sleepers.splice(0)) pending.release();
    await restarted?.close();
    await cleanup(h);
  }
});
