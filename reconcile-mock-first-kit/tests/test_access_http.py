"""Integration of the real HTTP router, SDK collector and Lumen gate."""
import http.client
import json
from pathlib import Path
import sys
import tempfile
import threading
import unittest
from unittest.mock import patch

KIT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(KIT))
import paid_access as access
import reconcile_mock as server_module
from collector_sdk import CollectorSDK, http_transport


class AccessHTTPTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.temp = tempfile.TemporaryDirectory()
        cls.root = Path(cls.temp.name)
        cls.patches = [
            patch.object(access, 'STATE', cls.root / 'access.json'),
            patch.object(access, 'EVAL', cls.root / 'access_oracle.json'),
            patch.object(server_module, 'STATE', cls.root / 'analytics.json'),
            patch.object(server_module, 'EVAL', cls.root / 'analytics_oracle.json'),
        ]
        for item in cls.patches: item.start()
        cls.server = server_module.ThreadingHTTPServer(('127.0.0.1', 0), server_module.Handler)
        cls.thread = threading.Thread(target=cls.server.serve_forever, daemon=True)
        cls.thread.start()
        cls.port = cls.server.server_port

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown(); cls.server.server_close(); cls.thread.join(timeout=3)
        for item in reversed(cls.patches): item.stop()
        cls.temp.cleanup()

    def setUp(self):
        server_module.seed()
        access.seed()

    def request(self, path, body=None, headers=None):
        connection = http.client.HTTPConnection('127.0.0.1', self.port, timeout=15)
        try:
            payload = None if body is None else json.dumps(body)
            request_headers = {'Content-Type': 'application/json', **(headers or {})}
            connection.request('GET' if body is None else 'POST', path, payload, request_headers)
            response = connection.getresponse(); data = response.read()
            result = json.loads(data) if 'application/json' in response.getheader('Content-Type', '') else data
            return response.status, result
        finally:
            connection.close()

    def plan(self, ids, retry_of=None):
        status, plan = self.request('/api/access/preview', {'ids': ids, **({'retry_of': retry_of} if retry_of else {})})
        self.assertEqual(status, 200, plan)
        return plan

    def approve(self, plan):
        status, result = self.request('/api/access/approve', {'plan_id': plan['id'], 'plan_hash': plan['plan_hash'], 'actor': 'http-test-operator'})
        self.assertEqual(status, 200, result)

    def test_http_full_recovery_uses_actual_gate_and_preserves_analytics(self):
        analytics_before = server_module.STATE.read_bytes()
        self.assertEqual(self.request('/access.html')[0], 200)
        self.assertEqual(self.request('/mock/lumen/export', {'user_id': 'u00000'})[0], 403)
        status, detected = self.request('/api/access/detect', {})
        self.assertEqual(status, 200, detected)
        report = self.request('/api/access/report')[1]
        self.assertEqual((report['summary']['in_scope'], report['summary']['evaluated'], report['summary']['confirmed'], report['summary']['inconclusive']), (100, 94, 24, 6))
        ids = [row['id'] for row in report['accounts'] if row['eligible']]
        plan = self.plan(ids)
        self.assertEqual(self.request('/api/access/apply', {'plan_id': plan['id'], 'plan_hash': plan['plan_hash']})[0], 409)
        projections = json.dumps(access.read()['projection'], sort_keys=True)
        self.approve(plan)
        self.assertEqual(json.dumps(access.read()['projection'], sort_keys=True), projections)
        self.assertEqual(self.request('/api/access/apply', {'plan_id': plan['id'], 'plan_hash': plan['plan_hash']})[1]['writes_accepted'], 24)
        status, first = self.request('/api/access/verify', {'plan_id': plan['id']})
        self.assertEqual(status, 200, first)
        report = self.request('/api/access/report')[1]
        self.assertEqual((report['recovery']['verified_count'], report['recovery']['unresolved_count']), (23, 1))
        failed = report['recovery']['unresolved_ids']
        self.assertEqual(len(failed), 1)
        self.assertEqual(self.request('/mock/lumen/export', {'user_id': failed[0]})[0], 403)
        self.assertEqual(self.request('/api/access/apply', {'plan_id': plan['id'], 'plan_hash': plan['plan_hash']})[1]['writes_accepted'], 0)
        retry = self.plan(failed, retry_of=plan['id']); self.approve(retry)
        self.assertEqual(self.request('/api/access/apply', {'plan_id': retry['id'], 'plan_hash': retry['plan_hash']})[1]['writes_accepted'], 1)
        self.assertEqual(self.request('/api/access/verify', {'plan_id': retry['id']})[0], 200)
        final = self.request('/api/access/report')[1]
        self.assertEqual((final['recovery']['verified_count'], final['recovery']['unresolved_count'], final['summary']['inconclusive']), (24, 0, 6))
        self.assertEqual(final['recovery']['root_cause_status'], 'pending')
        self.assertEqual(self.request('/mock/lumen/export', {'user_id': failed[0]})[0], 200)
        self.assertEqual(server_module.STATE.read_bytes(), analytics_before)
        audit = self.request('/api/access/audit')[1]
        serialized = json.dumps(audit)
        self.assertNotIn(access.read()['_collector_key'], serialized)
        self.assertNotIn('_fault_controls', serialized)
        self.assertNotIn('affected_ids', serialized)

    def test_real_sdk_posts_to_protected_collector_route(self):
        state = access.read()
        sdk = CollectorSDK(state['_collector_key'], state['manifest']['run_id'], access.APP,
                           http_transport(f'http://127.0.0.1:{self.port}/api/collector/events'))
        before = len(state['collector']['events'])
        details = {'outcome': 'observed', 'source_hash': 'test-observation', 'initiator': 'sdk_http_test'}
        first = sdk.emit('source_entitlement_observed', 'u00000', '2026-11-03T00:12:04Z', details, event_id='sdk-http-event')
        repeated = sdk.emit('source_entitlement_observed', 'u00000', '2026-11-03T00:12:04Z', details, event_id='sdk-http-event')
        self.assertFalse(first['duplicate']); self.assertTrue(repeated['duplicate'])
        self.assertEqual(len(access.read()['collector']['events']), before + 1)
        self.assertEqual(self.request('/api/collector/events', {'event': {}, 'sent_at': 0})[0], 401)
        self.assertEqual(self.request('/api/access/detect', {}, {'Origin': 'http://untrusted.example'})[0], 403)
        self.assertEqual(self.request('/runtime/access_state.json')[0], 404)
        status, journal = self.request('/api/access/journal?limit=2')
        self.assertEqual(status, 200)
        self.assertEqual(len(journal['events']), 2)
        self.assertEqual(self.request('/api/access/journal?limit=invalid')[0], 400)

    def test_access_reset_and_variant_are_independent_of_analytics(self):
        analytics_before = server_module.STATE.read_bytes()
        initial = self.request('/api/access/registry')[1]
        self.assertEqual(self.request('/api/access/demo', {'action': 'reset', 'variant': 1})[0], 200)
        self.assertNotEqual(initial, self.request('/api/access/registry')[1])
        self.assertEqual(self.request('/api/access/detect', {})[0], 200)
        report = self.request('/api/access/report')[1]
        self.assertEqual((report['summary']['confirmed'], report['summary']['inconclusive']), (24, 6))
        self.assertEqual(self.request('/mock/lumen/export', {'user_id': 'not-in-this-run'})[0], 404)
        self.assertEqual(server_module.STATE.read_bytes(), analytics_before)


if __name__ == '__main__': unittest.main()
