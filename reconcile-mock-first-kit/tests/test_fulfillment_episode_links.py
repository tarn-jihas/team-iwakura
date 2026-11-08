"""Late processing receipts and repeated denials retain their episode owner."""
from datetime import datetime, timedelta, timezone
from concurrent.futures import ThreadPoolExecutor
import json
from pathlib import Path
import sys
import tempfile
import time
import threading
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parent))
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from test_live_recovery_flow import LiveHarness
import recovery_domain as domain
import recovery_service as service
from recovery_sdk import sign


class FulfillmentEpisodeLinkTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix='reconcile-episode-')
        self.addCleanup(self.temporary.cleanup)
        self.h = LiveHarness(Path(self.temporary.name))
        self.addCleanup(self.h.close)
        self.h.engine._live_fulfillment_audit(refresh_source=False)
        self.user = self.h.users[0]
        db = domain.connect(self.h.engine.db_path)
        try:
            self.expectation = dict(db.execute('SELECT * FROM fulfillment_expectations '
                "WHERE json_extract(key_json,'$.customer_id')=?", (self.user,)).fetchone())
            db.execute("UPDATE fulfillment_expectations SET incident_id='current',episode_open=1 "
                'WHERE expectation_id=?', (self.expectation['expectation_id'],))
        finally:
            db.close()

    def test_repeated_denial_reuses_the_open_fulfillment_incident_without_rescan(self):
        incident_id, _, _ = self.h.inject_and_scan()
        db = domain.connect(self.h.engine.db_path)
        try:
            db.execute('UPDATE fulfillment_expectations SET incident_id=?,episode_open=1 WHERE expectation_id=?',
                (incident_id, self.expectation['expectation_id']))
            before = db.execute('SELECT COUNT(*) FROM jobs').fetchone()[0]
        finally:
            db.close()
        gate = domain.lumen_access(self.h.lumen.db_path,self.user)
        self.assertFalse(gate['allowed'])
        self.h.lumen._emit_gate(self.user,'premium_export',gate,'customer_demo')
        kind,user,at,details = self.h.lumen.sdk.emit.call_args.args
        manifest = self.h.engine._manifest()
        event = {'schema_version':1,'event_id':'repeat-denial',
            'run_id':manifest['run_id'],'app':manifest['app'],
            'environment':manifest['environment'],'app_user_id':user,
            'kind':kind,'occurred_at':at,'correlation_id':'repeat-denial',
            'source_event_id':'repeat-denial','details':details}
        envelope = {'schema_version':1,'event':event,'sent_at':int(time.time())}
        self.assertEqual(self.h.engine._open_fulfillment_incident_for_handler(event),incident_id)
        result = self.h.engine._collect(envelope,sign(envelope,self.h.engine.key))
        self.assertEqual(result['incident_id'],incident_id)
        db = domain.connect(self.h.engine.db_path)
        try:
            self.assertEqual(db.execute('SELECT COUNT(*) FROM incidents').fetchone()[0],1)
            self.assertEqual(db.execute('SELECT COUNT(*) FROM jobs').fetchone()[0],before)
            assessment = json.loads(db.execute('SELECT result FROM collector_assessments '
                'ORDER BY rowid DESC LIMIT 1').fetchone()[0])
            self.assertEqual(assessment['incident_id'],incident_id)
        finally:
            db.close()

    def test_late_receipt_keeps_closed_owner_but_later_failure_uses_current_episode(self):
        closed_at = datetime.now(timezone.utc)-timedelta(seconds=2)
        transaction = json.loads(self.expectation['key_json'])['transaction_id']
        trace = {'source_fingerprint':self.expectation['source_fingerprint'],
            'transaction_id':transaction,'status':'verified_application',
            'created_at':service.iso_precise(closed_at)}
        db = domain.connect(self.h.engine.db_path)
        try:
            db.execute('INSERT INTO fulfillment_traces VALUES(?,?,?,?,?,?)',
                ('closed-trace',self.expectation['expectation_id'],'old',self.user,
                 json.dumps(trace),trace['created_at']))
        finally:
            db.close()
        event = {'app_user_id':self.user,'kind':'handler_completed',
            'occurred_at':service.iso_precise(closed_at-timedelta(seconds=1)),
            'details':{'transaction_id':transaction,
                'source_hash':self.expectation['source_fingerprint']}}
        self.assertEqual(self.h.engine._open_fulfillment_incident_for_handler(event),'old')
        event['occurred_at'] = service.iso_precise(closed_at+timedelta(seconds=1))
        self.assertEqual(self.h.engine._open_fulfillment_incident_for_handler(event),'current')
        db = domain.connect(self.h.engine.db_path)
        try:
            db.execute('UPDATE fulfillment_expectations SET episode_open=0 WHERE expectation_id=?',
                (self.expectation['expectation_id'],))
        finally:
            db.close()
        self.assertIsNone(self.h.engine._open_fulfillment_incident_for_handler(event))

    def test_random_cycle_seed_and_selected_fault_survive_idempotent_replay(self):
        engine = self.h.engine
        accepted = engine._live_simulation_control({'action':'once','operation_key':'reproduce-this'})
        duplicate = engine._live_simulation_control({'action':'once','operation_key':'reproduce-this'})
        self.assertEqual(accepted['simulation_id'],duplicate['simulation_id'])
        step = json.loads(engine._simulation_row(accepted['simulation_id'])['sequence_json'])[0]
        self.assertEqual(step['seed'],service.digest({'operation_key':'reproduce-this'}))
        with (patch.object(engine,'_live_simulation_wait_reason',return_value=None),
              patch.object(engine,'_live_simulation_candidates',return_value=[self.user]),
              patch.object(engine,'_live_source_request_total',return_value=1),
              patch.object(engine,'_live_handler_result',return_value={'outcome':'completed'}) as handler):
            first = engine._run_live_simulation_cycle(accepted['simulation_id'],'random')
            second = engine._run_live_simulation_cycle(accepted['simulation_id'],'random')
        self.assertEqual(first,second)
        self.assertIn(first['fault_mode'],('handler_precommit','cache_refresh_skipped',
            'delayed_older_update','timeout_after_commit'))
        self.assertEqual(handler.call_args_list[0],handler.call_args_list[1])

    def test_resumed_short_sequence_runs_only_its_remaining_cycles(self):
        engine = self.h.engine
        accepted = engine._live_simulation_control({'action':'start','operation_key':'short-sequence'})
        identifier = accepted['simulation_id']
        db = domain.connect(engine.db_path)
        try:
            db.execute("UPDATE simulations SET completed=1,current_index=1,status='stopped',"
                'stop_requested=1 WHERE id=?',(identifier,))
        finally:
            db.close()
        engine._live_simulation_control({'action':'resume','simulation_id':identifier})
        step = json.loads(engine._simulation_row(identifier)['sequence_json'])[0]
        def cycle(*_):
            return {'cycle_no':engine._simulation_row(identifier)['completed']+1}
        with (patch.object(engine,'_run_live_simulation_cycle',side_effect=cycle) as run,
              patch.object(engine,'_live_duration',return_value=0)):
            result = engine._run_live_simulation(identifier,step)
        self.assertEqual(run.call_count,2)
        self.assertEqual((result['completed'],result['total'],result['status']),(3,3,'completed'))

    def _handler_event(self):
        engine = self.h.engine
        at = engine.wall_now_precise()
        manifest = engine._manifest()
        transaction = json.loads(self.expectation['key_json'])['transaction_id']
        details = {'event_type':'source_entitlement_observed','handler_version':'lumen-handler-v2',
            'received_at':at,'processed_at':at,'outcome':'failed','reason_code':'handler_failure',
            'projection_version':'lumen-handler-v2','adapter_version':'adapty-profile-read-v1',
            'transaction_id':transaction,'source_hash':self.expectation['source_fingerprint'],
            'processing_id':'old-processing','trace_id':'old-processing-trace',
            'steps':[{'name':'handler','status':'failed','owner':'lumen','result':'failed'}],
            'revisions':{'identity':1,'policy':1,'projection':1,'cache':1}}
        event = {'schema_version':2,'event_id':'old-receipt','run_id':manifest['run_id'],
            'app':manifest['app'],'environment':manifest['environment'],'app_user_id':self.user,
            'kind':'handler_completed','occurred_at':at,'correlation_id':'old-processing-trace',
            'source_event_id':'old-source','details':details}
        return event

    def test_duplicate_assessed_receipt_cannot_move_to_another_episode(self):
        engine = self.h.engine
        event = self._handler_event()
        details,at = event['details'],event['occurred_at']
        transaction = details['transaction_id']
        db = domain.connect(engine.db_path)
        try:
            db.execute('INSERT INTO collector_events VALUES(?,?,?,?,?)',
                (event['event_id'],service.digest(event),json.dumps(event),at,'test'))
            db.execute('INSERT INTO collector_assessments VALUES(?,?)',
                (event['event_id'],json.dumps({'incident_id':'old','job_id':None})))
            db.execute('INSERT INTO fulfillment_receipts VALUES(?,?,?,?,?,?,?,?,?)',
                (event['event_id'],self.user,transaction,self.expectation['source_fingerprint'],
                 details['trace_id'],None,'old',json.dumps(details['steps']),at))
        finally:
            db.close()
        envelope = {'schema_version':2,'event':event,'sent_at':int(time.time())}
        result = engine._collect(envelope,sign(envelope,engine.key))
        self.assertTrue(result['duplicate'])
        self.assertEqual(result['incident_id'],'old')
        db = domain.connect(engine.db_path)
        try:
            self.assertEqual(db.execute('SELECT incident_id FROM fulfillment_receipts '
                'WHERE event_id=?',(event['event_id'],)).fetchone()[0],'old')
        finally:
            db.close()

    def _assert_collector_and_audit_share_one_episode(self, order):
        engine = self.h.engine
        engine.auto_repair = True
        db = domain.connect(engine.db_path)
        try:
            db.execute('UPDATE fulfillment_expectations SET incident_id=NULL,episode_open=0 '
                'WHERE expectation_id=?',(self.expectation['expectation_id'],))
        finally:
            db.close()
        db = domain.connect(self.h.lumen.db_path)
        try:
            db.execute('UPDATE access SET active=0,cache_active=0 WHERE user_id=?',(self.user,))
        finally:
            db.close()
        event = self._handler_event()
        envelope = {'schema_version':2,'event':event,'sent_at':int(time.time())}
        operations = [lambda:engine._collect(envelope,sign(envelope,engine.key)),
                      lambda:engine._live_fulfillment_audit(refresh_source=False)]
        if order == 'concurrent':
            barrier = threading.Barrier(2)
            def start(index):
                barrier.wait(timeout=5)
                return operations[index]()
            with ThreadPoolExecutor(max_workers=2) as executor:
                list(executor.map(start,(0,1)))
        else:
            for index in order:
                operations[index]()
        for _ in range(10):
            db = domain.connect(engine.db_path)
            try:
                row = db.execute("SELECT id FROM jobs WHERE status='queued' ORDER BY rowid LIMIT 1").fetchone()
            finally:
                db.close()
            if row is None:
                break
            engine._run_job(row['id'])
        db = domain.connect(engine.db_path)
        try:
            self.assertEqual(db.execute('SELECT COUNT(*) FROM incidents').fetchone()[0],1)
            decisions = db.execute('SELECT status FROM automatic_recovery').fetchall()
            self.assertEqual([row['status'] for row in decisions],['completed'])
        finally:
            db.close()
        self.assertTrue(domain.lumen_access(self.h.lumen.db_path,self.user)['allowed'])

    def test_collector_before_audit_claims_one_episode_before_scan(self):
        self._assert_collector_and_audit_share_one_episode((0,1))

    def test_audit_before_collector_claims_one_episode_before_scan(self):
        self._assert_collector_and_audit_share_one_episode((1,0))

    def test_concurrent_collector_and_audit_claim_one_episode(self):
        self._assert_collector_and_audit_share_one_episode('concurrent')

    def test_multi_account_audit_preserves_separately_claimed_receipt_owners(self):
        engine = self.h.engine
        engine.auto_repair = True
        users = self.h.users[:2]
        db = domain.connect(engine.db_path)
        try:
            db.execute('UPDATE fulfillment_expectations SET incident_id=NULL,episode_open=0')
        finally:
            db.close()
        db = domain.connect(self.h.lumen.db_path)
        try:
            db.executemany('UPDATE access SET active=0,cache_active=0 WHERE user_id=?',
                [(user,) for user in users])
        finally:
            db.close()
        original = engine._start_incident
        def interleave(*args,**kwargs):
            if kwargs.get('fulfillment_claims'):
                for index,user in enumerate(users):
                    event = self._handler_event()
                    profile = self.h.source.read(user)
                    event.update(event_id='interleaved-'+str(index),app_user_id=user)
                    event['details'].update(transaction_id=profile['entitlement']['transaction_id'],
                        source_hash=profile['source_fingerprint'],processing_id='processing-'+str(index))
                    envelope = {'schema_version':2,'event':event,'sent_at':int(time.time())}
                    engine._collect(envelope,sign(envelope,engine.key))
            return original(*args,**kwargs)
        with patch.object(engine,'_start_incident',side_effect=interleave):
            engine._live_fulfillment_audit(refresh_source=False)
        db = domain.connect(engine.db_path)
        try:
            self.assertEqual(db.execute('SELECT COUNT(*) FROM incidents').fetchone()[0],2)
            for user in users:
                owner = db.execute('SELECT incident_id FROM fulfillment_expectations '
                    "WHERE json_extract(key_json,'$.customer_id')=?",(user,)).fetchone()[0]
                receipt = db.execute('SELECT incident_id FROM fulfillment_receipts '
                    'WHERE user_id=?',(user,)).fetchone()[0]
                self.assertEqual(owner,receipt)
                self.assertIsNotNone(owner)
                trace = engine._fulfillment_trace(owner)
                self.assertTrue(trace['processing_receipts'])
                self.assertEqual({row['user_id'] for row in trace['processing_receipts']},{user})
        finally:
            db.close()

    def test_simulation_summary_exposes_only_atomically_completed_cycle_results(self):
        engine = self.h.engine
        accepted = engine._live_simulation_control({'action':'once','operation_key':'cycle-summary'})
        identifier = accepted['simulation_id']
        engine._save_simulation_intent('summary-intent',identifier,1,self.user,
            'handler_precommit','summary-processing','handler_failed',{'outcome':'failed'})
        self.assertNotIn('last_cycle',engine._simulation_summary())
        engine._advance_simulation_cycle(identifier,{'cycle_no':1,'source_calls':4,
            'handler_outcome':'failed','recovery_status':'completed'})
        summary = engine._simulation_summary()
        self.assertEqual(summary['completed'],1)
        self.assertEqual(summary['last_cycle']['source_calls'],4)

    def test_unavailable_fresh_source_is_an_unknown_receipt_not_a_db_failure(self):
        profile = self.h.source.read(self.user)
        db = domain.connect(self.h.lumen.db_path)
        try:
            db.execute('UPDATE access SET active=0,cache_active=0 WHERE user_id=?',(self.user,))
        finally:
            db.close()
        self.h.source.fail = True
        source_event = self.h.lumen._emit_source_observations([profile])[self.user]
        self.h.lumen._handle_live_source_observation(profile,source_event,'source-unavailable')
        stored = domain.lumen_handler_result(self.h.lumen.db_path,'source-unavailable')['result']
        self.assertEqual((stored['outcome'],stored['reason']),('diagnostic_only','source_unavailable'))
        self.assertNotIn('projection_commit',{step['name'] for step in stored['steps']})
        source_step = next(step for step in stored['steps'] if step['name']=='fresh_source_read')
        self.assertEqual((source_step['status'],source_step['result']),('unknown','unavailable'))
        emitted = self.h.lumen.sdk.emit.call_args.args[3]
        self.assertEqual((emitted['outcome'],emitted['reason_code']),('unknown','source_unavailable'))


if __name__ == '__main__':
    unittest.main()
