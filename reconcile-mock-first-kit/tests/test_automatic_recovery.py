"""Focused safety and durability checks for automatic live recovery."""
import json
from datetime import datetime, timedelta, timezone
from pathlib import Path
import sys
import tempfile
import threading
import time
import unittest
from unittest.mock import Mock, patch

sys.path.insert(0, str(Path(__file__).resolve().parent))
from test_live_recovery_flow import LiveHarness
import recovery_domain as domain
import recovery_monitor
import recovery_service as service
from recovery_sdk import sign


class AutomaticRecoveryTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix='reconcile-auto-recovery-')
        self.addCleanup(self.temporary.cleanup)
        self.h = LiveHarness(Path(self.temporary.name))
        self.addCleanup(self.h.close)
        self.h.engine.auto_repair = True

    def run_automatic_jobs(self, engine=None):
        engine = engine or self.h.engine
        for _ in range(8):
            db = domain.connect(engine.db_path)
            try:
                row = db.execute("SELECT id FROM jobs WHERE status='queued' "
                    "AND kind IN ('automatic_recovery','execution') ORDER BY created_at,rowid LIMIT 1").fetchone()
            finally:
                db.close()
            if row is None:
                return
            engine._run_job(row['id'])
        self.fail('Automatic policy jobs did not settle within the bounded retry budget')

    def start_incident(self):
        incident_id, snapshot, ids = self.h.inject_and_scan()
        self.assertEqual(len(snapshot['accounts']), 100)
        self.assertEqual(len(ids), 24)
        return incident_id, snapshot, ids

    def decisions(self, incident_id):
        db = domain.connect(self.h.engine.db_path)
        try:
            return [dict(row) for row in db.execute(
                'SELECT * FROM automatic_recovery WHERE incident_id=? ORDER BY attempt',
                (incident_id,))]
        finally:
            db.close()

    def actions(self, incident_id):
        db = domain.connect(self.h.engine.db_path)
        try:
            return [dict(row) for row in db.execute(
                'SELECT a.* FROM actions a JOIN plans p ON p.id=a.plan_id WHERE p.incident_id=?',
                (incident_id,))]
        finally:
            db.close()

    def test_policy_resyncs_only_local_access_and_verifies_each_gate(self):
        incident_id, _, ids = self.start_incident()
        self.run_automatic_jobs()

        decisions = self.decisions(incident_id)
        actions = self.actions(incident_id)
        self.assertEqual(len(decisions), 1)
        self.assertEqual(decisions[0]['status'], 'completed')
        self.assertEqual(json.loads(decisions[0]['selected_ids']), ids)
        self.assertEqual(len(actions), 48)
        self.assertEqual({row['owner'] for row in actions}, {'lumen'})
        self.assertEqual({row['status'] for row in actions}, {'verified'})
        db = domain.connect(self.h.engine.db_path)
        try:
            plan = json.loads(db.execute('SELECT plan_json FROM plans WHERE id=?',
                                          (decisions[0]['plan_id'],)).fetchone()[0])
            approvals = [dict(row) for row in db.execute(
                'SELECT * FROM approvals WHERE plan_id=?', (plan['id'],))]
        finally:
            db.close()
        self.assertEqual({entry['type'] for entry in plan['entries']},
                         {'resync_access', 'verify_gate'})
        self.assertEqual(plan['expected_effect']['provider_writes'], 0)
        self.assertFalse(plan['expected_effect']['manual_grant'])
        self.assertEqual([row['actor'] for row in approvals],
                         ['policy:local-fulfillment-resync-v2'])
        report = self.h.engine._report(incident_id)
        self.assertEqual(report['recovery']['access_verified'], 24)
        self.assertEqual(report['coverage']['provider_evidence'], 0)

    def test_source_fingerprint_change_after_scan_prevents_every_write(self):
        incident_id, _, ids = self.start_incident()
        self.h.source.changes[ids[0]] = 'fingerprint'
        self.run_automatic_jobs()

        self.assertEqual(self.decisions(incident_id)[0]['status'], 'unresolved')
        self.assertEqual(self.actions(incident_id), [])
        self.assertTrue(all(domain.lumen_action(self.h.lumen.db_path, user_id) is None
                            for user_id in ids))

    def test_unresolved_same_signature_denial_reuses_incident_and_retry_budget(self):
        incident_id, _, ids = self.start_incident()
        self.h.source.changes[ids[0]] = 'fingerprint'
        self.run_automatic_jobs()
        self.assertEqual(self.decisions(incident_id)[0]['status'], 'unresolved')

        occurred_at = service.iso_precise(datetime.now(timezone.utc))
        manifest = self.h.engine._manifest()
        event_id = 'customer:unresolved-repeat-'+str(id(self))
        envelope = {'schema_version': 1, 'event': {
            'schema_version': 1, 'event_id': event_id, 'run_id': manifest['run_id'],
            'app': manifest['app'], 'environment': manifest['environment'],
            'app_user_id': ids[0], 'kind': 'feature_access_decided',
            'occurred_at': occurred_at, 'correlation_id': event_id,
            'source_event_id': event_id, 'details': {
                'feature': 'premium_export', 'decision': 'deny', 'reason_code': 'subscription_inactive',
                'projection_version': 'test-handler-v1', 'cache_version': 'test-config-v1',
                'policy_version': 'access-policy-v2', 'adapter_version': 'lumen-adapter-v2',
                'initiator': 'customer_demo'}}, 'sent_at': int(time.time())}
        receipt = self.h.engine._collect(envelope, sign(envelope, self.h.engine.key))
        self.assertEqual(receipt['incident_id'], incident_id)
        self.h.engine._run_job(receipt['job_id'])
        self.assertEqual(len(self.decisions(incident_id)), 1)
        with self.assertRaises(service.RecoveryError):
            self.h.engine._simulation({'action': 'once', 'operation_key': 'unresolved-repeat'})

    def test_identity_revision_change_after_scan_prevents_every_write(self):
        incident_id, _, ids = self.start_incident()
        domain.lumen_demo_fault(self.h.lumen.db_path, 'identity', user_id=ids[0], status='unknown')
        self.run_automatic_jobs()

        self.assertEqual(self.decisions(incident_id)[0]['status'], 'unresolved')
        self.assertEqual(self.actions(incident_id), [])
        self.assertTrue(all(domain.lumen_action(self.h.lumen.db_path, user_id) is None
                            for user_id in ids))

    def test_final_fresh_source_read_failure_does_not_claim_verified_actions_as_repaired(self):
        incident_id, _, ids = self.start_incident()
        probe = self.h.engine._probe

        def expire_source_after_probe(user_id):
            result = probe(user_id)
            if user_id == ids[0]:
                self.h.source.changes[user_id] = 'expired'
            return result

        with patch.object(self.h.engine, '_probe', side_effect=expire_source_after_probe):
            self.run_automatic_jobs()

        item = next(row for row in recovery_monitor.build(self.h.engine)['incidents']
                    if row['id'] == incident_id)
        self.assertEqual(item['status'], 'unresolved')
        self.assertLess(item['repaired_accounts'], item['affected_accounts'])
        self.assertEqual(item['repaired_accounts'], 23)
        self.assertIn('verified the premium gate', item['repair_summary'])

    def test_late_queued_or_failed_diagnostic_scan_does_not_reopen_closed_recovery(self):
        incident_id, _, _ = self.start_incident()
        self.run_automatic_jobs()
        before = next(row for row in recovery_monitor.build(self.h.engine)['incidents']
                      if row['id'] == incident_id)
        self.assertEqual(before['status'], 'repaired')

        scan_id = self.h.engine._start_scan(incident_id)
        queued = next(row for row in recovery_monitor.build(self.h.engine)['incidents']
                      if row['id'] == incident_id)
        self.assertEqual(queued, before)
        with patch.object(self.h.engine, '_capture_snapshot',
                          side_effect=service.RecoveryError('diagnostic source unavailable', 503)):
            self.h.engine._run_job(scan_id)
        failed = next(row for row in recovery_monitor.build(self.h.engine)['incidents']
                      if row['id'] == incident_id)
        self.assertEqual(failed, before)

    def test_same_account_same_signature_new_denial_gets_a_separate_stable_history_row(self):
        first_id, _, _ = self.start_incident()
        self.run_automatic_jobs()
        user_id = self.h.users[0]
        original_at = self.h.engine._get_incident(first_id)['occurred_at']
        closed_at = service.iso_precise(service.parse_time(original_at)+timedelta(microseconds=500_000))
        db = domain.connect(self.h.engine.db_path)
        try:
            db.execute('UPDATE automatic_recovery SET updated_at=? WHERE incident_id=?',
                       (closed_at, first_id))
        finally:
            db.close()
        before = next(row for row in recovery_monitor.build(self.h.engine)['incidents']
                      if row['id'] == first_id)
        manifest = self.h.engine._manifest()
        def customer_denial(event_id, occurred_at):
            envelope = {'schema_version': 1, 'event': {
                'schema_version': 1, 'event_id': event_id, 'run_id': manifest['run_id'],
                'app': manifest['app'], 'environment': manifest['environment'],
                'app_user_id': user_id, 'kind': 'feature_access_decided',
                'occurred_at': occurred_at, 'correlation_id': event_id,
                'source_event_id': event_id, 'details': {
                    'feature': 'premium_export', 'decision': 'deny', 'reason_code': 'subscription_inactive',
                    'projection_version': 'test-handler-v1', 'cache_version': 'test-config-v1',
                    'policy_version': 'access-policy-v2', 'adapter_version': 'lumen-adapter-v2',
                    'initiator': 'customer_demo'}}, 'sent_at': int(time.time())}
            return self.h.engine._collect(envelope, sign(envelope, self.h.engine.key))

        late = customer_denial('customer:late-original-'+str(id(self)), original_at)
        self.assertEqual(late['incident_id'], first_id)
        self.h.engine._run_job(late['job_id'])
        self.run_automatic_jobs()
        self.assertEqual(len(self.decisions(first_id)), 1)

        fresh_at = service.iso_precise(service.parse_time(closed_at)+timedelta(microseconds=100_000))
        self.assertEqual(fresh_at[:19], closed_at[:19])
        self.assertGreater(service.parse_time(fresh_at), service.parse_time(closed_at))
        self.h.lumen._lumen_post('/internal/lumen/live/inject', {
            'user_ids': [user_id, self.h.users[1]], 'handler_version': 'test-handler-v1',
            'config_version': 'test-config-v1', 'occurred_at': fresh_at})
        receipt = customer_denial('customer:fresh-repeat-'+str(id(self)), fresh_at)
        second_id, job_id = receipt['incident_id'], receipt['job_id']
        self.assertNotEqual(first_id, second_id)
        self.h.engine._run_job(job_id)
        self.run_automatic_jobs()
        feed = recovery_monitor.build(self.h.engine)['incidents']
        self.assertEqual(next(row for row in feed if row['id'] == first_id), before)
        self.assertEqual(next(row for row in feed if row['id'] == second_id)['status'], 'repaired')

    def test_restart_resumes_queued_policy_execution_without_creating_duplicate_plan(self):
        incident_id, _, _ = self.start_incident()
        db = domain.connect(self.h.engine.db_path)
        try:
            job_id = db.execute("SELECT id FROM jobs WHERE kind='automatic_recovery' AND status='queued'").fetchone()[0]
        finally:
            db.close()
        self.h.engine._run_job(job_id)
        decision = self.decisions(incident_id)[0]
        self.assertEqual(decision['status'], 'awaiting_execution')
        execution_id = decision['execution_job_id']

        with (patch.object(service.RecoveryService, '_init_legacy'),
              patch.object(service.RecoveryService, '_launch_job')):
            restarted = service.RecoveryService('engine', 0, self.h.root/'engine.db',
                self.h.provider.key_file, provider_url='http://127.0.0.1:1',
                lumen_url='http://127.0.0.1:2', demo=True, live_config=self.h.config_path,
                auto_repair=True)
        restarted._launch_job = Mock()
        self.h.engine = restarted
        self.run_automatic_jobs(restarted)

        db = domain.connect(restarted.db_path)
        try:
            self.assertEqual(db.execute('SELECT COUNT(*) FROM plans WHERE incident_id=?',
                                        (incident_id,)).fetchone()[0], 1)
            self.assertEqual(db.execute("SELECT COUNT(*) FROM jobs WHERE kind='execution'").fetchone()[0], 1)
        finally:
            db.close()
        self.assertEqual(len(self.actions(incident_id)), 48)
        self.assertEqual(self.decisions(incident_id)[0]['status'], 'completed')

    def test_simulation_deduplicates_and_stop_status_stays_running_until_job_finishes(self):
        accepted = self.h.engine._simulation({'action': 'start', 'operation_key': 'unit-operation'})
        duplicate = self.h.engine._simulation({'action': 'start', 'operation_key': 'unit-operation'})
        self.assertEqual(accepted['job_id'], duplicate['job_id'])
        self.assertTrue(duplicate['duplicate'])
        stopped = self.h.engine._simulation({'action': 'stop'})
        self.assertEqual(stopped['status'], 'running')
        self.assertEqual(self.h.engine._simulation_summary()['status'], 'running')
        self.h.engine._run_job(accepted['job_id'])
        self.assertEqual(self.h.engine._get_job(accepted['job_id'])['status'], 'completed')
        self.assertEqual(self.h.engine._simulation_summary()['status'], 'stopped')

    def test_successful_bounded_retry_allows_next_simulation(self):
        incident_id, _, ids = self.start_incident()
        original_probe = self.h.engine._probe
        failed_once = set()

        def fail_one_probe_once(user_id):
            if user_id == ids[0] and user_id not in failed_once:
                failed_once.add(user_id)
                return {'allowed': False, 'reason': 'test_probe_failure'}
            return original_probe(user_id)

        with patch.object(self.h.engine, '_probe', side_effect=fail_one_probe_once):
            self.run_automatic_jobs()
        decisions = self.decisions(incident_id)
        self.assertEqual([row['status'] for row in decisions], ['retry_scheduled', 'completed'])
        simulation = self.h.engine._simulation({'action': 'once', 'operation_key': 'after-retry'})
        self.assertFalse(simulation['duplicate'])
        self.assertTrue(simulation['job_id'])

    def test_retry_of_safe_subset_keeps_other_unresolved_accounts_open(self):
        incident_id, _, ids = self.start_incident()
        original_probe = self.h.engine._probe
        failed_once = set()

        def leave_two_outcomes(user_id):
            result = original_probe(user_id)
            if user_id == ids[0]:
                self.h.source.changes[user_id] = 'expired'
            elif user_id == ids[1] and user_id not in failed_once:
                failed_once.add(user_id)
                return {'allowed': False, 'reason': 'test_probe_failure'}
            return result

        with patch.object(self.h.engine, '_probe', side_effect=leave_two_outcomes):
            self.run_automatic_jobs()

        decisions = self.decisions(incident_id)
        self.assertEqual([row['status'] for row in decisions], ['retry_scheduled', 'unresolved'])
        outcome = json.loads(decisions[1]['outcome_json'])
        self.assertEqual(outcome['reason'], 'retry_left_unresolved_targets')
        self.assertEqual(outcome['unresolved_ids'], [ids[0]])
        item = next(row for row in recovery_monitor.build(self.h.engine)['incidents']
                    if row['id'] == incident_id)
        self.assertEqual(item['status'], 'unresolved')
        self.assertEqual(item['repaired_accounts'], 23)
        with self.assertRaises(service.RecoveryError):
            self.h.engine._simulation({'action': 'once', 'operation_key': 'retry-left-open'})

    def test_stop_during_source_refresh_prevents_next_fault_injection(self):
        accepted = self.h.engine._simulation({'action': 'start', 'operation_key': 'stop-race'})
        entered, release = threading.Event(), threading.Event()
        users = self.h.users

        def pages(_base, path):
            if path == '/internal/provider/accounts':
                entered.set()
                self.assertTrue(release.wait(5), 'simulation source preparation timed out')
                return [{'user_id': user} for user in users]
            return []

        self.h.engine._pages = pages
        self.h.engine._notify_live_source_observations = lambda _profiles: None
        self.h.engine._observations = lambda: {
            'scope_ids': users,
            'profiles_by_id': {user: {} for user in users},
            'entitlement_by_id': {user: {} for user in users},
            'provider_by_id': {user: {'identity_status': 'mapped'} for user in users},
            'clients_by_id': {user: {'identity_status': 'mapped', 'policy_enabled': True,
                                     'gate': {'allowed': True}} for user in users}}
        self.h.engine._live_entitlement_current = lambda *_args: True
        self.h.engine._proxy_lumen_gate = lambda _body: (403, {'event_id': 'unused'})
        worker = threading.Thread(target=self.h.engine._run_job,
                                  args=(accepted['job_id'],), daemon=True)
        worker.start()
        self.assertTrue(entered.wait(5), 'simulation did not begin source preparation')
        self.assertTrue(self.h.engine._simulation({'action': 'stop'})['stop_requested'])
        release.set()
        worker.join(timeout=10)
        self.assertFalse(worker.is_alive())
        self.assertFalse(domain.lumen_live_fault_status(self.h.lumen.db_path)['injected'])
        self.assertEqual(self.h.engine._simulation_summary()['status'], 'stopped')


if __name__ == '__main__':
    unittest.main()
