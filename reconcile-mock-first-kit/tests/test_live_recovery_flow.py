"""Focused live Adapty recovery state-machine regressions."""
from datetime import datetime, timedelta, timezone
import json
from pathlib import Path
import sys
import tempfile
import time
import unittest
from unittest.mock import Mock, patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import adapty_seed_setup
import recovery_domain as domain
import recovery_live
import recovery_service as service
from recovery_sdk import sign


APP_ID = recovery_live.APP_ID
SEED_REVISION = '77d39ed807a66bbebcf24fe67c42be4fc9ef4c82'


def live_config(root):
    users = [f'lumen_test_{index:05d}' for index in range(100)]
    key_path = root / 'adapty.key'
    key_path.write_text('test-secret-that-must-not-escape')
    key_path.chmod(0o600)
    path = root / 'live-config.json'
    path.write_text(json.dumps({'app_id': APP_ID,
        'title': recovery_live.APP_TITLE, 'secret_key_file': str(key_path),
        'environment': 'hackathon_seed', 'source_environment': 'Production',
        'seed': {'revision': SEED_REVISION, 'run_prefix': 'lumen_test_'},
        'customer_user_ids': users}))
    return path, users


def catalog_fixture():
    return {'app_id': APP_ID, 'command': 'adapty products list',
        'cli_version': 'test-fixture', 'product_count': 1,
        'observed_at': datetime.now(timezone.utc).isoformat(),
        'source_hash': 'a' * 64, 'products': [{'id': 'lumen.annual'}]}


def timestamp(value):
    return value.astimezone(timezone.utc).isoformat(timespec='seconds').replace('+00:00', 'Z')


class FakeAdaptySource:
    def __init__(self):
        self.config = None
        self.fail = False
        self.changes = {}
        self.period_anchor = datetime.now(timezone.utc).replace(microsecond=0)

    def bind(self, config):
        self.config = config
        return self

    def raw_profile(self, user_id):
        now = datetime.now(timezone.utc).replace(microsecond=0)
        start, expiry = self.period_anchor - timedelta(days=30), self.period_anchor + timedelta(days=365)
        transaction_id = 'txn-' + user_id
        level = {'store': 'app_store', 'store_product_id': 'lumen.annual',
            'store_transaction_id': transaction_id, 'purchased_at': timestamp(start),
            'starts_at': timestamp(start), 'expires_at': timestamp(expiry),
            'is_in_grace_period': False, 'renewal_cancelled_at': None,
            'cancellation_reason': None, 'billing_issue_detected_at': None,
            'access_level_id': 'premium', 'offer': None}
        subscription = {**level, 'environment': 'Production', 'status': 'active'}
        change = self.changes.get(user_id)
        if change == 'expired':
            level['expires_at'] = subscription['expires_at'] = timestamp(now - timedelta(days=1))
        elif change == 'revoked':
            subscription['revoked_at'] = timestamp(now - timedelta(minutes=1))
        elif change == 'fingerprint':
            transaction_id = 'changed-' + user_id
            level['store_transaction_id'] = subscription['store_transaction_id'] = transaction_id
        return {'app_id': APP_ID, 'profile_id': 'profile-' + user_id,
            'customer_user_id': user_id, 'timestamp': timestamp(now),
            'custom_attributes': {}, 'access_levels': [level],
            'subscriptions': [subscription], 'non_subscriptions': []}

    def read(self, user_id):
        if self.fail:
            raise recovery_live.LiveSourceError('transport_error')
        return recovery_live.normalize_profile(self.raw_profile(user_id), self.config, user_id)


class LiveHarness:
    def __init__(self, root, *, pending=False):
        self.root = root
        self.config_path, self.users = live_config(root)
        self.source = FakeAdaptySource()
        self.catalog = catalog_fixture()
        self.provider = self.make_provider()
        self.transport = patch.object(service, 'internal_request', side_effect=self.exchange)
        self.transport.start()
        with patch.object(service.RecoveryService, '_init_sdk'):
            self.lumen = service.RecoveryService('lumen', 0, root/'lumen.db',
                self.provider.key_file, provider_url='http://127.0.0.1:1',
                collector_url='http://127.0.0.1:3/api/recovery/collector',
                demo=True, live_config=self.config_path,
                live_bootstrap_pending=pending)
        self.lumen.sdk = Mock()
        self.lumen.sdk.coverage.return_value = {'queued': 0, 'dropped': 0}
        with patch.object(service.RecoveryService, '_init_legacy'):
            self.engine = service.RecoveryService('engine', 0, root/'engine.db',
                self.provider.key_file, provider_url='http://127.0.0.1:1',
                lumen_url='http://127.0.0.1:2', demo=True, live_config=self.config_path,
                live_bootstrap_pending=pending)
        self.engine._launch_job = Mock()

    def make_provider(self):
        with (patch.object(adapty_seed_setup, 'read_cli_catalog', return_value=self.catalog),
              patch.object(recovery_live, 'AdaptyReader', side_effect=lambda config: self.source.bind(config))):
            return service.RecoveryService('provider', 0, self.root/'provider.db',
                self.root/'shared.key', demo=True, live_config=self.config_path)

    def exchange(self, _key, base, method, path, body=None, **_kwargs):
        route, query = service._parse_query(path)
        target = self.provider if base.endswith(':1') else self.lumen
        if method == 'GET':
            return (target._provider_get(route, query) if target is self.provider
                    else target._lumen_get(route, query))
        result = (target._provider_post(route, body) if target is self.provider
                  else target._lumen_post(route, body))
        return result[0] if isinstance(result, tuple) else result

    def close(self):
        self.engine._fulfillment_stop.set()
        self.engine._fulfillment_wake.set()
        if self.engine._fulfillment_thread:
            self.engine._fulfillment_thread.join(timeout=5)
            if self.engine._fulfillment_thread.is_alive():
                raise RuntimeError('Fulfillment watcher did not stop before fixture cleanup')
        self.transport.stop()

    def inject_and_scan(self):
        # Seed the ordinary-processing baseline before exercising this legacy
        # customer-denial test path. New source rights are protected by the
        # normal-processing grace in live classification.
        self.engine._live_fulfillment_audit(refresh_source=True)
        db = domain.connect(self.engine.db_path)
        try:
            old = timestamp(datetime.now(timezone.utc)-timedelta(minutes=1))
            db.execute('UPDATE fulfillment_expectations SET first_observed_at=?', (old,))
        finally:
            db.close()
        occurred_at = service.iso(datetime.now(timezone.utc))
        self.lumen._lumen_post('/internal/lumen/live/inject', {
            'user_ids': self.users[:24], 'handler_version': 'test-handler-v1',
            'config_version': 'test-config-v1', 'occurred_at': occurred_at})
        manifest = self.engine._manifest()
        event_id = 'customer:unit-' + str(id(self))
        envelope = {'schema_version': 1, 'event': {
            'schema_version': 1, 'event_id': event_id, 'run_id': manifest['run_id'],
            'app': manifest['app'], 'environment': manifest['environment'],
            'app_user_id': self.users[0], 'kind': 'feature_access_decided',
            'occurred_at': occurred_at, 'correlation_id': event_id,
            'source_event_id': event_id, 'details': {
                'feature': 'premium_export', 'decision': 'deny', 'reason_code': 'cache_stale',
                'projection_version': 'test-handler-v1', 'cache_version': 'test-config-v1',
                'policy_version': 'access-policy-v2', 'adapter_version': 'lumen-adapter-v2',
                'initiator': 'customer_demo'}}, 'sent_at': int(time.time())}
        receipt = self.engine._collect(envelope, sign(envelope, self.engine.key))
        incident_id, job_id = receipt['incident_id'], receipt['job_id']
        self.engine._run_job(job_id)
        snapshot = self.engine._latest_snapshot(incident_id)
        ids = [row['id'] for row in snapshot['accounts']
               if row['status'] == 'confirmed' and row['eligible']]
        return incident_id, snapshot, ids

    def plan(self, incident_id, ids):
        plan = self.engine._create_plan({'incident_id': incident_id, 'ids': ids})
        self.engine._approve({'plan_id': plan['id'], 'plan_hash': plan['plan_hash'],
                              'actor': 'unit operator'})
        return plan


class LiveRecoveryFlowTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='reconcile-live-flow-')
        self.addCleanup(self.temp.cleanup)
        self.h = LiveHarness(Path(self.temp.name))
        self.addCleanup(self.h.close)

    def test_execution_job_completes_with_entitlement_evidence_separate_from_provider_evidence(self):
        incident_id, snapshot, ids = self.h.inject_and_scan()
        self.assertEqual(len(snapshot['accounts']), 100)
        self.assertEqual(len(ids), 24)
        plan = self.h.plan(incident_id, ids[:1])
        queued = self.h.engine._start_execution({'plan_id': plan['id'],
                                                   'plan_hash': plan['plan_hash']})
        self.h.engine._run_job(queued['job_id'])
        job = self.h.engine._get_job(queued['job_id'])
        self.assertEqual(job['status'], 'completed', job)
        self.assertEqual(job['result']['access_verified'], 1, job)
        self.assertEqual(job['result']['entitlement_verified'], 1, job)
        result_snapshot = self.h.engine._load_snapshot(job['result']['snapshot_id'])
        self.assertEqual(result_snapshot['provider_evidence'], [])
        self.assertEqual(len(result_snapshot['entitlement_evidence']), 100)

    def test_changed_live_entitlement_after_preview_blocks_execution_without_resync(self):
        incident_id, _, ids = self.h.inject_and_scan()
        user_id = ids[0]
        for change in ('expired', 'revoked', 'fingerprint'):
            with self.subTest(change=change):
                plan = self.h.plan(incident_id, [user_id])
                self.h.source.changes[user_id] = change
                with self.assertRaises(service.RecoveryError):
                    self.h.engine._start_execution({'plan_id': plan['id'],
                                                     'plan_hash': plan['plan_hash']})
                resync = next(entry for entry in plan['entries'] if entry['type'] == 'resync_access')
                self.assertIsNone(domain.lumen_action(self.h.lumen.db_path, resync['id']))
                self.assertFalse(domain.lumen_access(self.h.lumen.db_path, user_id)['allowed'])
                self.h.source.changes.pop(user_id)

    def test_restart_reads_committed_resync_and_blocks_unstarted_writes(self):
        incident_id, snapshot, ids = self.h.inject_and_scan()
        plan = self.h.plan(incident_id, ids[:2])
        for entry in plan['entries']:
            self.h.engine._save_action(entry, plan['id'], 'accepted')
        first = ids[0]
        resync = next(entry for entry in plan['entries']
                      if entry['type'] == 'resync_access' and entry['account_id'] == first)
        entitlement = next(item for item in snapshot['entitlement_evidence']
                           if item['user_id'] == first)
        self.h.engine._save_action(resync, plan['id'], 'accepted', started=True)
        body = {'schema_version': 2, 'user_id': first,
            'expected_provider_customer_id': resync['preconditions']['provider_customer_id'],
            'expected_identity_revision': resync['preconditions']['identity_revision'],
            'expected_policy_revision': resync['preconditions']['policy_revision'],
            'expected_projection_revision': resync['preconditions']['projection_revision'],
            'processing_id': 'processing-'+resync['id'], 'trace_id': 'trace-'+resync['id'],
            'entitlement': {key: entitlement[key] for key in
                ('product_id', 'expires_at', 'entitlement_hash', 'transaction_id',
                 'source_fingerprint', 'store', 'source_environment')},
            'operation_key': resync['id']}
        service.internal_request(self.h.provider.key, self.h.engine.lumen_url, 'POST',
                                 '/internal/lumen/resync', body)
        revision_after_commit = domain.lumen_access(self.h.lumen.db_path, first)['projection_revision']

        with patch.object(service.RecoveryService, '_init_legacy'):
            restarted = service.RecoveryService('engine', 0, self.h.root/'engine.db',
                self.h.provider.key_file, provider_url='http://127.0.0.1:1',
                lumen_url='http://127.0.0.1:2', demo=True, live_config=self.h.config_path)
        restarted._launch_job = Mock()
        self.h.engine = restarted
        result = restarted._execute_plan(plan['id'], plan['plan_hash'])

        self.assertEqual(restarted._existing_action(resync['id'])['status'], 'verified')
        second_resync = next(entry for entry in plan['entries']
                             if entry['type'] == 'resync_access' and entry['account_id'] == ids[1])
        self.assertEqual(restarted._existing_action(second_resync['id'])['status'], 'blocked')
        first_probe = next(entry for entry in plan['entries']
                           if entry['type'] == 'verify_gate' and entry['account_id'] == first)
        self.assertEqual(restarted._existing_action(first_probe['id'])['status'], 'verified')
        self.assertEqual(domain.lumen_access(self.h.lumen.db_path, first)['projection_revision'],
                         revision_after_commit)
        self.assertEqual(result['access_verified'], 1)

    def test_failed_probe_with_healthy_gate_retries_only_gate_and_requires_new_approval(self):
        incident_id, _, ids = self.h.inject_and_scan()
        user_id = ids[0]
        plan = self.h.plan(incident_id, [user_id])
        with patch.object(self.h.engine, '_probe', return_value={'allowed': False, 'reason': 'probe_failed'}):
            self.h.engine._execute_plan(plan['id'], plan['plan_hash'])
        report = self.h.engine._report(incident_id)
        account = next(row for row in report['accounts'] if row['id'] == user_id)
        self.assertTrue(account['eligible'])
        self.assertTrue(account['gate']['allowed'])

        retry = self.h.engine._create_plan({'incident_id': incident_id, 'ids': [user_id]})
        self.assertEqual([entry['type'] for entry in retry['entries']], ['verify_gate'])
        with self.assertRaisesRegex(service.RecoveryError, 'separate approval'):
            self.h.engine._start_execution({'plan_id': retry['id'], 'plan_hash': retry['plan_hash']})
        self.h.engine._approve({'plan_id': retry['id'], 'plan_hash': retry['plan_hash'],
                                'actor': 'second operator'})
        queued = self.h.engine._start_execution({'plan_id': retry['id'],
                                                   'plan_hash': retry['plan_hash']})
        self.h.engine._run_job(queued['job_id'])
        self.assertEqual(self.h.engine._get_job(queued['job_id'])['status'], 'completed')

    def test_failed_resync_with_confirmed_denial_retries_resync_and_probe(self):
        incident_id, _, ids = self.h.inject_and_scan()
        user_id = ids[0]
        plan = self.h.plan(incident_id, [user_id])
        with patch.object(self.h.engine, '_remote_post', return_value=(None, 'failed')):
            self.h.engine._execute_plan(plan['id'], plan['plan_hash'])
        report = self.h.engine._report(incident_id)
        account = next(row for row in report['accounts'] if row['id'] == user_id)
        self.assertTrue(account['eligible'])
        self.assertFalse(account['gate']['allowed'])

        retry = self.h.engine._create_plan({'incident_id': incident_id, 'ids': [user_id]})
        self.assertEqual({entry['type'] for entry in retry['entries']},
                         {'resync_access', 'verify_gate'})
        with self.assertRaisesRegex(service.RecoveryError, 'separate approval'):
            self.h.engine._start_execution({'plan_id': retry['id'], 'plan_hash': retry['plan_hash']})
        self.h.engine._approve({'plan_id': retry['id'], 'plan_hash': retry['plan_hash'],
                                'actor': 'second operator'})
        queued = self.h.engine._start_execution({'plan_id': retry['id'],
                                                   'plan_hash': retry['plan_hash']})
        self.h.engine._run_job(queued['job_id'])
        self.assertEqual(self.h.engine._get_job(queued['job_id'])['status'], 'completed')


class LiveRecoveryRestartTests(unittest.TestCase):
    def test_transient_startup_source_failure_recovers_on_same_seeded_runtime(self):
        with tempfile.TemporaryDirectory(prefix='reconcile-live-restart-') as temporary:
            root = Path(temporary)
            config_path, _ = live_config(root)
            source = FakeAdaptySource()
            source.fail = True
            with (patch.object(adapty_seed_setup, 'read_cli_catalog', return_value=catalog_fixture()),
                  patch.object(recovery_live, 'AdaptyReader', side_effect=lambda config: source.bind(config))):
                first = service.RecoveryService('provider', 0, root/'provider.db',
                    root/'shared.key', demo=True, live_config=config_path)
            initial = first._provider_get('/internal/live/status', {})
            run_id = first._provider_get('/internal/manifest', {})['run_id']
            self.assertEqual(initial['observed_count'], 0)

            # Every full-scope read, including an incomplete pass, is subject to
            # the durable 60-second source cadence.
            provider_db = domain.connect(root/'provider.db')
            try:
                domain._set_meta(provider_db,'adapty_full_pass_started_epoch',time.time()-61)
            finally:
                provider_db.close()

            source.fail = False
            with (patch.object(adapty_seed_setup, 'read_cli_catalog', return_value=catalog_fixture()),
                  patch.object(recovery_live, 'AdaptyReader', side_effect=lambda config: source.bind(config))):
                restarted = service.RecoveryService('provider', 0, root/'provider.db',
                    root/'shared.key', demo=True, live_config=config_path)
            recovered = restarted._provider_get('/internal/live/status', {})
            self.assertEqual(restarted._provider_get('/internal/manifest', {})['run_id'], run_id)
            self.assertEqual(recovered['observed_count'], 100)
            self.assertEqual(recovered['identity_match_count'], 100)
            self.assertEqual(recovered['active_count'], 100)


if __name__ == '__main__':
    unittest.main()
