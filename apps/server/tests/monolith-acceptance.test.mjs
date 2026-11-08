import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp,rm,writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const delay = milliseconds => new Promise(resolve => setTimeout(resolve,milliseconds));

test('black-box 100-account recovery checks the real Lumen gate and preserves transaction references',
  { timeout:180_000 },async () => {
    const directory = await mkdtemp(join(tmpdir(),'reconcile-ts-acceptance-'));
    await writeFile(join(directory,'key'),'0123456789abcdef'.repeat(4),{ mode:0o600 });
    await writeFile(join(directory,'run.json'),JSON.stringify({ providerRunId:'black-box-acceptance' }),{ mode:0o600 });
    const child = spawn(process.execPath,[fileURLToPath(new URL('../dist/demo-main.js',import.meta.url))],{
      env:{ ...process.env,RECONCILE_RUNTIME_DIR:directory,ENGINE_PORT:'0' },stdio:['ignore','pipe','pipe'] });
    let errors = '';
    child.stderr.on('data',chunk => { errors += chunk.toString(); });
    try {
      const started = await new Promise((resolve,reject) => {
        let output = '';
        const timer = setTimeout(() => reject(new Error(`Startup timed out: ${errors}`)),30_000);
        child.stdout.on('data',chunk => { output += chunk.toString(); if (output.includes('\n')) {
          clearTimeout(timer); try { resolve(JSON.parse(output.split('\n')[0])); } catch (error) { reject(error); }
        } });
        child.once('exit',code => { clearTimeout(timer); reject(new Error(`Demo exited (${code}): ${errors}`)); });
      });
      const get = async path => {
        const response = await fetch(new URL(path,started.url));
        assert.equal(response.status,200,`GET ${path}`);
        return response.json();
      };
      const post = async (base,path,body) => fetch(new URL(path,base),{ method:'POST',
        headers:{ 'Content-Type':'application/json' },body:JSON.stringify(body) });
      let feed;
      const readyDeadline = Date.now()+30_000;
      do {
        feed = await get('/api/recovery/monitor');
        if (feed.connection?.ready) break;
        await delay(200);
      } while (Date.now()<readyDeadline);
      assert.equal(feed.connection?.ready,true);
      assert.equal(feed.connection.total_accounts,100);
      const before = await get('/api/recovery/fulfillments?cursor=0&limit=200');
      assert.equal(before.items.length,100);
      const references = items => items.map(item => `${item.key.customer_id}:${item.key.transaction_id}`).sort();
      const accepted = await post(started.url,'/api/recovery/simulation',{ action:'once',operation_key:'acceptance-once' });
      assert.equal(accepted.status,202);
      const duplicate = await post(started.url,'/api/recovery/simulation',{ action:'once',operation_key:'acceptance-once' });
      assert.equal(duplicate.status,202);
      assert.equal((await duplicate.json()).duplicate,true);
      let simulation;
      const deadline = Date.now()+45_000;
      do {
        simulation = await get('/api/recovery/simulation');
        if (['completed','failed'].includes(simulation.status)) break;
        await delay(500);
      } while (Date.now()<deadline);
      if (simulation.status !== 'completed') {
        const states = await get('/api/recovery/fulfillments?cursor=0&limit=200');
        const affected = states.items.filter(item => item.incident_id);
        const incidentId = affected[0]?.incident_id;
        const trace = incidentId ? await get(`/api/recovery/incidents/${encodeURIComponent(incidentId)}/trace`) : null;
        const summary = Object.fromEntries([...new Set(affected.map(item => item.status))]
          .map(status => [status,affected.filter(item => item.status === status).length]));
        assert.fail(JSON.stringify({ simulation,summary,trace }));
      }
      assert.equal(simulation.last_result.repaired,23);
      assert.equal(simulation.last_result.unresolved,1);
      assert.equal(simulation.last_result.selected.length,24);
      const crossOrigin = await fetch(new URL('/premium/export',started.services.lumen),{ method:'POST',
        headers:{ 'Content-Type':'application/json',Origin:'http://example.invalid' },
        body:JSON.stringify({ user_id:simulation.last_result.selected[0].user_id }) });
      assert.equal(crossOrigin.status,403);
      for (const account of simulation.last_result.selected) {
        const response = await post(started.services.lumen,'/premium/export',{ user_id:account.user_id });
        assert.equal(response.status,account.status === 'repaired' ? 200 : 403,account.user_id);
        assert.equal((await response.json()).allowed,account.status === 'repaired',account.user_id);
      }
      const after = await get('/api/recovery/fulfillments?cursor=0&limit=200');
      assert.deepEqual(references(after.items),references(before.items));
      const report = await get('/api/recovery/export?format=json');
      assert.equal(report.incidents.reduce((sum,item) => sum+item.affected_accounts,0),24);
      assert.equal(report.incidents.reduce((sum,item) => sum+item.repaired_accounts,0),23);
    } finally {
      if (child.exitCode === null && child.signalCode === null) {
        await new Promise(resolve => { const timer = setTimeout(() => child.kill('SIGKILL'),10_000);
          child.once('exit',() => { clearTimeout(timer); resolve(); }); child.kill('SIGTERM'); });
      }
      await rm(directory,{ recursive:true,force:true });
    }
  });
