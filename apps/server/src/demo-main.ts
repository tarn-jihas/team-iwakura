import { randomBytes,randomUUID } from 'node:crypto';
import { chmod,mkdir,mkdtemp,readFile,writeFile } from 'node:fs/promises';
import { spawn,type ChildProcess } from 'node:child_process';
import { createServer } from 'node:net';
import { resolve,join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadPrivateApiKey } from './modules/source/adapty-reader.js';
import { ProviderAdapter } from './modules/source/provider-adapter.js';
import { EngineRuntime } from './http/runtime.js';

async function start(file:URL,environment:NodeJS.ProcessEnv,timeoutMs = 30_000):Promise<{ child:ChildProcess; port:number }> {
  const child = spawn(process.execPath,[fileURLToPath(file)],{ env:{ ...process.env,...environment },stdio:['ignore','pipe','pipe'] });
  const port = await new Promise<number>((resolvePort,reject) => {
    let output = '';
    const timer = setTimeout(() => reject(new Error('Demo service startup timed out')),timeoutMs);
    child.stderr?.on('data',() => undefined);
    child.stdout?.on('data',chunk => {
      output += String(chunk);
      if (output.length > 4096) { clearTimeout(timer); reject(new Error('Invalid demo service startup')); return; }
      if (output.includes('\n')) {
        clearTimeout(timer);
        try {
          const value:unknown = JSON.parse(output.split('\n')[0]!);
          if (!value || typeof value !== 'object' || !('port' in value) || typeof value.port !== 'number'
              || !Number.isInteger(value.port) || value.port < 1 || value.port > 65535) throw new Error('invalid');
          resolvePort(value.port);
        } catch { reject(new Error('Invalid demo service startup')); }
      }
    });
    child.once('exit',() => { clearTimeout(timer); reject(new Error('Demo service exited during startup')); });
    child.once('error',() => { clearTimeout(timer); reject(new Error('Demo service could not start')); });
  }).catch(error => { child.kill('SIGTERM'); throw error; });
  return { child,port };
}

async function stopChild(child:ChildProcess):Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await new Promise<void>(resolveStop => {
    const timer = setTimeout(() => { child.kill('SIGKILL'); },5_000);
    child.once('exit',() => { clearTimeout(timer); resolveStop(); });
    if (!child.kill('SIGTERM')) { clearTimeout(timer); resolveStop(); }
  });
}

async function availablePort():Promise<number> {
  const server = createServer();
  await new Promise<void>((resolveListen,reject) => { server.once('error',reject); server.listen(0,'127.0.0.1',resolveListen); });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Unable to allocate a demo port');
  const port = address.port;
  await new Promise<void>((resolveClose,reject) => server.close(error => error ? reject(error) : resolveClose()));
  return port;
}

async function main():Promise<void> {
  const requested = process.env.RECONCILE_RUNTIME_DIR;
  const parent = resolve('runtime/typescript');
  let directory:string;
  if (requested) directory = resolve(requested);
  else {
    await mkdir(parent,{ recursive:true });
    directory = await mkdtemp(join(parent,'demo-'));
    await chmod(directory,0o700);
    await writeFile(join(directory,'key'),randomBytes(32).toString('hex'),{ mode:0o600,flag:'wx' });
    await writeFile(join(directory,'run.json'),JSON.stringify({ providerRunId:`demo_${randomUUID()}` }),{ mode:0o600,flag:'wx' });
  }
  const config:unknown = JSON.parse(await readFile(join(directory,'run.json'),'utf8'));
  if (!config || typeof config !== 'object' || !('providerRunId' in config)
      || typeof config.providerRunId !== 'string' || !/^[A-Za-z0-9._-]{1,96}$/.test(config.providerRunId)) {
    throw new Error('Invalid isolated demo runtime');
  }
  const keyPath = join(directory,'key'), keyText = await loadPrivateApiKey(keyPath);
  const key = /^(?:[0-9a-fA-F]{2}){32,}$/.test(keyText) ? Buffer.from(keyText,'hex') : Buffer.from(keyText,'utf8');
  if (key.byteLength < 32) throw new Error('Invalid isolated demo key');
  const children:ChildProcess[] = [];
  let engine:EngineRuntime | undefined;
  let stopping = false;
  const stop = async ():Promise<void> => {
    if (stopping) return;
    stopping = true;
    await engine?.close();
    for (const child of children.reverse()) await stopChild(child);
  };
  try {
    let port = Number(process.env.ENGINE_PORT ?? 8768);
    if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('Invalid engine port');
    if (port === 0) port = await availablePort();
    const liveConfig = process.env.RECONCILE_LIVE_CONFIG;
    const provider = await start(new URL('../../provider-simulator/dist/main.js',import.meta.url),{
      PROVIDER_PORT:'0',PROVIDER_DB:join(directory,'provider.sqlite3'),PROVIDER_MODE:liveConfig ? 'live' : 'mock',
      PROVIDER_LIVE_CONFIG:liveConfig ? resolve(liveConfig) : undefined,
      PROVIDER_RUN_ID:config.providerRunId,PROVIDER_SAMPLE_SIZE:'100',PROVIDER_ACTIVE_OVERLAY:'true',
      PROVIDER_FIXTURE_DIR:undefined,RECOVERY_KEY_FILE:keyPath });
    children.push(provider.child);
    const providerUrl = `http://127.0.0.1:${provider.port}`, source = new ProviderAdapter(providerUrl,key);
    const [manifest,accounts] = await Promise.all([source.manifest(),source.accounts(null,100)]);
    const ids = (accounts.items as unknown[]).map(item => item && typeof item === 'object' && 'user_id' in item ? item.user_id : null);
    if (ids.length !== 100 || ids.some(id => typeof id !== 'string') || new Set(ids).size !== 100) {
      throw new Error('Demo fixture does not contain 100 scoped accounts');
    }
    const lumenConfig = join(directory,'lumen-config.json');
    try { await writeFile(lumenConfig,JSON.stringify({ app_id:manifest.app,source_environment:'Production',customer_user_ids:ids }),{ mode:0o600,flag:'wx' }); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
    const lumen = await start(new URL('../../lumen/dist/main.js',import.meta.url),{
      LUMEN_PORT:'0',LUMEN_DB:join(directory,'lumen.sqlite3'),LUMEN_OUTBOX_DB:join(directory,'outbox.sqlite3'),
      RECOVERY_KEY_FILE:keyPath,PROVIDER_URL:providerUrl,LUMEN_LIVE_CONFIG:lumenConfig,LUMEN_DEMO:liveConfig ? 'false' : 'true',
      LUMEN_APP:String(manifest.app),LUMEN_ENVIRONMENT:String(manifest.environment),LUMEN_RUN_ID:String(manifest.run_id),
      LUMEN_LIVE_BOOTSTRAP_PENDING:'false',
      COLLECTOR_URL:`http://127.0.0.1:${port}/api/recovery/collector` },liveConfig ? 160_000 : 30_000);
    children.push(lumen.child);
    const lumenUrl = `http://127.0.0.1:${lumen.port}`;
    engine = await EngineRuntime.create({ key,providerUrl,lumenUrl,databasePath:join(directory,'engine.sqlite3'),
      analyticsDatabasePath:join(directory,'analytics.sqlite3'),accessDatabasePath:join(directory,'access.sqlite3'),
      webRoot:resolve('apps/web/dist'),simulationEnabled:!liveConfig });
    const bound = await engine.listen(port);
    process.stdout.write(`${JSON.stringify({ url:`http://127.0.0.1:${bound}/`,runtime:directory,
      services:{ provider:providerUrl,lumen:lumenUrl },mode:liveConfig ? 'live_seeded_read_only' : 'synthetic_fixture' })}\n`);
    process.once('SIGINT',() => { void stop(); });
    process.once('SIGTERM',() => { void stop(); });
  } catch (error) { await stop(); throw error; }
}

void main().catch((error:unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : 'Demo startup failed'}\n`);
  process.exitCode = 1;
});
