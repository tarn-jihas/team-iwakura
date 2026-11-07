"""External acceptance: subprocesses and public HTTP only, never engine imports/DBs."""
from concurrent.futures import ThreadPoolExecutor
from collections import Counter
import hashlib
import hmac
import json
from pathlib import Path
import re
import sys
import subprocess
import tempfile
import threading
import time
import unittest
from urllib.error import HTTPError
from urllib.request import Request, urlopen

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from recovery_demo import Demo


class RecoveryAcceptance(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix='reconcile-uat-')
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
            self.fail(f'Demo startup failed: {exc}' + ('\n' + '\n'.join(logs) if logs else ''))

    def request(self, path, body=None, status=200, headers=None, timeout=15):
        payload = None if body is None else json.dumps(body).encode()
        request = Request(self.demo.urls['engine'] + '/api/recovery/' + path,
                          data=payload, headers={'Content-Type': 'application/json', **(headers or {})})
        try:
            response = urlopen(request, timeout=timeout)
        except HTTPError as error:
            response = error
        with response:
            result = json.load(response)
            if isinstance(status, int):
                self.assertEqual(response.status, status, (path, result))
            else:
                self.assertIn(response.status, status, (path, result))
        return result

    def wait_job(self, result, timeout=30):
        self.assertIn('job_id', result)
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            job = self.request('jobs/' + result['job_id'])
            self.assertNotEqual(job['status'], 'failed', job)
            if job['status'] == 'completed':
                return job
            time.sleep(0.05)
        self.fail('Job did not complete: ' + result['job_id'])

    def investigate(self, user='u00000'):
        self.wait_job(self.request('incidents', {'user_id': user}, status=202))
        return self.request('report')

    def plan(self, report, ids=None):
        ids = ids if ids is not None else [a['id'] for a in report['accounts'] if a['eligible']]
        self.assertTrue(ids, 'Expected at least one eligible account')
        return self.request('plans', {'ids': ids, 'incident_id': report['incident']['id']})

    def demo_control(self, body, timeout=15):
        return self.request('demo', body, timeout=timeout)

    def approve(self, plan):
        return self.request('approvals', {'plan_id': plan['id'], 'plan_hash': plan['plan_hash'],
                                          'actor': 'Independent UAT operator'})

    def execute(self, plan):
        self.wait_job(self.request('executions', {'plan_id': plan['id'], 'plan_hash': plan['plan_hash']}, status=202))
        return self.request('report')

    @staticmethod
    def action_details(plan, report):
        by_id = {action['id']: action for action in report['actions']}
        return [{'type': entry['type'], 'owner': entry['owner'],
                 'account_id': entry['account_id'],
                 'status': by_id.get(entry['id'], {}).get('status', 'missing'),
                 'result': by_id.get(entry['id'], {}).get('result')}
                for entry in plan['entries']]

    def collect(self, event, status=200, key=None):
        # Independent implementation of the published wire contract, not engine code.
        envelope = {'schema_version': 1, 'event': event, 'sent_at': int(time.time())}
        canonical = json.dumps(envelope, sort_keys=True, separators=(',', ':'), ensure_ascii=False, allow_nan=False).encode()
        secret = key or bytes.fromhex(self.demo.runtime.joinpath('collector.key').read_text().strip())
        signature = hmac.new(secret, canonical, hashlib.sha256).hexdigest()
        return self.request('collector', envelope, status, {'X-Reconcile-Signature': signature})

    def direct_lumen_export(self, user_id, timeout=2):
        request = Request(self.demo.urls['lumen'] + '/mock/lumen/export',
                          data=json.dumps({'user_id': user_id}).encode(),
                          headers={'Content-Type': 'application/json'})
        started = time.monotonic()
        try:
            response = urlopen(request, timeout=timeout)
        except HTTPError as error:
            response = error
        with response:
            return response.status, json.load(response), time.monotonic() - started

    def lumen_health(self):
        with urlopen(self.demo.urls['lumen'] + '/health', timeout=5) as response:
            self.assertEqual(response.status, 200)
            return json.load(response)

    def event(self, report, event_id='uat-late-event', occurred_at='2026-11-07T11:59:00Z'):
        manifest = report['manifest']
        return {'schema_version': 1, 'event_id': event_id, 'run_id': manifest['run_id'],
                'app': manifest['app'], 'environment': manifest['environment'],
                'app_user_id': 'u00099', 'kind': 'feature_access_decided',
                'occurred_at': occurred_at, 'correlation_id': 'uat-correlation',
                'source_event_id': event_id, 'details': {'feature': 'premium_export',
                'decision': 'allow', 'reason_code': 'allowed', 'projection_version': 'projection-v1',
                'cache_version': 'cache-v1', 'policy_version': 'policy-v1',
                'adapter_version': 'probe-v1', 'initiator': 'reconcile_probe'}}

    def test_100_account_activation_partial_recovery_then_bounded_retry(self):
        before = self.request('lumen/export', {'user_id': 'u00000'}, status=403)
        self.assertFalse(before['allowed'])
        report = self.investigate()
        summary = report['summary']
        self.assertEqual({k: summary[k] for k in ('in_scope', 'evaluated', 'confirmed', 'inconclusive')},
                         {'in_scope': 100, 'evaluated': 94, 'confirmed': 24, 'inconclusive': 6})
        self.assertEqual((summary['excluded'], summary['potential']), (70, 0))
        self.assertEqual(Counter(a['status'] for a in report['accounts']), {
            'confirmed': 24, 'healthy': 60, 'legitimate_denial': 6,
            'policy_denial': 4, 'inconclusive': 6})
        self.assertEqual({a['id'] for a in report['accounts']}, {f'u{i:05}' for i in range(100)})
        confirmed = {a['id'] for a in report['accounts'] if a['eligible']}
        self.assertEqual(confirmed, {f'u{i:05}' for i in range(24)})
        for account in report['accounts']:
            if account['status'] == 'confirmed':
                self.assertEqual(account['payment_state'], 'paid')
                self.assertFalse(account['adapty_active'])
                self.assertFalse(account['gate']['allowed'])
                self.assertFalse(account['catalog_mapped'])
        self.assertTrue(all(not a['eligible'] for a in report['accounts'] if a['status'] == 'inconclusive'))
        snapshot_id = report['incident']['snapshot_id']
        self.assertTrue(all(report['incident'][field] for field in
                            ('id', 'window_start', 'window_end', 'status', 'snapshot_id')))
        snapshot = self.request('snapshots/' + snapshot_id)
        plan = self.plan(report)
        self.approve(plan)
        report = self.execute(plan)
        recovery = report['recovery']
        self.assertEqual((recovery['activation_verified'], recovery['access_verified'], recovery['unresolved']),
                         (24, 23, 1), self.action_details(plan, report))
        self.assertEqual(recovery['target_count'], 24)
        self.assertEqual(recovery['unresolved_ids'], ['u00000'])
        self.assertEqual(recovery['latest_plan_id'], plan['id'])
        self.assertEqual(self.request('snapshots/' + snapshot_id), snapshot, 'Recovery mutated approved snapshot')
        unresolved = [a['id'] for a in report['accounts'] if a['eligible']]
        self.assertEqual(len(unresolved), 1)
        retry = self.plan(report, unresolved)
        self.assertNotEqual(retry['id'], plan['id'])
        self.assertEqual(retry['ids'], ['u00000'])
        self.assertFalse(any(entry['type'] in ('repair_catalog', 'validate_purchase')
                             for entry in retry['entries']), retry['entries'])
        self.assertEqual(sum(entry['type'] == 'resync_access' for entry in retry['entries']), 1)
        self.assertEqual(sum(entry['type'] == 'verify_gate' for entry in retry['entries']), 1)
        self.approve(retry)
        report = self.execute(retry)
        self.assertEqual((report['recovery']['activation_verified'], report['recovery']['access_verified'], report['recovery']['unresolved']), (24, 24, 0))
        self.assertEqual(report['recovery']['unresolved_ids'], [])
        self.assertEqual(report['recovery']['target_count'], 24)
        for user in sorted(confirmed):
            self.assertTrue(self.request('lumen/export', {'user_id': user})['allowed'])
        audit = self.request('audit')
        expected_action_ids = {entry['id'] for current_plan in (plan, retry)
                               for entry in current_plan['entries']}
        self.assertEqual({action['id'] for action in audit['actions']}, expected_action_ids)
        validate_ids = {entry['id'] for current_plan in (plan, retry)
                        for entry in current_plan['entries'] if entry['type'] == 'validate_purchase'}
        repair_ids = {entry['id'] for current_plan in (plan, retry)
                      for entry in current_plan['entries'] if entry['type'] == 'repair_catalog'}
        self.assertEqual(len(validate_ids), 24)
        self.assertEqual(len(repair_ids), 1)
        self.assertTrue(all(action['status'] in ('verified', 'failed') for action in audit['actions']))
        stripe_validation = next(entry for entry in plan['entries']
                                 if entry['type'] == 'validate_purchase' and entry['account_id'] == 'u00000')
        stripe_action = next(action for action in audit['actions'] if action['id'] == stripe_validation['id'])
        stripe_trace = stripe_action['result']['request_contract']
        self.assertEqual((stripe_trace['provider'], stripe_trace['method'], stripe_trace['path'],
                          stripe_trace['content_type']),
                         ('stripe', 'POST', '/api/v1/sdk/purchase/stripe/token/validate/',
                          'application/vnd.api+json'))
        self.assertEqual(stripe_trace['body']['data']['type'], 'stripe_receipt_validation_result')
        self.assertEqual(stripe_trace['body']['data']['attributes']['customer_user_id'], 'u00000')
        self.assertTrue(stripe_trace['body']['data']['attributes']['stripe_token'].startswith('sub_mock_'))
        serialized = json.dumps(audit)
        self.assertNotIn('collector.key', serialized)
        self.assertNotIn(self.demo.runtime.joinpath('collector.key').read_text().strip(), serialized)
        self.assertEqual(self.request('snapshots/' + snapshot_id), snapshot)

    def test_non_paid_lifecycles_never_enter_a_repair_plan(self):
        states = ('pending', 'trial', 'grace', 'manual', 'refunded', 'expired')
        changed = {f'u{i:05}': state for i, state in enumerate(states, 1)}
        for user_id, state in changed.items():
            self.demo_control({'action': 'fault', 'fault': 'lifecycle', 'user_id': user_id, 'state': state})
        report = self.investigate()
        rows = {account['id']: account for account in report['accounts']}
        for user_id in changed:
            self.assertFalse(rows[user_id]['eligible'], (user_id, changed[user_id], rows[user_id]))
            self.assertFalse(self.request('lumen/export', {'user_id': user_id}, status=403)['allowed'])
            self.request('plans', {'ids': [user_id], 'incident_id': report['incident']['id']}, status=409)
        self.assertEqual(report['recovery']['target_count'], 0)
        self.assertEqual(self.request('report')['recovery']['activation_verified'], 0)

    def test_different_paid_price_in_same_window_is_potential_and_not_writable(self):
        self.demo_control({'action': 'fault', 'fault': 'different_cause', 'user_id': 'u00001'})
        report = self.investigate()
        account = next(row for row in report['accounts'] if row['id'] == 'u00001')
        self.assertEqual(account['status'], 'potential')
        self.assertFalse(account['eligible'])
        self.assertGreaterEqual(report['summary']['potential'], 1)
        self.request('plans', {'ids': ['u00001'], 'incident_id': report['incident']['id']}, status=409)
        self.assertEqual(report['recovery']['target_count'], 0)
        self.assertFalse(self.request('lumen/export', {'user_id': 'u00001'}, status=403)['allowed'])

    def test_identity_mismatch_is_inconclusive_and_never_plan_eligible(self):
        self.demo_control({'action': 'fault', 'fault': 'identity', 'user_id': 'u00000', 'status': 'unknown'})
        report = self.investigate()
        account = next(row for row in report['accounts'] if row['id'] == 'u00000')
        self.assertEqual(account['status'], 'inconclusive')
        self.assertFalse(account['eligible'])
        self.request('plans', {'ids': ['u00000'], 'incident_id': report['incident']['id']}, status=409)
        self.assertEqual(report['recovery']['target_count'], 0)
        self.assertFalse(self.request('lumen/export', {'user_id': 'u00000'}, status=403)['allowed'])

    def test_plan_stales_as_a_whole_after_source_change_before_apply(self):
        report = self.investigate()
        selected = [a['id'] for a in report['accounts'] if a['eligible']]
        plan = self.plan(report, selected)
        self.approve(plan)
        self.demo_control({'action': 'fault', 'fault': 'source_stale', 'user_id': selected[0]})
        self.request('executions', {'plan_id': plan['id'], 'plan_hash': plan['plan_hash']}, status=409)
        after = self.request('report')
        self.assertEqual(after['actions'], [])
        self.assertEqual(after['recovery']['activation_verified'], 0)
        self.assertEqual(after['recovery']['access_verified'], 0)
        self.assertFalse(self.request('lumen/export', {'user_id': selected[-1]}, status=403)['allowed'])

    def test_lumen_self_heal_makes_approved_plan_stale_without_partial_writes(self):
        report = self.investigate()
        selected = [a['id'] for a in report['accounts'] if a['eligible']]
        plan = self.plan(report, selected)
        self.approve(plan)
        self.demo_control({'action': 'fault', 'fault': 'self_heal', 'user_id': selected[0]})
        self.request('executions', {'plan_id': plan['id'], 'plan_hash': plan['plan_hash']}, status=409)
        after = self.request('report')
        self.assertEqual(after['actions'], [])
        self.assertEqual(after['recovery']['activation_verified'], 0)
        self.assertEqual(after['recovery']['access_verified'], 0)
        self.assertFalse(self.request('lumen/export', {'user_id': selected[-1]}, status=403)['allowed'])

    def test_external_commit_timeout_uses_readback_and_retry_has_no_new_effects(self):
        report = self.investigate()
        user_id = 'u00000'
        plan = self.plan(report, [user_id])
        self.approve(plan)
        self.demo_control({'action': 'fault', 'fault': 'validation_timeout_after_commit', 'active': True})
        report = self.execute(plan)
        audit = self.request('audit')
        validation_id = next(entry['id'] for entry in plan['entries'] if entry['type'] == 'validate_purchase')
        validated = [row for row in audit['actions'] if row['id'] == validation_id]
        self.assertEqual(len(validated), 1, audit['actions'])
        self.assertEqual(validated[0]['status'], 'verified', validated[0])
        self.assertTrue(validated[0]['result']['accepted'])
        self.assertFalse(validated[0]['result'].get('duplicate', False), validated[0]['result'])
        self.assertEqual((report['recovery']['activation_verified'],
                          report['recovery']['access_verified'],
                          report['recovery']['unresolved']), (1, 0, 1))
        self.assertFalse(self.request('lumen/export', {'user_id': user_id}, status=403)['allowed'])
        actions = audit['actions']
        self.execute(plan)
        self.assertEqual(self.request('audit')['actions'], actions)
        retry = self.plan(report, [user_id])
        self.assertFalse(any(entry['type'] == 'validate_purchase' for entry in retry['entries']), retry['entries'])
        self.approve(retry)
        report = self.execute(retry)
        self.assertEqual((report['recovery']['activation_verified'],
                          report['recovery']['access_verified'],
                          report['recovery']['unresolved']), (1, 1, 0))
        self.assertTrue(self.request('lumen/export', {'user_id': user_id})['allowed'])
        audit = self.request('audit')
        self.assertEqual(sum(action['id'] == validation_id for action in audit['actions']), 1)

    def test_probe_outage_completes_without_claiming_probe_verification(self):
        report = self.investigate()
        user_id = 'u00001'
        plan = self.plan(report, [user_id])
        self.approve(plan)
        self.demo_control({'action': 'fault', 'fault': 'probe_outage', 'active': True})
        result = self.request('executions', {'plan_id': plan['id'], 'plan_hash': plan['plan_hash']}, status=202)
        job = self.wait_job(result)
        self.assertEqual(job['status'], 'completed', job)
        report = self.request('report')
        verify_id = next(entry['id'] for entry in plan['entries'] if entry['type'] == 'verify_gate')
        action = next(row for row in report['actions'] if row['id'] == verify_id)
        self.assertEqual(action['status'], 'unknown_outcome', action)
        self.assertEqual(action['result']['reason'], 'independent_gate_probe_unavailable')
        self.assertTrue(action['result']['readback_gate']['allowed'])
        self.assertEqual(action['next_step'], 'read_back_before_retry')
        self.assertEqual(report['recovery']['activation_verified'], 1)
        self.assertEqual(report['recovery']['access_verified'], 0)
        self.assertEqual(report['recovery']['unresolved_ids'], [user_id])
        self.assertTrue(self.request('lumen/export', {'user_id': user_id})['allowed'])

    def test_provider_429_retry_after_is_honored_without_duplicate_actions(self):
        report = self.investigate()
        plan = self.plan(report)
        self.approve(plan)
        self.demo_control({'action': 'fault', 'fault': 'rate_limit', 'active': True})
        started = time.monotonic()
        report = self.execute(plan)
        elapsed = time.monotonic() - started
        self.assertGreaterEqual(elapsed, 0.8, f'1-second Retry-After was not honored ({elapsed:.3f}s)')
        self.assertEqual((report['recovery']['activation_verified'],
                          report['recovery']['access_verified'],
                          report['recovery']['unresolved']), (24, 23, 1))
        audit = self.request('audit')
        self.assertEqual({action['id'] for action in audit['actions']},
                         {entry['id'] for entry in plan['entries']})
        validations = [entry for entry in plan['entries'] if entry['type'] == 'validate_purchase']
        validation_ids = {entry['id'] for entry in validations}
        validation_actions = [action for action in audit['actions'] if action['id'] in validation_ids]
        self.assertEqual(len(validation_actions), 24)
        self.assertTrue(all(action['status'] == 'verified' for action in validation_actions))

    def test_apple_and_google_wait_for_client_action_without_verified_recovery(self):
        for scenario in ('apple', 'google'):
            with self.subTest(scenario=scenario):
                self.demo_control({'action': 'reset', 'scenario': scenario, 'variant': 0})
                report = self.investigate()
                pending = [row for row in report['accounts'] if row['reason'] == 'awaiting_client_action']
                self.assertEqual(len(pending), 24, Counter(row['reason'] for row in report['accounts']))
                self.assertTrue(all(row['status'] == 'confirmed' and not row['eligible'] for row in pending))
                self.assertEqual(report['recovery']['target_count'], 0)
                self.assertEqual(report['recovery']['activation_verified'], 0)
                self.assertEqual(report['recovery']['access_verified'], 0)
                self.request('plans', {'ids': [pending[0]['id'],],
                                       'incident_id': report['incident']['id']}, status=409)

    def assert_provider_contract_reaches_gate(self, scenario):
        self.demo_control({'action': 'reset', 'scenario': scenario, 'variant': 0})
        report = self.investigate()
        plan = self.plan(report, ['u00000'])
        self.assertEqual(plan['provider'], scenario)
        self.approve(plan)
        report = self.execute(plan)
        self.assertEqual((report['recovery']['activation_verified'],
                          report['recovery']['access_verified'],
                          report['recovery']['unresolved']), (1, 0, 1),
                         (scenario, self.action_details(plan, report)))
        self.assertEqual(report['recovery']['unresolved_ids'], ['u00000'])
        retry = self.plan(report, ['u00000'])
        self.assertFalse(any(entry['type'] in ('repair_catalog', 'validate_purchase')
                             for entry in retry['entries']), retry['entries'])
        self.assertEqual(sum(entry['type'] == 'resync_access' for entry in retry['entries']), 1)
        self.assertEqual(sum(entry['type'] == 'verify_gate' for entry in retry['entries']), 1)
        self.approve(retry)
        report = self.execute(retry)
        self.assertEqual((report['recovery']['activation_verified'],
                          report['recovery']['access_verified'],
                          report['recovery']['unresolved']), (1, 1, 0),
                         (scenario, self.action_details(retry, report)))
        self.assertTrue(self.request('lumen/export', {'user_id': 'u00000'})['allowed'])
        validation = next(entry for entry in plan['entries'] if entry['type'] == 'validate_purchase')
        action = next(row for row in self.request('audit')['actions'] if row['id'] == validation['id'])
        trace = action['result']['request_contract']
        self.assertEqual(trace['provider'], scenario)
        if scenario == 'paddle':
            self.assertEqual((trace['method'], trace['path'], trace['content_type']),
                             ('POST', '/api/v2/server-side-api/purchase/paddle/token/validate/',
                              'application/json'))
            self.assertEqual(set(trace['body']), {'customer_user_id', 'paddle_token'})
            self.assertEqual(trace['body']['customer_user_id'], 'u00000')
            self.assertTrue(trace['body']['paddle_token'].startswith('txn_mock_'))
        else:
            self.assertEqual((trace['method'], trace['path'], trace['content_type']),
                             ('POST', '/custom-store/transactions/validate', 'application/json'))
            self.assertEqual(trace['body'], {'customer_user_id': 'u00000',
                                             'transaction_id': validation['target']['transaction_id']})

    def test_paddle_validation_uses_its_contract_and_reaches_the_gate(self):
        self.assert_provider_contract_reaches_gate('paddle')

    def test_custom_validation_uses_its_contract_and_reaches_the_gate(self):
        self.assert_provider_contract_reaches_gate('custom')

    def test_collector_outage_keeps_the_lumen_gate_fast_and_durable_queue_drains(self):
        self.demo_control({'action': 'fault', 'fault': 'collector_outage', 'active': True})
        event_ids, durations = set(), []
        for index in range(36):
            user_id, expected = ('u00000', 403) if index == 0 else ('u00024', 200)
            status, receipt, elapsed = self.direct_lumen_export(user_id)
            self.assertEqual(status, expected, receipt)
            self.assertEqual(receipt['allowed'], expected == 200)
            self.assertTrue(receipt['telemetry_queued'])
            event_ids.add(receipt['event_id'])
            durations.append(elapsed)
        self.assertEqual(len(event_ids), 36)
        self.assertLess(max(durations), 1.0, durations)
        time.sleep(1.2)
        outage_health = self.lumen_health()
        queued = outage_health['collector_coverage']
        self.assertEqual(set(queued), {'queued', 'accepted', 'dropped', 'failed', 'retries', 'last_error'})
        self.assertNotIn(self.demo.runtime.joinpath('collector.key').read_text().strip(),
                         json.dumps(outage_health))
        self.assertGreaterEqual(queued['queued'], len(event_ids), queued)
        self.assertGreaterEqual(queued['failed'], 1, queued)
        self.assertEqual(queued['dropped'], 0, queued)
        self.demo_control({'action': 'fault', 'fault': 'collector_outage', 'active': False})
        deadline = time.monotonic() + 10
        delivered = set()
        while time.monotonic() < deadline:
            audit = self.request('audit')
            delivered = {event['event_id'] for event in audit['collector_events']}
            if event_ids <= delivered:
                break
            time.sleep(0.05)
        self.assertTrue(event_ids <= delivered, f'Outbox did not drain; missing {len(event_ids-delivered)} events')
        coverage = self.lumen_health()['collector_coverage']
        self.assertEqual(coverage['queued'], 0, coverage)
        self.assertGreaterEqual(coverage['accepted'], len(event_ids), coverage)
        self.assertEqual(coverage['dropped'], 0, coverage)

    def test_reset_uses_new_scope_without_carrying_old_outbox_events(self):
        old_run_id = self.request('report')['manifest']['run_id']
        self.demo_control({'action': 'fault', 'fault': 'collector_outage', 'active': True})
        status, old_receipt, _ = self.direct_lumen_export('u00000')
        self.assertEqual(status, 403)
        self.assertTrue(old_receipt['telemetry_queued'])
        old_event_id = old_receipt['event_id']
        self.assertGreaterEqual(self.lumen_health()['collector_coverage']['queued'], 1)

        reset = self.demo_control({'action': 'reset', 'scenario': 'stripe', 'variant': 1})
        new_run_id = reset['manifest']['run_id']
        self.assertNotEqual(new_run_id, old_run_id)
        status, new_receipt, _ = self.direct_lumen_export('v1-u00064')
        self.assertEqual(status, 200)
        new_event_id = new_receipt['event_id']
        deadline = time.monotonic() + 10
        events = []
        while time.monotonic() < deadline:
            events = self.request('audit')['collector_events']
            if any(event['event_id'] == new_event_id for event in events):
                break
            time.sleep(0.05)
        self.assertIn(new_event_id, {event['event_id'] for event in events})
        self.assertNotIn(old_event_id, {event['event_id'] for event in events})
        self.assertTrue(all(event['run_id'] == new_run_id for event in events))
        coverage = self.lumen_health()['collector_coverage']
        self.assertEqual(coverage['queued'], 0, coverage)

    def test_approval_is_required_and_bad_accounts_cannot_enter_plan(self):
        report = self.investigate()
        self.assertFalse(report['coverage']['complete'], 'Missing historical telemetry must stay visible')
        self.assertTrue(report['coverage']['gaps'])
        self.assertEqual((report['summary']['in_scope'], report['summary']['evaluated'],
                          report['summary']['confirmed'], report['summary']['inconclusive']),
                         (100, 94, 24, 6))
        self.assertEqual({a['id'] for a in report['accounts'] if a['eligible']},
                         {f'u{i:05}' for i in range(24)})
        plan = self.plan(report)
        self.request('executions', {'plan_id': plan['id'], 'plan_hash': plan['plan_hash']}, status=409)
        for user in ('unknown-user', 'u00099', 'u00030'):
            self.request('plans', {'ids': [user], 'incident_id': report['incident']['id']}, status=409)
        self.request('approvals', {'plan_id': plan['id'], 'plan_hash': 'changed', 'actor': 'UAT'}, status=409)
        after = self.request('report')
        self.assertEqual(after['recovery']['access_verified'], 0)
        self.assertEqual(after['recovery']['activation_verified'], 0)

    def test_late_duplicate_client_events_cannot_create_payment_or_mutate_snapshot(self):
        report = self.investigate()
        snapshot_id = report['incident']['snapshot_id']
        snapshot = self.request('snapshots/' + snapshot_id)
        plan = self.plan(report)
        self.approve(plan)
        newer = self.event(report, 'uat-newer-event', '2026-11-07T12:00:02Z')
        older = self.event(report, 'uat-later-arrival-older-event', '2026-11-07T11:58:00Z')
        first = self.collect(newer)
        second = self.collect(older)
        duplicate = self.collect(older)
        self.assertFalse(first['duplicate'])
        self.assertFalse(second['duplicate'])
        self.assertTrue(duplicate['duplicate'])
        self.assertEqual(second['event_hash'], duplicate['event_hash'])
        self.collect({**older, 'details': {**older['details'], 'decision': 'deny'}}, status=(400, 409))
        self.wait_job(self.request('scans', {'incident_id': report['incident']['id']}, status=202))
        after = self.request('report')
        self.assertNotEqual(after['incident']['snapshot_id'], snapshot_id)
        self.assertEqual(self.request('snapshots/' + snapshot_id), snapshot)
        unknown = next(a for a in after['accounts'] if a['id'] == 'u00099')
        self.assertEqual(unknown['status'], 'inconclusive')
        self.assertFalse(unknown['eligible'])
        self.assertEqual(after['summary']['confirmed'], 24)

    def test_wrong_scope_key_and_unallowlisted_payment_metadata_are_rejected(self):
        report = self.investigate()
        event = self.event(report, 'uat-rejected')
        self.collect(event, status=(401, 403), key=b'wrong-key-for-independent-contract-test')
        for field, value in (('app', 'another-app'), ('environment', 'Sandbox'), ('run_id', 'another-run')):
            self.collect({**event, field: value}, status=(400, 403, 409))
        self.collect({**event, 'details': {**event['details'], 'provider_secret': 'not-a-real-secret'}}, status=(400, 403, 409))
        self.assertEqual(self.request('report')['recovery']['activation_verified'], 0)

    def test_approval_survives_restart_and_concurrent_apply_has_one_effect(self):
        report = self.investigate()
        plan = self.plan(report)
        self.approve(plan)
        self.demo.stop_role('engine')
        self.demo.stop_role('lumen')
        self.demo.stop_role('provider')
        self.demo.start_role('provider')
        self.demo.start_role('lumen')
        self.demo.start_role('engine')
        payload = {'plan_id': plan['id'], 'plan_hash': plan['plan_hash']}
        with ThreadPoolExecutor(max_workers=2) as pool:
            jobs = list(pool.map(lambda _: self.request('executions', payload, status=202), range(2)))
        self.assertEqual(len({job['job_id'] for job in jobs}), 1, jobs)
        for job in jobs:
            self.wait_job(job)
        report = self.request('report')
        self.assertEqual(report['recovery']['access_verified'], 23)
        audit = self.request('audit')
        self.assertEqual({action['id'] for action in audit['actions']},
                         {entry['id'] for entry in plan['entries']})
        self.demo.stop_role('engine')
        self.demo.start_role('engine')
        self.assertEqual(self.request('audit')['actions'], audit['actions'])
        self.assertEqual(self.request('report')['recovery']['access_verified'], 23)
        self.execute(plan)
        self.assertEqual(self.request('audit')['actions'], audit['actions'],
                         'Repeated execution appended duplicate action effects')

    def test_mobile_metadata_uses_sdk_and_late_event_creates_new_assessment(self):
        report = self.investigate()
        original = self.request('snapshots/' + report['incident']['snapshot_id'])
        mobile = {'event_id': 'mobile-late-1', 'user_id': 'u00099',
                  'kind': 'purchase_succeeded', 'occurred_at': '2026-11-07T11:58:00Z',
                  'details': {'transaction_id': 'device-only-reference', 'product_id': 'premium.annual'}}
        request = Request(self.demo.urls['lumen']+'/mobile/events', data=json.dumps(mobile).encode(),
                          headers={'Content-Type': 'application/json'})
        with urlopen(request, timeout=5) as response:
            receipt = json.load(response)
        self.assertFalse(receipt['trusted_payment_evidence'])
        deadline = time.monotonic()+8
        while time.monotonic() < deadline:
            after = self.request('report')
            if after['incident']['snapshot_id'] != original['id']:
                break
            time.sleep(0.05)
        self.assertNotEqual(after['incident']['snapshot_id'], original['id'])
        self.assertEqual(self.request('snapshots/'+original['id']), original)
        account = next(row for row in after['accounts'] if row['id'] == 'u00099')
        self.assertEqual(account['status'], 'inconclusive')
        self.assertFalse(account['eligible'])
        events = self.request('audit')['collector_events']
        observed = next(event for event in events if event['source_event_id'] == mobile['event_id'])
        self.assertEqual(observed['kind'], 'mobile_observation')
        self.assertEqual(observed['details']['transaction_id'], 'device-only-reference')

    def test_probe_retry_contains_only_probe_and_retains_prior_activation(self):
        report = self.investigate()
        plan = self.plan(report, ['u00001'])
        self.approve(plan)
        self.demo_control({'action':'fault','fault':'probe_outage','active':True})
        report = self.execute(plan)
        self.assertEqual(report['recovery']['access_verified'], 0)
        self.demo_control({'action':'fault','fault':'probe_outage','active':False})
        retry = self.plan(report, ['u00001'])
        self.assertEqual([entry['type'] for entry in retry['entries']], ['verify_gate'])
        self.approve(retry)
        report = self.execute(retry)
        self.assertEqual(report['recovery']['access_verified'], 1)
        self.assertEqual(report['recovery']['unresolved'], 0)

    def test_incident_reports_do_not_mix_targets_and_live_outage_is_visible(self):
        first = self.investigate()
        plan = self.plan(first, ['u00001'])
        self.approve(plan)
        self.execute(plan)
        second = self.investigate('u00002')
        self.assertNotEqual(second['incident']['id'], first['incident']['id'])
        self.assertEqual(second['recovery']['target_count'], 0)
        selected = self.request('report?incident_id='+first['incident']['id'])
        self.assertEqual(selected['recovery']['access_verified'], 1)
        self.demo_control({'action':'fault','fault':'provider_outage','active':True})
        selected = self.request('report?incident_id='+first['incident']['id'])
        self.assertFalse(selected['coverage']['complete'])
        self.assertTrue(any('provider' in gap for gap in selected['coverage']['gaps']))
        self.assertEqual(selected['recovery']['access_verified'], 0)

    def test_alternate_identifiers_do_not_change_the_detector_policy(self):
        self.demo_control({'action':'reset','scenario':'stripe','variant':1})
        report = self.investigate('v1-u00000')
        expected = {f'v1-u{i:05}' for i in range(100) if (i*37)%100 < 24}
        self.assertEqual({row['id'] for row in report['accounts'] if row['eligible']}, expected)
        self.assertEqual(report['summary']['in_scope'], 100)
        self.assertEqual(report['summary']['inconclusive'], 6)

    def test_offline_50k_import_scans_original_ids_without_payment_eligibility(self):
        role_by_pid = {process.pid: role for role, process in self.demo.processes.items()}
        peak_rss_kib = {}
        ps_errors = []
        stop_sampling = threading.Event()

        def sample_process_rss():
            pids = ','.join(str(pid) for pid in role_by_pid)
            while not stop_sampling.is_set():
                try:
                    result = subprocess.run(['ps', '-o', 'pid=,rss=', '-p', pids],
                                            capture_output=True, text=True, timeout=3, check=False)
                    for line in result.stdout.splitlines():
                        fields = line.split()
                        if len(fields) == 2:
                            role = role_by_pid[int(fields[0])]
                            peak_rss_kib[role] = max(peak_rss_kib.get(role, 0), int(fields[1]))
                    if result.returncode:
                        ps_errors.append('exit_'+str(result.returncode))
                        return
                except PermissionError:
                    ps_errors.append('permission_denied')
                    return
                except (OSError, subprocess.TimeoutExpired) as exc:
                    ps_errors.append(type(exc).__name__)
                    return
                stop_sampling.wait(0.03)

        previous_run_id = self.request('report')['manifest']['run_id']
        sampler = threading.Thread(target=sample_process_rss, daemon=True)
        started = time.monotonic()
        sampler.start()
        try:
            reset = self.demo_control({'action': 'reset', 'scenario': 'offline', 'variant': 0}, timeout=120)
            reset_seconds = time.monotonic() - started
            manifest = reset['manifest']
            del reset
            self.assertEqual(manifest['scenario'], 'offline')
            self.assertNotEqual(manifest['run_id'], previous_run_id)
            self.assertEqual(manifest['source_revision'], '77d39ed807a66bbebcf24fe67c42be4fc9ef4c82')
            self.assertEqual(manifest['provenance'], 'official_hackathon_synthetic')
            self.assertEqual(manifest['source_user_count'], 50000)
            self.assertEqual(manifest['source_transaction_count'], 29794)
            self.assertEqual(manifest['payment_verification'], 'unverified_synthetic_history')
            self.assertEqual(manifest['adapty_coverage'], 'not_observed')
            self.assertEqual(manifest['client_gate_coverage'], 'not_observed')

            scan_started = time.monotonic()
            incident = self.request('incidents', {'user_id': 'u00042'}, status=202, timeout=120)
            job = self.wait_job(incident, timeout=120)
            self.assertEqual(job['status'], 'completed', job)
            report = self.request('report', timeout=120)
            scan_report_seconds = time.monotonic() - scan_started
            self.assertEqual(report['incident']['trigger_user_id'], 'u00042')
            self.assertEqual({key: report['summary'][key] for key in
                              ('in_scope', 'evaluated', 'confirmed', 'inconclusive')},
                             {'in_scope': 50000, 'evaluated': 0, 'confirmed': 0, 'inconclusive': 50000})
            self.assertEqual((report['summary']['excluded'], report['summary']['potential']), (0, 0))
            ids = [row['id'] for row in report['accounts']]
            self.assertEqual(len(ids), 50000)
            self.assertEqual(len(set(ids)), 50000)
            self.assertEqual(set(ids), {f'u{i:05d}' for i in range(50000)})
            self.assertTrue(all(row['status'] == 'inconclusive' and not row['eligible']
                                and row['payment_state'] is None and row['adapty_active'] is None
                                and row['gate']['allowed'] is None
                                and not row.get('evidence_refs', []) for row in report['accounts']))
            self.assertEqual(report['recovery']['target_count'], 0)
            self.assertEqual(report['plans'], [])
            self.assertEqual(report['actions'], [])
            self.assertEqual(report['coverage']['provider_accounts'], 50000)
            self.assertEqual(report['coverage']['provider_evidence'], 0)
            self.assertEqual(report['coverage']['adapty_profiles'], 0)
            self.assertEqual(report['coverage']['lumen_accounts'], 0)
            source_history = report['coverage']['source_history']
            self.assertEqual(source_history['record_count'], 29794)
            self.assertEqual(source_history['provenance'], 'official_hackathon_synthetic')
            self.assertEqual(source_history['payment_verification'], 'unverified_synthetic_history')
            self.assertEqual(source_history['adapty_coverage'], 'not_observed')
            self.assertEqual(source_history['client_gate_coverage'], 'not_observed')
            self.assertRegex(source_history['record_hash'], r'^[0-9a-f]{64}$')
            snapshot_id = report['incident']['snapshot_id']
            incident_id = report['incident']['id']
            del ids, report

            snapshot_started = time.monotonic()
            snapshot = self.request('snapshots/' + snapshot_id, timeout=120)
            snapshot_seconds = time.monotonic() - snapshot_started
            self.assertEqual(snapshot['incident_id'], incident_id)
            self.assertEqual(snapshot['manifest']['run_id'], manifest['run_id'])
            self.assertEqual(snapshot['coverage']['source_history'], source_history)
            self.assertEqual(len(snapshot['accounts']), 50000)
            self.assertEqual(len(snapshot['provider_accounts']), 50000)
            self.assertEqual(snapshot['provider_evidence'], [])
            self.assertEqual(snapshot['adapty_profiles'], [])
            self.assertEqual(snapshot['lumen_accounts'], [])
            snapshot_hash = snapshot['snapshot_hash']
            signed_snapshot = {key: value for key, value in snapshot.items() if key != 'snapshot_hash'}
            computed_hash = hashlib.sha256(json.dumps(
                signed_snapshot, sort_keys=True, separators=(',', ':'),
                ensure_ascii=False, allow_nan=False).encode()).hexdigest()
            self.assertEqual(snapshot_hash, computed_hash)
            del signed_snapshot, snapshot

            self.request('plans', {'ids': ['u00042'], 'incident_id': incident_id}, status=409, timeout=60)
            after_plan = self.request('report', timeout=120)
            self.assertEqual(after_plan['recovery']['target_count'], 0)
            self.assertEqual(after_plan['plans'], [])
            self.assertEqual(after_plan['actions'], [])
            del after_plan
            snapshot_after = self.request('snapshots/' + snapshot_id, timeout=120)
            self.assertEqual(snapshot_after['snapshot_hash'], snapshot_hash)
            self.assertEqual(snapshot_after['coverage']['source_history'], source_history)
        finally:
            stop_sampling.set()
            sampler.join(timeout=5)
        self.assertFalse(sampler.is_alive(), 'RSS sampler did not stop')
        rss_unavailable = ps_errors[0] if ps_errors else None
        if not rss_unavailable and set(peak_rss_kib) != {'engine', 'provider', 'lumen'}:
            rss_unavailable = 'missing_child_process_sample'
        if not rss_unavailable:
            self.assertTrue(all(value > 0 for value in peak_rss_kib.values()), peak_rss_kib)
        elapsed_seconds = time.monotonic() - started
        print('offline_http_metrics=' + json.dumps({
            'reset_seconds': round(reset_seconds, 3),
            'scan_and_report_seconds': round(scan_report_seconds, 3),
            'snapshot_fetch_seconds': round(snapshot_seconds, 3),
            'elapsed_seconds': round(elapsed_seconds, 3),
            'peak_rss_kib_by_role': None if rss_unavailable else peak_rss_kib,
            'rss_unavailable': rss_unavailable,
        }, sort_keys=True), flush=True)


if __name__ == '__main__':
    unittest.main()
