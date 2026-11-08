import test from 'node:test';
import assert from 'node:assert/strict';
import { FulfillmentMonitor } from '../dist/modules/fulfillment/monitor.js';
import { RecoveryExecution } from '../dist/modules/recovery/execution.js';

test('an ambiguous write does not prevent another account in the approved plan from resuming', async () => {
  const at = new Date('2026-11-08T12:00:00Z');
  const plan = { id:'plan',incidentId:'incident',expiresAt:'2026-11-08T12:05:00Z',actions:[
    { kind:'resync_access',userId:'unknown',operationKey:'unknown-write',request:{ operation_key:'unknown-write' } },
    { kind:'verify_gate',userId:'unknown',operationKey:'unknown-gate' },
    { kind:'resync_access',userId:'next',operationKey:'next-write',request:{ operation_key:'next-write' } },
    { kind:'verify_gate',userId:'next',operationKey:'next-gate' }
  ] };
  const repository = {
    latestPlan:async () => ({ plan,hash:'hash' }),
    pendingWriteRequests:async () => [plan.actions[0].request],
    hasPendingOwnVerification:async () => false,
    readAction:async key => key === 'unknown-write' ? { status:'unknown_outcome' } : null,
    hasApproval:async () => true
  };
  const monitor = new FulfillmentMonitor({ appId:'app',environment:'demo',sourceEnvironment:'Production',
    policyRevision:1,provenance:'local_fixture' },{},{},{},{},repository,{},() => at);
  const originalResolve = RecoveryExecution.prototype.resolveWrite, originalExecute = RecoveryExecution.prototype.execute;
  const resolved = []; let executed = 0;
  RecoveryExecution.prototype.resolveWrite = async request => { resolved.push(request.operation_key); return 'unknown_outcome'; };
  RecoveryExecution.prototype.execute = async id => { assert.equal(id,'plan'); executed++; return []; };
  try {
    await monitor.processIncident('incident',['unknown','next']);
    assert.deepEqual(resolved,['unknown-write']);
    assert.equal(executed,1);
  } finally {
    RecoveryExecution.prototype.resolveWrite = originalResolve;
    RecoveryExecution.prototype.execute = originalExecute;
  }
});
