import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline';
import { LumenAdapter } from '../dist/modules/client/lumen-adapter.js';

test('TypeScript client interoperates with the isolated Python Lumen gate',
  { skip:process.env.RECONCILE_PYTHON_ORACLE !== '1', timeout:45_000 }, async () => {
    const root = fileURLToPath(new URL('../../../', import.meta.url));
    const directory = await mkdtemp(join(tmpdir(), 'reconcile-ts-python-oracle-'));
    const child = spawn('python3', ['-u', join(root,'reconcile-mock-first-kit/recovery_demo.py'),
      '--runtime', directory, '--port', '0'], { cwd:root, stdio:['ignore','pipe','pipe'] });
    const lines = createInterface({ input:child.stdout });
    const stopTimer = setTimeout(() => child.kill('SIGTERM'), 20_000);
    stopTimer.unref();
    try {
      const [line] = await Promise.race([
        once(lines,'line'),
        once(child,'exit').then(() => { throw new Error('Python oracle exited before readiness'); })
      ]);
      clearTimeout(stopTimer);
      const started = JSON.parse(line);
      const key = Buffer.from((await readFile(join(directory,'collector.key'),'utf8')).trim(),'hex');
      const adapter = new LumenAdapter(started.services.lumen,key,'Production');
      const page = await adapter.listAccounts(null, 100);
      assert.equal(page.total, 100);
      const userId = page.items[0].user_id;
      const access = await adapter.readAccess(userId);
      const probe = await adapter.probeAccess(userId);
      const gateResponse = await fetch(started.services.lumen+'/premium/export', {
        method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({ user_id:userId }) });
      assert.ok([200,403].includes(gateResponse.status));
      const customerGate = await gateResponse.json();
      assert.equal(probe.allowed, access.allowed);
      assert.equal(customerGate.allowed, access.allowed);
      assert.equal(await adapter.readAction('unknown-operation'), null);
    } finally {
      clearTimeout(stopTimer);
      lines.close();
      if (child.exitCode === null && child.signalCode === null) {
        child.kill('SIGTERM');
        await once(child,'exit');
      }
      await rm(directory, { recursive:true, force:true });
    }
  });
