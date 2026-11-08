import { constants, closeSync, lstatSync, openSync } from 'node:fs';
import { mkdir, readFile, realpath } from 'node:fs/promises';
import { dirname, resolve, sep } from 'node:path';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { isIP } from 'node:net';
import { DatabaseSync } from 'node:sqlite';
import { semanticDigest } from '../infrastructure/json.js';
import { parseTimestamp } from '../infrastructure/time.js';
import { SQLiteStorage } from '../infrastructure/sqlite.js';
import { collectorRoute } from '../infrastructure/collector-http.js';
import { MonitorScheduler } from '../infrastructure/scheduler.js';
import { LumenAdapter } from '../modules/client/lumen-adapter.js';
import { ProviderAdapter } from '../modules/source/provider-adapter.js';
import { Collector } from '../modules/fulfillment/collector.js';
import { Expectations } from '../modules/fulfillment/expectations.js';
import { FulfillmentRegistry, type FulfillmentState } from '../modules/fulfillment/registry.js';
import { FulfillmentMonitor, type MonitorScope } from '../modules/fulfillment/monitor.js';
import { RecoveryRepository } from '../modules/recovery/repository.js';
import { Reporting, type MonitorOptions } from '../modules/reporting/export.js';
import { AnalyticsDemo } from '../modules/legacy-analytics/demo.js';
import { AccessDemo } from '../modules/legacy-access/demo.js';
import { SimulationRunner, SimulationError } from '../modules/simulation/runner.js';

export interface EngineOptions {
  databasePath:string; analyticsDatabasePath:string; accessDatabasePath:string;
  providerUrl:string; lumenUrl:string; key:Uint8Array; webRoot:string;
  simulationEnabled?:boolean;
}

function isolatedEngineFile(path:string,scopeHash:string):void {
  let info;
  try { info = lstatSync(path); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  if (info) {
    let db:DatabaseSync | undefined;
    try {
      if (!info.isFile() || info.isSymbolicLink() || !info.size) throw new Error('invalid');
      db = new DatabaseSync(path,{ readOnly:true });
      const row = db.prepare("SELECT value FROM engine_runtime_meta WHERE key='scope'").get() as { value:string } | undefined;
      if (row?.value !== scopeHash) throw new Error('invalid');
    } catch { throw new Error('Engine database is not an isolated matching TypeScript runtime'); }
    finally { db?.close(); }
    return;
  }
  const fd = openSync(path,constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,0o600);
  closeSync(fd);
  const db = new DatabaseSync(path);
  try {
    db.exec('BEGIN IMMEDIATE; CREATE TABLE engine_runtime_meta (key TEXT PRIMARY KEY,value TEXT NOT NULL)');
    db.prepare('INSERT INTO engine_runtime_meta VALUES (?,?)').run('scope',scopeHash);
    db.exec('COMMIT');
  } catch (error) { try { db.exec('ROLLBACK'); } catch { /* Preserve the original failure. */ } throw error; }
  finally { db.close(); }
}

function localWrite(request:IncomingMessage):boolean {
  try {
    const host = request.headers.host;
    if (!host) return false;
    const target = new URL(`http://${host}`), hostname = target.hostname.replace(/^\[|\]$/g,'').toLowerCase().replace(/\.$/,'');
    const local = hostname === 'localhost' || hostname === '::1' || (isIP(hostname) === 4 && hostname.split('.')[0] === '127');
    if (!local || target.username || target.password || target.pathname !== '/' || target.search || target.hash
        || Number(target.port || 80) !== request.socket.localPort) return false;
    const rawOrigin = request.headers.origin;
    if (!rawOrigin) return true;
    const origin = new URL(rawOrigin);
    return origin.protocol === 'http:' && origin.hostname.toLowerCase().replace(/\.$/,'') === target.hostname.toLowerCase().replace(/\.$/,'')
      && Number(origin.port || 80) === Number(target.port || 80) && !origin.username && !origin.password
      && origin.pathname === '/' && !origin.search && !origin.hash;
  } catch { return false; }
}

async function jsonBody(request:IncomingMessage):Promise<unknown> {
  if (request.headers['content-type']?.split(';')[0]?.trim().toLowerCase() !== 'application/json') throw new HttpError(415,'Content-Type must be application/json');
  const rawLength = request.headers['content-length'];
  if (!rawLength || !/^\d+$/.test(rawLength)) throw new HttpError(400,'Content-Length required');
  if (Number(rawLength) > 1024*1024) throw new HttpError(413,'Request body too large');
  const chunks:Buffer[] = []; let size = 0;
  for await (const chunk of request) {
    const bytes = Buffer.from(chunk as Uint8Array); size += bytes.length;
    if (size > 1024*1024) throw new HttpError(413,'Request body too large');
    chunks.push(bytes);
  }
  try { return size ? JSON.parse(new TextDecoder('utf-8',{ fatal:true }).decode(Buffer.concat(chunks))) as unknown : {}; }
  catch { throw new HttpError(400,'Invalid JSON'); }
}

class HttpError extends Error { constructor(readonly status:number,message:string) { super(message); } }

function send(response:ServerResponse,status:number,body:unknown,contentType = 'application/json; charset=utf-8'):void {
  const raw = typeof body === 'string' && !contentType.startsWith('application/json') ? body :
    typeof body === 'string' ? body : JSON.stringify(body);
  response.writeHead(status,{ 'Content-Type':contentType,'Content-Length':Buffer.byteLength(raw),
    'Cache-Control':'no-store','X-Content-Type-Options':'nosniff' });
  response.end(raw);
}

function pageValue(value:string | null,fallback:number,max:number):number {
  if (value === null) return fallback;
  if (!/^\d+$/.test(value)) throw new HttpError(400,'Invalid pagination');
  const result = Number(value);
  if (!Number.isSafeInteger(result) || result < 0 || result > max) throw new HttpError(400,'Invalid pagination');
  return result;
}

export class EngineRuntime {
  readonly server:Server;
  private readonly scheduler:MonitorScheduler;
  private schedulerError = false;
  private simulation:SimulationRunner | null = null;

  private constructor(private readonly options:EngineOptions,private readonly scope:MonitorScope,private readonly mode:string,
    private readonly storage:SQLiteStorage, private readonly collector:Collector,private readonly registry:FulfillmentRegistry,
    private readonly reporting:Reporting,private readonly monitor:FulfillmentMonitor,private readonly analytics:AnalyticsDemo,
    private readonly access:AccessDemo) {
    this.scheduler = new MonitorScheduler(source => this.monitor.pass(source),() => { this.schedulerError = true; });
    this.server = createServer((request,response) => { void this.handle(request,response); });
  }

  static async create(options:EngineOptions):Promise<EngineRuntime> {
    if (options.key.byteLength < 32 || new Set([options.databasePath,options.analyticsDatabasePath,options.accessDatabasePath].map(path => resolve(path))).size !== 3) {
      throw new Error('Engine and demo databases must be distinct');
    }
    const provider = new ProviderAdapter(options.providerUrl,options.key), lumen = new LumenAdapter(options.lumenUrl,options.key,'Production');
    const [sourceManifest,clientManifest] = await Promise.all([provider.manifest(),lumen.manifest()]);
    if (sourceManifest.app !== clientManifest.app || sourceManifest.environment !== clientManifest.environment
        || sourceManifest.run_id !== clientManifest.run_id) throw new Error('Provider and Lumen runtime scopes differ');
    const appId = String(sourceManifest.app), environment = String(sourceManifest.environment), runId = String(sourceManifest.run_id);
    const sourceEnvironment = String(sourceManifest.source_environment ?? 'Production');
    if (sourceEnvironment !== 'Production') throw new Error('Unsupported source environment');
    const scope:MonitorScope = { appId,environment,sourceEnvironment,policyRevision:1,
      provenance:sourceManifest.mode === 'live' ? 'official_synthetic_seed' : 'local_fixture' };
    await mkdir(dirname(options.databasePath),{ recursive:true });
    isolatedEngineFile(options.databasePath,semanticDigest({ appId,environment,sourceEnvironment,runId }));
    const storage = new SQLiteStorage(options.databasePath);
    let analytics:AnalyticsDemo | undefined, access:AccessDemo | undefined;
    try {
      const repository = new RecoveryRepository(storage), expectations = new Expectations(storage), registry = new FulfillmentRegistry(storage);
      const reporting = new Reporting(storage), collector = new Collector(storage,options.key,{ app:appId,environment,runId });
      await repository.initialize(); await expectations.initialize(); await registry.initialize(); await reporting.initialize(); await collector.initialize();
      analytics = await AnalyticsDemo.create({ databasePath:options.analyticsDatabasePath });
      access = await AccessDemo.create({ databasePath:options.accessDatabasePath });
      const monitor = new FulfillmentMonitor(scope,lumen,provider,expectations,registry,repository,reporting);
      const runtime = new EngineRuntime(options,scope,sourceManifest.mode === 'live' ? 'LIVE_ADAPTY_SEEDED' : 'LOCAL_ADAPTY_FIXTURE',
        storage,collector,registry,reporting,monitor,analytics,access);
      if (options.simulationEnabled && sourceManifest.mode === 'mock') {
        runtime.simulation = await SimulationRunner.create({ storage,engineDatabasePath:options.databasePath,scope,lumen,provider,
          monitor,registry,repository,handlerVersion:'lumen-handler-v1',configVersion:'lumen-config-v1',
          wakeMonitor:() => runtime.scheduler.requestLocal() });
      }
      return runtime;
    } catch (error) {
      await analytics?.close(); await access?.close(); await storage.close(); throw error;
    }
  }

  listen(port = 0):Promise<number> {
    return new Promise((resolvePort,reject) => {
      this.server.once('error',reject);
      this.server.listen(port,'127.0.0.1',() => {
        this.server.removeListener('error',reject);
        const address = this.server.address();
        if (!address || typeof address === 'string') return reject(new Error('Engine listener unavailable'));
        this.scheduler.start(); resolvePort(address.port);
      });
    });
  }

  async close():Promise<void> {
    await this.simulation?.close();
    await this.scheduler.stop();
    if (this.server.listening) await new Promise<void>((resolveClose,reject) => this.server.close(error => error ? reject(error) : resolveClose()));
    await this.analytics.close(); await this.access.close(); await this.storage.close();
  }

  private async handle(request:IncomingMessage,response:ServerResponse):Promise<void> {
    try {
      if (!localWrite(request)) throw new HttpError(403,'Loopback same-origin request required');
      if (await collectorRoute(this.collector,() => this.scheduler.requestSource())(request,response)) return;
      const url = new URL(request.url ?? '/', 'http://127.0.0.1');
      const method = request.method ?? 'GET';
      if (!['GET','POST'].includes(method)) throw new HttpError(405,'Method not allowed');
      const body = method === 'POST' ? await jsonBody(request) : undefined;
      if (url.pathname.startsWith('/api/recovery/')) {
        await this.recovery(method,url,body,response); return;
      }
      if (url.pathname.startsWith('/api/access/') || url.pathname === '/api/collector/events' || url.pathname === '/mock/lumen/export') {
        const result = await this.access.handle(method,request.url ?? '/',body,request.headers);
        send(response,result.status,result.body,result.contentType); return;
      }
      if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/mock/')) {
        const result = await this.analytics.handle(method,request.url ?? '/',body);
        send(response,result.status,result.body,result.contentType); return;
      }
      if (method !== 'GET') throw new HttpError(404,'Not found');
      await this.staticFile(url.pathname,response);
    } catch (error) {
      if (!response.headersSent && !response.destroyed) send(response,error instanceof HttpError ? error.status : error instanceof SimulationError ? error.statusCode : 500,
        { error:error instanceof HttpError || error instanceof SimulationError ? error.message : 'Request unavailable' });
    }
  }

  private async recovery(method:string,url:URL,body:unknown,response:ServerResponse):Promise<void> {
    const path = url.pathname, status = this.monitor.status();
    if (path === '/api/recovery/simulation') {
      if (!this.simulation) {
        if (method === 'GET') { send(response,200,{ status:'idle',available:false }); return; }
        throw new HttpError(404,'Simulation unavailable');
      }
      if (method === 'GET') { send(response,200,await this.simulation.status()); return; }
      const result = await this.simulation.command(body);
      send(response,(body && typeof body === 'object' && 'action' in body && body.action === 'stop') ? 200 : 202,result); return;
    }
    if (method === 'GET' && path === '/api/recovery/monitor') {
      const cursor = pageValue(url.searchParams.get('cursor'),0,Number.MAX_SAFE_INTEGER);
      const limit = pageValue(url.searchParams.get('limit'),50,200);
      const filter = url.searchParams.get('status') ?? 'needs_attention';
      if (!limit || !['needs_attention','detecting','repairing','repaired'].includes(filter)) throw new HttpError(400,'Invalid incident filter');
      const result = await this.reporting.monitor(this.scope.appId,this.scope.environment,{ cursor,limit,
        status:filter as MonitorOptions['status'],mode:this.mode,title:'Lumen',sourceReady:status.sourceReady,
        sourceFresh:status.sourceFresh,lastError:status.lastError ?? (this.schedulerError ? 'scheduler_unavailable' : null) });
      const feed = JSON.parse(result.body) as Record<string,unknown>;
      feed.simulation = this.simulation ? await this.simulation.status() : { status:'idle',available:false };
      send(response,200,feed,result.contentType); return;
    }
    if (method === 'GET' && path === '/api/recovery/fulfillments') {
      const cursor = pageValue(url.searchParams.get('cursor'),0,Number.MAX_SAFE_INTEGER), limit = pageValue(url.searchParams.get('limit'),50,200);
      if (!limit) throw new HttpError(400,'Invalid fulfillment page');
      const filter = url.searchParams.get('status') ?? undefined;
      try { send(response,200,await this.registry.list(this.scope.appId,this.scope.environment,cursor,limit,filter as FulfillmentState | undefined)); }
      catch { throw new HttpError(400,'Invalid fulfillment page'); }
      return;
    }
    if (method === 'GET' && path === '/api/recovery/export') {
      const now = Date.now(), to = url.searchParams.get('to') ?? new Date(now).toISOString();
      const from = url.searchParams.get('from') ?? new Date(now-86_400_000).toISOString();
      const format = url.searchParams.get('format') ?? 'json';
      if (format !== 'csv' && format !== 'json') throw new HttpError(400,'Invalid export format');
      if (!from.endsWith('Z') || !to.endsWith('Z') || !Number.isFinite(parseTimestamp(from))
          || !Number.isFinite(parseTimestamp(to)) || parseTimestamp(from) >= parseTimestamp(to)) throw new HttpError(400,'Invalid export range');
      const result = await this.reporting.export(this.scope.appId,this.scope.environment,from,to,format);
      send(response,200,result.body,result.contentType); return;
    }
    const trace = /^\/api\/recovery\/incidents\/([^/]+)\/trace$/.exec(path);
    if (method === 'GET' && trace) {
      try { send(response,200,await this.reporting.trace(this.scope.appId,this.scope.environment,decodeURIComponent(trace[1]!))); }
      catch (error) { if (error instanceof Error && error.message === 'Incident not found') throw new HttpError(404,'Incident not found'); throw error; }
      return;
    }
    throw new HttpError(501,'This recovery endpoint is not yet available in the TypeScript runtime');
  }

  private async staticFile(pathname:string,response:ServerResponse):Promise<void> {
    const pages = new Set(['/','/index.html','/analytics.html','/access.html','/recovery.html','/recovery-console.html','/legacy.html']);
    if (!pages.has(pathname) && !pathname.startsWith('/assets/')) throw new HttpError(404,'Not found');
    try {
      const root = await realpath(this.options.webRoot), filename = pages.has(pathname) ? 'index.html' : pathname.slice(1);
      const file = await realpath(resolve(root,filename));
      if (!file.startsWith(root+sep)) throw new Error('invalid');
      const content = await readFile(file);
      if (content.length > 10*1024*1024) throw new Error('invalid');
      const type = filename.endsWith('.html') ? 'text/html; charset=utf-8' : filename.endsWith('.js') ? 'text/javascript; charset=utf-8'
        : filename.endsWith('.css') ? 'text/css; charset=utf-8' : filename.endsWith('.woff2') ? 'font/woff2' : 'application/octet-stream';
      response.writeHead(200,{ 'Content-Type':type,'Content-Length':content.length,'X-Content-Type-Options':'nosniff' }); response.end(content);
    } catch { throw new HttpError(404,'Web asset unavailable'); }
  }
}
