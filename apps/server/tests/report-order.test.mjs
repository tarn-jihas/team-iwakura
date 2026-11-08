import test from 'node:test';
import assert from 'node:assert/strict';
import { SQLiteStorage } from '../dist/infrastructure/sqlite.js';
import { RecoveryRepository } from '../dist/modules/recovery/repository.js';
import { Reporting } from '../dist/modules/reporting/export.js';

test('report uses event order when an older plan receives the latest gate result', async () => {
  const storage = new SQLiteStorage(':memory:'), at = '2026-11-08T12:00:00Z';
  try {
    const repo = new RecoveryRepository(storage), reporting = new Reporting(storage,() => new Date('2026-11-08T13:00:00Z'));
    await repo.initialize(); await reporting.initialize();
    await repo.createIncident('incident','app','sandbox',at);
    await repo.saveSnapshot('snapshot','incident',{},at);
    for (const id of ['old','new']) {
      const plan = { targets:[{ userId:'user' }],actions:[{ operationKey:`${id}-gate`,userId:'user',kind:'verify_gate' }] };
      await storage.statement({ mode:'run',sql:'INSERT INTO recovery_plans VALUES (?,?,?,?,?,?,?,?,?)',
        params:[id,'incident','snapshot','a'.repeat(64),JSON.stringify(plan),at,'2026-11-09T00:00:00Z',0,99_999_999_999_999] });
      await storage.statement({ mode:'run',sql:"INSERT INTO recovery_actions VALUES (?,?,?,?,'accepted',NULL,?)",
        params:[`${id}-gate`,'incident',id,'b'.repeat(64),at] });
    }
    await repo.finishAction('new-gate','verified',{ evidence_ref:'lumen-gate:new' },at);
    await repo.finishAction('old-gate','failed',{ reason:'projection_or_gate_mismatch' },at);
    const report = JSON.parse((await reporting.export('app','sandbox','2026-11-08T00:00:00Z','2026-11-09T00:00:00Z','json')).body);
    assert.equal(report.incidents[0].status,'needs_attention');
    assert.equal(report.incidents[0].repaired_accounts,0);
  } finally { await storage.close(); }
});
