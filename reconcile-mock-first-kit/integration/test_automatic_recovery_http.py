"""Real HTTP flow for policy-driven live recovery and its monitor feed."""
import sys
import time
from pathlib import Path
import unittest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'integration'))
import test_live_recovery_http as live_http


class AutomaticRecoveryHTTPTests(unittest.TestCase):
    start_server = live_http.LiveRecoveryHTTPTests.start_server
    stop_server = staticmethod(live_http.LiveRecoveryHTTPTests.stop_server)
    exchange = live_http.LiveRecoveryHTTPTests.exchange
    wait_for_job = live_http.LiveRecoveryHTTPTests.wait_for_job

    def setUp(self):
        live_http.LiveRecoveryHTTPTests.setUp(self)
        self.engine.auto_repair = True

    def wait_for_monitor(self, predicate, timeout=90):
        deadline = time.monotonic()+timeout
        latest = None
        while time.monotonic() < deadline:
            status, latest = self.exchange('engine', '/api/recovery/monitor')
            if status == 200 and predicate(latest):
                return latest
            time.sleep(0.1)
        self.fail(f'Automatic recovery did not reach the expected state: {latest}')

    def test_http_customer_denial_auto_repairs_and_repeat_simulation_preserves_history(self):
        status, initial = self.exchange('engine', '/api/recovery/monitor')
        self.assertEqual(status, 200)
        self.assertEqual(initial['mode'], 'LIVE_ADAPTY_SEEDED')
        self.assertTrue(initial['automation']['enabled'])
        self.assertEqual(initial['connection']['total_accounts'], 100)
        self.assertEqual(initial['incidents'], [])

        status, incident_response = self.exchange('engine', '/api/recovery/live/incident',
                                                   {'action': 'inject'})
        self.assertEqual(status, 202, incident_response)
        self.assertEqual(incident_response['gate']['status'], 403)
        first_monitor = self.wait_for_monitor(lambda value: len(value['incidents']) == 1
            and value['incidents'][0]['status'] in ('repaired', 'unresolved'))
        first = first_monitor['incidents'][0]
        self.assertEqual(first['status'], 'repaired', first)
        self.assertEqual(first['affected_accounts'], 24)
        self.assertEqual(first['repaired_accounts'], 24)
        self.assertEqual(len(first['actions']), 48)
        self.assertIn('current Adapty evidence', first['repair_summary'])
        report_status, report = self.exchange('engine', '/api/recovery/report?incident_id='+first['id'])
        self.assertEqual(report_status, 200)
        self.assertEqual(report['recovery']['access_verified'], 24)
        self.assertEqual(report['recovery']['unresolved'], 0)
        self.assertEqual(len(report['actions']), 48)
        self.assertEqual({row['owner'] for row in report['actions']}, {'lumen'})
        audit_status, audit = self.exchange('engine', '/api/recovery/audit?incident_id='+first['id'])
        self.assertEqual(audit_status, 200)
        self.assertTrue(audit['approvals'])
        self.assertEqual({row['actor'] for row in audit['approvals']},
                         {'policy:local-fulfillment-resync-v2'})

        operation = {'action': 'once', 'operation_key': 'automatic-http-repeat'}
        status, accepted = self.exchange('engine', '/api/recovery/simulation', operation)
        self.assertEqual(status, 202)
        status, duplicate = self.exchange('engine', '/api/recovery/simulation', operation)
        self.assertEqual(status, 202)
        self.assertEqual(accepted['job_id'], duplicate['job_id'])
        self.assertTrue(duplicate['duplicate'])
        job = self.wait_for_job(accepted['job_id'], timeout=120)
        self.assertEqual(job['status'], 'completed', job)
        final = self.wait_for_monitor(lambda value: value['simulation']['status'] == 'completed')
        self.assertEqual(len(final['incidents']), 2)
        self.assertTrue(all(item['status'] == 'repaired' for item in final['incidents']))
        self.assertEqual(next(item for item in final['incidents'] if item['id'] == first['id']), first)


if __name__ == '__main__':
    unittest.main()
