"""HTTP boundaries between the isolated demo services and the browser contract."""
import json
from pathlib import Path
import re
import sys
import tempfile
import time
import unittest
from urllib.error import HTTPError
from urllib.request import Request, urlopen

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from recovery_demo import Demo


class RecoveryHTTPTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix='reconcile-http-')
        self.addCleanup(self.temporary.cleanup)
        self.demo = Demo(self.temporary.name)
        self.addCleanup(self.demo.close)
        try:
            self.demo.start()
        except Exception as exc:
            key_path = self.demo.runtime / 'collector.key'
            try:
                key = key_path.read_text().strip()
            except OSError:
                key = ''
            logs = []
            for role in ('provider', 'lumen', 'engine'):
                try:
                    content = (self.demo.runtime / (role + '.log')).read_text(errors='replace')
                except OSError:
                    continue
                if key:
                    content = content.replace(key, '<redacted>')
                content = content.replace(str(self.demo.runtime), '<runtime>')
                content = re.sub(r'(?i)(signature|secret|password|token|api[_-]?key)(\s*[:=]\s*)\S+',
                                 r'\1\2<redacted>', content)
                logs.append(role + ' stderr tail:\n' + '\n'.join(content.splitlines()[-30:]))
            raise AssertionError(f'Demo startup failed: {exc}' +
                                 ('\n' + '\n'.join(logs) if logs else '')) from exc

    def exchange(self, role, path, body=None, headers=None):
        payload = None if body is None else json.dumps(body).encode()
        request = Request(self.demo.urls[role] + path, data=payload,
                          headers={'Content-Type': 'application/json', **(headers or {})})
        try:
            response = urlopen(request, timeout=10)
        except HTTPError as error:
            response = error
        with response:
            return response.status, response.headers, response.read()

    def test_three_processes_have_distinct_addresses_and_are_healthy(self):
        self.assertEqual(len(set(self.demo.urls.values())), 3)
        self.assertEqual(len({p.pid for p in self.demo.processes.values()}), 3)
        for role in self.demo.urls:
            status, _, raw = self.exchange(role, '/health')
            self.assertEqual(status, 200, (role, raw))

    def test_report_contract_is_typed_and_does_not_leak_signing_material(self):
        status, _, raw = self.exchange('engine', '/api/recovery/report')
        self.assertEqual(status, 200)
        report = json.loads(raw)
        self.assertEqual(report['mode'], 'FULL_MOCK')
        self.assertEqual(set(report['summary']),
                         {'in_scope', 'evaluated', 'confirmed', 'inconclusive', 'excluded', 'potential'})
        for field, value in {'in_scope': 100, 'evaluated': 0, 'confirmed': 0,
                             'inconclusive': 0, 'excluded': 100, 'potential': 0}.items():
            self.assertEqual(report['summary'][field], value, field)
            self.assertIs(type(report['summary'][field]), int, field)
        self.assertIsNone(report['incident'])
        for field in ('target_count', 'activation_verified', 'access_verified', 'unresolved'):
            self.assertIs(type(report['recovery'][field]), int, field)
        self.assertIsInstance(report['recovery']['unresolved_ids'], list)
        self.assertEqual(report['recovery']['target_count'], 0)
        self.assertEqual(report['recovery']['unresolved_ids'], [])
        self.assertIsNone(report['recovery']['latest_plan_id'])
        self.assertEqual(len(report['accounts']), 100)
        for account in report['accounts']:
            self.assertEqual(set(account) & {'id', 'status', 'reason', 'eligible', 'provider',
                                              'payment_state', 'adapty_active', 'gate'},
                             {'id', 'status', 'reason', 'eligible', 'provider',
                              'payment_state', 'adapty_active', 'gate'})
            self.assertIs(type(account['eligible']), bool)
            self.assertIs(type(account['adapty_active']), bool)
            self.assertIs(type(account['gate']['allowed']), bool)
        self.assertIs(type(report['coverage']['complete']), bool)
        self.assertIsInstance(report['coverage']['gaps'], list)
        self.assertNotIn(self.demo.runtime.joinpath('collector.key').read_text().strip().encode(), raw)

    def test_engine_proxy_and_direct_lumen_export_share_the_real_gate(self):
        for role, path in (('engine', '/api/recovery/lumen/export'),
                           ('lumen', '/mock/lumen/export')):
            for user_id, expected in (('u00000', 403), ('u00024', 200)):
                with self.subTest(role=role, user_id=user_id):
                    status, _, raw = self.exchange(role, path, {'user_id': user_id})
                    self.assertEqual(status, expected, raw)
                    self.assertEqual(json.loads(raw)['allowed'], expected == 200)

    def test_private_adapters_and_collector_reject_unsigned_requests(self):
        for role, path, body in (
            ('provider', '/internal/provider/accounts', None),
            ('provider', '/internal/adapty/catalog/repair', {}),
            ('provider', '/internal/adapty/validate', {}),
            ('lumen', '/internal/lumen/resync', {}),
            ('engine', '/api/recovery/collector',
             {'schema_version': 1, 'event': {}, 'sent_at': int(time.time())}),
        ):
            with self.subTest(role=role, path=path):
                status, _, raw = self.exchange(role, path, body)
                self.assertIn(status, (401, 403), raw)

    def test_cross_origin_mutation_and_runtime_file_reads_are_blocked(self):
        status, _, raw = self.exchange('engine', '/api/recovery/demo',
                                       {'action': 'reset', 'scenario': 'stripe', 'variant': 0},
                                       {'Origin': 'https://untrusted.example'})
        self.assertIn(status, (401, 403), raw)
        for path in ('/runtime/engine.sqlite3', '/collector.key', '/%2e%2e/collector.key'):
            status, _, raw = self.exchange('engine', path)
            self.assertIn(status, (400, 403, 404), (path, raw[:100]))

    def test_home_and_retained_labs_use_local_assets(self):
        for path, script in (('/', b'recovery-app.js'), ('/analytics.html', b'mock-app.js'),
                             ('/access.html', b'access-app.js'), ('/legacy.html', b'app.js')):
            status, headers, raw = self.exchange('engine', path)
            self.assertEqual(status, 200, path)
            self.assertIn('text/html', headers.get('Content-Type', ''))
            self.assertIn(script, raw)


if __name__ == '__main__':
    unittest.main()
