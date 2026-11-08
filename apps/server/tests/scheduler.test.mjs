import test from 'node:test';
import assert from 'node:assert/strict';
import { MonitorScheduler } from '../dist/infrastructure/scheduler.js';

test('source passes run initially and at most once a minute unless a new event wakes them', async () => {
  let now = 0; const calls = [];
  const scheduler = new MonitorScheduler(async source => { calls.push(source); },() => undefined,() => now);
  await scheduler.pulse();
  now = 30_000; await scheduler.pulse();
  now = 60_000; await scheduler.pulse();
  now = 61_000; scheduler.requestSource();
  await scheduler.pulse();
  assert.deepEqual(calls,[true,false,true,true]);
  await scheduler.stop();
  await scheduler.pulse();
  assert.equal(calls.length,4);
});

test('concurrent wakeups coalesce without overlapping passes', async () => {
  let release; const calls = [];
  const scheduler = new MonitorScheduler(async source => { calls.push(source);
    if (calls.length === 1) await new Promise(resolve => { release = resolve; }); },() => undefined);
  const first = scheduler.pulse();
  await Promise.resolve();
  scheduler.requestSource(); scheduler.requestSource();
  release(); await first;
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(calls,[true,true]);
  await scheduler.stop();
});

test('local simulation wakeups do not force extra full provider scans', async () => {
  let now = 0; const calls = [];
  const scheduler = new MonitorScheduler(async source => { calls.push(source); },() => undefined,() => now);
  await scheduler.pulse();
  now = 1_000; scheduler.requestLocal(); await scheduler.pulse();
  now = 2_000; scheduler.requestLocal(); await scheduler.pulse();
  assert.deepEqual(calls,[true,false,false]);
  await scheduler.stop();
});
