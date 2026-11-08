"""Automatic recovery in the full-mock demo, observed through public HTTP and the engine journal."""
import collections
import json
from pathlib import Path
import sqlite3
import sys
import tempfile
import time
import unittest
from urllib.error import HTTPError
from urllib.request import Request, urlopen
import uuid

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from recovery_demo import Demo


class AutomaticMockRecoveryTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix='reconcile-auto-')
        self.addCleanup(self.temporary.cleanup)
        self.demo = Demo(self.temporary.name, auto_repair=True)
        self.addCleanup(self.demo.close)
        self.demo.start()
        self.base = self.demo.urls['engine']

    def call(self, path, body=None):
        request = Request(self.base + path, data=None if body is None else json.dumps(body).encode(),
                          headers={'Content-Type': 'application/json', 'Origin': self.base})
        try:
            response = urlopen(request, timeout=60)
        except HTTPError as error:
            response = error
        with response:
            return response.status, json.loads(response.read() or b'{}')

    def run_once(self):
        _, before = self.call('/api/recovery/monitor')
        status, run = self.call('/api/recovery/simulation',
                                {'action': 'once', 'operation_key': str(uuid.uuid4())})
        self.assertEqual(status, 202, run)
        deadline = time.monotonic() + 60
        while time.monotonic() < deadline:
            _, feed = self.call('/api/recovery/monitor')
            if (feed['summary']['incidents'] > before['summary']['incidents']
                    and feed['incidents'][0]['status'] in ('repaired', 'unresolved')
                    and not feed['telemetry']['queued']):
                return run, feed
            time.sleep(0.3)
        self.fail('run did not settle: ' + json.dumps(feed)[:600])

    def collector_events(self, run_id):
        db = sqlite3.connect(f"file:{self.demo.runtime / 'engine.sqlite3'}?mode=ro", uri=True)
        try:
            events = [json.loads(row[0]) for row in db.execute('SELECT event_json FROM collector_events')]
        finally:
            db.close()
        return collections.Counter((event['kind'], event['details'].get('decision'),
                                    event['details'].get('initiator'))
                                   for event in events if event['run_id'] == run_id)

    def test_each_run_is_repaired_automatically_and_history_is_kept(self):
        first, feed = self.run_once()
        second, feed = self.run_once()
        self.assertNotEqual(first['run_id'], second['run_id'])
        self.assertEqual(feed['summary'], {'incidents': 2, 'fixed': 2, 'needs_attention': 0,
                                           'affected_accounts': 48})
        code, access = self.call('/api/recovery/fulfillments?limit=100')
        self.assertEqual(code, 200)
        self.assertEqual(access['pagination']['total'], 100)
        self.assertEqual(collections.Counter(row['access_state'] for row in access['items']),
            {'verified':84, 'expired':6, 'policy_restricted':4, 'inconclusive':6})
        by_user = {row['user_id']:row for row in access['items']}
        self.assertEqual(by_user['u00084']['display_label'], 'Subscription expired')
        self.assertEqual(by_user['u00090']['display_label'], 'Blocked by app rule')
        self.assertIn('does not override', by_user['u00090']['reason'])
        self.assertIn('intentional', by_user['u00090']['next_step'])
        self.assertEqual(by_user['u00094']['display_label'], 'Identity not mapped')
        self.assertEqual(by_user['u00097']['display_label'], 'Source stale')
        self.assertEqual(by_user['u00098']['display_label'], 'Source unavailable')
        self.assertTrue(all(not by_user[f'u{i:05}']['telemetry_gap'] for i in range(24)))
        for incident in feed['incidents']:
            self.assertEqual((incident['status'], incident['repaired_accounts']), ('repaired', 24))
            self.assertIsNone(incident['failure'])
            self.assertTrue(all(step['status'] in ('ok', 'failed') for step in incident['timeline']))
            self.assertEqual(incident['source_provenance'], 'synthetic_extension')
            self.assertEqual(incident['payment_verification'], 'not_independently_verified')
        db = sqlite3.connect(f"file:{self.demo.runtime / 'engine.sqlite3'}?mode=ro", uri=True)
        try:
            snapshots = [json.loads(row[0]) for row in db.execute('SELECT snapshot_json FROM snapshots')]
        finally:
            db.close()
        self.assertTrue(snapshots)
        for snapshot in snapshots:
            scope = tuple(snapshot['incident'][key] for key in ('run_id', 'app', 'environment'))
            self.assertEqual(tuple(snapshot['manifest'][key] for key in ('run_id', 'app', 'environment')), scope)
            self.assertEqual(snapshot['manifest']['payment_verification'], 'not_independently_verified')
            self.assertTrue(all(tuple(event[key] for key in ('run_id', 'app', 'environment')) == scope
                                for event in snapshot['historical_events']))
        status, exported = self.call('/api/recovery/export?format=json')
        self.assertEqual(status, 200)
        self.assertEqual(exported['provenance']['payment_verification'], 'not_independently_verified')
        self.assertTrue(all(snapshot['manifest']['payment_verification'] == 'not_independently_verified'
                            for incident in exported['incidents'] for snapshot in incident['snapshots']))
        status, gate = self.call('/api/recovery/lumen/export', {'user_id': 'u00000'})
        self.assertEqual((status, gate['allowed']), (200, True))

    def test_every_link_of_the_event_chain_reaches_the_collector(self):
        run, feed = self.run_once()
        events = self.collector_events(run['run_id'])
        # Customer denial opens the incident; Lumen reports every resync and every gate probe.
        self.assertEqual(events[('feature_access_decided', 'deny', 'customer_demo')], 1)
        self.assertEqual(events[('access_projection_changed', None, None)], 25)
        self.assertEqual(events[('feature_access_decided', 'allow', 'reconcile_probe')], 24)
        self.assertEqual(events[('feature_access_decided', 'deny', 'reconcile_probe')], 1)
        self.assertEqual((feed['telemetry']['queued'], feed['telemetry']['dropped'],
                          feed['telemetry']['failed']), (0, 0, 0))
        _, journal = self.call('/api/recovery/journal')
        items = journal if isinstance(journal, list) else next(v for v in journal.values() if isinstance(v, list))
        order = [item['action'] for item in reversed(items)]
        expected = ['demo_run_started', 'incident_created', 'automatic_recovery_decided', 'plan_created',
                    'plan_approved', 'execution_queued', 'execution_finished',
                    'automatic_recovery_retry_scheduled', 'plan_created', 'plan_approved',
                    'execution_queued', 'execution_finished']
        position = 0
        for action in order:
            if position < len(expected) and action == expected[position]:
                position += 1
        self.assertEqual(position, len(expected), order)
        approvals = [item['details']['actor'] for item in items if item['action'] == 'plan_approved']
        self.assertTrue(approvals and all(actor.startswith('policy:') for actor in approvals))

    def test_failed_verification_is_marked_with_the_step_and_accounts(self):
        status, _ = self.call('/api/recovery/demo', {'action': 'fault', 'fault': 'probe_outage',
                                                     'active': True})
        self.assertEqual(status, 200)
        _, feed = self.run_once()
        incident = feed['incidents'][0]
        self.assertEqual(incident['status'], 'unresolved')
        self.assertEqual(feed['summary']['needs_attention'], 1)
        self.assertEqual(incident['failure']['step'], 'Verify the premium gate')
        self.assertEqual(incident['failure']['owner'], 'Lumen')
        self.assertEqual(incident['title'], 'Premium access verification unavailable')
        self.assertIn('Lumen resync succeeded for 24 accounts', incident['repair_summary'])
        self.assertIn('availability and connectivity', incident['next_step'])
        self.assertIn('current access is unknown', incident['failure']['reason'])
        trace = incident['failure']['trace']
        self.assertEqual((trace['account'], trace['affected_count']), ('u00000', 24))
        self.assertEqual(len(trace['attempts']), 2)
        for attempt in trace['attempts']:
            self.assertEqual(attempt['request']['http_status'], 503)
            self.assertEqual(attempt['request']['path'], '/internal/lumen/probe')
            self.assertEqual(attempt['request']['method'], 'POST')
            self.assertGreaterEqual(attempt['request']['duration_ms'], 0)
            self.assertTrue(attempt['action_id'])
        self.assertTrue(trace['attempts'][-1]['readback']['allowed'])
        self.assertIn('u00000', {item['account'] for item in incident['failure']['accounts']})
        self.assertIn('failed', {step['status'] for step in incident['timeline']})

    def test_manual_launcher_default_keeps_the_empty_manual_feed(self):
        manual = Demo(Path(self.temporary.name) / 'manual')
        self.addCleanup(manual.close)
        manual.start()
        with urlopen(manual.urls['engine'] + '/api/recovery/monitor', timeout=10) as response:
            feed = json.loads(response.read())
        self.assertFalse(feed['automation']['enabled'])
        self.assertEqual(feed['incidents'], [])


if __name__ == '__main__':
    unittest.main()
