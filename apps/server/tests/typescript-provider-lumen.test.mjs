import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp,rm,writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { internalRequest } from '../../lumen/dist/index.js';
import { SQLiteStorage } from '../dist/infrastructure/sqlite.js';
import { ProviderAdapter } from '../dist/modules/source/provider-adapter.js';
import { LumenAdapter } from '../dist/modules/client/lumen-adapter.js';
import { Expectations } from '../dist/modules/fulfillment/expectations.js';
import { classifyFulfillment } from '../dist/modules/fulfillment/classification.js';
import { scanFulfillments } from '../dist/modules/fulfillment/scan.js';
import { prepareRecovery } from '../dist/modules/recovery/preview.js';
import { RecoveryRepository } from '../dist/modules/recovery/repository.js';
import { RecoveryExecution } from '../dist/modules/recovery/execution.js';
import { FulfillmentRegistry } from '../dist/modules/fulfillment/registry.js';
import { FulfillmentMonitor } from '../dist/modules/fulfillment/monitor.js';
import { Reporting } from '../dist/modules/reporting/export.js';

async function start(file,env) {
  const child = spawn(process.execPath,[fileURLToPath(new URL(file,import.meta.url))],
    { env:{ ...process.env,...env },stdio:['ignore','pipe','pipe'] });
  const port = await new Promise((resolve,reject) => {
    let output = '',errors = '';
    const timer = setTimeout(() => reject(new Error(`Process startup timed out: ${errors}`)),15_000);
    child.stderr.on('data',chunk => { errors += chunk.toString(); });
    child.stdout.on('data',chunk => {
      output += chunk.toString();
      if (output.includes('\n')) { clearTimeout(timer); try { resolve(JSON.parse(output.split('\n')[0]).port); } catch (error) { reject(error); } }
    });
    child.once('exit',code => { clearTimeout(timer); reject(new Error(`Process exited (${code}): ${errors}`)); });
  }).catch(error => { child.kill('SIGTERM'); throw error; });
  return { child,port };
}

test('independent TypeScript provider and Lumen processes preserve official seed scope', async () => {
  const directory = await mkdtemp(join(tmpdir(),'reconcile-ts-seed-'));
  const key = Buffer.from('local-seed-integration-key-0123456789abcdef');
  const keyPath = join(directory,'key');
  let providerProcess,lumenProcess,storage;
  try {
    await writeFile(keyPath,key,{ mode:0o600 });
    providerProcess = await start('../../provider-simulator/dist/main.js',{
      PROVIDER_PORT:'0',PROVIDER_DB:join(directory,'provider.sqlite'),PROVIDER_MODE:'mock',
      PROVIDER_RUN_ID:'typescript-integration',RECOVERY_KEY_FILE:keyPath });
    const providerUrl = `http://127.0.0.1:${providerProcess.port}`;
    const manifest = await internalRequest(key,new URL(providerUrl),'GET','/internal/manifest');
    const page = await internalRequest(key,new URL(providerUrl),'GET','/internal/adapty/profiles?limit=100');
    assert.equal(page.items.length,100);
    assert.equal(manifest.provenance,'official_hackathon_synthetic');
    assert.match(page.items[0].source_user_id,/^u\d{5}$/);
    const appId = manifest.app_id, userIds = page.items.map(item => item.user_id);
    const configPath = join(directory,'live.json');
    await writeFile(configPath,JSON.stringify({ app_id:appId,source_environment:'Production',customer_user_ids:userIds }));
    lumenProcess = await start('../../lumen/dist/main.js',{
      LUMEN_PORT:'0',LUMEN_DB:join(directory,'lumen.sqlite'),LUMEN_OUTBOX_DB:join(directory,'outbox.sqlite'),
      RECOVERY_KEY_FILE:keyPath,PROVIDER_URL:providerUrl,LUMEN_LIVE_CONFIG:configPath,LUMEN_DEMO:'true' });
    const lumenUrl = `http://127.0.0.1:${lumenProcess.port}`;
    storage = new SQLiteStorage(join(directory,'engine.sqlite'));
    const expectations = new Expectations(storage); await expectations.initialize();
    const provider = new ProviderAdapter(providerUrl,key),lumen = new LumenAdapter(lumenUrl,key,'Production');
    let now = new Date(Date.now() + 31_000);
    const before = await scanFulfillments(lumen,provider,expectations,appId,'Production',() => now,async () => false);
    assert.equal(before.coverage.registered,100);
    assert.equal(before.coverage.sourceRead,100);
    assert.equal(before.observations.filter(item => classifyFulfillment(item).status === 'confirmed').length,0);
    const active = before.observations.filter(item => classifyFulfillment(item).status === 'healthy').map(item => item.userId);
    assert.ok(active.length >= 2,'official synthetic sample must contain two currently valid subscriptions');
    const injection = {
      user_ids:active.slice(0,2),handler_version:'handler-v1',config_version:'config-v1',
      occurred_at:new Date().toISOString(),fault_kind:'missed_projection',operation_key:'seed-injection' };
    await internalRequest(key,new URL(lumenUrl),'POST','/internal/lumen/live/inject',injection);
    const replay = await internalRequest(key,new URL(lumenUrl),'POST','/internal/lumen/live/inject',injection);
    assert.equal(replay.duplicate,true);
    const readback = await internalRequest(key,new URL(lumenUrl),'GET','/internal/lumen/simulation/injection?operation_key=seed-injection');
    assert.equal(readback.account_count,2);
    const after = await scanFulfillments(lumen,provider,expectations,appId,'Production',() => now,async () => false);
    assert.deepEqual(after.observations.filter(item => classifyFulfillment(item).status === 'confirmed')
      .map(item => item.userId),active.slice(0,2));
    assert.equal((await lumen.probeAccess(active[0])).allowed,false);
    const repository = new RecoveryRepository(storage); await repository.initialize();
    const preview = prepareRecovery(appId,after.current,[active[0]],now);
    const createdAt = now.toISOString(),expiresAt = new Date(now.getTime()+300_000).toISOString();
    await repository.createIncident('incident',appId,'Production',createdAt);
    const snapshotHash = await repository.saveSnapshot('snapshot','incident',
      { appId,environment:'Production',targets:preview.targets,evidence:preview.evidence },createdAt);
    const plan = { id:'plan',incidentId:'incident',snapshotId:'snapshot',snapshotHash,appId,environment:'Production',
      policyRevision:1,createdAt,expiresAt,targets:preview.targets,actions:preview.actions };
    const hash = await repository.savePlan('plan','incident','snapshot',plan,createdAt,expiresAt);
    await repository.approve('policy-decision','plan',hash,'automatic-policy',createdAt);
    const observe = async users => (await scanFulfillments(lumen,provider,expectations,appId,'Production',() => now,
      async () => false,new Set(users))).current;
    const executor = new RecoveryExecution(repository,lumen,observe,() => now);
    assert.deepEqual((await executor.execute('plan',{ appId,environment:'Production',policyRevision:1 })).map(row => row.status),
      ['verified','verified']);
    assert.equal((await lumen.probeAccess(active[0])).allowed,true);
    assert.equal((await lumen.probeAccess(active[1])).allowed,false);
    const registry = new FulfillmentRegistry(storage), reporting = new Reporting(storage,() => now);
    await registry.initialize(); await reporting.initialize();
    const monitor = new FulfillmentMonitor({ appId,environment:'Production',sourceEnvironment:'Production',
      policyRevision:1,provenance:'local_fixture' },lumen,provider,expectations,registry,repository,reporting,() => now);
    await monitor.pass(true);
    assert.equal(monitor.status().lastError,null);
    assert.equal((await lumen.probeAccess(active[1])).allowed,true);
    now = new Date(now.getTime() + 1_000);
    await monitor.pass(true);
    const exported = JSON.parse((await reporting.export(appId,'Production',new Date(now.getTime()-300_000).toISOString(),
      new Date(now.getTime()+1_000).toISOString(),'json')).body);
    const automatic = exported.incidents.find(incident => incident.actions.some(action => action.user_id === active[1]));
    assert.equal(automatic.status,'repaired');
    assert.equal(automatic.repaired_accounts,1);
    assert.equal(automatic.externally_restored_accounts,0);
  } finally {
    await storage?.close();
    for (const process of [lumenProcess,providerProcess]) if (process?.child.exitCode === null && process.child.signalCode === null) {
      process.child.kill('SIGTERM'); await new Promise(resolve => process.child.once('exit',resolve));
    }
    await rm(directory,{ recursive:true,force:true });
  }
});
