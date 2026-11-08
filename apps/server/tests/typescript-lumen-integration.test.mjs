import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { internalRequest } from '../../lumen/dist/index.js';
import { SQLiteStorage } from '../dist/infrastructure/sqlite.js';
import { semanticDigest } from '../dist/infrastructure/json.js';
import { verifyInternal } from '../dist/infrastructure/internal-auth.js';
import { LumenAdapter } from '../dist/modules/client/lumen-adapter.js';
import { ProviderAdapter } from '../dist/modules/source/provider-adapter.js';
import { Expectations } from '../dist/modules/fulfillment/expectations.js';
import { scanFulfillments } from '../dist/modules/fulfillment/scan.js';
import { classifyFulfillment } from '../dist/modules/fulfillment/classification.js';
import { prepareRecovery } from '../dist/modules/recovery/preview.js';
import { RecoveryRepository } from '../dist/modules/recovery/repository.js';
import { RecoveryExecution } from '../dist/modules/recovery/execution.js';

test('TypeScript scanner, plan and executor recover an actual isolated Lumen gate', async () => {
  const directory = await mkdtemp(join(tmpdir(),'reconcile-ts-vertical-'));
  const key = Buffer.from('local-integration-signing-key-0123456789abcdef');
  const appId = 'vertical-lumen', userIds = Array.from({ length:100 },(_,i) => `customer-${String(i).padStart(3,'0')}`);
  const baseTime = Date.now(), observedAt = new Date(baseTime).toISOString();
  const now = () => new Date(baseTime + 31_000);
  const sourceFingerprint = 'a'.repeat(64), expiresAt = new Date(baseTime + 30 * 86400_000).toISOString().replace(/\.\d{3}Z$/,'Z');
  const profile = userId => {
    const entitlementHash = semanticDigest({ user_id:userId,product_id:'premium',expires_at:expiresAt });
    return { user_id:userId,provider_customer_id:userId,app_id:appId,identity_match:true,status:'active',reason:'active',
      observed_at:observedAt,source_fingerprint:sourceFingerprint,
      entitlement:{ app_id:appId,user_id:userId,provider_customer_id:userId,transaction_id:`transaction-${userId}`,
        original_transaction_id:null,product_id:'premium',store:'app_store',source_environment:'Production',
        source_fingerprint:sourceFingerprint,starts_at:new Date(baseTime - 86400_000).toISOString(),
        expires_at:expiresAt,is_in_grace_period:false,entitlement_hash:entitlementHash } };
  };
  const providerServer = createServer((request,response) => {
    if (!verifyInternal(key,request.method,request.url,String(request.headers['x-recovery-timestamp'] ?? ''),
      Buffer.alloc(0),String(request.headers['x-recovery-signature'] ?? ''))) {
      response.writeHead(401).end('{}'); return;
    }
    const url = new URL(request.url,'http://127.0.0.1');
    if (url.pathname === '/internal/manifest') {
      response.writeHead(200,{ 'Content-Type':'application/json' }).end(JSON.stringify({ app:appId,environment:'sandbox',
        run_id:'vertical-run',scenario_now:observedAt })); return;
    }
    if (url.pathname === '/internal/adapty/profiles') {
      response.writeHead(200,{ 'Content-Type':'application/json' }).end(JSON.stringify({ items:userIds.map(profile),total:100,next_cursor:null })); return;
    }
    if (url.pathname !== '/internal/adapty/profile' || !userIds.includes(url.searchParams.get('user'))) {
      response.writeHead(404).end('{}'); return;
    }
    response.writeHead(200,{ 'Content-Type':'application/json' }).end(JSON.stringify(profile(url.searchParams.get('user'))));
  });
  await new Promise(resolve => providerServer.listen(0,'127.0.0.1',resolve));
  const providerUrl = `http://127.0.0.1:${providerServer.address().port}`;
  let child, storage;
  try {
    const keyPath = join(directory,'key'), configPath = join(directory,'live.json');
    await writeFile(keyPath,key,{ mode:0o600 });
    await writeFile(configPath,JSON.stringify({ app_id:appId,source_environment:'Production',customer_user_ids:userIds }));
    child = spawn(process.execPath,[fileURLToPath(new URL('../../lumen/dist/main.js',import.meta.url))],{ env:{ ...process.env,
      LUMEN_PORT:'0',LUMEN_DB:join(directory,'lumen.sqlite'),LUMEN_OUTBOX_DB:join(directory,'outbox.sqlite'),
      RECOVERY_KEY_FILE:keyPath,PROVIDER_URL:providerUrl,LUMEN_LIVE_CONFIG:configPath,LUMEN_DEMO:'true' },stdio:['ignore','pipe','pipe'] });
    const port = await new Promise((resolve,reject) => {
      let output = '', errors = '';
      const timer = setTimeout(() => reject(new Error(`Lumen startup timed out: ${errors}`)),10_000);
      child.stderr.on('data',chunk => { errors += chunk.toString(); });
      child.stdout.on('data',chunk => {
        output += chunk.toString();
        if (output.includes('\n')) { clearTimeout(timer); try { resolve(JSON.parse(output.split('\n')[0]).port); } catch (error) { reject(error); } }
      });
      child.once('exit',code => { clearTimeout(timer); reject(new Error(`Lumen exited (${code}): ${errors}`)); });
    });
    const lumenUrl = `http://127.0.0.1:${port}`;
    await internalRequest(key,new URL(lumenUrl),'POST','/internal/lumen/live/inject',{
      user_ids:userIds.slice(0,2),handler_version:'handler-v1',config_version:'config-v1',occurred_at:observedAt,
      fault_kind:'missed_projection' });
    storage = new SQLiteStorage(join(directory,'engine.sqlite'));
    const expectations = new Expectations(storage), repository = new RecoveryRepository(storage);
    await expectations.initialize(); await repository.initialize();
    const lumen = new LumenAdapter(lumenUrl,key,'Production'), provider = new ProviderAdapter(providerUrl,key);
    const scan = selected => scanFulfillments(lumen,provider,expectations,appId,'Production',now,async () => false,
      selected ? new Set(selected) : undefined);
    const initial = await scan();
    assert.equal(initial.coverage.registered,100);
    assert.deepEqual(initial.observations.filter(item => classifyFulfillment(item).status === 'confirmed')
      .map(item => item.userId),userIds.slice(0,2));
    const preview = prepareRecovery(appId,initial.current,[userIds[0]],now());
    const createdAt = now().toISOString(), expiresAtPlan = new Date(now().getTime() + 300_000).toISOString();
    await repository.createIncident('incident',appId,'sandbox',createdAt);
    const snapshotHash = await repository.saveSnapshot('snapshot','incident',
      { appId,environment:'sandbox',targets:preview.targets,evidence:preview.evidence },createdAt);
    const plan = { id:'plan',incidentId:'incident',snapshotId:'snapshot',snapshotHash,appId,environment:'sandbox',
      policyRevision:1,createdAt,expiresAt:expiresAtPlan,targets:preview.targets,actions:preview.actions };
    const planHash = await repository.savePlan('plan','incident','snapshot',plan,createdAt,expiresAtPlan);
    await repository.approve('decision','plan',planHash,'automatic-policy',createdAt);
    const executor = new RecoveryExecution(repository,lumen,async ids => (await scan(ids)).current,now);
    assert.deepEqual((await executor.execute('plan',{ appId,environment:'sandbox',policyRevision:1 })).map(row => row.status),
      ['verified','verified']);
    assert.equal((await lumen.probeAccess(userIds[0])).allowed,true);
    assert.equal((await lumen.probeAccess(userIds[1])).allowed,false);
  } finally {
    if (child && child.exitCode === null) {
      child.kill('SIGTERM');
      await new Promise(resolve => child.once('exit',resolve));
    }
    await storage?.close();
    await new Promise(resolve => providerServer.close(resolve));
    await rm(directory,{ recursive:true,force:true });
  }
});
