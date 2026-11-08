import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp,rm,writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

test('isolated TypeScript monolith serves Preact, monitoring, demo APIs and exports', { timeout:45_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(),'reconcile-monolith-'));
  await writeFile(join(directory,'key'),'0123456789abcdef'.repeat(4),{ mode:0o600 });
  await writeFile(join(directory,'run.json'),JSON.stringify({ providerRunId:'http-integration' }),{ mode:0o600 });
  const child = spawn(process.execPath,[fileURLToPath(new URL('../dist/demo-main.js',import.meta.url))],{
    env:{ ...process.env,RECONCILE_RUNTIME_DIR:directory,ENGINE_PORT:'0' },stdio:['ignore','pipe','pipe'] });
  let errors = '';
  child.stderr.on('data',chunk => { errors += chunk.toString(); });
  try {
    const base = await new Promise((resolve,reject) => {
      let output = '';
      const timer = setTimeout(() => reject(new Error(`Startup timed out: ${errors}`)),25_000);
      child.stdout.on('data',chunk => { output += chunk.toString(); if (output.includes('\n')) {
        clearTimeout(timer); try { resolve(JSON.parse(output.split('\n')[0]).url); } catch (error) { reject(error); }
      } });
      child.once('exit',code => { clearTimeout(timer); reject(new Error(`Demo exited (${code}): ${errors}`)); });
    });
    const root = await fetch(base);
    assert.equal(root.status,200);
    const html = await root.text();
    assert.match(html,/id="app"/);
    const asset = html.match(/src="([^"]+\.js)"/);
    assert.ok(asset);
    assert.equal((await fetch(new URL(asset[1],base))).status,200);
    assert.equal((await fetch(new URL('/analytics.html',base))).status,200);
    assert.equal((await fetch(new URL('/api/report',base))).status,200);
    assert.equal((await fetch(new URL('/api/access/report',base))).status,200);
    assert.equal((await fetch(new URL('/api/recovery/incidents/missing/trace',base))).status,404);
    const denied = await fetch(new URL('/api/reset',base),{ method:'POST',headers:{ 'Content-Type':'application/json',
      Origin:'http://example.invalid' },body:'{}' });
    assert.equal(denied.status,403);
    assert.equal((await fetch(new URL('/api/reset',base),{ method:'POST',body:'{}' })).status,415);
    let feed;
    const deadline = Date.now()+20_000;
    while (Date.now()<deadline) {
      const response = await fetch(new URL('/api/recovery/monitor?cursor=0&limit=50&status=needs_attention',base));
      assert.equal(response.status,200);
      feed = await response.json();
      if (feed.connection?.ready) break;
      await new Promise(resolve => setTimeout(resolve,200));
    }
    assert.equal(feed?.connection?.ready,true);
    assert.equal(feed.connection.total_accounts,100);
    assert.equal((await fetch(new URL('/api/recovery/fulfillments?cursor=0&limit=5',base))).status,200);
    for (const format of ['csv','json']) {
      const response = await fetch(new URL(`/api/recovery/export?format=${format}`,base));
      assert.equal(response.status,200);
      assert.match(response.headers.get('content-type'),format === 'csv' ? /text\/csv/ : /application\/json/);
    }
    const simulation = await fetch(new URL('/api/recovery/simulation',base));
    assert.equal(simulation.status,200);
    assert.equal((await simulation.json()).available,true);
    const invalid = await fetch(new URL('/api/recovery/simulation',base),{ method:'POST',
      headers:{ 'Content-Type':'application/json' },body:JSON.stringify({ action:'invalid' }) });
    assert.equal(invalid.status,400);
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      await new Promise(resolve => { const timer = setTimeout(() => child.kill('SIGKILL'),8_000);
        child.once('exit',() => { clearTimeout(timer); resolve(); }); child.kill('SIGTERM'); });
    }
    await rm(directory,{ recursive:true,force:true });
  }
});
