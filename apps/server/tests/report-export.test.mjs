import test from 'node:test';
import assert from 'node:assert/strict';
import { SQLiteStorage } from '../dist/infrastructure/sqlite.js';
import { RecoveryRepository } from '../dist/modules/recovery/repository.js';
import { Reporting } from '../dist/modules/reporting/export.js';
import { FulfillmentRegistry } from '../dist/modules/fulfillment/registry.js';

test('period exports include every page, whole history and protect CSV formulas', async () => {
  const storage = new SQLiteStorage(':memory:');
  try {
    const repository = new RecoveryRepository(storage), reporting = new Reporting(storage,() => new Date('2026-11-10T00:00:00Z'));
    await repository.initialize(); await reporting.initialize();
    const coverage = { registered:100,scanned:100,sourceRead:94,clientRead:100,incomplete:6,sourceStopped:true };
    await reporting.updateCoverage(coverage,'local_fixture');
    for (let index=0; index<51; index++) {
      await repository.createIncident(`incident-${index}`,'app','sandbox','2026-11-08T00:00:00Z');
    }
    await repository.createIncident('=formula','app','sandbox','2026-11-08T00:00:00Z');
    await repository.createIncident('excluded','app','sandbox','2026-11-09T00:00:00Z');
    await repository.createIncident('old-with-activity','app','sandbox','2026-11-01T00:00:00Z');
    await repository.saveSnapshot('snapshot','old-with-activity',{},'2026-11-01T00:00:00Z');
    const plan = { targets:[{ userId:'user' }],actions:[{ operationKey:'gate',userId:'user',kind:'verify_gate' }] };
    await storage.statement({ mode:'run',sql:'INSERT INTO recovery_plans VALUES (?,?,?,?,?,?,?,?,?)',
      params:['plan','old-with-activity','snapshot','a'.repeat(64),JSON.stringify(plan),'2026-11-01T00:00:00Z',
        '2026-11-10T00:00:00Z',0,99_999_999_999_999] });
    await storage.statement({ mode:'run',sql:"INSERT INTO recovery_actions VALUES (?,?,?,?,'accepted',NULL,?)",
      params:['gate','old-with-activity','plan','b'.repeat(64),'2026-11-08T00:00:00Z'] });
    await repository.finishAction('gate','verified',{ evidence_ref:'lumen-gate:gate' },'2026-11-08T00:00:01Z');
    const registry = new FulfillmentRegistry(storage);
    const key = { app:'app',environment:'sandbox',store:'app_store',transactionId:'txn-external',userId:'external',accessLevel:'premium' };
    const changed = await registry.observe(key,{ status:'confirmed',reason:'projection_mismatch',eligible:true,projectionMatches:false },
      'a'.repeat(64),'b'.repeat(64),'2026-11-01T00:00:00Z');
    assert.equal(await registry.claimIncident('external-incident','app','sandbox',[changed.identityHash],'2026-11-01T00:00:01Z'),true);
    await registry.observe(key,{ status:'healthy',reason:'source_period_and_gate_match',eligible:false,projectionMatches:true },
      'a'.repeat(64),'b'.repeat(64),'2026-11-08T01:00:00Z');
    const laterKey = { ...key,transactionId:'txn-later',userId:'later' };
    const later = await registry.observe(laterKey,{ status:'confirmed',reason:'projection_mismatch',eligible:true,projectionMatches:false },
      'a'.repeat(64),'b'.repeat(64),'2026-11-01T00:00:00Z');
    assert.equal(await registry.claimIncident('later-incident','app','sandbox',[later.identityHash],'2026-11-01T00:00:01Z'),true);
    await repository.saveSnapshot('later-snapshot','later-incident',{},'2026-11-01T00:00:01Z');
    const laterPlan = { targets:[{ userId:'later' }],actions:[{ operationKey:'later-gate',userId:'later',kind:'verify_gate' }] };
    await storage.statement({ mode:'run',sql:'INSERT INTO recovery_plans VALUES (?,?,?,?,?,?,?,?,?)',
      params:['later-plan','later-incident','later-snapshot','a'.repeat(64),JSON.stringify(laterPlan),
        '2026-11-01T00:00:01Z','2026-11-10T00:00:00Z',0,99_999_999_999_999] });
    await storage.statement({ mode:'run',sql:"INSERT INTO recovery_actions VALUES (?,?,?,?,'accepted',NULL,?)",
      params:['later-gate','later-incident','later-plan','b'.repeat(64),'2026-11-08T00:00:00Z'] });
    await repository.finishAction('later-gate','verified',{ evidence_ref:'lumen-gate:later-gate' },'2026-11-08T00:00:01Z');
    await registry.observe(laterKey,{ status:'inconclusive',reason:'coverage_incomplete',eligible:false,projectionMatches:false },
      'a'.repeat(64),'b'.repeat(64),'2026-11-08T02:00:00Z');
    const proofKey = { ...key,transactionId:'txn-proof',userId:'proof' };
    const proof = await registry.observe(proofKey,{ status:'confirmed',reason:'projection_mismatch',eligible:true,projectionMatches:false },
      'a'.repeat(64),'b'.repeat(64),'2026-11-01T00:00:00Z');
    assert.equal(await registry.claimIncident('proof-incident','app','sandbox',[proof.identityHash],'2026-11-01T00:00:01Z'),true);
    assert.equal(await repository.acquireOwnership('proof-incident','app','sandbox','proof','2026-11-01T00:00:02Z'),true);
    assert.equal(await repository.recordExternalVerification('proof-incident','app','sandbox','proof',
      'txn-proof','a'.repeat(64),'b'.repeat(64),1,1,2,'2026-11-08T03:00:00Z'),true);
    const from = '2026-11-08T00:00:00Z', to = '2026-11-09T00:00:00Z';
    const json = JSON.parse((await reporting.export('app','sandbox',from,to,'json')).body);
    assert.equal(json.incidents.length,56);
    assert.deepEqual(json.coverage,coverage);
    assert.equal(json.incidents.some(row => row.id === 'excluded'),false);
    const older = json.incidents.find(row => row.id === 'old-with-activity');
    assert.equal(older.status,'repaired');
    assert.deepEqual(older.actions.map(action => action.status),['accepted','verified']);
    const external = json.incidents.find(row => row.id === 'external-incident');
    assert.equal(external.status,'resolved_externally');
    assert.equal(external.externally_restored_accounts,1);
    assert.equal(external.repaired_accounts,0);
    const laterReport = json.incidents.find(row => row.id === 'later-incident');
    assert.equal(laterReport.status,'needs_attention');
    assert.equal(laterReport.repaired_accounts,0);
    const proofReport = json.incidents.find(row => row.id === 'proof-incident');
    assert.equal(proofReport.status,'resolved_externally');
    assert.equal(proofReport.actions.at(-1).action,'external_gate_verification');
    const early = new Reporting(storage,() => new Date('2026-11-08T00:00:00.500Z'));
    const earlyReport = JSON.parse((await early.export('app','sandbox',from,to,'json')).body);
    const earlyOlder = earlyReport.incidents.find(row => row.id === 'old-with-activity');
    assert.equal(earlyOlder.status,'needs_attention');
    assert.deepEqual(earlyOlder.actions.map(action => action.status),['accepted']);
    const csv = (await reporting.export('app','sandbox',from,to,'csv')).body;
    assert.ok(csv.includes("\"'=formula\""));
    assert.ok(csv.includes('lumen-gate:gate'));
    const options = { cursor:0,limit:50,status:'needs_attention',mode:'LOCAL_ADAPTY_FIXTURE',title:'Lumen',
      sourceReady:true,sourceFresh:true,lastError:null };
    const feed = JSON.parse((await reporting.monitor('app','sandbox',options)).body);
    assert.equal(feed.summary.incidents,57);
    assert.equal(feed.summary.fixed,1);
    assert.equal(feed.summary.needs_attention,54);
    assert.equal(feed.incidents.length,50);
    assert.equal(feed.pagination.next_cursor,'50');
    const next = JSON.parse((await reporting.monitor('app','sandbox',{ ...options,cursor:50 })).body);
    assert.equal(next.incidents.length,4);
    await assert.rejects(reporting.export('app','sandbox',to,from,'csv'), /Invalid UTC/);
    await assert.rejects(reporting.export('app','sandbox','2026-11-08T00:00:00+01:00',to,'json'), /Invalid UTC/);
  } finally { await storage.close(); }
});
