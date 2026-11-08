"""Durability and evidence-scope regressions for automatic mock runs."""
from datetime import datetime, timedelta, timezone
import json
from pathlib import Path
import sys
import tempfile
import threading
import time
import unittest
from unittest.mock import Mock, patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import recovery_domain as domain
import recovery_monitor
import recovery_service as service


class MockRunHarness:
    def __init__(self, root):
        self.root = Path(root)
        key_file = self.root / 'collector.key'
        self.provider = service.RecoveryService('provider', 0, self.root/'provider.sqlite3',
                                                key_file, demo=True)
        with patch.object(service.RecoveryService, '_init_sdk'):
            self.lumen = service.RecoveryService('lumen', 0, self.root/'lumen.sqlite3', key_file,
                provider_url='http://127.0.0.1:1',
                collector_url='http://127.0.0.1:3/api/recovery/collector', demo=True)
        self.lumen._init_sdk = Mock()
        self.lumen.sdk = Mock()
        self.lumen.sdk.coverage.return_value = {'queued': 0}
        self.fail_lumen_reset = False
        self.coverage_entered = threading.Event()
        self.coverage_release = threading.Event()
        self.block_coverage = False
        self.reset_calls = []
        self.transport = patch.object(service, 'internal_request', side_effect=self.exchange)
        self.transport.start()
        self.engine = self.make_engine()

    def make_engine(self):
        with patch.object(service.RecoveryService, '_init_legacy'):
            engine = service.RecoveryService('engine', 0, self.root/'engine.sqlite3',
                self.provider.key_file, provider_url='http://127.0.0.1:1',
                lumen_url='http://127.0.0.1:2', demo=True, auto_repair=True)
        engine._launch_job = Mock()
        engine._proxy_lumen_gate = Mock(return_value=(403, {'event_id': 'customer-event'}))
        return engine

    def exchange(self, _key, base, method, path, body=None, **_kwargs):
        target = self.provider if base.endswith(':1') else self.lumen
        route, query = service._parse_query(path)
        if target is self.lumen and method == 'GET' and route == '/internal/lumen/collector-coverage':
            if self.block_coverage:
                self.coverage_entered.set()
                if not self.coverage_release.wait(5):
                    raise TimeoutError('coverage test gate timed out')
            return target._lumen_get(route, query)
        if target is self.lumen and method == 'POST' and route == '/internal/demo/reset':
            self.reset_calls.append('lumen')
            if self.fail_lumen_reset:
                raise OSError('simulated Lumen reset failure')
        if target is self.provider and method == 'POST' and route == '/internal/demo/reset':
            self.reset_calls.append('provider')
        if method == 'GET':
            return target._provider_get(route, query) if target is self.provider else target._lumen_get(route, query)
        result = target._provider_post(route, body) if target is self.provider else target._lumen_post(route, body)
        return result[0] if isinstance(result, tuple) else result

    def manifest(self, role):
        db = domain.connect(self.root/(role+'.sqlite3'))
        try:
            return domain.manifest(db)
        finally:
            db.close()

    def run_row(self, operation_key):
        db = domain.connect(self.engine.db_path)
        try:
            row = db.execute('SELECT * FROM mock_runs WHERE operation_key=?', (operation_key,)).fetchone()
            return None if row is None else dict(row)
        finally:
            db.close()

    def restart_engine(self):
        self.engine = self.make_engine()
        return self.engine

    def close(self):
        self.coverage_release.set()
        self.transport.stop()


class MockRunIntegrityTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix='reconcile-mock-run-')
        self.addCleanup(self.temporary.cleanup)
        self.h = MockRunHarness(Path(self.temporary.name))
        self.addCleanup(self.h.close)

    def test_same_key_replays_identical_result_across_restart(self):
        body = {'action': 'once', 'operation_key': 'durable-run'}
        first = self.h.engine._simulation(body)
        duplicate = self.h.engine._simulation(body)
        self.assertEqual(duplicate, first)
        run_id = self.h.manifest('provider')['run_id']
        self.assertEqual(run_id, first['run_id'])
        self.assertEqual(self.h.reset_calls, ['provider', 'lumen'])

        restarted = self.h.restart_engine()
        restarted._proxy_lumen_gate = Mock(side_effect=AssertionError('duplicate called the customer gate'))
        self.assertEqual(restarted._simulation(body), first)
        self.assertEqual(self.h.manifest('provider')['run_id'], run_id)
        self.assertEqual(self.h.reset_calls, ['provider', 'lumen'])
        self.assertEqual(self.h.run_row('durable-run')['status'], 'accepted')

    def test_concurrent_same_key_is_reserved_before_backlog_wait(self):
        self.h.block_coverage = True
        result = []
        worker = threading.Thread(target=lambda: result.append(
            self.h.engine._simulation({'action': 'once', 'operation_key': 'concurrent-run'})), daemon=True)
        worker.start()
        self.assertTrue(self.h.coverage_entered.wait(3), 'first request did not enter backlog wait')
        row = self.h.run_row('concurrent-run')
        self.assertEqual(row['status'], 'waiting')
        started = time.monotonic()
        with self.assertRaises(service.RecoveryError) as duplicate:
            self.h.engine._simulation({'action': 'once', 'operation_key': 'concurrent-run'})
        self.assertLess(time.monotonic()-started, 3)
        self.assertIn(row['run_id'], str(duplicate.exception))
        self.h.coverage_release.set()
        worker.join(timeout=10)
        self.assertFalse(worker.is_alive())
        self.assertEqual(len(result), 1)
        self.assertEqual(result[0]['status'], 'accepted')
        self.assertEqual(self.h.reset_calls, ['provider', 'lumen'])

    def test_lumen_reset_failure_stays_unknown_and_blocks_new_keys(self):
        self.h.fail_lumen_reset = True
        with self.assertRaises(service.RecoveryError) as failed:
            self.h.engine._simulation({'action': 'once', 'operation_key': 'split-reset'})
        row = self.h.run_row('split-reset')
        self.assertEqual((row['status'], row['step']), ('unknown', 'lumen_reset'))
        self.assertEqual(failed.exception.status, 503)
        self.assertIn(row['run_id'], str(failed.exception))
        self.assertNotEqual(self.h.manifest('provider')['run_id'], self.h.manifest('lumen')['run_id'])

        provider_run = self.h.manifest('provider')['run_id']
        for key in ('split-reset', 'new-key'):
            with self.assertRaises(service.RecoveryError) as retry:
                self.h.engine._simulation({'action': 'once', 'operation_key': key})
            self.assertEqual(retry.exception.status, 503)
            self.assertIn(row['run_id'], str(retry.exception))
        self.assertEqual(self.h.manifest('provider')['run_id'], provider_run)
        self.assertEqual(self.h.reset_calls, ['provider', 'lumen'])

        db = domain.connect(self.h.engine.db_path)
        try:
            db.execute("UPDATE mock_runs SET status='lumen_reset_pending' WHERE operation_key='split-reset'")
        finally:
            db.close()
        self.h.restart_engine()
        self.assertEqual(self.h.run_row('split-reset')['status'], 'unknown')
        with self.assertRaises(service.RecoveryError) as restarted_retry:
            self.h.engine._simulation({'action': 'once', 'operation_key': 'split-reset'})
        self.assertEqual(restarted_retry.exception.status, 503)
        self.assertEqual(self.h.manifest('provider')['run_id'], provider_run)

    def test_collector_history_is_limited_to_incident_run_app_and_environment(self):
        manifest = self.h.engine._manifest()
        now = datetime.now(timezone.utc)
        incident = {'run_id': manifest['run_id'], 'app': manifest['app'],
            'environment': manifest['environment'],
            'window_start': service.iso_precise(now-timedelta(minutes=1)),
            'window_end': service.iso_precise(now+timedelta(minutes=1))}
        scopes = [
            (incident['run_id'], incident['app'], incident['environment']),
            ('other-run', incident['app'], incident['environment']),
            (incident['run_id'], 'other-app', incident['environment']),
            (incident['run_id'], incident['app'], 'other-environment'),
        ]
        db = domain.connect(self.h.engine.db_path)
        try:
            for index, (run_id, app, environment) in enumerate(scopes):
                event = {'event_id': f'scope-{index}', 'run_id': run_id, 'app': app,
                    'environment': environment, 'occurred_at': service.iso_precise(now)}
                db.execute('INSERT INTO collector_events VALUES(?,?,?,?,?)',
                    (event['event_id'], str(index), json.dumps(event), service.iso_precise(now), 'test'))
        finally:
            db.close()
        events = self.h.engine._collector_events(incident)
        self.assertEqual([event['event_id'] for event in events], ['scope-0'])

    def test_timeline_describes_only_the_recorded_trigger(self):
        row = {'created_at': '2026-11-08T10:00:00Z'}
        incident = {'trigger_user_id': 'customer-1', 'trigger_event_id': None}
        manual, _ = recovery_monitor._timeline(row, incident, None, [], [], {}, {}, None)
        self.assertEqual(manual[0]['step'], 'Incident opened manually')
        self.assertNotIn('denied', manual[0]['detail'].lower())

        purchase = {'event_id': 'purchase-1', 'kind': 'mobile_observation',
            'app_user_id': 'customer-1', 'occurred_at': row['created_at'],
            'details': {'observation_kind': 'purchase_succeeded'}}
        incident['trigger_event_id'] = purchase['event_id']
        timeline, _ = recovery_monitor._timeline(row, incident, None, [], [], {}, {}, purchase)
        self.assertEqual(timeline[0]['step'], 'Purchase success was reported')
        self.assertIn('not independently verified', timeline[0]['detail'])

        denial = {'event_id': 'denial-1', 'kind': 'feature_access_decided',
            'app_user_id': 'customer-1', 'occurred_at': row['created_at'],
            'details': {'decision': 'deny', 'initiator': 'customer_demo'}}
        timeline, _ = recovery_monitor._timeline(row, incident, None, [], [], {}, {}, denial)
        self.assertEqual(timeline[0]['step'], 'Customer denied at the Lumen gate')


if __name__ == '__main__':
    unittest.main()
