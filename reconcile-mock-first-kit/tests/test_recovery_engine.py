"""Focused state-machine regressions; HTTP acceptance lives in acceptance/."""
from datetime import datetime, timezone
from pathlib import Path
import tempfile
import threading
import time
import unittest
from unittest.mock import Mock, patch
import sys

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import recovery_domain as domain
import recovery_service as service


class RecoveryEngineTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        root = Path(self.temp.name)
        key = root / 'shared.key'
        self.provider = service.RecoveryService('provider', 0, root/'provider.db', key, demo=True)
        with patch.object(service.RecoveryService, '_init_sdk'):
            self.lumen = service.RecoveryService('lumen', 0, root/'lumen.db', key,
                provider_url='http://127.0.0.1:1', collector_url='http://127.0.0.1:3/api/recovery/collector', demo=True)
        self.lumen.sdk = Mock()
        self.lumen.sdk.coverage.return_value = {'queued': 0, 'dropped': 0}
        self.lumen.sdk.emit.return_value = None
        self.transport = patch.object(service, 'internal_request', side_effect=self.exchange)
        self.transport.start()
        self.addCleanup(self.transport.stop)
        with patch.object(service.RecoveryService, '_init_legacy'):
            self.engine = service.RecoveryService('engine', 0, root/'engine.db', key,
                provider_url='http://127.0.0.1:1', lumen_url='http://127.0.0.1:2', demo=True)
        self.engine._launch_job = Mock()

    def exchange(self, key, base, method, path, body=None, **kwargs):
        route, query = service._parse_query(path)
        target = self.provider if base.endswith(':1') else self.lumen
        if method == 'GET':
            return target._provider_get(route, query) if target is self.provider else target._lumen_get(route, query)
        result = target._provider_post(route, body) if target is self.provider else target._lumen_post(route, body)
        return result[0] if isinstance(result, tuple) else result

    def planned(self, user='u00001'):
        incident, _ = self.engine._start_incident(user)
        self.engine._capture_snapshot(incident)
        plan = self.engine._create_plan({'incident_id': incident, 'ids': [user]})
        self.engine._approve({'plan_id': plan['id'], 'plan_hash': plan['plan_hash'], 'actor': 'unit operator'})
        return plan

    def test_refund_between_validation_and_resync_blocks_client_write(self):
        plan = self.planned()
        original = self.engine._operation_result
        def operate(entry, *args, **kwargs):
            result = original(entry, *args, **kwargs)
            if entry['type'] == 'validate_purchase':
                domain.provider_demo_fault(self.provider.db_path, 'refund', user_id='u00001')
            return result
        with patch.object(self.engine, '_operation_result', side_effect=operate):
            result = self.engine._execute_plan(plan['id'], plan['plan_hash'])
        self.assertEqual(result['access_verified'], 0)
        self.assertFalse(domain.lumen_access(self.lumen.db_path, 'u00001')['allowed'])
        resync = next(entry for entry in plan['entries'] if entry['type'] == 'resync_access')
        self.assertEqual(self.engine._existing_action(resync['id'])['status'], 'blocked')

    def test_restart_reads_started_action_but_never_starts_remaining_writes(self):
        plan = self.planned()
        for entry in plan['entries']:
            self.engine._save_action(entry, plan['id'], 'accepted')
        catalog = plan['entries'][0]
        body = {key: catalog['target'][key] for key in ('provider','product_id','price_id')}
        self.engine._save_action(catalog, plan['id'], 'accepted', started=True)
        domain.repair_catalog(self.provider.adapty_db, {**body, 'operation_key': catalog['id']})
        domain.advance_clock(self.engine.db_path, 301)
        result = self.engine._execute_plan(plan['id'], plan['plan_hash'])
        self.assertEqual(self.engine._existing_action(catalog['id'])['status'], 'verified')
        self.assertEqual(result['activation_verified'], 0)
        self.assertFalse(domain.lumen_access(self.lumen.db_path, 'u00001')['allowed'])
        self.assertEqual(domain.adapty_profiles(self.provider.adapty_db, 'u00001')['status'], 'missing')

    def test_profile_binding_and_time_boundaries_are_strict(self):
        now = datetime(2026, 11, 7, 12, tzinfo=timezone.utc)
        source = {'product_id': 'annual', 'transaction_id': 'tx', 'expires_at': '2026-12-07T12:00:00Z'}
        profile = {**source, 'status': 'active', 'entitlement_hash': domain.digest({
            'user_id': 'u', 'product_id': 'annual', 'expires_at': source['expires_at']})}
        self.assertTrue(self.engine._profile_matches(profile, source, 'u', now))
        for field in ('product_id', 'transaction_id', 'expires_at', 'entitlement_hash'):
            self.assertFalse(self.engine._profile_matches({**profile, field: 'other'}, source, 'u', now))
        self.assertFalse(self.engine._profile_current({'expires_at': service.iso(now)}, now))
        self.assertEqual(service.parse_time('2026-11-07T13:00:00+01:00'), now)
        with self.assertRaises(ValueError):
            service.parse_time('2026-11-07T12:00:00')
        records = [{'occurred_at': '2026-11-07T11:00:00Z', 'observed_at': service.iso(now)},
                   {'occurred_at': '2026-11-07T12:30:00+02:00', 'observed_at': service.iso(now)}]
        self.assertIs(self.engine._latest_evidence(records), records[0])

    def test_cohort_signature_survives_catalog_repair_and_snapshot_is_immutable(self):
        plan = self.planned()
        before = self.engine._load_snapshot(plan['snapshot_id'])
        signature = self.engine._get_incident(plan['incident_id'])['cohort_signature']
        self.engine._execute_plan(plan['id'], plan['plan_hash'])
        self.assertEqual(self.engine._get_incident(plan['incident_id'])['cohort_signature'], signature)
        self.assertEqual(self.engine._load_snapshot(plan['snapshot_id']), before)

    def test_unexecuted_preview_cannot_replace_verified_probe(self):
        plan = self.planned()
        self.engine._create_plan({'incident_id': plan['incident_id'], 'ids': plan['ids']})
        self.engine._execute_plan(plan['id'], plan['plan_hash'])
        report = self.engine._report(plan['incident_id'])
        self.assertEqual(report['recovery']['access_verified'], 1)
        self.assertEqual(report['recovery']['unresolved'], 0)

    def test_collector_retry_recovers_crash_after_event_persistence(self):
        from recovery_sdk import sign
        manifest = self.engine._manifest()
        event = {'schema_version': 1, 'event_id': 'mobile:crash', 'run_id': manifest['run_id'],
                 'app': manifest['app'], 'environment': manifest['environment'], 'app_user_id': 'u00001',
                 'kind': 'mobile_observation', 'occurred_at': manifest['scenario_now'],
                 'correlation_id': 'crash', 'source_event_id': 'crash', 'details': {
                     'observation_kind': 'purchase_succeeded', 'transaction_id': 'reference',
                     'product_id': None, 'price_id': None, 'feature': None, 'reason_code': None}}
        envelope = {'schema_version': 1, 'event': event, 'sent_at': int(time.time())}
        signature = sign(envelope, self.engine.key)
        with patch.object(self.engine, '_start_incident', side_effect=OSError('crash')):
            with self.assertRaises(OSError):
                self.engine._collect(envelope, signature)
        replay = self.engine._collect(envelope, signature)
        self.assertTrue(replay['duplicate'])
        self.assertTrue(replay['incident_id'])
        self.assertTrue(replay['job_id'])
        self.assertEqual(self.engine._collect(envelope, signature), replay)

    def test_worker_capacity_drains_all_durable_jobs(self):
        engine = self.engine
        engine._launch_job = service.RecoveryService._launch_job.__get__(engine)
        completed = []
        original = engine._run_job
        def run(job_id):
            time.sleep(0.01)
            original(job_id)
            completed.append(job_id)
        with patch.object(engine, '_run_job', side_effect=run), patch.object(service, 'MAX_JOB_WORKERS', 2):
            # Unknown kinds terminate as failed; this tests queue scheduling, not scan I/O.
            jobs = [engine._new_job('invalid-test-kind', {}) for _ in range(12)]
            deadline = time.monotonic()+3
            while time.monotonic() < deadline and len(completed) < len(jobs):
                time.sleep(0.01)
        self.assertEqual(set(completed), set(jobs))
        for thread in threading.enumerate():
            if thread.name.startswith('recovery-job-'):
                thread.join(timeout=1)

    def test_evidence_freshness_money_and_unknown_lifecycle_never_enable_repair(self):
        plan = self.planned()
        incident = self.engine._get_incident(plan['incident_id'])
        for changes in ({'amount_minor': True}, {'amount_minor': 9.99},
                        {'currency': 'US'}, {'starts_at': '2028-01-01T00:00:00Z'},
                        {'payment_state': 'mystery'}, {'refund_state': 'unknown'},
                        {'observed_at': '2026-11-07T11:44:59Z'},
                        {'observed_at': '2026-11-07T12:00:01Z'}):
            observations = self.engine._observations()
            observations['evidence_by_id']['u00001'][0].update(changes)
            row = next(item for item in self.engine._classify(observations, incident) if item['id'] == 'u00001')
            with self.subTest(changes=changes):
                self.assertFalse(row['eligible'])
                self.assertEqual(row['status'], 'inconclusive')

    def test_expired_approval_blocks_every_write(self):
        plan = self.planned()
        domain.advance_clock(self.engine.db_path, 300)
        with self.assertRaisesRegex(service.RecoveryError, 'expired'):
            self.engine._start_execution({'plan_id': plan['id'], 'plan_hash': plan['plan_hash']})
        self.assertEqual(self.engine._actions(), [])

    def test_manual_investigation_reuses_automatic_incident_window(self):
        first, _ = self.engine._start_incident('u00001', trigger_event_id='customer-denial')
        second, _ = self.engine._start_incident('u00001')
        self.assertEqual(first, second)

    def test_collector_rechecks_scope_inside_persistence_transaction(self):
        from recovery_sdk import sign, validate_event
        manifest = self.engine._manifest()
        event = {'schema_version': 1, 'event_id': 'scope-race', 'run_id': manifest['run_id'],
                 'app': manifest['app'], 'environment': manifest['environment'], 'app_user_id': 'u00001',
                 'kind': 'mobile_observation', 'occurred_at': manifest['scenario_now'],
                 'correlation_id': 'scope-race', 'source_event_id': 'scope-race', 'details': {
                     'observation_kind': 'purchase_succeeded', 'transaction_id': None,
                     'product_id': None, 'price_id': None, 'feature': None, 'reason_code': None}}
        envelope = {'schema_version': 1, 'event': event, 'sent_at': int(time.time())}
        def change_generation(*args, **kwargs):
            validate_event(*args, **kwargs)
            self.engine._set_scenario_meta('run_id', 'new-generation')
        with patch('recovery_sdk.validate_event', side_effect=change_generation):
            with self.assertRaisesRegex(service.RecoveryError, 'scope changed'):
                self.engine._collect(envelope, sign(envelope, self.engine.key))
        db = domain.connect(self.engine.db_path)
        try:
            self.assertEqual(db.execute('SELECT COUNT(*) FROM collector_events').fetchone()[0], 0)
            self.assertEqual(db.execute('SELECT COUNT(*) FROM incidents').fetchone()[0], 0)
        finally:
            db.close()


if __name__ == '__main__':
    unittest.main()
