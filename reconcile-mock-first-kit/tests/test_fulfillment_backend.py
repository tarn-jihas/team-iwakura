"""Focused safety checks for live fulfillment contracts."""
from datetime import datetime, timedelta, timezone
import json
from pathlib import Path
import sqlite3
import sys
import tempfile
import threading
import time
import unittest
from unittest.mock import Mock, patch

sys.path.insert(0, str(Path(__file__).resolve().parent))
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from test_live_recovery_flow import LiveHarness
import recovery_domain as domain
import recovery_live
import recovery_sdk
import recovery_service as service
import adapty_seed_setup


class FulfillmentBackendTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='reconcile-fulfillment-')
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)

    def _v2_request(self, harness, user_id):
        profile = harness.source.read(user_id)
        access = next(item for item in domain.lumen_accounts(harness.lumen.db_path)['items']
                      if item['user_id'] == user_id)
        entitlement = profile['entitlement']
        return {'schema_version': 2, 'user_id': user_id,
            'expected_provider_customer_id': access['provider_customer_id'],
            'expected_identity_revision': access['identity_revision'],
            'expected_policy_revision': access['policy_revision'],
            'expected_projection_revision': access['projection_revision'],
            'processing_id': 'processing-test', 'trace_id': 'trace-test',
            'operation_key': 'operation-test',
            'entitlement': {key: entitlement[key] for key in (
                'product_id', 'expires_at', 'entitlement_hash', 'transaction_id',
                'source_fingerprint', 'store', 'source_environment')}}

    def test_mock_fulfillments_require_matching_active_source_and_allowed_gate(self):
        user_id, transaction_id = 'u00001', 'txn-u00001'
        evidence = {'user_id':user_id, 'provider_customer_id':'cust-u00001',
            'transaction_id':transaction_id, 'product_id':'premium.annual',
            'starts_at':'2026-01-01T00:00:00Z', 'expires_at':'2027-01-01T00:00:00Z',
            'observed_at':'2026-06-01T00:00:00Z',
            'evidence_hash':'a'*64, 'provenance':'synthetic_extension'}
        profile = {'status':'active', 'product_id':evidence['product_id'],
            'expires_at':evidence['expires_at']}
        expected_hash = service.digest({'user_id':user_id,
            'product_id':evidence['product_id'], 'expires_at':evidence['expires_at']})
        client = {'access_active':True, 'access_expires_at':evidence['expires_at'],
            'entitlement_hash':expected_hash, 'gate':{'allowed':False,'reason':'subscription_inactive'}}
        engine = object.__new__(service.RecoveryService)
        engine.live_config = None
        engine.demo = True
        engine.role = 'engine'
        engine.db_path = self.root / 'fulfillments.sqlite3'
        db = sqlite3.connect(engine.db_path)
        db.execute('CREATE TABLE collector_events(event_json TEXT)')
        db.commit()
        db.close()
        engine.scenario_now = Mock(return_value=datetime(2026, 6, 1, tzinfo=timezone.utc))
        engine._mutation_lock = threading.RLock()
        engine._observations = Mock(return_value={'evidence_by_id':{user_id:[evidence]},
            'profiles_by_id':{user_id:profile}, 'clients_by_id':{user_id:client},
            'scope_ids':[user_id],
            'complete':True,'gaps':[],'observed_at':'2026-01-01T00:00:00Z'})
        engine._manifest = Mock(return_value={'app':'mock-lumen-activation'})
        engine._live_processing_receipts = Mock(return_value=set())

        item = engine._fulfillments()['items'][0]
        self.assertEqual(item['stages'], {'source_recorded':'recorded',
            'application_applied':'applied', 'access_verified':'unknown'})
        self.assertEqual(item['status'], 'discrepancy')

        profile['status'] = 'missing'
        client['gate']['allowed'] = True
        item = engine._fulfillments()['items'][0]
        self.assertEqual(item['stages'], {'source_recorded':'unknown',
            'application_applied':'unknown', 'access_verified':'unknown'})
        self.assertEqual(item['status'], 'discrepancy')
        self.assertEqual(item['display_label'], 'Activation missing')

        profile['status'] = 'active'
        item = engine._fulfillments()['items'][0]
        self.assertEqual(item['stages']['access_verified'], 'verified')
        self.assertEqual(item['status'], 'verified_application')
        self.assertEqual(engine._fulfillments(status='discrepancy')['items'], [])
        self.assertIsNone(engine._fulfillments()['pagination']['next_cursor'])

        evidence['expires_at'] = '2026-05-31T00:00:00Z'
        item = engine._fulfillments()['items'][0]
        self.assertEqual(item['access_state'], 'discrepancy')
        self.assertNotEqual(item['stages']['access_verified'], 'verified')
        client['gate'] = {'allowed':False,'reason':'subscription_expired'}
        item = engine._fulfillments()['items'][0]
        self.assertEqual(item['access_state'], 'expired')
        self.assertEqual(item['display_label'], 'Subscription expired')
        client['gate'] = {'allowed':False,'reason':'policy_restricted'}
        self.assertEqual(engine._fulfillments()['items'][0]['access_state'], 'policy_restricted')

    def test_pending_demo_exposes_bootstrap_until_initial_replay_finishes(self):
        harness = LiveHarness(self.root, pending=True)
        self.addCleanup(harness.close)
        user_id = harness.users[0]
        self.assertFalse(domain.lumen_access(harness.lumen.db_path, user_id)['active'])
        self.assertTrue(harness.engine._simulation_summary()['bootstrap_required'])
        self.assertEqual(harness.engine._simulation_summary()['bootstrap_status'], 'not_started')

        harness.engine.auto_repair = True
        accepted = harness.engine._simulation({'action':'bootstrap',
            'operation_key':'initial-replay-test'})
        self.assertFalse(accepted['duplicate'])
        running = harness.engine._simulation_summary()
        self.assertTrue(running['bootstrap_required'])
        self.assertEqual(running['bootstrap_status'], 'running')
        harness.engine._finish_simulation(accepted['simulation_id'], 'completed')
        completed = harness.engine._simulation_summary()
        self.assertFalse(completed['bootstrap_required'])
        self.assertEqual(completed['bootstrap_status'], 'completed')

    def test_pending_initial_projection_waits_for_bootstrap_instead_of_auto_repairing(self):
        harness = LiveHarness(self.root, pending=True)
        self.addCleanup(harness.close)
        harness.engine.auto_repair = True
        domain.lumen_simulation_configure(harness.lumen.db_path, [], paused=False)
        harness.engine._live_fulfillment_audit(refresh_source=True)
        self.assertFalse(domain.lumen_access(harness.lumen.db_path,
            harness.users[0])['active'])
        db = domain.connect(harness.engine.db_path)
        try:
            db.execute('UPDATE fulfillment_expectations SET first_observed_at=?',
                (service.iso(datetime.now(timezone.utc)-timedelta(seconds=60)),))
        finally:
            db.close()

        harness.engine._live_fulfillment_audit(refresh_source=False)

        db = domain.connect(harness.engine.db_path)
        try:
            incidents = db.execute('SELECT COUNT(*) FROM incidents').fetchone()[0]
            statuses = {row[0] for row in db.execute(
                'SELECT status FROM fulfillment_expectations')}
        finally:
            db.close()
        self.assertEqual(incidents, 0)
        self.assertEqual(statuses, {'discrepancy'})
        self.assertFalse(domain.lumen_access(harness.lumen.db_path,
            harness.users[0])['active'])

    def test_prior_verified_right_bypasses_grace_during_another_handler_failure(self):
        harness = LiveHarness(self.root)
        self.addCleanup(harness.close)
        target_id, trigger_id = harness.users[:2]
        harness.engine._live_fulfillment_audit(refresh_source=True)
        target_profile = recovery_live.profile(harness.provider.db_path, target_id)
        trigger_profile = recovery_live.profile(harness.provider.db_path, trigger_id)
        db = domain.connect(harness.lumen.db_path)
        try:
            db.execute('UPDATE access SET active=0,cache_active=0 WHERE user_id IN (?,?)',
                (target_id,trigger_id))
        finally:
            db.close()
        manifest = harness.engine._manifest()
        occurred_at = service.iso(datetime.now(timezone.utc))
        event = {'schema_version':2,'event_id':'handler:other-account-failure',
            'run_id':manifest['run_id'],'app':manifest['app'],
            'environment':manifest['environment'],'app_user_id':trigger_id,
            'kind':'handler_completed','occurred_at':occurred_at,
            'correlation_id':'other-account-failure','source_event_id':'source-other',
            'details':{'outcome':'failed','transaction_id':
                trigger_profile['entitlement']['transaction_id'],
                'source_hash':trigger_profile['source_fingerprint']}}
        db = domain.connect(harness.engine.db_path)
        try:
            db.execute('INSERT INTO collector_events VALUES(?,?,?,?,?)',
                (event['event_id'],service.digest(event),service._json(event),occurred_at,
                 'unit-test'))
        finally:
            db.close()
        observations = harness.engine._observations()
        incident = {'trigger_event_id':event['event_id'],'occurred_at':occurred_at,
            'window_start':service.iso(datetime.now(timezone.utc)-timedelta(minutes=5)),
            'window_end':service.iso(datetime.now(timezone.utc)+timedelta(minutes=5))}

        row = next(item for item in harness.engine._classify_live(observations,incident)
                   if item['id'] == target_id)

        self.assertEqual(row['status'],'confirmed')
        self.assertTrue(row['eligible'])
        self.assertTrue(target_profile['identity_match'])

    def test_same_verified_source_version_regression_bypasses_new_right_grace(self):
        harness=LiveHarness(self.root)
        self.addCleanup(harness.close)
        user_id=harness.users[0]
        harness.engine._live_fulfillment_audit(refresh_source=True)
        db=domain.connect(harness.lumen.db_path)
        try:
            db.execute('UPDATE access SET active=0,cache_active=0 WHERE user_id=?',(user_id,))
        finally:
            db.close()

        harness.engine._live_fulfillment_audit(refresh_source=False)

        db=domain.connect(harness.engine.db_path)
        try:
            row=db.execute('SELECT status,reason FROM fulfillment_expectations WHERE '
                "key_json LIKE ? ORDER BY updated_at DESC LIMIT 1",('%'+user_id+'%',)).fetchone()
        finally:
            db.close()
        self.assertEqual(row['status'],'discrepancy')

    def test_normal_source_handler_commits_once_and_replays_its_durable_receipt(self):
        harness = LiveHarness(self.root, pending=True)
        self.addCleanup(harness.close)
        user_id = harness.users[0]
        domain.lumen_simulation_configure(harness.lumen.db_path, [], paused=False)
        manifest = harness.lumen._manifest()
        harness.lumen.sdk = recovery_sdk.CollectorSDK(harness.lumen.key,
            manifest['run_id'],manifest['app'],lambda *_args: {'accepted':True},
            outbox_path=self.root/'handler-outbox.sqlite3',
            environment=manifest['environment'])
        profile = harness.source.read(user_id)
        processing_id = 'normal-handler-test'
        first = harness.engine._deliver_live_source_handlers(
            [profile], {user_id: processing_id})
        projection = domain.lumen_access(harness.lumen.db_path, user_id)
        self.assertEqual(first['handled'], 1, first)
        self.assertEqual(first['failed'], 0)
        self.assertTrue(projection['allowed'])
        revision = projection['projection_revision']
        queued = harness.lumen.sdk.coverage()['queued']
        self.assertEqual(queued, 3)
        with sqlite3.connect(harness.lumen.sdk.outbox_path) as db:
            events = [json.loads(row[0]) for row in db.execute('SELECT event_json FROM sdk_events')]
        projection_event = next(item for item in events if item['kind']=='access_projection_changed')
        self.assertNotIn('source_hash',projection_event['details']['before'])
        self.assertEqual(projection_event['details']['processing_id'],processing_id)
        receipt = domain.lumen_handler_result(harness.lumen.db_path, processing_id)
        self.assertEqual(receipt['outcome'], 'completed')
        self.assertEqual(receipt['result']['steps'][0]['name'], 'receive')

        duplicate = harness.engine._deliver_live_source_handlers(
            [profile], {user_id: processing_id})

        self.assertEqual(duplicate['handled'], 1)
        self.assertEqual(harness.lumen.sdk.coverage()['queued'],queued)
        self.assertEqual(domain.lumen_access(harness.lumen.db_path, user_id)['projection_revision'],
            revision)
        self.assertEqual(domain.lumen_handler_result(harness.lumen.db_path,
            processing_id)['result'], receipt['result'])

    def test_committed_handler_with_outbox_failure_is_not_reported_as_db_failure(self):
        harness = LiveHarness(self.root, pending=True)
        self.addCleanup(harness.close)
        user_id = harness.users[0]
        domain.lumen_simulation_configure(harness.lumen.db_path, [], paused=False)
        harness.lumen.sdk = Mock()
        harness.lumen.sdk.emit.side_effect = OSError('local outbox unavailable')
        profile = harness.source.read(user_id)

        result = harness.engine._deliver_live_source_handlers(
            [profile],{user_id:'telemetry-gap-test'})

        self.assertEqual(result['handled'],1)
        self.assertEqual(result['failed'],0)
        self.assertTrue(domain.lumen_access(harness.lumen.db_path,user_id)['allowed'])
        receipt = domain.lumen_handler_result(harness.lumen.db_path,'telemetry-gap-test')
        self.assertEqual(receipt['outcome'],'completed')
        self.assertTrue(receipt['result']['telemetry_gap'])

    def test_handler_result_readback_keeps_only_latest_source_key_result(self):
        harness = LiveHarness(self.root, pending=True)
        self.addCleanup(harness.close)
        user_id = harness.users[0]
        profile = harness.source.read(user_id)
        entitlement = profile['entitlement']
        for processing_id,outcome,recorded_at in (
                ('older','failed','2026-01-01T00:00:00Z'),
                ('newer','completed','2026-01-02T00:00:00Z')):
            domain.lumen_save_handler_result(harness.lumen.db_path,processing_id,user_id,
                entitlement['transaction_id'],profile['source_fingerprint'],outcome,
                {'outcome':outcome},recorded_at)

        result = domain.lumen_handler_results(harness.lumen.db_path,limit=1)

        matching = [item for item in result['items'] if item['user_id'] == user_id]
        self.assertEqual(len(matching),1)
        self.assertEqual(matching[0]['processing_id'],'newer')
        self.assertEqual(matching[0]['outcome'],'completed')

    def test_open_incident_accounts_follow_durable_gate_closure(self):
        harness = LiveHarness(self.root)
        self.addCleanup(harness.close)
        repaired, unresolved = harness.users[:2]
        incident_id, snapshot_id, plan_id = 'incident-closed','snapshot-closed','plan-closed'
        incident = {'id':incident_id,'trigger_user_id':repaired,
            'snapshot_id':snapshot_id,'first_snapshot_id':snapshot_id,
            'confirmed_ids':[repaired,unresolved],'status':'ready'}
        snapshot = {'accounts':[{'id':repaired,'status':'confirmed'},
            {'id':unresolved,'status':'confirmed'}]}
        entries = [{'id':'verify-repaired','account_id':repaired,'type':'verify_gate'},
            {'id':'verify-unresolved','account_id':unresolved,'type':'verify_gate'}]
        plan = {'id':plan_id,'incident_id':incident_id,'entries':entries}
        db = domain.connect(harness.engine.db_path)
        try:
            db.execute('INSERT INTO incidents VALUES(?,?,?,?)',
                (incident_id,None,service._json(incident),service.iso(datetime.now(timezone.utc))))
            db.execute('INSERT INTO snapshots VALUES(?,?,?,?,?,?)',
                (snapshot_id,incident_id,service.iso(datetime.now(timezone.utc)),
                 service.iso(datetime.now(timezone.utc)),'snapshot-hash',service._json(snapshot)))
            db.execute('INSERT INTO plans VALUES(?,?,?,?,?,?,?,?,?)',
                (plan_id,'plan-hash',incident_id,snapshot_id,service._json(plan),'completed',
                 service.iso(datetime.now(timezone.utc)),service.iso(datetime.now(timezone.utc)+timedelta(minutes=5)),
                 service.iso(datetime.now(timezone.utc)+timedelta(minutes=5))))
            db.execute('INSERT INTO actions VALUES(?,?,?,?,?,?,?,?,?,?,?)',
                ('verify-repaired',plan_id,repaired,'lumen',service._json({'feature':'premium_export'}),
                 service._json({'projection_revision':2}),'verified',None,
                 service.iso(datetime.now(timezone.utc)),None,service._json({'allowed':True})))
        finally:
            db.close()

        open_accounts = harness.engine._live_open_incident_accounts()

        self.assertNotIn(repaired,open_accounts)
        self.assertIn(unresolved,open_accounts)
        generator_exclusions = harness.engine._live_open_incident_accounts(include_verified=True)
        self.assertTrue({repaired,unresolved} <= generator_exclusions)
        self.assertTrue({repaired,unresolved} <= open_accounts | generator_exclusions)

    def test_live_cohort_reuses_only_an_in_progress_incident(self):
        harness = LiveHarness(self.root)
        self.addCleanup(harness.close)
        at = datetime.now(timezone.utc)
        start = service.iso(at-timedelta(minutes=5))
        end = service.iso(at+timedelta(minutes=5))
        signature = {'handler_version':'handler-v1','config_version':'config-v1'}
        first = harness.engine._start_incident(harness.users[0],service.iso(at),start,end,
            'handler-event-1',signature)
        same = harness.engine._start_incident(harness.users[1],service.iso(at+timedelta(seconds=1)),
            start,end,'handler-event-2',signature)
        self.assertEqual(same[0],first[0])
        db = domain.connect(harness.engine.db_path)
        try:
            db.execute("UPDATE jobs SET status='completed' WHERE id=?",(first[1],))
            now=service.iso(datetime.now(timezone.utc))
            db.execute('INSERT INTO automatic_recovery VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)',
                ('terminal-decision',first[0],'snapshot-terminal',0,
                 'local-fulfillment-resync-v2','unresolved','[]','job-terminal',None,None,
                 service._json({'reason':'unresolved'}),now,now))
        finally:
            db.close()

        next_episode = harness.engine._start_incident(harness.users[2],
            service.iso(at+timedelta(seconds=2)),start,end,'handler-event-3',signature)

        self.assertNotEqual(next_episode[0],first[0])

    def test_handler_failure_does_not_attach_to_a_closed_fulfillment_episode(self):
        harness = LiveHarness(self.root)
        self.addCleanup(harness.close)
        harness.engine._live_fulfillment_audit(refresh_source=True)
        user_id=harness.users[0]
        profile=recovery_live.profile(harness.provider.db_path,user_id)
        entitlement=profile['entitlement']
        db=domain.connect(harness.engine.db_path)
        try:
            db.execute('UPDATE fulfillment_expectations SET incident_id=?,episode_open=0 '
                'WHERE source_fingerprint=?',('closed-episode',profile['source_fingerprint']))
        finally:
            db.close()
        event={'app_user_id':user_id,'details':{'transaction_id':entitlement['transaction_id'],
            'source_hash':profile['source_fingerprint']}}

        self.assertIsNone(harness.engine._open_fulfillment_incident_for_handler(event))

    def test_failed_handler_batch_creates_one_source_assessed_incident(self):
        harness = LiveHarness(self.root,pending=True)
        self.addCleanup(harness.close)
        harness.engine.auto_repair = True
        harness.engine._live_fulfillment_audit(refresh_source=True)
        profiles = harness.engine._pages(harness.engine.provider_url,'/internal/adapty/profiles')
        ordered = sorted(profiles,key=lambda item:item['user_id'])
        faults = [{'user_id':item['user_id'],'fault_mode':'handler_precommit',
            'remaining_attempts':1,'permanent':False} for item in ordered[:23]]
        faults.append({'user_id':ordered[23]['user_id'],'fault_mode':'permanent_handler',
            'remaining_attempts':1,'permanent':True})
        domain.lumen_simulation_configure(harness.lumen.db_path,faults,paused=False)
        processing_ids={item['user_id']:'batch-'+str(index)
            for index,item in enumerate(ordered)}

        replay=harness.engine._deliver_live_source_handlers(ordered,processing_ids)
        direct=domain.lumen_handler_results(harness.lumen.db_path,limit=500)
        self.assertEqual(len(direct['items']),100)
        observed=harness.engine._observations()
        self.assertEqual(len(observed['handler_results_by_key']),100,
            observed.get('gaps'))
        self.assertEqual(sum(row['outcome']=='failed' for row in
            observed['handler_results_by_key'].values()),24)
        audit=harness.engine._live_fulfillment_audit(refresh_source=False,
            handler_batch_complete=True)

        self.assertEqual((replay['accepted'],replay['handled'],replay['failed']),
            (100,76,24))
        self.assertIsNotNone(audit['incident_id'],audit)
        db=domain.connect(harness.engine.db_path)
        try:
            incidents=db.execute('SELECT COUNT(*) FROM incidents').fetchone()[0]
            linked=db.execute('SELECT COUNT(*) FROM fulfillment_expectations WHERE incident_id=?',
                (audit['incident_id'],)).fetchone()[0]
            reasons={row['reason']:row['count'] for row in db.execute(
                'SELECT reason,COUNT(*) AS count FROM fulfillment_expectations GROUP BY reason')}
        finally:
            db.close()
        self.assertEqual(incidents,1)
        self.assertEqual(linked,24)
        self.assertEqual(reasons.get('handler_processing_failed'),24)

    def test_pending_bootstrap_finishes_one_24_account_partial_recovery(self):
        harness = LiveHarness(self.root,pending=True)
        self.addCleanup(harness.close)
        harness.engine.auto_repair=True
        def run_job(job_id):
            harness.engine._run_job(job_id)
            harness.engine._resume_jobs()
        harness.engine._launch_job=run_job

        accepted=harness.engine._simulation({'action':'bootstrap',
            'operation_key':'public-bootstrap-full-flow'})
        summary=harness.engine._simulation_summary()
        db=domain.connect(harness.engine.db_path)
        try:
            incident_row=db.execute('SELECT id FROM incidents ORDER BY created_at DESC LIMIT 1').fetchone()
            snapshot_row=None if incident_row is None else db.execute(
                'SELECT snapshot_json FROM snapshots WHERE incident_id=? ORDER BY created_at DESC LIMIT 1',
                (incident_row['id'],)).fetchone()
            account_summary={}
            if snapshot_row:
                for item in json.loads(snapshot_row['snapshot_json'])['accounts']:
                    key=(item['status'],item['reason'])
                    account_summary[key]=account_summary.get(key,0)+1
            diagnostic={'incidents':db.execute('SELECT COUNT(*) FROM incidents').fetchone()[0],
                'decisions':[dict(row) for row in db.execute(
                    'SELECT incident_id,status,selected_ids,outcome_json FROM automatic_recovery')],
                'expectations':{row['status']:row['count'] for row in db.execute(
                    'SELECT status,COUNT(*) AS count FROM fulfillment_expectations GROUP BY status')},
                'snapshot_accounts':account_summary,
                'snapshot_coverage':None if not snapshot_row else json.loads(
                    snapshot_row['snapshot_json'])['coverage']}
        finally:
            db.close()

        self.assertEqual(summary['bootstrap_status'],'completed',(summary,diagnostic))
        self.assertEqual(summary['result']['handler_completed'],76)
        self.assertEqual(summary['result']['handler_failed'],24)
        self.assertEqual(summary['result']['repaired'],23)
        self.assertEqual(summary['result']['unresolved'],1)
        db=domain.connect(harness.engine.db_path)
        try:
            incidents=db.execute('SELECT COUNT(*) FROM incidents').fetchone()[0]
            incident=db.execute('SELECT id FROM incidents LIMIT 1').fetchone()[0]
            linked=db.execute('SELECT COUNT(*) FROM fulfillment_expectations WHERE incident_id=?',
                (incident,)).fetchone()[0]
            statuses={row['status']:row['count'] for row in db.execute(
                'SELECT status,COUNT(*) AS count FROM fulfillment_expectations GROUP BY status')}
        finally:
            db.close()
        self.assertEqual(accepted['status'],'running')
        self.assertEqual(incidents,1)
        self.assertEqual(linked,24)
        self.assertEqual(statuses.get('verified_application'),99)
        self.assertEqual(statuses.get('discrepancy'),1)
        before_revisions={row['user_id']:row['projection_revision'] for row in
            domain.lumen_accounts(harness.lumen.db_path)['items']}
        before_actions=domain.connect(harness.lumen.db_path)
        try:
            action_count=before_actions.execute('SELECT COUNT(*) FROM actions').fetchone()[0]
        finally:
            before_actions.close()
        harness.engine._finish_simulation(accepted['simulation_id'],'stopped')

        resumed=harness.engine._live_simulation_control({'action':'resume',
            'simulation_id':accepted['simulation_id']})

        after_revisions={row['user_id']:row['projection_revision'] for row in
            domain.lumen_accounts(harness.lumen.db_path)['items']}
        action_db=domain.connect(harness.lumen.db_path)
        try:
            self.assertEqual(action_db.execute('SELECT COUNT(*) FROM actions').fetchone()[0],
                action_count)
        finally:
            action_db.close()
        self.assertTrue(resumed['resumed'])
        self.assertEqual(after_revisions,before_revisions)

    def test_normal_handler_failure_emits_bounded_v2_receipt_without_projection_write(self):
        harness = LiveHarness(self.root, pending=True)
        self.addCleanup(harness.close)
        user_id = harness.users[0]
        domain.lumen_simulation_configure(harness.lumen.db_path, [{
            'user_id':user_id,'fault_mode':'handler_precommit',
            'remaining_attempts':1,'permanent':False}], paused=False)
        manifest = harness.lumen._manifest()
        harness.lumen.sdk = recovery_sdk.CollectorSDK(harness.lumen.key,
            manifest['run_id'],manifest['app'],lambda *_args: {'accepted':True},
            outbox_path=self.root/'failed-handler-outbox.sqlite3',
            environment=manifest['environment'])
        processing_id = 'failed-handler-test'
        profile = harness.source.read(user_id)

        result = harness.engine._deliver_live_source_handlers(
            [profile],{user_id:processing_id})

        self.assertEqual(result['failed'],1)
        self.assertFalse(domain.lumen_access(harness.lumen.db_path,user_id)['active'])
        stored = domain.lumen_handler_result(harness.lumen.db_path,processing_id)
        self.assertEqual(stored['outcome'],'failed')
        self.assertNotIn('fresh_source_read', {step['name'] for step in stored['result']['steps']})
        self.assertNotIn('projection_commit', {step['name'] for step in stored['result']['steps']})
        self.assertEqual(stored['result']['steps'][-2]['result'],'mismatched')
        self.assertEqual(stored['result']['steps'][-1]['result'],'denied')
        db = sqlite3.connect(harness.lumen.sdk.outbox_path)
        try:
            events = [json.loads(row[0]) for row in db.execute(
                'SELECT event_json FROM sdk_events ORDER BY created_at,event_id')]
        finally:
            db.close()
        handler = next(event for event in events if event['kind'] == 'handler_completed')
        self.assertEqual(handler['schema_version'],2)
        self.assertEqual(handler['details']['outcome'],'failed')
        self.assertLessEqual(len(handler['details']['steps']),32)

    def test_timeout_after_commit_uses_action_and_gate_readback_as_success(self):
        harness = LiveHarness(self.root,pending=True)
        self.addCleanup(harness.close)
        user_id = harness.users[0]
        domain.lumen_simulation_configure(harness.lumen.db_path,[],paused=False)
        profile = harness.source.read(user_id)
        first = harness.engine._deliver_live_source_handlers(
            [profile],{user_id:'before-timeout'})
        self.assertEqual(first['handled'],1)
        self.assertTrue(domain.lumen_access(harness.lumen.db_path,user_id)['allowed'])
        configured = domain.lumen_simulation_configure(harness.lumen.db_path,[{
            'user_id':user_id,'fault_mode':'timeout_after_commit',
            'remaining_attempts':1,'permanent':False}],paused=False,
            prepare_projection_loss=[user_id])
        self.assertEqual(configured['prepared_projection_losses'],1)

        delivered = harness.engine._deliver_live_source_handlers(
            [profile],{user_id:'timeout-after-commit'})
        result = domain.lumen_handler_result(harness.lumen.db_path,'timeout-after-commit')['result']
        operation = domain.lumen_action(harness.lumen.db_path,result['operation_key'])
        access = domain.lumen_access(harness.lumen.db_path,user_id)

        self.assertEqual(delivered['handled'],1,delivered)
        self.assertEqual(result['outcome'],'completed')
        self.assertEqual(result['reason'],'committed_readback')
        self.assertIsNotNone(operation)
        self.assertTrue(access['allowed'])
        self.assertEqual(result['steps'][-1]['reason_code'],'timeout_after_commit')

    def test_processing_id_cannot_be_reused_for_another_source_account(self):
        harness = LiveHarness(self.root,pending=True)
        self.addCleanup(harness.close)
        domain.lumen_simulation_configure(harness.lumen.db_path,[],paused=False)
        first_profile,second_profile = [harness.source.read(user_id)
            for user_id in harness.users[:2]]
        processing_id = 'bound-processing-id'
        harness.engine._deliver_live_source_handlers(
            [first_profile],{first_profile['user_id']:processing_id})

        with self.assertRaises(service.RecoveryError) as error:
            harness.engine._deliver_live_source_handlers(
                [second_profile],{second_profile['user_id']:processing_id})

        self.assertEqual(error.exception.status,409)
        stored = domain.lumen_handler_result(harness.lumen.db_path,processing_id)
        self.assertEqual(stored['user_id'],first_profile['user_id'])

    def test_simulation_prepares_local_projection_loss_before_normal_handler_fault(self):
        harness=LiveHarness(self.root,pending=True)
        self.addCleanup(harness.close)
        user_id=harness.users[0]
        domain.lumen_simulation_configure(harness.lumen.db_path,[],paused=False)
        profile=harness.source.read(user_id)
        first=harness.engine._deliver_live_source_handlers([profile],
            {user_id:'precondition-handler'})
        self.assertEqual(first['handled'],1)
        intent_key='simcycle:'+service.digest({'operation_key':'cycle-test','user_id':user_id})
        processing_id='cycle-processing-test'
        harness.engine._save_simulation_intent(intent_key,'simulation-test',1,user_id,
            'handler_precommit',processing_id,'intent')

        outcome=harness.engine._live_handler_result('simulation-test',intent_key,
            processing_id,user_id,'handler_precommit')
        access=domain.lumen_access(harness.lumen.db_path,user_id)

        self.assertEqual(outcome['outcome'],'failed',outcome)
        self.assertEqual(access['reason'],'subscription_inactive')
        self.assertEqual(domain.lumen_handler_result(harness.lumen.db_path,processing_id)['outcome'],
            'failed')

    def test_delayed_older_simulation_is_rejected_without_source_writes(self):
        harness=LiveHarness(self.root,pending=True)
        self.addCleanup(harness.close)
        user_id=harness.users[0]
        domain.lumen_simulation_configure(harness.lumen.db_path,[],paused=False)
        older=harness.source.read(user_id)
        self.assertEqual(harness.engine._deliver_live_source_handlers([older],
            {user_id:'initial-current-right'})['handled'],1)
        operation_key='simcycle:'+service.digest({'operation_key':'delayed-old-cycle',
            'user_id':user_id})
        processing_id='delayed-old-cycle-processing'
        harness.engine._save_simulation_intent(operation_key,'simulation-test',1,user_id,
            'delayed_older_update',processing_id,'intent')
        result=harness.engine._live_handler_result('simulation-test',operation_key,
            processing_id,user_id,'delayed_older_update')
        current=harness.source.read(user_id)
        self.assertEqual(result['outcome'],'failed')
        self.assertEqual(result['error_class'],'recovery_http_409')
        self.assertIsNone(domain.lumen_action(harness.lumen.db_path,result['operation_key']))
        self.assertEqual(current['entitlement']['expires_at'],older['entitlement']['expires_at'])
        self.assertEqual(current['source_fingerprint'],older['source_fingerprint'])
        self.assertEqual(domain.lumen_access(harness.lumen.db_path,user_id)['reason'],
            'subscription_inactive')

    def test_live_resync_cas_receipt_and_projection_share_one_idempotent_operation(self):
        harness = LiveHarness(self.root)
        self.addCleanup(harness.close)
        body = self._v2_request(harness, harness.users[0])

        result = domain.lumen_resync(harness.lumen.db_path, body)
        duplicate = domain.lumen_resync(harness.lumen.db_path, body)
        access = domain.lumen_access(harness.lumen.db_path, harness.users[0])

        self.assertEqual(result['schema_version'], 2)
        self.assertEqual(result['transaction_id'], body['entitlement']['transaction_id'])
        self.assertEqual(result['trace_id'], 'trace-test')
        self.assertEqual(result['steps'][-1]['name'], 'cache_refresh')
        self.assertFalse(result['cache_skipped'])
        self.assertTrue(duplicate['duplicate'])
        self.assertEqual(access['projection_revision'], result['revisions']['projection'])
        self.assertTrue(access['allowed'])

    def test_live_resync_rejects_v1_and_each_changed_cas_revision_without_writes(self):
        harness = LiveHarness(self.root)
        self.addCleanup(harness.close)
        body = self._v2_request(harness, harness.users[0])
        legacy = {'user_id': body['user_id'], 'expected_revision': 1,
                  'entitlement': {key: body['entitlement'][key] for key in (
                      'product_id', 'expires_at', 'entitlement_hash', 'transaction_id',
                      'source_fingerprint')}, 'operation_key': 'legacy'}
        with self.assertRaisesRegex(ValueError, 'contract'):
            domain.lumen_resync(harness.lumen.db_path, legacy)

        mutations = (
            lambda db, user: db.execute('UPDATE mappings SET revision=revision+1 WHERE user_id=?', (user,)),
            lambda db, user: db.execute('UPDATE policies SET enabled=0,revision=revision+1 WHERE user_id=?', (user,)),
            lambda db, user: db.execute('UPDATE access SET projection_revision=projection_revision+1 WHERE user_id=?', (user,)),
            lambda db, user: (db.execute('UPDATE accounts SET provider_customer_id=? WHERE user_id=?', ('relinked', user)),
                              db.execute('UPDATE mappings SET provider_customer_id=? WHERE user_id=?', ('relinked', user))),
        )
        for index, mutate in enumerate(mutations):
            with self.subTest(revision=index):
                fresh = self._v2_request(harness, harness.users[index+1])
                fresh['operation_key'] = 'operation-race-'+str(index)
                db = domain.connect(harness.lumen.db_path)
                try:
                    mutate(db, fresh['user_id'])
                finally:
                    db.close()
                with self.assertRaises(ValueError):
                    domain.lumen_resync(harness.lumen.db_path, fresh)
                self.assertIsNone(domain.lumen_action(harness.lumen.db_path, fresh['operation_key']))

    def test_long_retry_after_blocks_concurrent_and_restarted_source_reads(self):
        provider = self.root/'provider.sqlite3'
        db = domain.connect(provider)
        try:
            db.execute('CREATE TABLE meta(key TEXT PRIMARY KEY,value TEXT NOT NULL)')
            db.execute('CREATE TABLE provider_accounts(user_id TEXT PRIMARY KEY,provider_customer_id TEXT,identity_status TEXT,provenance TEXT)')
            db.execute('CREATE TABLE live_profiles(user_id TEXT PRIMARY KEY,profile_json TEXT,error_code TEXT)')
            db.execute('CREATE TABLE live_catalog(id INTEGER PRIMARY KEY,catalog_json TEXT NOT NULL)')
            db.execute('INSERT INTO live_catalog VALUES(1,?)', (domain.canonical({'items': []}),))
        finally:
            db.close()
        secret = self.root/'adapty.key'
        secret.write_text('unit-test-only-key')
        secret.chmod(0o600)
        config = {'secret_key_file': str(secret)}
        attempts = []
        lock = threading.Lock()

        class Response:
            status = 429

            @staticmethod
            def getheader(name):
                return '120' if name == 'Retry-After' else None

        class Connection:
            def __init__(self, *_args, **_kwargs):
                pass

            def request(self, *_args, **_kwargs):
                with lock:
                    attempts.append(datetime.now(timezone.utc))

            @staticmethod
            def getresponse():
                return Response()

            @staticmethod
            def close():
                pass

        with patch.object(recovery_live.http.client, 'HTTPSConnection', Connection):
            reader = recovery_live.AdaptyReader(config, provider_path=provider)
            result = recovery_live.refresh_profiles(provider, {'customer_user_ids': ['u1', 'u2']},
                                                    reader, ['u1', 'u2'])
            self.assertEqual(result['observed'], 0)
            self.assertEqual(result['waiting_reason'], 'source_cooldown')
            self.assertEqual(result['source_calls'], 1)
            restarted = recovery_live.AdaptyReader(config, provider_path=provider)
            with self.assertRaises(recovery_live.LiveSourceError) as error:
                restarted.read('u1')
            self.assertEqual(error.exception.code, 'rate_limited')
        self.assertEqual(len(attempts), 1)
        source_status = recovery_live.status(provider)
        self.assertEqual(source_status['source_requests_total'], 1)
        self.assertEqual(source_status['last_source_pass']['source_calls'], 1)
        self.assertGreaterEqual(recovery_live._retry_delay('3600'), 3600)

    def test_restart_during_source_cooldown_uses_cached_catalog_without_source_calls(self):
        harness = LiveHarness(self.root)
        self.addCleanup(harness.close)
        db = domain.connect(harness.provider.db_path)
        try:
            before = domain._meta(db, 'catalog_observed_at')
            domain._set_meta(db, 'adapty_not_before_epoch', time.time()+120)
        finally:
            db.close()
        reads = harness.source.read
        with patch.object(harness.source, 'read', wraps=reads) as source_read, \
             patch.object(adapty_seed_setup, 'read_cli_catalog', side_effect=AssertionError('cooldown must skip CLI')) as cli_read:
            recovery_live.init_provider(harness.provider.db_path, harness.provider.adapty_db,
                harness.provider.live_config, harness.source)
        self.assertEqual(source_read.call_count, 0)
        cli_read.assert_not_called()
        db = domain.connect(harness.provider.db_path)
        try:
            self.assertEqual(domain._meta(db, 'catalog_observed_at'), before)
        finally:
            db.close()

    def test_full_scope_source_refresh_obeys_persistent_sixty_second_cadence(self):
        harness = LiveHarness(self.root)
        self.addCleanup(harness.close)
        before = recovery_live.status(harness.provider.db_path)
        started_at = before['last_source_pass']['started_at']

        result = recovery_live.refresh_profiles(harness.provider.db_path,
            harness.provider.live_config,harness.source,harness.users)

        after = recovery_live.status(harness.provider.db_path)
        self.assertEqual(result['waiting_reason'],'source_poll_interval')
        self.assertEqual(result['source_calls'],0)
        self.assertEqual(after['source_requests_total'],before['source_requests_total'])
        self.assertEqual(after['last_source_pass']['started_at'],started_at)
        self.assertIsNone(after['last_source_pass']['waiting_reason'])

    def test_single_profile_reads_preserve_last_complete_source_pass(self):
        harness = LiveHarness(self.root)
        self.addCleanup(harness.close)
        before = recovery_live.status(harness.provider.db_path)['last_source_pass']
        self.assertEqual(before['observed'],100)
        user_id = harness.users[0]

        for _ in range(101):
            result = recovery_live.refresh_profiles(harness.provider.db_path,
                harness.provider.live_config,harness.source,[user_id])
            self.assertEqual(result['observed'],1)

        after = recovery_live.status(harness.provider.db_path)['last_source_pass']
        self.assertEqual(after['started_at'],before['started_at'])
        self.assertEqual(after['observed'],100)
        self.assertIsNone(after['waiting_reason'])

    def test_newer_single_profile_read_cannot_be_overwritten_by_older_batch(self):
        harness = LiveHarness(self.root)
        self.addCleanup(harness.close)
        user_id, slower_user = harness.users[:2]
        body = self._v2_request(harness, user_id)
        reached_late_read, finish_late_read = threading.Event(), threading.Event()
        read = harness.source.read

        def pause_after_read(candidate):
            profile = read(candidate)
            if candidate == slower_user:
                reached_late_read.set()
                if not finish_late_read.wait(5):
                    raise TimeoutError('test read barrier timed out')
            return profile

        harness.source.read = pause_after_read
        batch_result, profile_result = {}, {}
        batch = threading.Thread(target=lambda: batch_result.update(
            recovery_live.refresh_profiles(harness.provider.db_path,
                harness.provider.live_config, harness.source, [user_id, slower_user])))
        batch.start()
        self.assertTrue(reached_late_read.wait(5))
        harness.source.changes[user_id] = 'revoked'
        single = threading.Thread(target=lambda: profile_result.update(
            harness.provider._provider_get('/internal/adapty/profile', {'user': [user_id]})))
        single.start()
        time.sleep(0.05)
        finish_late_read.set()
        batch.join(5)
        single.join(5)
        self.assertFalse(batch.is_alive())
        self.assertFalse(single.is_alive())
        self.assertEqual(profile_result.get('status'), 'unknown')
        cached = recovery_live.profile(harness.provider.db_path, user_id)
        self.assertEqual(cached['status'], 'unknown')
        with self.assertRaises(service.RecoveryError):
            harness.lumen._lumen_post('/internal/lumen/resync', body)
        self.assertIsNone(domain.lumen_action(harness.lumen.db_path, body['operation_key']))

    def test_live_classification_uses_individual_period_and_gate_evidence(self):
        harness = LiveHarness(self.root)
        self.addCleanup(harness.close)
        user_id = harness.users[0]
        db = domain.connect(harness.lumen.db_path)
        try:
            db.execute('UPDATE access SET active=0,cache_active=0 WHERE user_id=?', (user_id,))
        finally:
            db.close()
        observations = harness.engine._observations()
        now = datetime.now(timezone.utc)
        observations['profiles_by_id'][user_id]['observed_at'] = (now-timedelta(seconds=60)).isoformat()
        incident = {'occurred_at': (now-timedelta(minutes=10)).isoformat(),
                    'window_start': (now-timedelta(minutes=15)).isoformat(),
                    'window_end': (now-timedelta(minutes=5)).isoformat()}
        # The source read is fresh now but falls outside this old incident's
        # explicit event window. It still proves the current local mismatch.
        observations['clients_by_id'][user_id]['delivery_signature'] = None
        row = next(item for item in harness.engine._classify_live(observations, incident)
                   if item['id'] == user_id)
        self.assertEqual(row['status'], 'confirmed')
        self.assertFalse(row['incident_window_match'])
        self.assertTrue(row['eligible'])
        observations['clients_by_id'][user_id].update(access_active=True,
            access_expires_at=observations['entitlement_by_id'][user_id]['expires_at'],
            entitlement_hash=observations['entitlement_by_id'][user_id]['entitlement_hash'])
        observations['clients_by_id'][user_id]['gate']['allowed'] = None
        unknown_gate = next(item for item in harness.engine._classify_live(observations, incident)
                            if item['id'] == user_id)
        self.assertEqual(unknown_gate['status'], 'inconclusive')
        self.assertFalse(unknown_gate['eligible'])

    def test_trial_grace_and_manual_access_are_inconclusive_without_paid_basis(self):
        harness = LiveHarness(self.root)
        self.addCleanup(harness.close)
        user_id = harness.users[0]
        incident = {'occurred_at': service.iso(datetime.now(timezone.utc)),
            'window_start': service.iso(datetime.now(timezone.utc)-timedelta(minutes=5)),
            'window_end': service.iso(datetime.now(timezone.utc)+timedelta(minutes=5))}
        for reason in ('trial_period','grace_period'):
            with self.subTest(reason=reason):
                observations = harness.engine._observations()
                observations['profiles_by_id'][user_id].update(status='inactive',reason=reason)
                row = next(item for item in harness.engine._classify_live(observations,incident)
                           if item['id'] == user_id)
                self.assertEqual(row['status'],'inconclusive')
                self.assertEqual(row['reason'],reason)
                self.assertFalse(row['eligible'])

        observations = harness.engine._observations()
        observations['profiles_by_id'][user_id].update(status='unknown',
            reason='premium_source_binding_uncertain')
        observations['entitlement_by_id'].pop(user_id)
        row = next(item for item in harness.engine._classify_live(observations,incident)
                   if item['id'] == user_id)
        self.assertEqual(row['status'],'inconclusive')
        self.assertEqual(row['reason'],'premium_source_binding_uncertain')
        self.assertFalse(row['eligible'])

        for reason in ('subscription_not_started','subscription_expired',
                       'premium_entitlement_absent'):
            with self.subTest(reason=reason):
                observations = harness.engine._observations()
                observations['profiles_by_id'][user_id].update(status='inactive',reason=reason)
                if reason == 'premium_entitlement_absent':
                    observations['entitlement_by_id'].pop(user_id,None)
                row = next(item for item in harness.engine._classify_live(observations,incident)
                           if item['id'] == user_id)
                self.assertEqual(row['status'],'legitimate_denial')
                self.assertEqual(row['reason'],reason)
                self.assertFalse(row['eligible'])

    def test_live_fulfillment_expectations_are_versioned_and_coalesced(self):
        harness = LiveHarness(self.root)
        self.addCleanup(harness.close)
        first = harness.engine._live_fulfillment_audit(refresh_source=True)
        self.assertIsNone(first['waiting_reason'])
        db = domain.connect(harness.engine.db_path)
        try:
            before = db.execute('SELECT COUNT(*) FROM fulfillment_expectations').fetchone()[0]
            activity_before = db.execute('SELECT COUNT(*) FROM fulfillment_activity').fetchone()[0]
        finally:
            db.close()
        self.assertEqual(before, 100)
        harness.engine._live_fulfillment_audit(refresh_source=False)
        db = domain.connect(harness.engine.db_path)
        try:
            self.assertEqual(db.execute('SELECT COUNT(*) FROM fulfillment_expectations').fetchone()[0], before)
            self.assertEqual(db.execute('SELECT COUNT(*) FROM fulfillment_activity').fetchone()[0], activity_before)
        finally:
            db.close()
        user_id = harness.users[0]
        db = domain.connect(harness.lumen.db_path)
        try:
            db.execute('UPDATE access SET active=0,cache_active=0 WHERE user_id=?', (user_id,))
        finally:
            db.close()
        db = domain.connect(harness.engine.db_path)
        try:
            db.execute('UPDATE fulfillment_expectations SET first_observed_at=? WHERE key_json LIKE ?',
                ((datetime.now(timezone.utc)-timedelta(minutes=1)).isoformat(), '%'+user_id+'%'))
        finally:
            db.close()
        harness.engine._live_fulfillment_audit(refresh_source=False)
        db = domain.connect(harness.engine.db_path)
        try:
            row = db.execute('SELECT status,episode_no,episode_open FROM fulfillment_expectations '
                'WHERE key_json LIKE ?', ('%'+user_id+'%',)).fetchone()
        finally:
            db.close()
        self.assertEqual(row['status'], 'discrepancy')
        self.assertEqual(row['episode_no'], 1)
        self.assertEqual(row['episode_open'], 1)

    def test_source_event_payload_survives_outbox_prune_and_sdk_restart(self):
        harness = LiveHarness(self.root)
        self.addCleanup(harness.close)
        user_id = harness.users[0]
        outbox = self.root/'source-events.sqlite3'
        manifest = harness.engine._manifest()

        def make_sdk():
            return recovery_sdk.CollectorSDK(harness.engine.key, manifest['run_id'],
                manifest['app'], lambda *_args: {'accepted': True}, outbox_path=outbox,
                environment=manifest['environment'])

        harness.lumen.sdk = make_sdk()
        first = harness.source.read(user_id)
        harness.lumen._emit_source_observations([first])
        event_id = 'source:'+service.digest({'customer': user_id,
            'source_hash': first['source_fingerprint']})
        db = sqlite3.connect(outbox)
        try:
            original = db.execute('SELECT event_hash,event_json FROM sdk_events WHERE event_id=?',
                                   (event_id,)).fetchone()
            self.assertIsNotNone(original)
            original_event = json.loads(original[1])
            db.execute('UPDATE sdk_events SET created_at=? WHERE event_id=?',
                (int(time.time())-recovery_sdk._RETENTION_SECONDS-10,event_id))
            db.commit()
        finally:
            db.close()
        second = harness.source.read(user_id)
        second['observed_at'] = service.iso(datetime.now(timezone.utc)+timedelta(seconds=5))
        self.assertNotEqual(first['observed_at'], second['observed_at'])
        harness.lumen.sdk = make_sdk()
        harness.lumen._emit_source_observations([second])
        db = sqlite3.connect(outbox)
        try:
            replayed = db.execute('SELECT event_hash,event_json,state FROM sdk_events WHERE event_id=?',
                                  (event_id,)).fetchone()
        finally:
            db.close()
        self.assertEqual(replayed[0], original[0])
        self.assertEqual(json.loads(replayed[1]), original_event)
        self.assertEqual(replayed[2], 'queued')

    def test_trace_v2_validation_is_bounded_and_rejects_sensitive_fields(self):
        steps = [{'name': 'projection_commit', 'status': 'completed', 'owner': 'lumen',
                  'result': 'committed', 'revision': 2}]
        event = {'schema_version': 2, 'event_id': 'event-1', 'run_id': 'run-1',
            'app': 'app', 'environment': 'test', 'app_user_id': 'user-1',
            'kind': 'access_projection_changed', 'occurred_at': '2026-11-07T00:00:00Z',
            'correlation_id': 'event-1', 'source_event_id': 'event-1',
            'details': {'action_id': 'action-1', 'source_hash': 'a'*64,
                'expected_revision': 1, 'policy_version': 'policy-v2',
                'adapter_version': 'adapter-v2', 'projection_version': 'handler-v2',
                'cache_version': 'cache-v2', 'outcome': 'projection_updated',
                'before': {'active': False, 'projection_revision': 1},
                'after': {'active': True, 'projection_revision': 2},
                'cache_invalidated': False, 'processing_id': 'processing-1',
                'trace_id': 'trace-1', 'transaction_id': 'txn-1',
                'steps': steps, 'revisions': {'identity': 1, 'policy': 1,
                    'projection': 2, 'cache': 2},
                'stack': [{'module': 'recovery_service', 'function': 'handle', 'line': 42}]}}
        recovery_sdk.validate_event(event)
        event['details']['steps'] = steps*33
        with self.assertRaisesRegex(ValueError, 'trace steps'):
            recovery_sdk.validate_event(event)
        event['details']['steps'] = [dict(steps[0], body='secret')]
        with self.assertRaisesRegex(ValueError, 'trace step'):
            recovery_sdk.validate_event(event)
        event['details']['steps'] = [dict(steps[0], name=[])]
        with self.assertRaisesRegex(ValueError, 'trace step'):
            recovery_sdk.validate_event(event)
        for reason in ([], {}):
            with self.subTest(reason=reason):
                event['details']['steps'] = [dict(steps[0], reason_code=reason)]
                with self.assertRaisesRegex(ValueError, 'trace reason'):
                    recovery_sdk.validate_event(event)

    def test_missing_transaction_remains_source_diagnostic_only(self):
        raw = {'app_id': recovery_live.APP_ID, 'profile_id': 'profile-1',
            'customer_user_id': 'customer-1', 'access_levels': [{
                'access_level_id': 'premium', 'store': 'app_store',
                'store_product_id': 'premium.annual', 'store_transaction_id': None,
                'starts_at': '2026-01-01T00:00:00Z', 'expires_at': '2027-01-01T00:00:00Z',
                'is_in_grace_period': False}], 'subscriptions': [{
                'store': 'app_store', 'store_product_id': 'premium.annual',
                'store_transaction_id': None, 'environment': 'Production',
                'expires_at': '2027-01-01T00:00:00Z', 'is_in_grace_period': False}],
            'non_subscriptions': []}
        config = {'secret_key_file': str(self.root/'unused')}

        result = recovery_live.normalize_profile(raw, config, 'customer-1',
                                                  datetime(2026, 11, 7, tzinfo=timezone.utc))
        self.assertEqual(result['status'], 'active')
        self.assertIsNone(result['entitlement']['transaction_id'])
        self.assertEqual(result['entitlement']['source_environment'], 'Production')


if __name__ == '__main__':
    unittest.main()
