import test from 'node:test';
import assert from 'node:assert/strict';
import { assessIncident } from '../dist/modules/incidents/assessment.js';

test('100 independent observations distinguish discrepancies, missing evidence and cause hypotheses', () => {
  const now = new Date('2026-11-08T12:01:00Z'), records = [];
  for (let index = 0; index < 100; index++) {
    const user = `user-${index}`, mismatch = index < 24;
    const observation = { appId:'app',userId:user,now,complete:index < 94,sourceScopeMatches:true,
      ownedByOtherIncident:false,normalProcessingWindow:false,explicitHandlerFailure:false,
      provider:{ provider_customer_id:user,identity_status:'mapped' },
      profile:{ app_id:'app',user_id:user,identity_match:true,observed_at:'2026-11-08T12:00:00Z',status:'active',reason:'active' },
      entitlement:{ app_id:'app',user_id:user,provider_customer_id:user,transaction_id:`txn-${index}`,product_id:'premium',
        store:'app_store',source_environment:'Production',source_fingerprint:'a'.repeat(64),
        starts_at:'2026-11-01T00:00:00Z',expires_at:'2026-12-01T00:00:00Z',is_in_grace_period:false,
        entitlement_hash:'b'.repeat(64) },
      client:{ provider_customer_id:user,identity_status:'mapped',policy_enabled:true,access_active:!mismatch,
        access_expires_at:mismatch ? null : '2026-12-01T00:00:00Z',entitlement_hash:mismatch ? null : 'b'.repeat(64),
        gate:{ allowed:!mismatch,reason:mismatch ? 'subscription_inactive' : 'allowed' } } };
    records.push({ userId:user,environment:'sandbox',observation,
      signal:{ at:'2026-11-08T12:00:00Z',productId:'premium',handlerVersion:'v1',failedStep:index === 1 ? 'cache' : 'handler' } });
  }
  const result = assessIncident('app','sandbox','user-0','2026-11-08T12:00:00Z',records,now);
  assert.equal(result.filter(row => row.status === 'confirmed').length,24);
  assert.equal(result.filter(row => row.status === 'inconclusive').length,6);
  assert.equal(result[1].correlation,'different_signature');
  assert.equal(result[1].status,'confirmed');
  assert.equal(result[0].correlation,'shared_signature_hypothesis');
  const withoutSignals = assessIncident('app','sandbox','user-0','2026-11-08T12:00:00Z',
    records.map(row => ({ ...row,signal:null })),now);
  assert.deepEqual(withoutSignals.map(row => row.status),result.map(row => row.status));
  assert.ok(withoutSignals.every(row => row.correlation === 'unknown'));
  records[2].observation.userId = 'different-user';
  assert.equal(assessIncident('app','sandbox','user-0','2026-11-08T12:00:00Z',records,now)[2].status,'inconclusive');
  records[0].environment = 'other';
  assert.equal(assessIncident('app','sandbox','user-0','2026-11-08T12:00:00Z',records,now).length,99);
});
