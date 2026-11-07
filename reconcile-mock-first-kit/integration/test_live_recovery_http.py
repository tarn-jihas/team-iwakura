"""Real HTTP boundaries for the isolated live Adapty recovery flow."""
import json
from pathlib import Path
import socket
import sys
import tempfile
import threading
import time
import unittest
from urllib.error import HTTPError
from urllib.request import Request, urlopen
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(ROOT / 'tests'))
from test_live_recovery_flow import FakeAdaptySource, catalog_fixture, live_config
import adapty_seed_setup
import recovery_live
import recovery_service as service


def free_port():
    with socket.socket() as listener:
        listener.bind(('127.0.0.1', 0))
        return listener.getsockname()[1]


class LiveRecoveryHTTPTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix='reconcile-live-http-')
        self.addCleanup(self.temporary.cleanup)
        root = Path(self.temporary.name)
        self.config_path, _ = live_config(root)
        self.source = FakeAdaptySource()
        with (patch.object(adapty_seed_setup, 'read_cli_catalog', return_value=catalog_fixture()),
              patch.object(recovery_live, 'AdaptyReader',
                           side_effect=lambda config: self.source.bind(config))):
            self.provider = service.RecoveryService('provider', 0, root/'provider.db',
                root/'shared.key', demo=True, live_config=self.config_path)
        self.provider_url = self.start_server(self.provider)
        engine_port = free_port()
        self.lumen = service.RecoveryService('lumen', 0, root/'lumen.db',
            self.provider.key_file, provider_url=self.provider_url,
            collector_url=f'http://127.0.0.1:{engine_port}/api/recovery/collector',
            demo=True, live_config=self.config_path)
        self.lumen_url = self.start_server(self.lumen)
        self.engine = service.RecoveryService('engine', engine_port, root/'engine.db',
            self.provider.key_file, provider_url=self.provider_url,
            lumen_url=self.lumen_url, demo=True, live_config=self.config_path)
        self.engine_url = self.start_server(self.engine)

    def start_server(self, app):
        server = service.RecoveryHTTPServer(app)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        self.addCleanup(self.stop_server, server, thread)
        return f'http://127.0.0.1:{server.server_port}'

    @staticmethod
    def stop_server(server, thread):
        server.shutdown()
        server.server_close()
        thread.join(timeout=5)

    def exchange(self, role, path, body=None):
        base = {'provider': self.provider_url, 'lumen': self.lumen_url,
                'engine': self.engine_url}[role]
        payload = None if body is None else json.dumps(body).encode()
        request = Request(base+path, data=payload,
            headers={'Content-Type': 'application/json'})
        try:
            response = urlopen(request, timeout=10)
        except HTTPError as error:
            response = error
        with response:
            raw = response.read()
            return response.status, json.loads(raw) if raw else None

    def wait_for_report(self, predicate, timeout=60):
        deadline = time.monotonic() + timeout
        latest = None
        while time.monotonic() < deadline:
            status, latest = self.exchange('engine', '/api/recovery/report')
            if status == 200 and predicate(latest):
                return latest
            time.sleep(0.1)
        self.fail(f'Live recovery did not reach the expected state: {latest}')

    def wait_for_job(self, job_id, timeout=60):
        deadline = time.monotonic() + timeout
        latest = None
        while time.monotonic() < deadline:
            status, latest = self.exchange('engine', '/api/recovery/jobs/'+job_id)
            if status == 200 and latest['status'] in ('completed', 'failed'):
                return latest
            time.sleep(0.1)
        self.fail(f'Execution job did not finish: {latest}')

    def test_customer_denial_runs_approved_24_account_recovery_over_http(self):
        status, live_status = self.exchange('engine', '/api/recovery/live/status')
        self.assertEqual(status, 200)
        self.assertTrue(live_status['ready'])
        self.assertEqual(live_status['account_count'], 100)
        self.assertEqual(live_status['provider_evidence_count'], 0)

        status, incident_response = self.exchange('engine', '/api/recovery/live/incident',
                                                   {'action': 'inject'})
        self.assertEqual(status, 202, incident_response)
        self.assertTrue(incident_response['incident']['pending'])
        self.assertEqual(incident_response['gate']['status'], 403)

        report = self.wait_for_report(lambda value: value.get('incident')
            and value['incident'].get('snapshot_id')
            and value['summary']['confirmed'] == 24)
        targets = [row['id'] for row in report['accounts']
                   if row['status'] == 'confirmed' and row['eligible']]
        self.assertEqual(len(targets), 24)
        self.assertEqual(report['coverage']['provider_accounts'], 100)
        self.assertEqual(report['coverage']['entitlement_evidence'], 100)
        self.assertEqual(report['coverage']['provider_evidence'], 0)

        status, plan = self.exchange('engine', '/api/recovery/plans',
            {'incident_id': report['incident']['id'], 'ids': targets})
        self.assertEqual(status, 200)
        self.assertEqual(plan['recovery_basis'], 'adapty_entitlement_delivery')
        self.assertEqual({entry['type'] for entry in plan['entries']},
                         {'resync_access', 'verify_gate'})
        status, approval = self.exchange('engine', '/api/recovery/approvals', {
            'plan_id': plan['id'], 'plan_hash': plan['plan_hash'], 'actor': 'http operator'})
        self.assertEqual(status, 200)
        self.assertFalse(approval['duplicate'])
        status, execution = self.exchange('engine', '/api/recovery/executions', {
            'plan_id': plan['id'], 'plan_hash': plan['plan_hash']})
        self.assertEqual(status, 202)
        job = self.wait_for_job(execution['job_id'])
        self.assertEqual(job['status'], 'completed', job)
        self.assertEqual(job['result']['target_count'], 24)
        self.assertEqual(job['result']['entitlement_verified'], 24)
        self.assertEqual(job['result']['access_verified'], 24)

        status, snapshot = self.exchange('engine', '/api/recovery/snapshots/'+plan['snapshot_id'])
        self.assertEqual(status, 200)
        self.assertEqual(snapshot['provider_evidence'], [])
        self.assertEqual(len(snapshot['entitlement_evidence']), 100)
        final = self.wait_for_report(lambda value: value['recovery']['access_verified'] == 24)
        self.assertEqual(final['recovery']['unresolved'], 0)
        self.assertEqual(final['incident']['status'], 'access_verified')
        status, gate = self.exchange('engine', '/api/recovery/lumen/export',
                                     {'user_id': targets[0]})
        self.assertEqual(status, 200)
        self.assertTrue(gate['allowed'])


if __name__ == '__main__':
    unittest.main()
