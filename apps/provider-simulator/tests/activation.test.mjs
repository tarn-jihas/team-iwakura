import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ActivationProvider, activationValidationRequest, validateActivationValidationRequest } from '../dist/activation.js';

async function temporary(t) {
  const directory = await mkdtemp(join(tmpdir(), 'reconcile-activation-provider-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

async function provider(t, scenario = 'stripe', variant = 0, runId) {
  const directory = await temporary(t);
  const service = await ActivationProvider.create({ databasePath: join(directory, 'activation.sqlite'),
    scenario, variant, runId });
  t.after(() => service.close());
  return service;
}

test('Stripe activation seed preserves 100 identities and original evidence/profile cohorts', async t => {
  const service = await provider(t);
  const accounts = service.providerAccounts(null, 1000);
  const evidence = service.providerEvidence(null, null, 1000);
  const profiles = service.adaptyProfiles(null, null, 1000);
  assert.equal(service.manifest().scenario, 'stripe');
  assert.equal(accounts.total, 100);
  assert.equal(evidence.total, 95);
  assert.equal(profiles.total, 100);
  assert.equal(accounts.items.filter(item => item.identity_status === 'unknown').length, 3);
  const evidenceByUser = new Map(evidence.items.map(item => [item.user_id, item]));
  const inconclusive = accounts.items.filter(account => account.identity_status !== 'mapped'
    || !evidenceByUser.has(account.user_id)
    || Date.parse('2026-11-07T12:00:00Z') - Date.parse(evidenceByUser.get(account.user_id)?.observed_at) > 900_000);
  assert.equal(100 - inconclusive.length, 94);
  assert.equal(inconclusive.length, 6);
  assert.equal(evidence.items.filter(item => item.price_id === 'price_annual_new').length, 24);
  assert.equal(evidence.items.filter(item => item.refund_state === 'none'
    && item.payment_state === 'paid' && item.price_id === 'price_annual_current').length, 71);
  assert.equal(evidence.items.filter(item => Date.parse(item.expires_at) <= Date.parse('2026-11-07T12:00:00Z')).length, 6);
  assert.equal(evidence.items.filter(item => (Date.parse('2026-11-07T12:00:00Z') - Date.parse(item.observed_at)) <= 900_000).length, 94);
  assert.equal(profiles.items.filter(item => item.status === 'active').length, 64);
  assert.equal(evidence.items.filter(item => item.observed_at === '2026-11-07T11:40:00Z').length, 1);
});

test('catalog repair and provider validation bind idempotency to exact requests', async t => {
  const service = await provider(t);
  const repairBody = { provider: 'stripe', product_id: 'premium.annual',
    price_id: 'price_annual_new', operation_key: 'catalog-op-1' };
  assert.deepEqual(service.repairCatalog(repairBody), { accepted: true, provider: 'stripe',
    product_id: 'premium.annual', price_id: 'price_annual_new', catalog_revision: 2, duplicate: false });
  assert.equal(service.repairCatalog(repairBody).duplicate, true);
  assert.throws(() => service.repairCatalog({ ...repairBody, product_id: 'premium.monthly' }), /different request/u);
  assert.throws(() => service.repairCatalog({ ...repairBody, product_id: 'premium.monthly',
    operation_key: 'catalog-op-2' }), /Price is already mapped/u);

  const request = { provider: 'stripe', transaction_id: 'txn-u00000', user_id: 'u00000',
    operation_key: 'validate-op-1',
    contract_trace: { provider: 'stripe', ...activationValidationRequest('stripe', 'u00000', 'txn-u00000') } };
  const first = service.providerValidate(request);
  const repeat = service.providerValidate(request);
  assert.equal(first.accepted, true);
  assert.equal(first.profile_revision, 2);
  assert.equal(first.duplicate, false);
  assert.equal(repeat.duplicate, true);
  assert.equal(service.adaptyProfiles('u00000').transaction_id, 'txn-u00000');
  assert.equal(service.adaptyOperation('validate-op-1').request_contract.path,
    '/api/v1/sdk/purchase/stripe/token/validate/');
  assert.throws(() => service.providerValidate({ ...request, transaction_id: 'txn-u00001' }), /different request/u);
  assert.deepEqual(validateActivationValidationRequest('stripe', 'u00000', 'txn-u00000',
    activationValidationRequest('stripe', 'u00000', 'txn-u00000')),
  activationValidationRequest('stripe', 'u00000', 'txn-u00000'));
  assert.throws(() => validateActivationValidationRequest('stripe', 'u00000', 'txn-u00000',
    activationValidationRequest('stripe', 'u00000', 'txn-u00001')), /transport contract/u);
});

test('current paid periods fail closed until their provider catalog mapping exists', async t => {
  const stripe = await provider(t);
  const trace = { provider: 'stripe', ...activationValidationRequest('stripe', 'u00000', 'txn-u00000') };
  const request = { provider: 'stripe', transaction_id: 'txn-u00000', user_id: 'u00000',
    operation_key: 'gate-contract-1', contract_trace: trace };
  assert.throws(() => stripe.providerValidate(request), /not mapped in the Adapty catalog/u);
  assert.throws(() => stripe.providerValidate({ ...request, transaction_id: 'missing',
    contract_trace: { provider: 'stripe', ...activationValidationRequest('stripe', 'u00000', 'missing') } }), /not found/u);
});

test('provider faults are durable, observable, and leave evidence observations', async t => {
  const service = await provider(t);
  const before = service.providerEvidence('u00000', null, 10);
  assert.equal(before.total, 1);
  assert.equal(service.providerObservations('u00000').length, 1);
  service.repairCatalog({ provider: 'stripe', product_id: 'premium.annual',
    price_id: 'price_annual_new', operation_key: 'fault-catalog-op' });
  const stale = service.providerDemoFault('source_stale', { userId: 'u00000' });
  assert.equal(stale.state, 'stale');
  assert.equal(service.providerEvidence('u00000', null, 10).items[0].observed_at, '2026-11-07T11:30:00Z');
  assert.throws(() => service.providerValidate({ provider: 'stripe', transaction_id: 'txn-u00000',
    user_id: 'u00000', operation_key: 'stale-op', contract_trace: {
      provider: 'stripe', ...activationValidationRequest('stripe', 'u00000', 'txn-u00000'),
    } }), /Provider evidence is stale/u);

  service.providerDemoFault('identity', { userId: 'u00001', state: 'unknown' });
  assert.equal(service.providerAccounts('0', 2).items[1].identity_status, 'unknown');
  const outage = service.demoFault('provider_outage', { active: true });
  assert.deepEqual(outage, { fault: 'provider_outage', active: true });
  assert.equal(service.providerFaultActive('fault_provider_outage'), true);
  assert.deepEqual(service.consumeProviderFault('fault_provider_outage'), { active: true });
  assert.equal(service.providerFaultActive('fault_provider_outage'), false);
  service.providerDemoFault('rate_limit', { active: true });
  assert.deepEqual(service.consumeProviderFault('fault_rate_limit_remaining'), { active: true, retry_after: 1 });
  assert.deepEqual(service.consumeProviderFault('fault_rate_limit_remaining'), { active: false });
  service.providerDemoFault('validation_timeout_after_commit', { active: true });
  assert.deepEqual(service.consumeProviderFault('fault_validation_timeout_remaining'), { active: true });
  const recovered = await provider(t);
  recovered.repairCatalog({ provider: 'stripe', product_id: 'premium.annual',
    price_id: 'price_annual_new', operation_key: 'different-cause-catalog' });
  recovered.providerValidate({ provider: 'stripe', transaction_id: 'txn-u00000', user_id: 'u00000',
    operation_key: 'different-cause-validate', contract_trace: { provider: 'stripe',
      ...activationValidationRequest('stripe', 'u00000', 'txn-u00000') } });
  const differentCause = recovered.demoFault('different_cause', { userId: 'u00000' });
  assert.equal(differentCause.adapty.status, 'missing');
  assert.equal(recovered.providerEvidence('u00000').items[0].price_id, 'price_annual_other');
  assert.equal(recovered.adaptyProfiles('u00000').status, 'missing');
});

test('Paddle and custom synthetic contracts validate; Apple and Google require client action', async () => {
  for (const scenario of ['paddle', 'custom']) {
    const service = await ActivationProvider.create({ databasePath: ':memory:', scenario });
    try {
      service.repairCatalog({ provider: scenario, product_id: 'premium.annual',
        price_id: 'price_annual_new', operation_key: `${scenario}-catalog` });
      const wire = activationValidationRequest(scenario, 'u00000', 'txn-u00000');
      const result = service.providerValidate({ provider: scenario, transaction_id: 'txn-u00000',
        user_id: 'u00000', operation_key: `${scenario}-validate`,
        contract_trace: { provider: scenario, ...wire } });
      assert.equal(result.accepted, true);
    } finally { await service.close(); }
  }
  for (const scenario of ['apple', 'google']) {
    const service = await ActivationProvider.create({ databasePath: ':memory:', scenario });
    try {
      assert.throws(() => service.providerValidate({ provider: scenario, transaction_id: 'txn-u00000',
        user_id: 'u00000', operation_key: `${scenario}-validate`, contract_trace: {
          provider: scenario, method: 'POST', path: '/native/validate', content_type: 'application/json', body: {},
        } }), error => error.message === 'awaiting_client_action' && error.status === 409);
    } finally { await service.close(); }
  }
});

test('official offline history imports as unverified and paginates without Adapty claims', async t => {
  const directory = await temporary(t);
  const fixtureDirectory = resolve(fileURLToPath(new URL('../../../reconcile-mock-first-kit/fixtures/hackathon/', import.meta.url)));
  const service = await ActivationProvider.create({ databasePath: join(directory, 'offline.sqlite'),
    scenario: 'offline', runId: 'test-offline-run', fixtureDirectory });
  t.after(() => service.close());
  const accounts = service.providerAccounts(null, 1000);
  const history = service.providerHistory(null, '29000', 1000);
  const profiles = service.adaptyProfiles(null, null, 1000);
  assert.equal(accounts.total, 50000);
  assert.equal(accounts.items[42].provider_customer_id, 'lumen_test_offline_run_00042');
  assert.equal(accounts.items[42].identity_status, 'unknown');
  assert.equal(history.total, 29794);
  assert.equal(history.items.length, 794);
  assert.equal(history.next_cursor, null);
  assert.ok(history.items.every(item => item.payment_verification === 'unverified_synthetic_history'));
  assert.equal(profiles.total, 0);
  assert.equal(service.providerEvidence().total, 0);
  assert.equal(service.manifest().official_import.transactions, 29794);
  assert.throws(() => service.providerValidate({}), /Validation fields/u);
});

test('unmarked existing SQLite databases are rejected without mutation', async t => {
  const directory = await temporary(t);
  const path = join(directory, 'legacy.sqlite');
  const db = new DatabaseSync(path);
  db.exec("CREATE TABLE sentinel(value TEXT NOT NULL); INSERT INTO sentinel VALUES('preserve-me')");
  db.close();
  const before = createHash('sha256').update(await readFile(path)).digest('hex');
  await assert.rejects(ActivationProvider.create({ databasePath: path }), /owned TypeScript runtime database/u);
  assert.equal(createHash('sha256').update(await readFile(path)).digest('hex'), before);
});
