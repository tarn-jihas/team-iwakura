import copy
import http.client
import json
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
import sys
import tempfile
import threading
import unittest
from unittest.mock import patch
from urllib.parse import quote

KIT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(KIT))
import reconcile_mock as mock


class ReconcileMockTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.temp = tempfile.TemporaryDirectory()
        cls.root = Path(cls.temp.name)
        cls.patches = [
            patch.object(mock, 'STATE', cls.root / 'runtime' / 'state.json'),
            patch.object(mock, 'EVAL', cls.root / '_evaluation' / 'oracle.json'),
            patch.object(mock, 'REFERENCE', KIT / 'reference'),
            patch.object(mock, 'STATIC', KIT.parent / 'Reconcile' / 'dist'),
        ]
        for item in cls.patches:
            item.start()
        cls.server = mock.ThreadingHTTPServer(('127.0.0.1', 0), mock.Handler)
        cls.thread = threading.Thread(target=cls.server.serve_forever, daemon=True)
        cls.thread.start()
        cls.port = cls.server.server_port

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()
        cls.server.server_close()
        cls.thread.join(timeout=3)
        for item in reversed(cls.patches):
            item.stop()
        cls.temp.cleanup()

    def setUp(self):
        mock.seed()

    def request(self, path, method='GET', body=None, headers=None, raw=None):
        conn = http.client.HTTPConnection('127.0.0.1', self.port, timeout=5)
        payload = raw if raw is not None else (None if body is None else json.dumps(body, allow_nan=False))
        request_headers = dict(headers or {})
        if method == 'POST' and 'Content-Type' not in request_headers:
            request_headers['Content-Type'] = 'application/json'
        conn.request(method, path, body=payload, headers=request_headers)
        response = conn.getresponse()
        data = response.read()
        status = response.status
        content_type = response.getheader('Content-Type', '')
        conn.close()
        if 'application/json' in content_type:
            return status, json.loads(data)
        return status, data

    def snapshot(self):
        return mock.STATE.read_bytes()

    def test_seed_report_preview_and_read_routes_are_deterministic_and_pure(self):
        report = mock.detect(mock.read())
        self.assertEqual(report['gap'], {'USD': '21.97', 'EUR': '989.01'})
        self.assertEqual(len(report['groups']), 6)
        self.assertEqual(sum(len(group['findings']) for group in report['groups']), 7)
        self.assertEqual(report['manifest']['app'], 'mock-lumen')
        status, operations = self.request('/api/operations')
        self.assertEqual(status, 200)
        self.assertEqual(len(operations['operations']), 10)
        preview = mock.preview(mock.read())
        self.assertEqual(sum(group['row_count'] for group in preview['groups']), 4)
        before = self.snapshot()
        for path in ('/api/report?run=mock-run-20261107', '/api/preview', '/api/verify', '/api/manifest', '/api/audit', '/api/history', '/api/operations', '/api/samples'):
            status, _ = self.request(path)
            self.assertEqual(status, 200, path)
            self.assertEqual(self.snapshot(), before, path)
        self.assertEqual(self.request('/api/report?run=unknown')[0], 404)
        self.assertEqual(self.request('/mock/adapty/api/v2/server-side-api/profile/?customer_user_id=unknown-user')[0], 404)

    def test_original_full_mock_replay_passes_in_temporary_state(self):
        mock.verify()

    def test_approvals_bind_hashes_and_apply_prevalidates_every_group(self):
        before = self.snapshot()
        original_mixpanel = copy.deepcopy(mock.read()['mixpanel'])
        bad = {'run': mock.ID, 'ids': ['MISSING_IN_MIXPANEL'], 'hashes': {'MISSING_IN_MIXPANEL': 'stale'}}
        self.assertEqual(self.request('/api/approve', 'POST', bad)[0], 400)
        self.assertEqual(self.snapshot(), before)
        preview = mock.preview(mock.read())
        hashes = {group['class']: group['approval_hash'] for group in preview['groups']}
        approved = {'run': mock.ID, 'ids': list(hashes), 'hashes': hashes}
        self.assertEqual(self.request('/api/approve', 'POST', approved)[0], 200)
        self.assertEqual(mock.read()['mixpanel'], original_mixpanel)
        before_apply = self.snapshot()
        self.assertEqual(self.request('/api/apply', 'POST', {'run': mock.ID, 'ids': ['MISSING_IN_MIXPANEL', 'UNAPPROVED']})[0], 400)
        self.assertEqual(self.snapshot(), before_apply)
        status, result = self.request('/api/apply', 'POST', {'run': mock.ID, 'ids': list(hashes)})
        self.assertEqual(status, 200)
        self.assertEqual(result['writes_accepted'], 4)
        accepted = [entry['payload'] for entry in mock.read()['journal'] if entry['type'] == 'WRITE_ACCEPTED_MOCK']
        planned = [payload for group in preview['groups'] for payload in group['payloads']]
        self.assertCountEqual(accepted, planned)

    def test_apply_is_pending_until_readback_then_retry_is_noop(self):
        self.assertEqual(self.request('/api/map', 'POST', {'event': 'premium_paid_v2', 'cls': 'purchase'})[0], 200)
        preview = mock.preview(mock.read())
        hashes = {group['class']: group['approval_hash'] for group in preview['groups']}
        self.request('/api/approve', 'POST', {'ids': list(hashes), 'hashes': hashes})
        status, applied = self.request('/api/apply', 'POST', {'ids': list(hashes)})
        self.assertEqual((status, applied['writes_accepted']), (200, 4))
        self.assertEqual(applied['report']['pending_count'], 4)
        status, ev = self.request('/api/evidence?txn=txn_missing_purchase')
        self.assertEqual(status, 200)
        self.assertEqual(ev['destination'], [])
        self.assertEqual(len(ev['pending_destination']), 1)
        self.assertEqual(self.request('/api/apply', 'POST', {'ids': list(hashes)})[1]['writes_accepted'], 0)
        self.request('/api/advance-clock', 'POST', {'ticks': 1})
        report = mock.detect(mock.read())
        self.assertEqual(report['gap'], {'USD': '11.98', 'EUR': '0.00'})
        self.assertEqual(report['group_states']['MISSING_IN_MIXPANEL'], 'verified')
        self.assertEqual(self.request('/api/apply', 'POST', {'ids': list(hashes)})[1]['writes_accepted'], 0)
        _, ev = self.request('/api/evidence?txn=txn_price')
        self.assertEqual(ev['pending_destination'], [])
        self.assertEqual(len(ev['correction_receipts']), 1)
        state = mock.read()
        wrong_raw = [row['payload'] for row in state['mixpanel'] if row['payload']['properties']['transaction_id'] == 'txn_price' and row['payload']['event'] != 'reconcile_correction']
        duplicate_raw = [row['payload'] for row in state['mixpanel'] if row['payload']['properties']['transaction_id'] == 'txn_duplicate' and row['payload']['event'] != 'reconcile_correction']
        self.assertEqual(wrong_raw[0]['properties']['price_local'], '999.00')
        self.assertEqual(len(duplicate_raw), 2)
        self.assertEqual(len({row['properties']['$insert_id'] for row in duplicate_raw}), 2)
        ops = {op['txn']: op for op in mock.operations(state)['operations']}
        self.assertEqual(ops['txn_price']['destination_amount'], '9.99')
        self.assertEqual(mock.detect(state)['verification_status'], 'verified')

    def test_mapping_is_separate_from_destination_writes(self):
        s = mock.read()
        before = len(s['mixpanel'])
        result = mock.map_name(s, 'premium_paid_v2', 'purchase', 'tester')
        self.assertEqual(result['event_class'], 'purchase')
        self.assertEqual(len(mock.read()['mixpanel']), before)
        report = mock.detect(mock.read())
        self.assertNotIn('UNMAPPED_EVENT_NAME', {group['cls'] for group in report['groups']})
        self.assertEqual(report['group_states']['UNMAPPED_EVENT_NAME'], 'mapped')

    def test_missing_action_readback_cannot_be_reported_as_verified(self):
        group = next(g for g in mock.preview(mock.read())['groups'] if g['class'] == 'PRICE_MISMATCH')
        self.assertEqual(self.request('/api/approve', 'POST', {'ids': ['PRICE_MISMATCH'], 'hashes': {'PRICE_MISMATCH': group['approval_hash']}})[0], 200)
        self.assertEqual(self.request('/api/apply', 'POST', {'ids': ['PRICE_MISMATCH']})[1]['writes_accepted'], 1)
        self.request('/api/advance-clock', 'POST', {'ticks': 1})
        state = mock.read()
        action = next(iter(state['actions'].values()))
        state['mixpanel'] = [row for row in state['mixpanel'] if row['payload']['properties']['$insert_id'] != action['insert_id']]
        mock.save(state)
        status, report = self.request('/api/verify')
        self.assertEqual(status, 200)
        self.assertNotEqual(report['verification_status'], 'verified')
        self.assertEqual(report['verification']['status'], 'readback_failed')
        self.assertEqual(report['verification']['actions'][0]['status'], 'missing_readback')
        self.assertEqual(report['gap']['EUR'], '989.01')
        self.assertEqual(self.request('/api/audit')[1]['verification']['status'], 'readback_failed')

    def test_manual_ghost_and_sandbox_findings_are_not_repairable(self):
        report = mock.detect(mock.read())
        self.assertIn('EXTRA_IN_MIXPANEL', {g['cls'] for g in report['groups']})
        self.assertIn('SANDBOX_EXPECTED', {g['cls'] for g in report['groups']})
        self.assertEqual({g['class'] for g in mock.preview(mock.read())['groups']}, {'MISSING_IN_MIXPANEL', 'PRICE_MISMATCH', 'DUPLICATE_IN_MIXPANEL'})
        with self.assertRaises(ValueError):
            mock.approve(mock.read(), ['EXTRA_IN_MIXPANEL'])

    def test_import_batch_validation_is_atomic_and_us_transport_does_not_persist(self):
        state = mock.read()
        valid = copy.deepcopy(state['mixpanel'][0]['payload'])
        valid['properties']['$insert_id'] = 'new-id'
        invalid = copy.deepcopy(valid)
        del invalid['properties']['currency']
        before = self.snapshot()
        self.assertEqual(self.request('/mock/mixpanel/import', 'POST', [valid, invalid])[0], 400)
        self.assertEqual(self.snapshot(), before)
        status, response = self.request('/mock/mixpanel/import?region=us', 'POST', [valid])
        self.assertEqual((status, response['num_records_imported']), (200, 0))
        self.assertEqual(self.snapshot(), before)
        wrong_app = copy.deepcopy(valid)
        wrong_app['app_id'] = 'another-app'
        self.assertEqual(self.request('/mock/mixpanel/import', 'POST', [wrong_app])[0], 400)
        self.assertEqual(self.snapshot(), before)
        self.assertEqual(self.request('/mock/mixpanel/import', 'POST', raw=b'[{"event":"x","properties":{"price_local":NaN}}]')[0], 400)
        self.assertEqual(self.snapshot(), before)
        for bad_money in ('1.001', '1e100'):
            invalid_money = copy.deepcopy(valid)
            invalid_money['properties']['price_local'] = bad_money if bad_money == '1.001' else float('1e100')
            self.assertEqual(self.request('/mock/mixpanel/import', 'POST', [invalid_money])[0], 400)
            self.assertEqual(self.snapshot(), before)
        unsupported = copy.deepcopy(valid)
        unsupported['properties']['currency'] = 'JPY'
        self.assertEqual(self.request('/mock/mixpanel/import', 'POST', [unsupported])[0], 400)
        self.assertEqual(self.snapshot(), before)

    def test_identity_environment_and_currency_mismatches_block_auto_correction(self):
        for changed in ({'distinct_id': 'somebody-else'}, {'environment': 'Sandbox'}, {'currency': 'EUR'}):
            with self.subTest(changed=changed):
                mock.seed()
                source = copy.deepcopy(mock.read()['source'][0])
                p = source['event_properties']
                payload = {'event': source['event_type'], 'properties': {'distinct_id': source['customer_user_id'], 'time': mock.T0 + 50, '$insert_id': 'conflict-'+str(len(changed))+str(changed), 'transaction_id': p['transaction_id'], 'original_transaction_id': p['original_transaction_id'], 'currency': p['currency'], 'price_local': mock.amount(p['price_local']), 'environment': p['environment'], 'store': 'play_store'}}
                payload['properties'].update(changed)
                status, _ = self.request('/mock/mixpanel/import', 'POST', [payload])
                self.assertEqual(status, 200)
                self.request('/api/advance-clock', 'POST', {'ticks': 1})
                report = mock.detect(mock.read())
                findings = [f for g in report['groups'] for f in g['findings']]
                self.assertNotIn('txn_missing_purchase', {f['txn'] for f in findings if f['cls'] == 'MISSING_IN_MIXPANEL'})
                self.assertIn('txn_missing_purchase', {f['txn'] for f in findings if f['cls'] in ('AMBIGUOUS_IDENTITY', 'CURRENCY_MISMATCH')})

    def test_same_transaction_for_two_users_keeps_distinct_findings_and_receipts(self):
        s = mock.read()
        other = copy.deepcopy(next(e for e in s['source'] if e['event_properties']['transaction_id'] == 'txn_missing_purchase'))
        other['customer_user_id'] = 'u00010'
        other['profile_id'] = mock.uid('profile/u00010')
        other['event_properties']['profile_event_id'] = mock.uid('source/txn_missing_purchase/other-user')
        s['source'].append(other)
        mock.save(s)
        report = mock.detect(mock.read())
        matches = [f for g in report['groups'] if g['cls'] == 'MISSING_IN_MIXPANEL' for f in g['findings'] if f['txn'] == 'txn_missing_purchase']
        self.assertEqual({f['user'] for f in matches}, {'u00001', 'u00010'})
        self.assertEqual(len({f['id'] for f in matches}), 2)
        preview = mock.preview(mock.read())
        hashes = {g['class']: g['approval_hash'] for g in preview['groups']}
        mock.approve(mock.read(), list(hashes), hashes=hashes)
        result = mock.do_apply(mock.read(), list(hashes))
        self.assertEqual(result['writes_accepted'], 5)
        state = mock.read()
        self.assertEqual(len(state['actions']), 5)
        writes = [e['payload'] for e in state['mixpanel'] if e['payload']['properties'].get('transaction_id') == 'txn_missing_purchase' and e['visible_at'] > state['clock']]
        self.assertEqual({e['properties']['distinct_id'] for e in writes}, {'u00001', 'u00010'})

    def test_same_tuple_dedup_keeps_latest_imported_event(self):
        s = mock.read()
        source = next(e for e in s['source'] if e['event_properties']['transaction_id'] == 'txn_healthy_usd')
        original = next(e['payload'] for e in s['mixpanel'] if e['payload']['properties']['transaction_id'] == 'txn_healthy_usd')
        first = copy.deepcopy(original);first['properties']['price_local'] = '1.00'
        latest = copy.deepcopy(original);latest['properties']['price_local'] = '6.99'
        status, _ = self.request('/mock/mixpanel/import', 'POST', [first, latest])
        self.assertEqual(status, 200)
        self.request('/api/advance-clock', 'POST', {'ticks': 1})
        report = mock.detect(mock.read())
        self.assertEqual(report['raw_event_count'], report['query_event_count'] + 2)
        self.assertNotIn('txn_healthy_usd', {f['txn'] for g in report['groups'] if g['cls'] == 'PRICE_MISMATCH' for f in g['findings']})
        self.assertEqual(source['event_properties']['transaction_id'], 'txn_healthy_usd')

    def test_unknown_event_with_known_event_is_unmapped_not_healthy_or_repairable(self):
        original = next(e['payload'] for e in mock.read()['mixpanel'] if e['payload']['properties']['transaction_id'] == 'txn_healthy_usd')
        renamed = copy.deepcopy(original)
        renamed['event'] = 'unmapped_paid_event'
        renamed['properties']['$insert_id'] = 'healthy-unmapped-extra'
        renamed['properties']['time'] += 100
        self.assertEqual(self.request('/mock/mixpanel/import', 'POST', [renamed])[0], 200)
        self.request('/api/advance-clock', 'POST', {'ticks': 1})
        report = mock.detect(mock.read())
        self.assertEqual(report['gap']['USD'], '28.96')
        findings = [f for g in report['groups'] for f in g['findings']]
        self.assertIn(('UNMAPPED_EVENT_NAME', 'txn_healthy_usd'), {(f['cls'], f['txn']) for f in findings})
        self.assertNotIn(('PRICE_MISMATCH', 'txn_healthy_usd'), {(f['cls'], f['txn']) for f in findings})
        operation = next(op for op in mock.operations(mock.read())['operations'] if op['txn'] == 'txn_healthy_usd')
        self.assertEqual((operation['status'], operation['delta']), ('unmapped', '6.99'))
        mock.seed()
        refund = next(e for e in mock.read()['source'] if e['event_type'] == 'subscription_refunded')
        p = refund['event_properties']
        renamed_refund = {'event': 'unmapped_refund', 'properties': {'distinct_id': refund['customer_user_id'], 'time': mock.T0 + 200, '$insert_id': 'unmapped-refund-id', 'transaction_id': p['transaction_id'], 'original_transaction_id': p['original_transaction_id'], 'currency': p['currency'], 'price_local': mock.amount(p['price_local']), 'environment': p['environment'], 'store': 'play_store'}}
        self.assertEqual(self.request('/mock/mixpanel/import', 'POST', [renamed_refund])[0], 200)
        self.request('/api/advance-clock', 'POST', {'ticks': 1})
        report = mock.detect(mock.read())
        findings = [f for g in report['groups'] for f in g['findings']]
        self.assertNotIn(('MISSING_IN_MIXPANEL', 'txn_missing_refund', 'refund'), {(f['cls'], f['txn'], f['event_class']) for f in findings})
        self.assertIn(('UNMAPPED_EVENT_NAME', 'txn_missing_refund', 'refund'), {(f['cls'], f['txn'], f['event_class']) for f in findings})
        refund_operation = next(op for op in mock.operations(mock.read())['operations'] if op['txn'] == 'txn_missing_refund' and op['event_class'] == 'refund')
        self.assertEqual((refund_operation['status'], refund_operation['source_amount'], refund_operation['destination_amount'], refund_operation['delta']), ('unmapped', '-6.99', '-6.99', '0.00'))

    def test_new_duplicate_after_completed_correction_gets_a_new_action(self):
        preview = mock.preview(mock.read())
        duplicate = next(g for g in preview['groups'] if g['class'] == 'DUPLICATE_IN_MIXPANEL')
        self.request('/api/approve', 'POST', {'ids': ['DUPLICATE_IN_MIXPANEL'], 'hashes': {'DUPLICATE_IN_MIXPANEL': duplicate['approval_hash']}})
        first = self.request('/api/apply', 'POST', {'ids': ['DUPLICATE_IN_MIXPANEL']})[1]
        self.assertEqual(first['writes_accepted'], 1)
        self.request('/api/advance-clock', 'POST', {'ticks': 1})
        extra = copy.deepcopy(next(e['payload'] for e in mock.read()['mixpanel'] if e['payload']['properties']['transaction_id'] == 'txn_duplicate' and e['payload']['event'] != 'reconcile_correction'))
        extra['properties']['$insert_id'] = 'new-duplicate-id'
        extra['properties']['time'] += 100
        self.assertEqual(self.request('/mock/mixpanel/import', 'POST', [extra])[0], 200)
        self.request('/api/advance-clock', 'POST', {'ticks': 1})
        latest = next(g for g in mock.preview(mock.read())['groups'] if g['class'] == 'DUPLICATE_IN_MIXPANEL')
        self.request('/api/approve', 'POST', {'ids': ['DUPLICATE_IN_MIXPANEL'], 'hashes': {'DUPLICATE_IN_MIXPANEL': latest['approval_hash']}})
        result = self.request('/api/apply', 'POST', {'ids': ['DUPLICATE_IN_MIXPANEL']})[1]
        self.assertEqual(result['writes_accepted'], 1)
        self.assertNotEqual(duplicate['payloads'][0]['properties']['$insert_id'], latest['payloads'][0]['properties']['$insert_id'])
        self.request('/api/advance-clock', 'POST', {'ticks': 1})
        self.assertEqual(self.request('/api/apply', 'POST', {'ids': ['DUPLICATE_IN_MIXPANEL']})[1]['writes_accepted'], 0)
        self.assertNotIn('DUPLICATE_IN_MIXPANEL', {g['cls'] for g in mock.detect(mock.read())['groups']})

    def test_sandbox_destination_is_readable_but_excluded_from_production_metric(self):
        source = next(e for e in mock.read()['source'] if e['event_properties']['environment'] == 'Sandbox')
        p = source['event_properties']
        event = {'event': source['event_type'], 'properties': {'distinct_id': source['customer_user_id'], 'time': mock.T0 + 500, '$insert_id': 'sandbox-import', 'transaction_id': p['transaction_id'], 'original_transaction_id': p['original_transaction_id'], 'currency': p['currency'], 'price_local': mock.amount(p['price_local']), 'environment': 'Sandbox', 'store': 'play_store'}}
        self.assertEqual(self.request('/mock/mixpanel/import', 'POST', [event])[0], 200)
        self.request('/api/advance-clock', 'POST', {'ticks': 1})
        report = mock.detect(mock.read())
        self.assertEqual(report['gap'], {'USD': '21.97', 'EUR': '989.01'})
        status, export = self.request('/mock/mixpanel/api/2.0/export')
        self.assertEqual(status, 200)
        self.assertIn(b'sandbox-import', export)
        operations = mock.operations(mock.read())['operations']
        self.assertEqual(len(operations), 10)
        sandbox = next(op for op in operations if op['txn'] == 'txn_sandbox')
        ghost = next(op for op in operations if op['txn'] == 'txn_ghost')
        self.assertEqual((sandbox['source_amount'], sandbox['destination_amount'], sandbox['delta'], sandbox['status']), ('0.00', '0.00', '0.00', 'expected'))
        self.assertEqual((ghost['source_amount'], ghost['destination_amount'], ghost['delta'], ghost['status']), ('0.00', '11.98', '11.98', 'manual'))

    def test_samples_static_containment_and_write_origin_checks(self):
        status, page = self.request('/')
        self.assertEqual(status, 200)
        self.assertIn(b'Reconcile', page)
        status, samples = self.request('/api/samples')
        self.assertEqual(status, 200)
        self.assertTrue(samples['samples'])
        self.assertEqual(len(samples['samples']), 20)
        self.assertEqual(samples['samples'][0]['provider'], 'amplitude')
        sample_path = samples['samples'][0]['path']
        status, sample = self.request('/api/sample?path='+quote(sample_path))
        self.assertEqual(status, 200)
        self.assertEqual(sample['path'], sample_path)
        for item in samples['samples']:
            self.assertEqual(self.request('/api/sample?path='+quote(item['path']))[0], 200, item['path'])
        self.assertEqual(self.request('/api/sample?path=..%2Fruntime%2Fstate.json')[0], 400)
        self.assertEqual(self.request('/runtime/state.json')[0], 404)
        self.assertEqual(self.request('/reconcile_mock.py')[0], 404)
        self.assertEqual(self.request('/api/advance-clock', 'POST', {'ticks': 1}, {'Origin': 'http://evil.example'})[0], 403)
        self.assertEqual(self.request('/api/advance-clock', 'POST', {'ticks': 1}, {'Host': 'example.com:'+str(self.port)})[0], 403)
        self.assertEqual(self.request('/api/advance-clock', 'POST', {'ticks': 1}, {'Content-Type': 'text/plain'})[0], 415)
        self.assertEqual(self.request('/api/advance-clock', 'POST', raw=b'{')[0], 400)

    def test_empty_invalid_requests_and_reset(self):
        before = self.snapshot()
        for body in ({'ids': []}, {'ids': ['MISSING_IN_MIXPANEL'], 'actor': ''}):
            self.assertEqual(self.request('/api/approve', 'POST', body)[0], 400)
            self.assertEqual(self.snapshot(), before)
        self.assertEqual(self.request('/api/advance-clock', 'POST', {'ticks': 0})[0], 400)
        self.assertEqual(self.request('/api/advance-clock', 'POST', raw=b'{"ticks":Infinity}')[0], 400)
        self.assertEqual(self.snapshot(), before)
        self.request('/api/detect', 'POST', {})
        self.request('/api/verify', 'POST', {})
        status, history = self.request('/api/history')
        self.assertEqual(status, 200)
        self.assertEqual([x['kind'] for x in history['runs']], ['verify', 'detect'])
        for _ in range(22):
            self.assertEqual(self.request('/api/detect', 'POST', {})[0], 200)
        _, history = self.request('/api/history')
        self.assertEqual(len(history['runs']), 20)
        self.assertEqual(self.request('/api/reset', 'POST', {})[0], 200)
        self.assertEqual(mock.detect(mock.read())['gap'], {'USD': '21.97', 'EUR': '989.01'})

    def test_underlying_payload_change_stales_approval_without_partial_apply(self):
        cases = (
            ('MISSING_IN_MIXPANEL', 'source'),
            ('PRICE_MISMATCH', 'destination'),
        )
        for group_class, target in cases:
            with self.subTest(target=target):
                mock.seed()
                group = next(g for g in mock.preview(mock.read())['groups'] if g['class'] == group_class)
                self.request('/api/approve', 'POST', {'ids': [group_class], 'hashes': {group_class: group['approval_hash']}})
                state = mock.read()
                if target == 'source':
                    source = next(e for e in state['source'] if e['event_properties']['transaction_id'] == 'txn_missing_purchase')
                    source['event_properties']['original_transaction_id'] = 'changed-but-same-amount'
                else:
                    raw = next(row for row in state['mixpanel'] if row['payload']['properties']['transaction_id'] == 'txn_price')
                    raw['payload']['properties']['store'] = 'changed-but-same-amount'
                mock.save(state)
                before = self.snapshot()
                self.assertEqual(self.request('/api/apply', 'POST', {'ids': [group_class]})[0], 400)
                self.assertEqual(self.snapshot(), before)

    def test_mapping_change_to_a_planned_source_name_stales_approval(self):
        preview = mock.preview(mock.read())
        group = next(g for g in preview['groups'] if g['class'] == 'MISSING_IN_MIXPANEL')
        self.assertEqual(self.request('/api/approve', 'POST', {'ids': ['MISSING_IN_MIXPANEL'], 'hashes': {'MISSING_IN_MIXPANEL': group['approval_hash']}})[0], 200)
        self.assertEqual(self.request('/api/map', 'POST', {'event': 'subscription_refunded', 'cls': 'purchase'})[0], 200)
        before = self.snapshot()
        self.assertEqual(self.request('/api/apply', 'POST', {'ids': ['MISSING_IN_MIXPANEL']})[0], 400)
        self.assertEqual(self.snapshot(), before)

    def test_concurrent_http_clock_updates_are_serialized(self):
        def tick(_):
            return self.request('/api/advance-clock', 'POST', {'ticks': 1})[0]
        with ThreadPoolExecutor(max_workers=4) as pool:
            statuses = list(pool.map(tick, range(12)))
        self.assertEqual(statuses, [200] * 12)
        self.assertEqual(mock.read()['clock'], 12)


if __name__ == '__main__':
    unittest.main()
