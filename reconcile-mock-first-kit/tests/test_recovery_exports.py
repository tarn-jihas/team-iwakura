"""Public report projection and export boundary regressions."""
import json
from pathlib import Path
import sys
import tempfile
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parent))
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from test_live_recovery_flow import LiveHarness
import recovery_domain as domain
import recovery_monitor
import recovery_service as service


class RecoveryExportTests(unittest.TestCase):
    def harness(self):
        temporary = tempfile.TemporaryDirectory(prefix='reconcile-export-')
        self.addCleanup(temporary.cleanup)
        harness = LiveHarness(Path(temporary.name))
        self.addCleanup(harness.close)
        return harness

    def test_source_attributes_are_not_exported_and_export_makes_no_source_read(self):
        h = self.harness()
        original = h.source.raw_profile
        h.source.raw_profile = lambda user: dict(original(user),
            custom_attributes={'support_note': 'private-value-must-not-export'})
        h.provider._provider_get('/internal/adapty/profile', {'user':[h.users[0]]})
        h.engine._live_fulfillment_audit(refresh_source=False)
        incident_id, snapshot, _ = h.inject_and_scan()
        self.assertIn('private-value-must-not-export', json.dumps(snapshot))
        diagnosis = h.engine._report_live(incident_id)['recovery']
        self.assertEqual(diagnosis['root_cause_status'], 'fulfillment_mismatch_observed')
        self.assertEqual(diagnosis['root_cause_certainty'], 'shared_cause_not_established')
        h.source.read = lambda *_: self.fail('Export performed a source read')
        exported = h.engine._export_recovery(format='json')
        self.assertEqual(exported['incident_count'], 1)
        self.assertEqual(exported['incidents'][0]['summary'], {
            'affected_accounts':24,'repaired_accounts':0,'unresolved_accounts':24})
        encoded = json.dumps(exported)
        self.assertNotIn('private-value-must-not-export', encoded)
        self.assertNotIn('raw_source_profile', encoded)
        self.assertIn('snapshots', encoded)

    def test_filtered_pages_keep_global_totals(self):
        h = self.harness()
        incident_id, _, _ = h.inject_and_scan()
        db = domain.connect(h.engine.db_path)
        try:
            for index in range(51):
                identifier = 'pending-'+str(index)
                db.execute('INSERT INTO incidents VALUES(?,?,?,?)',
                    (identifier, identifier, json.dumps({'id': identifier,
                        'status': 'queued'}), h.engine.wall_now()))
        finally:
            db.close()
        page = recovery_monitor.build(h.engine, cursor='0', limit=1, status='unresolved')
        self.assertEqual(page['summary']['incidents'], 52)
        self.assertEqual(page['summary']['needs_attention'], 1)
        self.assertEqual(page['pagination']['total'], 1)
        self.assertIsNone(page['pagination']['next_cursor'])
        self.assertEqual([item['id'] for item in page['incidents']], [incident_id])
        detecting = recovery_monitor.build(h.engine, cursor='0', limit=2, status='detecting')
        self.assertEqual(detecting['summary'], page['summary'])
        self.assertEqual(detecting['pagination']['status'], 'detecting')
        self.assertEqual(detecting['pagination']['total'], 51)
        self.assertEqual(detecting['pagination']['next_cursor'], '2')
        self.assertEqual({item['status'] for item in detecting['incidents']}, {'detecting'})
        attention = recovery_monitor.build(h.engine, cursor='0', limit=200, status='needs_attention')
        self.assertEqual(attention['pagination']['total'], 52)
        self.assertEqual({item['status'] for item in attention['incidents']}, {'detecting','unresolved'})

    def test_csv_formula_protection_includes_whitespace(self):
        for value in ('=1+1', '  =1+1', '\n@SUM(A1)', '\ttext', '\rtext', ' +2', ' -2'):
            with self.subTest(value=value):
                self.assertTrue(service.RecoveryService._csv_safe(value).startswith("'"))
        self.assertEqual(service.RecoveryService._csv_safe('safe'), 'safe')

    def test_historical_assessment_is_separate_from_later_current_state(self):
        h = self.harness()
        h.engine._live_fulfillment_audit(refresh_source=True)
        incident_id, _, _ = h.inject_and_scan()
        db = domain.connect(h.engine.db_path)
        try:
            row = db.execute('SELECT expectation_id FROM fulfillment_expectations '
                'ORDER BY expectation_id LIMIT 1').fetchone()
            expectation_id = row['expectation_id']
            db.execute('UPDATE fulfillment_traces SET incident_id=? WHERE expectation_id=?',
                (incident_id, expectation_id))
            db.execute("UPDATE fulfillment_expectations SET status='discrepancy',"
                "reason='later-episode',episode_no=2,incident_id='later-incident' "
                'WHERE expectation_id=?', (expectation_id,))
        finally:
            db.close()
        exported = h.engine._export_recovery()['incidents'][0]
        historical = next(row for row in exported['fulfillments']
                          if row['expectation_id'] == expectation_id)
        current = next(row for row in exported['current_fulfillments']
                       if row['expectation_id'] == expectation_id)
        self.assertEqual(historical['status'], 'verified_application')
        self.assertIsNone(historical['application'])
        self.assertEqual(current['status'], 'discrepancy')
        self.assertEqual(current['reason'], 'later-episode')

    def test_allowed_gate_with_period_drift_is_not_called_a_denial(self):
        snapshot = {'accounts': [{'id': 'u', 'status': 'confirmed',
            'projection_matches_source_period': False}],
            'lumen_accounts': [{'user_id': 'u', 'access_active': True,
                'gate': {'allowed': True, 'reason': 'allowed'}}]}
        title, description = recovery_monitor._cause(snapshot, {})
        self.assertIn('period', title)
        self.assertIn('access is still allowed', description)
        snapshot['lumen_accounts'][0].update(access_active=False,
            gate={'allowed':False,'reason':'subscription_expired'})
        title, description = recovery_monitor._cause(snapshot,{})
        self.assertEqual(title,'Lumen access was not projected')
        self.assertIn('no active local projection',description)


if __name__ == '__main__':
    unittest.main()
