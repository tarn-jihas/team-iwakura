import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { createServer, request as httpRequest } from 'node:http';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { monitorEventLoopDelay, performance } from 'node:perf_hooks';
import { pathToFileURL } from 'node:url';
import { SQLiteStorage } from '../dist/infrastructure/sqlite.js';
import { ProviderAdapter } from '../dist/modules/source/provider-adapter.js';
import { LumenAdapter } from '../dist/modules/client/lumen-adapter.js';
import { Expectations } from '../dist/modules/fulfillment/expectations.js';
import { classifyFulfillment } from '../dist/modules/fulfillment/classification.js';
import { scanFulfillments } from '../dist/modules/fulfillment/scan.js';
import { persistScan } from '../dist/modules/fulfillment/persist-scan.js';
import { FulfillmentRegistry } from '../dist/modules/fulfillment/registry.js';
import { RecoveryRepository } from '../dist/modules/recovery/repository.js';
import { RecoveryExecution } from '../dist/modules/recovery/execution.js';
import { ExternalResolution } from '../dist/modules/recovery/external-resolution.js';
import { prepareRecovery } from '../dist/modules/recovery/preview.js';
import { Reporting } from '../dist/modules/reporting/export.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const offsetMs = 31_000;
const sourceEnvironment = 'Production';
const appEnvironment = 'Production';
const sampleSize = 100;
const defaultStressCycles = 1_000;
const defaultCheckpointCycles = 100;
const faultKinds = ['missed_projection', 'stale_cache', 'out_of_order'];

function clock() { return new Date(Date.now() + offsetMs); }

function percentiles(values) {
  if (!values.length) return { p50_ms: 0, p95_ms: 0, max_ms: 0 };
  const sorted = [...values].sort((left, right) => left - right);
  const at = percentile => sorted[Math.min(sorted.length - 1, Math.ceil(percentile * sorted.length) - 1)];
  return { p50_ms: at(0.50), p95_ms: at(0.95), max_ms: sorted.at(-1) };
}

function quartiles(values) {
  return Object.fromEntries([0, 1, 2, 3].map(index => {
    const start = Math.floor(index * values.length / 4);
    const end = Math.floor((index + 1) * values.length / 4);
    return [`q${index + 1}`, percentiles(values.slice(start, end))];
  }));
}

function fileBytes(path) {
  try { return statSync(path).size; }
  catch (error) { if (error.code === 'ENOENT') return 0; throw error; }
}

function storageBytes(paths) {
  return Object.fromEntries(Object.entries(paths).map(([name, path]) => [name, {
    database_bytes: fileBytes(path), wal_bytes: fileBytes(`${path}-wal`),
  }]));
}

function growth(before, after) {
  return Object.fromEntries(Object.keys(before).map(name => [name, {
    database_bytes: after[name].database_bytes - before[name].database_bytes,
    wal_bytes: after[name].wal_bytes - before[name].wal_bytes,
  }]));
}

async function waitForChild(child, role) {
  return new Promise((resolveReady, reject) => {
    let stdout = '';
    let stderr = '';
    let settled = false;
    const timer = setTimeout(() => finish(new Error(`${role} startup timed out: ${stderr.slice(-3000)}`)), 30_000);
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.stdout?.removeListener('data', onData);
      child.stderr?.removeListener('data', onError);
      child.removeListener('error', onSpawnError);
      child.removeListener('exit', onExit);
      if (error) reject(error); else resolveReady(value);
    };
    const onData = chunk => {
      stdout += chunk.toString();
      const newline = stdout.indexOf('\n');
      if (newline < 0) return;
      try {
        const message = JSON.parse(stdout.slice(0, newline));
        if (!Number.isInteger(message.port) || message.port < 1 || message.port > 65535) throw new Error('invalid port');
        finish(null, message.port);
      } catch (error) { finish(new Error(`${role} startup response was invalid: ${error.message}`)); }
    };
    const onError = chunk => { stderr += chunk.toString(); };
    const onSpawnError = error => finish(error);
    const onExit = code => finish(new Error(`${role} exited before startup (${code}): ${stderr.slice(-3000)}`));
    child.stdout.on('data', onData);
    child.stderr.on('data', onError);
    child.once('error', onSpawnError);
    child.once('exit', onExit);
  });
}

async function stopChild(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  child.kill('SIGTERM');
  await new Promise(resolveExit => {
    const timer = setTimeout(() => { child.kill('SIGKILL'); resolveExit(); }, 5_000);
    child.once('exit', () => { clearTimeout(timer); resolveExit(); });
  });
}

async function startSourceProxy(upstreamUrl) {
  const metrics = { sourceReads: 0, sourceFailures: 0 };
  const server = createServer((incoming, outgoing) => {
    const path = incoming.url ?? '/';
    const isSourceRead = incoming.method === 'GET' && path.startsWith('/internal/adapty/profile?');
    if (isSourceRead) metrics.sourceReads++;
    const headers = Object.fromEntries(Object.entries(incoming.headers).filter(([name]) =>
      !['connection', 'host', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'te',
        'trailer', 'transfer-encoding', 'upgrade'].includes(name)));
    let countedFailure = false;
    const failed = () => {
      if (isSourceRead && !countedFailure) { metrics.sourceFailures++; countedFailure = true; }
    };
    const upstream = httpRequest(new URL(path, upstreamUrl), { method: incoming.method, headers }, response => {
      if (isSourceRead && (response.statusCode ?? 500) >= 400) failed();
      outgoing.writeHead(response.statusCode ?? 502, response.headers);
      response.pipe(outgoing);
    });
    upstream.on('error', () => {
      failed();
      if (!outgoing.headersSent) outgoing.writeHead(502, { 'Content-Type': 'application/json' });
      outgoing.end('{"error":"isolated source transport unavailable"}');
    });
    incoming.pipe(upstream);
  });
  await new Promise((resolveListen, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolveListen);
  });
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  return { server, url: `http://127.0.0.1:${address.port}`, metrics,
    close: () => new Promise((resolveClose, reject) => server.close(error => error ? reject(error) : resolveClose())) };
}

function watchChildRss(child, role, current, peaks) {
  let pending = '';
  child.stderr.on('data', chunk => {
    pending += chunk.toString();
    let newline;
    while ((newline = pending.indexOf('\n')) >= 0) {
      const line = pending.slice(0, newline).trim();
      pending = pending.slice(newline + 1);
      const match = /^__RECOVERY_RSS__ (\d+) (\d+)$/.exec(line);
      if (!match || Number(match[1]) !== child.pid) continue;
      current[role] = Number(match[2]);
      peaks[role] = Math.max(peaks[role], current[role]);
    }
  });
}

async function runSuite({ name, cycles, verifyHistory = false }) {
  const directory = await mkdtemp(join(tmpdir(), `reconcile-${name}-`));
  const key = randomBytes(32);
  const keyPath = join(directory, 'internal.key');
  const liveConfigPath = join(directory, 'lumen-live.json');
  const paths = {
    provider: join(directory, 'provider.sqlite'), lumen: join(directory, 'lumen.sqlite'),
    outbox: join(directory, 'outbox.sqlite'), engine: join(directory, 'engine.sqlite'),
  };
  let providerChild, lumenChild, proxy, storage;
  let report;
  const latencies = [];
  const failures = [];
  const rssCurrent = { benchmark: process.memoryUsage().rss, provider: 0, lumen: 0 };
  const rssPeaks = { benchmark: rssCurrent.benchmark, provider: 0, lumen: 0 };
  const loopDelay = monitorEventLoopDelay({ resolution: 20 });
  let rssTimer;
  const rssProbeUrl = pathToFileURL(resolve(dirname(fileURLToPath(import.meta.url)), 'rss-probe.mjs')).href;
  const nodeOptions = [process.env.NODE_OPTIONS, `--import=${rssProbeUrl}`].filter(Boolean).join(' ');
  try {
    await writeFile(keyPath, key.toString('hex'), { mode: 0o600 });
    providerChild = spawn(process.execPath, [resolve(root, 'apps/provider-simulator/dist/main.js')], {
      cwd: root, env: { ...process.env, PROVIDER_PORT: '0', PROVIDER_MODE: 'mock',
        PROVIDER_DB: paths.provider, PROVIDER_RUN_ID: `stress-${randomUUID().replaceAll('-', '').slice(0, 12)}`,
        PROVIDER_SAMPLE_SIZE: String(sampleSize), PROVIDER_ACTIVE_OVERLAY: 'true', RECOVERY_KEY_FILE: keyPath,
        NODE_OPTIONS: nodeOptions, RECONCILE_BENCH_RSS_ROLE: 'provider' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    watchChildRss(providerChild, 'provider', rssCurrent, rssPeaks);
    const providerPort = await waitForChild(providerChild, 'provider');
    proxy = await startSourceProxy(`http://127.0.0.1:${providerPort}`);
    const provider = new ProviderAdapter(proxy.url, key);
    const manifest = await provider.manifest();
    const providerPage = await provider.accounts(null, sampleSize);
    assert.equal(manifest.mode, 'mock');
    assert.equal(manifest.synthetic_active_overlay, true);
    assert.equal(manifest.payment_verification, 'unverified_synthetic_history');
    assert.equal(providerPage.items.length, sampleSize);
    assert.equal(providerPage.total, sampleSize);
    const customerIds = providerPage.items.map(item => item.user_id);
    assert.equal(new Set(customerIds).size, sampleSize);
    await writeFile(liveConfigPath, JSON.stringify({ app_id: manifest.app_id,
      source_environment: sourceEnvironment, customer_user_ids: customerIds }));

    lumenChild = spawn(process.execPath, [resolve(root, 'apps/lumen/dist/main.js')], {
      cwd: root, env: { ...process.env, LUMEN_PORT: '0', LUMEN_DB: paths.lumen,
        LUMEN_OUTBOX_DB: paths.outbox, RECOVERY_KEY_FILE: keyPath, PROVIDER_URL: proxy.url,
        LUMEN_LIVE_CONFIG: liveConfigPath, LUMEN_DEMO: 'true', NODE_OPTIONS: nodeOptions,
        RECONCILE_BENCH_RSS_ROLE: 'lumen' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    watchChildRss(lumenChild, 'lumen', rssCurrent, rssPeaks);
    const lumenPort = await waitForChild(lumenChild, 'lumen');
    const lumen = new LumenAdapter(`http://127.0.0.1:${lumenPort}`, key, sourceEnvironment);
    storage = new SQLiteStorage(paths.engine);
    const expectations = new Expectations(storage);
    const registry = new FulfillmentRegistry(storage);
    const repository = new RecoveryRepository(storage);
    const reporting = new Reporting(storage, clock);
    await repository.initialize();
    await expectations.initialize();
    await registry.initialize();
    await reporting.initialize();
    const external = new ExternalResolution(repository, lumen, clock);
    const scope = { appId: String(manifest.app_id), environment: appEnvironment,
      sourceEnvironment, policyRevision: 1 };
    const accountPage = await lumen.listAccounts(null, sampleSize);
    assert.equal(accountPage.total, sampleSize);
    const selected = accountPage.items.slice(0, 2).map(item => item.user_id);
    assert.equal(selected.length, 2);
    assert.ok(selected.every(userId => customerIds.includes(userId)));

    const wasVerified = (userId, entitlement) => registry.wasVerified({ app: scope.appId,
      environment: scope.environment, store: entitlement.store, transactionId: entitlement.transaction_id,
      userId, accessLevel: 'premium' }, entitlement.source_fingerprint, entitlement.entitlement_hash);
    const scan = async (userIds, incidentId) => scanFulfillments(lumen, provider, expectations,
      scope.appId, scope.sourceEnvironment, clock, async userId => {
        const [registryOwned, repositoryOwned] = await Promise.all([
          registry.ownedByAnother(scope.appId, scope.environment, userId, incidentId),
          repository.ownedByAnother(scope.appId, scope.environment, userId, incidentId),
        ]);
        return registryOwned || repositoryOwned;
      }, new Set(userIds), wasVerified);
    const persist = scanResult => persistScan(registry, scanResult, scope.appId, scope.environment,
      (incidentId, current) => external.resolve(incidentId, scope.appId, scope.environment, current));

    const baseline = await scan(selected);
    assert.equal(baseline.coverage.registered, sampleSize);
    assert.equal(baseline.coverage.scanned, 2);
    assert.ok(baseline.observations.every(item => classifyFulfillment(item).status === 'healthy'),
      'selected official fixture accounts must be independently source-backed and healthy before fault injection');
    assert.equal((await persist(baseline)).length, 0);
    await reporting.updateCoverage(baseline.coverage, 'local_fixture');
    const beforeBytes = storageBytes(paths);
    const sourceReadsBefore = proxy.metrics.sourceReads;
    const rangeStart = clock().toISOString();
    const runStarted = performance.now();
    loopDelay.enable();
    rssTimer = setInterval(() => {
      rssCurrent.benchmark = process.memoryUsage().rss;
      rssPeaks.benchmark = Math.max(rssPeaks.benchmark, rssCurrent.benchmark);
    }, 250);
    rssTimer.unref();

    for (let cycle = 0; cycle < cycles; cycle++) {
      const started = performance.now();
      try {
        const occurredAt = new Date().toISOString();
        const operationKey = `${name}-${cycle + 1}-${randomUUID()}`;
        const injection = { user_ids: selected, handler_version: 'stress-handler-v1',
          config_version: 'premium-export-v2', occurred_at: occurredAt,
          fault_kind: faultKinds[cycle % faultKinds.length], operation_key: operationKey };
        const accepted = await lumen.injectDemo(injection);
        assert.equal(accepted.request_hash, (await lumen.readInjection(operationKey))?.request_hash,
          'injection must be durably readable before using its observed effects');

        const detected = await scan(selected);
        assert.equal(detected.coverage.sourceRead, selected.length);
        assert.ok(detected.observations.every(item => {
          const classification = classifyFulfillment(item);
          return classification.status === 'confirmed' && classification.eligible;
        }), `cycle ${cycle + 1} did not independently detect the injected projection discrepancy`);
        const pending = await persist(detected);
        assert.equal(pending.length, selected.length, `cycle ${cycle + 1} did not persist all detected targets`);
        const incidentId = randomUUID();
        assert.equal(await registry.claimIncident(incidentId, scope.appId, scope.environment,
          pending.map(item => item.identityHash), clock().toISOString()), true,
        `cycle ${cycle + 1} failed to atomically claim its detected cohort`);

        const preview = prepareRecovery(scope.appId, detected.current, selected, clock());
        const createdAt = clock().toISOString();
        const expiresAt = new Date(Date.parse(createdAt) + 300_000).toISOString();
        const snapshotId = randomUUID();
        const snapshotHash = await repository.saveSnapshot(snapshotId, incidentId, {
          appId: scope.appId, environment: scope.environment, targets: preview.targets,
          evidence: preview.evidence, coverage: detected.coverage,
        }, createdAt);
        const planId = randomUUID();
        const plan = { id: planId, incidentId, snapshotId, snapshotHash, appId: scope.appId,
          environment: scope.environment, policyRevision: scope.policyRevision, createdAt, expiresAt,
          targets: preview.targets, actions: preview.actions };
        const planHash = await repository.savePlan(planId, incidentId, snapshotId, plan, createdAt, expiresAt);
        await repository.approve(randomUUID(), planId, planHash, 'stress-automatic-policy', createdAt);
        const observe = async userIds => (await scan(userIds, incidentId)).current;
        const execution = new RecoveryExecution(repository, lumen, observe, clock);
        const actions = await execution.execute(planId, scope);
        assert.equal(actions.length, selected.length * 2);
        assert.ok(actions.every(action => action.status === 'verified'),
          `cycle ${cycle + 1} did not verify every durable resync and gate action`);
        for (const userId of selected) {
          const gate = await lumen.probeAccess(userId);
          assert.equal(gate.allowed, true, `cycle ${cycle + 1} gate denied ${userId} after recovery`);
          assert.equal(gate.active, true);
          const current = detected.current.get(userId);
          assert.equal(gate.identity_revision, current.identityRevision,
            `cycle ${cycle + 1} identity revision changed for ${userId}`);
          assert.equal(gate.policy_revision, current.policyRevision,
            `cycle ${cycle + 1} policy revision changed for ${userId}`);
        }

        const restored = await scan(selected);
        assert.ok(restored.observations.every(item => classifyFulfillment(item).status === 'healthy'),
          `cycle ${cycle + 1} failed independent post-recovery source and gate assessment`);
        await persist(restored);
        const listed = await registry.list(scope.appId, scope.environment, 0, 200, 'verified_application');
        assert.ok(selected.every(userId => listed.items.some(item => item.key.customer_id === userId)),
          `cycle ${cycle + 1} did not persist the verified application state`);
        latencies.push(performance.now() - started);
        if ((cycle + 1) % 100 === 0 || cycle + 1 === cycles) {
          process.stderr.write(`${JSON.stringify({ progress: name, completed_cycles: cycle + 1,
            total_cycles: cycles, elapsed_ms: Math.round(performance.now() - runStarted) })}\n`);
        }
      } catch (error) {
        failures.push({ cycle: cycle + 1, message: error instanceof Error ? error.message : String(error) });
        break;
      }
    }

    clearInterval(rssTimer);
    rssTimer = undefined;
    loopDelay.disable();
    rssCurrent.benchmark = process.memoryUsage().rss;
    rssPeaks.benchmark = Math.max(rssPeaks.benchmark, rssCurrent.benchmark);
    const sourceReadsAfter = proxy.metrics.sourceReads;
    let immutableExport = null;
    if (verifyHistory && failures.length === 0 && latencies.length === cycles) {
      try {
        const rangeEnd = new Date(clock().getTime() + 1_000).toISOString();
        const first = JSON.parse((await reporting.export(scope.appId, scope.environment,
          rangeStart, rangeEnd, 'json')).body);
        assert.equal(first.incidents.length, cycles);
        assert.ok(first.incidents.every(incident => incident.status === 'repaired'
          && incident.affected_accounts === selected.length && incident.repaired_accounts === selected.length));
        assert.ok(first.incidents.every(incident => selected.every(userId => {
          const writes = incident.actions.filter(action => action.action === 'resync_access' && action.user_id === userId);
          const gates = incident.actions.filter(action => action.action === 'verify_gate' && action.user_id === userId);
          return writes.filter(action => action.status === 'verified').length === 1
            && gates.filter(action => action.status === 'verified').length === 1;
        })), 'every target must have a verified write and verified gate in the export');
        await assert.rejects(storage.statement({ mode: 'run', sql: 'UPDATE fulfillment_history SET reason=reason WHERE sequence=(SELECT MIN(sequence) FROM fulfillment_history)' }),
          /immutable/i, 'fulfillment history must reject mutation');
        const second = JSON.parse((await reporting.export(scope.appId, scope.environment,
          rangeStart, rangeEnd, 'json')).body);
        assert.deepEqual(second.incidents, first.incidents,
          'exported recovery history must remain unchanged after later reads and a rejected mutation');
        immutableExport = { incidents: first.incidents.length,
          repaired_accounts: first.incidents.reduce((total, incident) => total + incident.repaired_accounts, 0),
          stable_reexport: true, rejected_history_update: true };
      } catch (error) {
        failures.push({ cycle: cycles, phase: 'immutable_history_export',
          message: error instanceof Error ? error.message : String(error) });
      }
    }

    const afterBytes = storageBytes(paths);
    const eventLoop = {
      mean_ms: Number.isFinite(loopDelay.mean) ? loopDelay.mean / 1e6 : 0,
      p95_ms: loopDelay.percentile(95) / 1e6,
      max_ms: loopDelay.max / 1e6,
    };
    const elapsedMs = performance.now() - runStarted;
    report = {
      name, requested_cycles: cycles, completed_cycles: latencies.length, failures,
      duration_ms: { cycles_total: elapsedMs, ...percentiles(latencies), quartiles: quartiles(latencies) },
      peak_rss_bytes: { per_process: rssPeaks,
        sampled_sum_bytes: rssPeaks.benchmark + rssPeaks.provider + rssPeaks.lumen },
      database_wal_before: beforeBytes, database_wal_after: afterBytes,
      database_wal_growth: growth(beforeBytes, afterBytes),
      source_reads: { baseline: sourceReadsBefore, during_cycles: sourceReadsAfter - sourceReadsBefore,
        total: sourceReadsAfter, failures: proxy.metrics.sourceFailures },
      event_loop_latency: eventLoop, immutable_history_export: immutableExport,
      fixture_provenance: { source: 'official_hackathon_synthetic_fixture',
        active_overlay: true, payment_verification: 'unverified_synthetic_history' },
    };
    return report;
  } finally {
    clearInterval(rssTimer);
    loopDelay.disable();
    await storage?.close().catch(() => undefined);
    await proxy?.close().catch(() => undefined);
    await stopChild(lumenChild);
    await stopChild(providerChild);
    await rm(directory, { recursive: true, force: true });
  }
}

const args = process.argv.slice(2);
const smoke = args.includes('--smoke');
const sample = args.includes('--sample');
assert.ok(args.every(argument => argument === '--smoke' || argument === '--sample') && !(smoke && sample),
  'Only one optional flag, --smoke or --sample, is supported');
const stressCycles = smoke ? 3 : sample ? 100 : Number(process.env.RECOVERY_STRESS_CYCLES ?? defaultStressCycles);
const exportCycles = smoke ? 3 : sample ? 0 : defaultCheckpointCycles;
assert.ok(Number.isSafeInteger(stressCycles) && (smoke || sample || stressCycles >= defaultStressCycles),
  `RECOVERY_STRESS_CYCLES must be an integer of at least ${defaultStressCycles}`);

const results = [];
try {
  results.push(await runSuite({ name: 'recovery-stress', cycles: stressCycles }));
  assert.equal(results.at(-1).failures.length, 0,
    `recovery-stress had a failure: ${results.at(-1).failures[0]?.message}`);
  assert.equal(results.at(-1).completed_cycles, stressCycles, 'recovery-stress completed fewer cycles than requested');
  if (exportCycles > 0) {
    results.push(await runSuite({ name: 'recovery-history-checkpoint', cycles: exportCycles, verifyHistory: true }));
    assert.equal(results.at(-1).failures.length, 0,
      `recovery-history-checkpoint had a failure: ${results.at(-1).failures[0]?.message}`);
    assert.equal(results.at(-1).completed_cycles, exportCycles,
      'recovery-history-checkpoint completed fewer cycles than requested');
    assert.ok(results.at(-1).immutable_history_export, 'history/export checkpoint did not run');
  }
  process.stdout.write(`${JSON.stringify({ schema_version: 1,
    mode: smoke ? 'smoke_only' : sample ? 'measured_sample' : 'integration_stress',
    suites: results }, null, 2)}\n`);
} catch (error) {
  process.stderr.write(`${JSON.stringify({ schema_version: 1,
    mode: smoke ? 'smoke_only' : sample ? 'measured_sample' : 'integration_stress', suites: results,
    failure: error instanceof Error ? error.message : String(error) }, null, 2)}\n`);
  process.exitCode = 1;
}
