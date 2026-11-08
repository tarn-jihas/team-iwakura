import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdir, mkdtemp, readdir, rm, stat } from 'node:fs/promises';
import { monitorEventLoopDelay, performance } from 'node:perf_hooks';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { CollectorSDK, canonical } from '@reconcile/server-sdk';
import { SQLiteStorage } from '../dist/infrastructure/sqlite.js';
import { collectorRoute } from '../dist/infrastructure/collector-http.js';
import { Collector } from '../dist/modules/fulfillment/collector.js';

const DEFAULT_EVENTS = 1_000;
const MAX_EVENTS = 10_000;
const KEY = createHash('sha256').update('reconcile sdk overhead benchmark only').digest();
const SCOPE = { runId: `sdk-benchmark-${process.pid}`, app: 'benchmark', environment: 'sandbox' };

function eventCountFromArgs(args) {
  if (args.length === 0) return DEFAULT_EVENTS;
  if (args.length !== 2 || args[0] !== '--events') {
    throw new Error('Usage: node apps/server/benchmarks/sdk-overhead.mjs [--events 1000]');
  }
  const count = Number(args[1]);
  if (!Number.isSafeInteger(count) || count < DEFAULT_EVENTS || count > MAX_EVENTS) {
    throw new Error(`--events must be an integer from ${DEFAULT_EVENTS} to ${MAX_EVENTS}`);
  }
  return count;
}

function percentile(values, fraction) {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.max(0, Math.ceil(fraction * sorted.length) - 1)];
}

function finiteMs(nanoseconds) {
  return Number.isFinite(nanoseconds) ? nanoseconds / 1_000_000 : null;
}

async function directoryBytes(directory) {
  let bytes = 0;
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) bytes += await directoryBytes(path);
    else if (entry.isFile()) bytes += (await stat(path)).size;
  }
  return bytes;
}

function detailsFor(traceEnabled, eventTime, index) {
  const base = {
    event_type: 'subscription_renewal_cancelled',
    handler_version: traceEnabled ? 'cancel-handler-v2' : 'cancel-handler-v1',
    received_at: eventTime,
    processed_at: eventTime,
    outcome: 'completed',
    reason_code: 'handler_completed',
  };
  if (!traceEnabled) return base;
  return {
    ...base,
    processing_id: `processing-${index}`,
    trace_id: `trace-${index}`,
    transaction_id: `transaction-${index}`,
    steps: [{
      name: 'handler', status: 'completed', owner: 'lumen', result: 'verified', at: eventTime,
    }],
    revisions: { projection: 1 },
    projection_version: 'projection-v1',
    adapter_version: 'adapter-v1',
    source_hash: 'a'.repeat(64),
  };
}

function eventForSize(traceEnabled, index, eventTime, details) {
  const eventId = `${traceEnabled ? 'trace-on' : 'trace-off'}-${index}`;
  return {
    schema_version: traceEnabled ? 2 : 1,
    event_id: eventId,
    run_id: SCOPE.runId,
    app: SCOPE.app,
    environment: SCOPE.environment,
    app_user_id: `benchmark-user-${index % 100}`,
    kind: 'handler_completed',
    occurred_at: eventTime,
    correlation_id: eventId,
    source_event_id: eventId,
    details,
  };
}

async function runScenario(directory, count, traceEnabled) {
  const scenarioDirectory = join(directory, traceEnabled ? 'trace-on' : 'trace-off');
  await mkdir(scenarioDirectory, { recursive: true });
  const storage = new SQLiteStorage(join(scenarioDirectory, 'collector.sqlite'));
  const eventLoop = monitorEventLoopDelay({ resolution: 10 });
  let server;
  let httpRequests = 0;
  let httpRequestBodyBytes = 0;
  let missingContentLength = 0;
  try {
    const collector = new Collector(storage, KEY, SCOPE);
    await collector.initialize();
    const route = collectorRoute(collector);
    server = createServer((request, response) => {
      httpRequests += 1;
      const length = request.headers['content-length'];
      if (typeof length === 'string' && /^\d+$/u.test(length)) httpRequestBodyBytes += Number(length);
      else missingContentLength += 1;
      void route(request, response).catch(() => {
        if (!response.headersSent) response.writeHead(500, { 'Content-Type': 'application/json' });
        response.end(JSON.stringify({ error: 'Collector unavailable' }));
      });
    });
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });

    const sdk = new CollectorSDK({
      key: KEY,
      ...SCOPE,
      outboxPath: join(scenarioDirectory, 'outbox.sqlite'),
      collectorUrl: `http://127.0.0.1:${server.address().port}/api/recovery/collector`,
    });
    const enqueueLatenciesMs = [];
    let serializedPayloadBytes = 0;
    let minPayloadBytes = Number.POSITIVE_INFINITY;
    let maxPayloadBytes = 0;
    const memoryBefore = process.memoryUsage();
    eventLoop.enable();

    const workloadStarted = performance.now();
    const enqueueStarted = workloadStarted;
    for (let index = 0; index < count; index += 1) {
      const eventTime = new Date(Date.now()).toISOString();
      const details = detailsFor(traceEnabled, eventTime, index);
      const eventId = `${traceEnabled ? 'trace-on' : 'trace-off'}-${index}`;
      const start = performance.now();
      const receipt = sdk.emit('handler_completed', `benchmark-user-${index % 100}`, eventTime,
        details, { eventId, sourceEventId: eventId, correlationId: eventId, schemaVersion: traceEnabled ? 2 : 1 });
      enqueueLatenciesMs.push(performance.now() - start);
      assert.equal(receipt.queued, true, `event ${index} should be durably queued`);
      const eventBytes = Buffer.byteLength(canonical(eventForSize(traceEnabled, index, eventTime, details)));
      serializedPayloadBytes += eventBytes;
      minPayloadBytes = Math.min(minPayloadBytes, eventBytes);
      maxPayloadBytes = Math.max(maxPayloadBytes, eventBytes);
      if (index % 100 === 99) await new Promise(resolve => setImmediate(resolve));
    }
    const enqueueElapsedMs = performance.now() - enqueueStarted;
    assert.equal(httpRequests, 0, 'emit must not make HTTP requests');
    const queued = sdk.coverage();
    assert.equal(queued.queued, count, 'all events should be durably queued before flush');
    assert.equal(queued.accepted, 0, 'events should not be accepted before flush');

    const flushStarted = performance.now();
    const flushTotals = { accepted: 0, dropped: 0, failed: 0, retries: 0 };
    const maximumFlushes = Math.ceil(count / 25) + 2;
    for (let flushNumber = 0; flushNumber < maximumFlushes; flushNumber += 1) {
      const result = await sdk.flush();
      for (const key of Object.keys(flushTotals)) flushTotals[key] += result[key];
      if (sdk.coverage().queued === 0) break;
    }
    const flushElapsedMs = performance.now() - flushStarted;
    const coverage = sdk.coverage();
    assert.equal(coverage.queued, 0, 'flush should drain the outbox');
    assert.equal(coverage.accepted, count, 'collector should accept every event');
    assert.equal(coverage.dropped, 0, 'no benchmark event should be dropped');
    assert.equal(coverage.retries, 0, 'loopback collector should not require retries');
    assert.equal(httpRequests, count, 'each event should use one collector request');

    const elapsedMs = performance.now() - workloadStarted;
    await delay(25);
    eventLoop.disable();
    const memoryAfter = process.memoryUsage();
    await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    await storage.close();
    const storageBytes = await directoryBytes(scenarioDirectory);
    return {
      trace_enabled: traceEnabled,
      event_count: count,
      enqueue_latency_ms: {
        p50: percentile(enqueueLatenciesMs, 0.50),
        p95: percentile(enqueueLatenciesMs, 0.95),
        elapsed: enqueueElapsedMs,
      },
      serialized_event_payload_bytes: {
        total: serializedPayloadBytes,
        mean: serializedPayloadBytes / count,
        min: minPayloadBytes,
        max: maxPayloadBytes,
      },
      http: {
        requests: httpRequests,
        request_body_bytes: httpRequestBodyBytes,
        missing_content_length: missingContentLength,
      },
      counts: {
        emitted: count,
        queued_at_emit: count,
        accepted: coverage.accepted,
        queued_after_flush: coverage.queued,
        dropped: coverage.dropped,
        retries: coverage.retries,
        failed: coverage.failed,
        flush_result: flushTotals,
      },
      flush_elapsed_ms: flushElapsedMs,
      elapsed_ms: elapsedMs,
      event_loop_delay_ms: {
        min: finiteMs(eventLoop.min),
        mean: finiteMs(eventLoop.mean),
        p50: finiteMs(eventLoop.percentile(50)),
        p95: finiteMs(eventLoop.percentile(95)),
        max: finiteMs(eventLoop.max),
      },
      process_memory_bytes: {
        before: memoryBefore,
        after: memoryAfter,
        delta: Object.fromEntries(Object.keys(memoryAfter).map(key => [key, memoryAfter[key] - memoryBefore[key]])),
      },
      sqlite_storage_bytes: storageBytes,
    };
  } finally {
    eventLoop.disable();
    if (server?.listening) await new Promise(resolve => server.close(resolve));
    await storage.close().catch(() => undefined);
  }
}

async function main() {
  const count = eventCountFromArgs(process.argv.slice(2));
  const directory = await mkdtemp(join(tmpdir(), 'reconcile-sdk-overhead-'));
  const startedAt = new Date().toISOString();
  try {
    const scenarios = [];
    for (const traceEnabled of [false, true]) {
      scenarios.push(await runScenario(directory, count, traceEnabled));
    }
    process.stdout.write(`${JSON.stringify({
      benchmark: 'reconcile-sdk-collector-overhead',
      started_at: startedAt,
      node: process.version,
      platform: process.platform,
      architecture: process.arch,
      scope: 'SDK and collector only; not the independent 1,000-cycle recovery acceptance test or a production performance guarantee.',
      isolation: 'Fresh temporary outbox and collector SQLite databases per scenario; local OS-assigned 127.0.0.1 ports; no provider calls.',
      scenarios,
    }, null, 2)}\n`);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

main().catch(error => {
  process.stderr.write(`${error instanceof Error ? error.message : 'Benchmark failed'}\n`);
  process.exitCode = 1;
});
