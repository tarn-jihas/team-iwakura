"""Black-box HTTP acceptance for the isolated synthetic fulfillment flow."""
from __future__ import annotations

import hashlib
import hmac
import csv
from datetime import datetime, timedelta, timezone
from io import StringIO
from concurrent.futures import ThreadPoolExecutor, as_completed
import json
from pathlib import Path
import tempfile
import time
import traceback
import unittest
from urllib.error import HTTPError
from urllib.request import Request, urlopen
from urllib.parse import urlencode

from support.fulfillment_fixture import FulfillmentDemo


def public_request(base, path, body=None, timeout=10):
    raw = None if body is None else json.dumps(body).encode('utf-8')
    try:
        request = Request(base+path, data=raw,
            headers={'Content-Type': 'application/json'} if raw is not None else {})
        response = urlopen(request, timeout=timeout)
    except HTTPError as error:
        response = error
    with response:
        payload = response.read()
        content_type = response.headers.get('Content-Type', '')
        if 'json' in content_type:
            payload = json.loads(payload) if payload else None
        return response.status, payload


def wait_for(base, path, predicate, timeout=90, interval=.05):
    deadline = time.monotonic()+timeout
    latest = None
    while time.monotonic() < deadline:
        code, latest = public_request(base, path, timeout=10)
        if code == 200 and predicate(latest):
            return latest
        time.sleep(interval)
    raise AssertionError(f'Timed out waiting for public state: {latest!r}')


def paged_items(base, path, limit=50):
    cursor = '0'
    rows = []
    while cursor is not None:
        separator = '&' if '?' in path else '?'
        code, page = public_request(base, path+separator+
            urlencode({'cursor': cursor, 'limit': limit}))
        if code != 200:
            raise AssertionError(f'Public page request failed: {code} {page!r}')
        rows.extend(page['items'] if 'items' in page else page['incidents'])
        pagination = page['pagination']
        cursor = pagination['next_cursor']
    return rows


def canonical(value):
    return json.dumps(value, sort_keys=True, separators=(',', ':'),
                      ensure_ascii=False, allow_nan=False).encode('utf-8')


class FulfillmentPublicHTTPAcceptance(unittest.TestCase):
    def test_independent_fixture_bootstraps_100_synthetic_profiles(self):
        with tempfile.TemporaryDirectory(prefix='reconcile-fulfillment-uat-') as root:
            with FulfillmentDemo(Path(root)) as demo:
                status_code, status = public_request(
                    demo.urls['engine'], '/api/recovery/live/status')
                self.assertEqual(status_code, 200, status)
                self.assertEqual(status['account_count'], 100)
                self.assertEqual(status['active_count'], 100)
                self.assertTrue(status['readiness']['all_profiles_observed'])
                self.assertTrue(status['readiness']['identity_scope_match'])
                self.assertEqual(status['provenance'], 'synthetic_test_fixture')
                self.assertEqual(status['payment_verification'], 'not_independently_verified')

                status_code, monitor = public_request(
                    demo.urls['engine'], '/api/recovery/monitor?cursor=0&limit=50')
                self.assertEqual(status_code, 200, monitor)
                self.assertEqual(monitor['mode'], 'LOCAL_ADAPTY_FIXTURE')
                self.assertEqual(monitor['automation']['enabled'], True)
                self.assertEqual(monitor['connection']['total_accounts'], 100)
                self.assertEqual(monitor['incidents'], [])

                page = wait_for(demo.urls['engine'],
                    '/api/recovery/fulfillments?cursor=0&limit=100',
                    lambda value: value['pagination']['total'] == 100
                        and value['coverage'].get('source_fresh') is True
                        and value['coverage'].get('fulfillments', {}).get(
                            'verified_application', 0) >= 1)
                healthy = next(row for row in page['items']
                               if row['status'] == 'verified_application')
                self.assertTrue(healthy['telemetry_gap'])
                user_id = healthy['key']['customer_id']
                _, before_report = public_request(demo.urls['engine'], '/api/recovery/report')
                before = next(row for row in before_report['accounts'] if row['id'] == user_id)
                code, refresh = public_request(demo.urls['engine'], '/api/recovery/live/refresh', {})
                self.assertEqual(code, 200, refresh)
                _, after_report = public_request(demo.urls['engine'], '/api/recovery/report')
                after = next(row for row in after_report['accounts'] if row['id'] == user_id)
                self.assertEqual(after['projection_revision'], before['projection_revision'])
                self.assertTrue(after['gate']['allowed'])

    def test_source_observed_bootstrap_recovers_23_and_leaves_one_unresolved(self):
        with tempfile.TemporaryDirectory(prefix='reconcile-fulfillment-bootstrap-') as root:
            with FulfillmentDemo(Path(root), live_bootstrap_pending=True) as demo:
                base = demo.urls['engine']
                code, initial = public_request(base, '/api/recovery/simulation')
                self.assertEqual(code, 200, initial)
                self.assertTrue(initial['bootstrap_required'])
                self.assertEqual(initial['bootstrap_status'], 'not_started')
                code, monitor = public_request(base, '/api/recovery/monitor')
                self.assertEqual(code, 200, monitor)
                self.assertEqual(monitor['incidents'], [])
                self.assertEqual(monitor['summary']['incidents'], 0)
                source_before = demo.source_fixture_status()['source_requests_total']

                operation = {'action': 'bootstrap', 'operation_key': 'uat-bootstrap-once'}
                code, accepted = public_request(base, '/api/recovery/simulation', operation)
                self.assertIn(code, (200, 202), accepted)
                code, duplicate = public_request(base, '/api/recovery/simulation', operation)
                self.assertIn(code, (200, 202), duplicate)
                self.assertEqual(accepted['simulation_id'], duplicate['simulation_id'])
                self.assertTrue(duplicate['duplicate'])

                deadline = time.monotonic()+90
                final = None
                incident_visible_before_completion = False
                while time.monotonic() < deadline:
                    code, final = public_request(base, '/api/recovery/simulation')
                    self.assertEqual(code, 200, final)
                    if (final['bootstrap_status'] == 'failed'
                            or final['bootstrap_status'] == 'completed' and 'result' in final):
                        break
                    _, in_progress = public_request(base,
                        '/api/recovery/monitor?cursor=0&limit=200')
                    cohort = next((incident for incident in in_progress['incidents']
                        if incident['affected_accounts'] == 24), None)
                    if cohort:
                        incident_visible_before_completion = True
                    time.sleep(.05)
                self.assertIsNotNone(final)
                if final['bootstrap_status'] != 'completed':
                    _, job = public_request(base, '/api/recovery/jobs/'+accepted['job_id'])
                    _, monitor = public_request(base, '/api/recovery/monitor?cursor=0&limit=200')
                    _, fulfillments = public_request(base,
                        '/api/recovery/fulfillments?cursor=0&limit=200')
                    reason_counts = {}
                    for item in fulfillments.get('items', []):
                        key = (item['status'], item['reason'])
                        reason_counts[key] = reason_counts.get(key, 0)+1
                    source = demo.source_fixture_status()
                    source_counts = {key: source[key] for key in (
                        'source_requests_total', 'fixture_profile_requests_total',
                        'fixture_refresh_requests_total')}
                    self.fail(f'Bootstrap failed: public={final!r}, job={job!r}, '
                        f'monitor_summary={monitor.get("summary")!r}, '
                        f'incident_statuses={[row["status"] for row in monitor.get("incidents", [])]!r}, '
                        f'fulfillment_coverage={fulfillments.get("coverage")!r}, '
                        f'fulfillment_reason_counts={reason_counts!r}, '
                        f'synthetic_source_counts={source_counts!r}')
                result = final['result']
                self.assertEqual({key: result[key] for key in (
                    'source_observed', 'handler_completed', 'handler_failed', 'repaired',
                    'unresolved', 'customer_denials', 'manual_incidents')}, {
                    'source_observed': 100, 'handler_completed': 76, 'handler_failed': 24,
                    'repaired': 23, 'unresolved': 1, 'customer_denials': 0,
                    'manual_incidents': 0})
                source = demo.source_fixture_status()
                self.assertGreater(result['source_calls'], 0)
                self.assertEqual(result['source_calls'],
                    source['source_requests_total']-source_before)
                self.assertGreater(source['fixture_refresh_requests_total'], 0)
                self.assertGreater(source['fixture_profile_requests_total'], 0)
                incidents = paged_items(base, '/api/recovery/monitor', limit=7)
                fulfillment_rows = paged_items(base, '/api/recovery/fulfillments', limit=13)
                status_counts = {status: sum(item['status'] == status for item in incidents)
                                 for status in sorted({item['status'] for item in incidents})}
                incident_refs = [(item['key'].get('customer_id'), item['status'],
                                  item['incident_id'], item['trace_ref'])
                                 for item in fulfillment_rows
                                 if item['incident_id'] or item['status'] != 'verified_application']
                self.assertEqual(len(incidents), 1,
                    f'public incidents={status_counts}; simulation={final!r}; '
                    f'fulfillment_incident_refs={incident_refs!r}')
                self.assertTrue(incident_visible_before_completion,
                    f'The unresolved cohort was not visible before completion; '
                    f'public incidents={status_counts}; simulation={final!r}; '
                    f'fulfillment_incident_refs={incident_refs!r}')
                self.assertEqual(incidents[0]['status'], 'unresolved')
                self.assertEqual(sum(item['affected_accounts'] for item in incidents), 24)
                self.assertEqual(sum(item['repaired_accounts'] for item in incidents), 23)
                self.assertEqual(sum(item['source_provenance'] == 'synthetic_test_fixture'
                                     for item in incidents), 1)
                self.assertEqual(sum(item['payment_verification'] == 'not_independently_verified'
                                     for item in incidents), 1)
                self.assertEqual(final['bootstrap_required'], False)

                self.assertEqual(len(fulfillment_rows), 100)
                self.assertEqual(len({item['key']['transaction_id'] for item in fulfillment_rows}), 100)
                self.assertEqual(sum(item['application']['gate']['allowed'] is True
                                     for item in fulfillment_rows), 99)
                self.assertEqual(sum(item['application']['gate']['allowed'] is False
                                     for item in fulfillment_rows), 1)
                for item in fulfillment_rows:
                    self.assertTrue(item['stages']['source_recorded'])
                    if item['status'] == 'verified_application':
                        self.assertTrue(item['stages']['application_applied'])
                        self.assertTrue(item['stages']['access_verified'])
                unresolved = next(item for item in fulfillment_rows
                                  if item['status'] != 'verified_application')
                self.assertEqual(unresolved['status'], 'discrepancy')
                self.assertEqual(unresolved['reason'], 'handler_processing_failed')
                self.assertFalse(unresolved['stages']['application_applied'])

                report_code, report = public_request(base, '/api/recovery/report')
                self.assertEqual(report_code, 200, report)
                self.assertEqual(len(report['accounts']), 100)
                self.assertEqual(sum(account['gate']['allowed'] is True
                                     for account in report['accounts']), 99)
                self.assertEqual(sum(account['gate']['allowed'] is False
                                     for account in report['accounts']), 1)

                telemetry_before = public_request(base,
                    '/api/recovery/monitor?cursor=0&limit=1')[1]['telemetry']
                if telemetry_before['queued']:
                    gap_rows = [item for item in fulfillment_rows
                        if item['status'] == 'verified_application' and item['telemetry_gap']]
                    self.assertTrue(gap_rows,
                        'Queued SDK receipts must be visible as fulfillment telemetry gaps')
                    telemetry_deadline = time.monotonic()+15
                    while telemetry_before['queued'] and time.monotonic() < telemetry_deadline:
                        time.sleep(.1)
                        telemetry_before = public_request(base,
                            '/api/recovery/monitor?cursor=0&limit=1')[1]['telemetry']
                self.assertEqual(telemetry_before['queued'], 0,
                    'The healthy local collector did not drain the SDK outbox within 15 seconds')
                self.assertEqual(telemetry_before['dropped'], 0)
                fulfillment_rows = paged_items(base,
                    '/api/recovery/fulfillments', limit=13)
                for incident in incidents:
                    trace_code, trace = public_request(base,
                        f"/api/recovery/incidents/{incident['id']}/trace")
                    self.assertEqual(trace_code, 200, trace)
                    self.assertTrue(trace['traces'])
                    self.assertEqual(len({row['user_id'] for row in trace['traces']}), 24)
                    user_by_transaction = {item['key']['transaction_id']:
                        item['key']['customer_id'] for item in trace['expectations']}
                    receipt_users = {user_by_transaction[receipt['transaction_id']]
                        for receipt in trace['processing_receipts']
                        if receipt['transaction_id'] in user_by_transaction}
                    repaired_users = {item['key']['customer_id']
                        for item in trace['expectations']
                        if item['status'] == 'verified_application'}
                    self.assertEqual(len(repaired_users), 23)
                    self.assertEqual(repaired_users & receipt_users, repaired_users,
                        f'Expected receipts for the 23 repaired accounts after collector drain; '
                        f'telemetry={telemetry_before!r}; raw_receipts={len(trace["processing_receipts"])}, '
                        f'unique_receipt_users={len(receipt_users)}; '
                        f'gap_users={sum(item["telemetry_gap"] for item in fulfillment_rows)}')
                    self.assertTrue(all(receipt['steps']
                                        for receipt in trace['processing_receipts']))
                    self.assertEqual(trace['provenance']['provenance'], 'synthetic_test_fixture')
                    self.assertNotIn('handler_precommit', json.dumps(trace))
                    self.assertNotIn('permanent_handler', json.dumps(trace))
                    self.assertFalse(any(key.lower() in ('api_key', 'secret', 'password')
                                         for row in trace['traces']
                                         for key in row))

                self.assertNotIn('handler_precommit', json.dumps(incidents))
                self.assertNotIn('permanent_handler', json.dumps(incidents))
                selected_incident = incidents[0]
                permanent_user = unresolved['key']['customer_id']
                denial_trace_code, denial_trace_before = public_request(base,
                    f"/api/recovery/incidents/{selected_incident['id']}/trace")
                self.assertEqual(denial_trace_code, 200, denial_trace_before)
                _, denial_audit_before = public_request(base,
                    '/api/recovery/audit?'+urlencode({'incident_id': selected_incident['id']}))
                _, denial_monitor_before = public_request(base,
                    '/api/recovery/monitor?cursor=0&limit=200')
                coverage_before = public_request(demo.urls['lumen'],
                    '/_demo/collector/coverage')[1]
                self.assertEqual(coverage_before['queued'], 0)
                self.assertFalse(denial_audit_before['incident']['status'] == 'repaired')
                self.assertFalse(next(account for account in report['accounts']
                    if account['id'] == permanent_user)['gate']['allowed'])
                for expected_accepts in (coverage_before['accepted']+1,
                                         coverage_before['accepted']+2):
                    denial_code, denial = public_request(demo.urls['lumen'],
                        '/premium/export', {'user_id': permanent_user})
                    self.assertEqual(denial_code, 403, denial)
                    self.assertFalse(denial['allowed'])
                    self.assertTrue(denial['event_id'])
                    self.assertTrue(denial['telemetry_queued'])
                    coverage = wait_for(demo.urls['lumen'], '/_demo/collector/coverage',
                        lambda value: value['accepted'] >= expected_accepts
                            and value['queued'] == 0, timeout=30)
                    self.assertEqual(coverage['dropped'], 0)
                    _, denial_audit_after = public_request(base,
                        '/api/recovery/audit?'+urlencode({'incident_id': selected_incident['id']}))
                    _, denial_monitor_after = public_request(base,
                        '/api/recovery/monitor?cursor=0&limit=200')
                    self.assertEqual(denial_monitor_after['pagination']['total'],
                                     denial_monitor_before['pagination']['total'])
                    self.assertEqual({row['id'] for row in denial_monitor_after['incidents']},
                        {row['id'] for row in denial_monitor_before['incidents']})
                    self.assertEqual(denial_audit_after['incident'],
                                     denial_audit_before['incident'])
                    for key in ('recovery', 'plans', 'actions'):
                        self.assertEqual(denial_audit_after[key], denial_audit_before[key],
                            f'Duplicate customer denial changed open incident {key}')
                    self.assertEqual({job['id'] for job in denial_audit_after['jobs']},
                                     {job['id'] for job in denial_audit_before['jobs']},
                        'An open partial denial cohort should not launch a duplicate scan/recovery job')
                    denial_events = [event for event in denial_audit_after['collector_events']
                        if event['event_id'] == denial['event_id']]
                    self.assertEqual(len(denial_events), 1,
                        'Wait for the SDK collector assessment of the public denial event')
                    denial_trace_code, denial_trace_after = public_request(base,
                        f"/api/recovery/incidents/{selected_incident['id']}/trace")
                    self.assertEqual(denial_trace_code, 200, denial_trace_after)
                    for key in ('incident', 'expectations', 'traces', 'processing_receipts',
                                'activity', 'provenance'):
                        self.assertEqual(denial_trace_after[key], denial_trace_before[key],
                            f'Duplicate customer denial changed trace history field {key}')
                detected = datetime.fromisoformat(selected_incident['detected_at'].replace(
                    'Z', '+00:00')).astimezone(timezone.utc)
                start = detected.isoformat(timespec='microseconds').replace('+00:00', 'Z')
                end = (detected+timedelta(seconds=1)).isoformat(
                    timespec='microseconds').replace('+00:00', 'Z')
                params = urlencode({'from': start, 'to': end, 'format': 'json'})
                json_code, exported_json = public_request(base, '/api/recovery/export?'+params)
                self.assertEqual(json_code, 200, exported_json)
                self.assertEqual(exported_json['period']['interval'], '[from,to)')
                self.assertEqual(exported_json['period']['from'], start)
                self.assertEqual(exported_json['period']['to'], end)
                self.assertIn(selected_incident['id'],
                    {row['id'] for row in exported_json['incidents']})
                self.assertEqual(exported_json['incident_count'], len(exported_json['incidents']))
                self.assertEqual(exported_json['incidents'][0]['summary'], {
                    'affected_accounts': 24, 'repaired_accounts': 23,
                    'unresolved_accounts': 1})
                exported_incident = exported_json['incidents'][0]
                selected_times = [exported_incident['detected_at']]
                selected_times.extend(value for action in exported_incident['actions']
                    for value in (action.get('started_at'), action.get('finished_at')) if value)
                selected_times.extend(item['occurred_at']
                    for item in exported_incident['activity'])
                selected_times.extend(decision['updated_at']
                    for decision in exported_incident['automatic_recovery'])
                first_selected_at = min(datetime.fromisoformat(value.replace('Z', '+00:00'))
                                        for value in selected_times)
                excluded_start = (first_selected_at-timedelta(seconds=1)).isoformat(
                    timespec='microseconds').replace('+00:00', 'Z')
                excluded_to = first_selected_at.isoformat(
                    timespec='microseconds').replace('+00:00', 'Z')
                exclude_params = urlencode({'from': excluded_start, 'to': excluded_to,
                    'format': 'json'})
                _, excluded = public_request(base, '/api/recovery/export?'+exclude_params)
                self.assertNotIn(selected_incident['id'],
                    {row['id'] for row in excluded['incidents']})

                csv_params = urlencode({'from': start, 'to': end, 'format': 'csv'})
                csv_code, exported_csv = public_request(base, '/api/recovery/export?'+csv_params)
                self.assertEqual(csv_code, 200, exported_csv)
                csv_rows = list(csv.DictReader(StringIO(exported_csv.decode('utf-8'))))
                csv_incidents = {row['incident_id'] for row in csv_rows
                                 if row['record_type'] == 'incident'}
                self.assertEqual(csv_incidents,
                    {row['id'] for row in exported_json['incidents']})
                self.assertIn(selected_incident['id'], csv_incidents)
                csv_incident = next(row for row in csv_rows
                    if row['record_type'] == 'incident'
                        and row['incident_id'] == selected_incident['id'])
                self.assertEqual({key: int(csv_incident[key]) for key in (
                    'affected_accounts', 'repaired_accounts', 'unresolved_accounts')}, {
                    'affected_accounts': 24, 'repaired_accounts': 23,
                    'unresolved_accounts': 1})

                old_trace_code, old_trace = public_request(base,
                    f"/api/recovery/incidents/{selected_incident['id']}/trace")
                self.assertEqual(old_trace_code, 200, old_trace)
                renewal_user = demo.run_prefix+'-000'
                old_expiry = next(row for row in report['accounts']
                                  if row['id'] == renewal_user)['entitlement_evidence']['expires_at']
                new_expiry = (datetime.fromisoformat(old_expiry.replace('Z', '+00:00'))
                              + timedelta(days=1)).isoformat(
                                  timespec='seconds').replace('+00:00', 'Z')
                demo.update_source_profile(renewal_user, expires_at=new_expiry)
                _, drift_report = public_request(base, '/api/recovery/report')
                drift_account = next(row for row in drift_report['accounts']
                                     if row['id'] == renewal_user)
                original_account = next(row for row in report['accounts']
                                        if row['id'] == renewal_user)
                self.assertTrue(drift_account['gate']['allowed'])
                self.assertEqual(drift_account['projection_revision'],
                                 original_account['projection_revision'])
                refresh_code, refresh = public_request(base,
                    '/api/recovery/live/refresh', {})
                self.assertEqual(refresh_code, 200, refresh)
                self.assertEqual(refresh['observed'], 100)
                fulfillment_rows = paged_items(base,
                    '/api/recovery/fulfillments', limit=50)
                drift_row = next(row for row in fulfillment_rows
                    if row['key']['customer_id'] == renewal_user
                        and row['source_period']['expires_at'] == new_expiry)
                self.assertEqual(drift_row['status'], 'awaiting_application')
                self.assertEqual(drift_row['reason'], 'normal_processing_window')
                self.assertIsNone(drift_row['incident_id'])
                self.assertTrue(drift_row['application']['gate']['allowed'])
                self.assertEqual(drift_row['application']['projection_revision'],
                                 original_account['projection_revision'])
                _, accelerated = public_request(base, '/api/recovery/simulation', {
                    'action': 'configure', 'clock_scale': 1000})
                self.assertEqual(accelerated['clock_scale'], 1000)
                self.assertTrue(accelerated['demo_only'])
                refresh_code, refresh = public_request(base,
                    '/api/recovery/live/refresh', {})
                self.assertEqual(refresh_code, 200, refresh)
                self.assertEqual(refresh['observed'], 100)
                drift_page = wait_for(base,
                    '/api/recovery/fulfillments?cursor=0&limit=200',
                    lambda page: any(row['key']['customer_id'] == renewal_user
                        and row['source_period']['expires_at'] == new_expiry
                        and row['status'] == 'discrepancy' for row in page['items']))
                drift_row = next(row for row in drift_page['items']
                    if row['key']['customer_id'] == renewal_user
                        and row['source_period']['expires_at'] == new_expiry)
                self.assertEqual(drift_row['status'], 'discrepancy')
                self.assertEqual(drift_row['reason'], 'projection_mismatch')
                self.assertTrue(drift_row['incident_id'])
                renewal_incident_id = drift_row['incident_id']
                renewal_monitor = wait_for(base,
                    '/api/recovery/monitor?cursor=0&limit=200&status=repaired',
                    lambda page: any(row['id'] == renewal_incident_id
                                     for row in page['incidents']))
                renewal_incident = next(row for row in renewal_monitor['incidents']
                    if row['id'] == renewal_incident_id)
                self.assertEqual(renewal_incident['title'], 'Lumen access period differs from Adapty')
                self.assertIn('even though access is still allowed', renewal_incident['description'])
                _, renewal_audit = public_request(base,
                    '/api/recovery/audit?'+urlencode({'incident_id': renewal_incident_id}))
                snapshot_code, renewal_snapshot = public_request(base,
                    '/api/recovery/snapshots/'+renewal_audit['incident']['snapshot_id'])
                self.assertEqual(snapshot_code, 200, renewal_snapshot)
                drift_snapshot_account = next(account for account in renewal_snapshot['accounts']
                    if account['id'] == renewal_user)
                self.assertTrue(drift_snapshot_account['gate']['allowed'])
                drift_trace_code, drift_trace = public_request(base,
                    f'/api/recovery/incidents/{renewal_incident_id}/trace')
                self.assertEqual(drift_trace_code, 200, drift_trace)
                drift_steps = [step for row in drift_trace['traces']
                    if row['user_id'] == renewal_user for step in row['steps']]
                self.assertTrue(any(step['name'] == 'projection_readback'
                                    and step['result'] == 'mismatched' for step in drift_steps))
                self.assertTrue(any(step['name'] == 'gate_readback'
                                    and step['result'] == 'allowed' for step in drift_steps))
                old_trace_after_code, old_trace_after = public_request(base,
                    f"/api/recovery/incidents/{selected_incident['id']}/trace")
                self.assertEqual(old_trace_after_code, 200, old_trace_after)
                for key in ('incident', 'expectations', 'traces', 'processing_receipts',
                            'activity', 'provenance'):
                    self.assertEqual(old_trace_after[key], old_trace[key],
                        f'New renewal episode changed immutable incident trace field {key}')

    def test_wrong_source_scope_does_not_write_after_a_successful_repair_control(self):
        variants = (('source_environment', 'Sandbox'), ('store', 'unsupported_store'),
                    ('app_id', 'wrong-app'), ('profile_id', 'wrong-profile'))
        for field, value in variants:
            with self.subTest(field=field), tempfile.TemporaryDirectory(
                    prefix=f'reconcile-scope-{field}-') as root:
                with FulfillmentDemo(Path(root), live_bootstrap_pending=True) as demo:
                    base = demo.urls['engine']
                    code, accepted = public_request(base, '/api/recovery/simulation', {
                        'action': 'bootstrap', 'operation_key': 'uat-scope-bootstrap'})
                    self.assertIn(code, (200, 202), accepted)
                    bootstrapped = wait_for(base, '/api/recovery/simulation',
                        lambda state: state['bootstrap_status'] == 'failed'
                            or state['bootstrap_status'] == 'completed' and 'result' in state)
                    self.assertEqual(bootstrapped['bootstrap_status'], 'completed', bootstrapped)
                    self.assertEqual(bootstrapped['result']['repaired'], 23)
                    user_id = demo.run_prefix+'-099'
                    _, before_report = public_request(base, '/api/recovery/report')
                    before = next(row for row in before_report['accounts']
                                  if row['id'] == user_id)
                    self.assertTrue(before['gate']['allowed'])
                    source_reads_before = demo.source_fixture_status()['source_requests_total']
                    demo.update_source_profile(user_id, **{field: value})
                    code, refresh = public_request(base, '/api/recovery/live/refresh', {})
                    self.assertEqual(code, 200, refresh)
                    self.assertEqual(refresh['observed'], 100)
                    self.assertGreater(demo.source_fixture_status()['source_requests_total'],
                                       source_reads_before)
                    _, after_report = public_request(base, '/api/recovery/report')
                    after = next(row for row in after_report['accounts']
                                 if row['id'] == user_id)
                    self.assertEqual(after['projection_revision'], before['projection_revision'],
                        f'{field} mismatch unexpectedly changed the projection')
                    self.assertEqual(after['gate'], before['gate'],
                        f'{field} mismatch unexpectedly changed the Lumen gate')
                    self.assertEqual(after['identity_revision'], before['identity_revision'])
                    self.assertEqual(after['policy_revision'], before['policy_revision'])
                    fulfillment_rows = paged_items(base,
                        '/api/recovery/fulfillments', limit=200)
                    rejected = [row for row in fulfillment_rows
                        if row['key'].get('customer_id') == user_id
                            and row['status'] == 'inconclusive']
                    self.assertTrue(rejected,
                        f'{field} mismatch produced no public rejection/inconclusive record')
                    accepted_reasons = {'identity_scope_mismatch', 'source_scope_mismatch',
                        'source_environment_mismatch', 'store_scope_mismatch'}
                    self.assertTrue(any(row['reason'] in accepted_reasons for row in rejected),
                        f'{field} mismatch reasons were {[row["reason"] for row in rejected]!r}')

    def test_secret_trace_metadata_is_rejected_without_persisting_it(self):
        with tempfile.TemporaryDirectory(prefix='reconcile-secret-trace-') as root:
            with FulfillmentDemo(Path(root)) as demo:
                base = demo.urls['engine']
                _, before_monitor = public_request(base, '/api/recovery/monitor')
                _, before_fulfillments = public_request(base,
                    '/api/recovery/fulfillments?cursor=0&limit=1')
                now = time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime())
                secret = 'fixture-only-rejected-api-key'
                event = {'schema_version': 2, 'event_id': 'secret-trace-rejected',
                    'run_id': demo.run_id, 'app': '46a573aa-8c90-4b4b-ba72-2349ae9fb030',
                    'environment': 'hackathon_seed',
                    'app_user_id': demo.run_prefix+'-000', 'kind': 'handler_completed',
                    'occurred_at': now, 'correlation_id': 'secret-trace-id',
                    'source_event_id': 'secret-trace-source',
                    'details': {'event_type': 'source_entitlement_observed',
                        'handler_version': 'lumen-handler-v2', 'received_at': now,
                        'processed_at': now, 'outcome': 'completed',
                        'reason_code': 'handler_completed',
                        'projection_version': 'lumen-handler-v2',
                        'adapter_version': 'adapty-profile-read-v1',
                        'source_hash': 'a'*64, 'processing_id': 'secret-trace-processing',
                        'trace_id': 'secret-trace-id', 'transaction_id': 'synthetic-transaction',
                        'steps': [], 'revisions': {'identity': 1, 'policy': 1,
                            'projection': 1, 'cache': 1}, 'api_key': secret}}
                envelope = {'schema_version': 2, 'event': event, 'sent_at': int(time.time())}
                signature = hmac.new(demo.key, canonical(envelope), hashlib.sha256).hexdigest()
                request = Request(base+'/api/recovery/collector', data=canonical(envelope),
                    headers={'Content-Type': 'application/json',
                             'X-Reconcile-Signature': signature})
                try:
                    response = urlopen(request, timeout=10)
                except HTTPError as error:
                    response = error
                with response:
                    self.assertEqual(response.status, 400)
                    body = response.read().decode('utf-8')
                self.assertNotIn(secret, body)
                _, after_monitor = public_request(base, '/api/recovery/monitor')
                _, after_fulfillments = public_request(base,
                    '/api/recovery/fulfillments?cursor=0&limit=1')
                self.assertEqual(after_monitor['summary']['incidents'],
                                 before_monitor['summary']['incidents'])
                self.assertEqual(after_fulfillments['pagination']['total'],
                                 before_fulfillments['pagination']['total'])

    def test_retry_after_cooldown_blocks_refresh_and_simulation_source_reads(self):
        with tempfile.TemporaryDirectory(prefix='reconcile-cooldown-') as root:
            with FulfillmentDemo(Path(root), live_bootstrap_pending=True) as demo:
                base = demo.urls['engine']
                demo.set_source_cooldown(3600)
                before = demo.source_fixture_status()['source_requests_total']

                code, refresh = public_request(base, '/api/recovery/live/refresh', {})
                self.assertEqual(code, 200, refresh)
                self.assertEqual(refresh['waiting_reason'], 'source_cooldown')
                self.assertEqual(demo.source_fixture_status()['source_requests_total'], before)

                code, once = public_request(base, '/api/recovery/simulation', {
                    'action': 'once', 'operation_key': 'uat-cooldown-once'})
                self.assertIn(code, (200, 202), once)
                single = wait_for(base, '/api/recovery/simulation',
                    lambda status: status['status'] in ('stopped', 'failed'))
                self.assertEqual(single['status'], 'stopped', single)
                self.assertEqual(single['completed'], 0)
                self.assertEqual(single['waiting_reason'], 'source_cooldown')
                self.assertEqual(demo.source_fixture_status()['source_requests_total'], before)

                code, continuous = public_request(base, '/api/recovery/simulation', {
                    'action': 'continuous', 'operation_key': 'uat-cooldown-continuous'})
                self.assertIn(code, (200, 202), continuous)
                waiting = wait_for(base, '/api/recovery/simulation',
                    lambda status: status.get('continuous') is True
                        and status.get('waiting_reason') == 'source_cooldown')
                self.assertEqual(waiting['completed'], 0)
                self.assertEqual(demo.source_fixture_status()['source_requests_total'], before)
                code, stopped = public_request(base, '/api/recovery/simulation', {'action': 'stop'})
                self.assertIn(code, (200, 202), stopped)
                final = wait_for(base, '/api/recovery/simulation',
                    lambda status: status['status'] == 'stopped')
                self.assertEqual(final['completed'], 0)
                self.assertEqual(demo.source_fixture_status()['source_requests_total'], before)

    def test_1000_healthy_continuous_cycles_keep_unresolved_history_and_measure_limits(self):
        batch_count, cycles_per_batch = 50, 20
        started = time.monotonic()
        batches = []
        with ThreadPoolExecutor(max_workers=4) as executor:
            futures = {executor.submit(self._run_stress_batch, batch_index,
                cycles_per_batch): batch_index for batch_index in range(1, batch_count+1)}
            try:
                for future in as_completed(futures):
                    batch_index = futures[future]
                    try:
                        batches.append(future.result())
                    except Exception as exc:
                        raise AssertionError(
                            f'Stress batch {batch_index} failed: {type(exc).__name__}: {exc}') from exc
            except BaseException:
                for pending in futures:
                    if not pending.done():
                        pending.cancel()
                executor.shutdown(wait=False, cancel_futures=True)
                raise
        batches.sort(key=lambda item: item['batch_index'])
        role_rss_max = {}
        for batch in batches:
            for sample in [batch['process_rss_kb_before'], batch['process_rss_kb_after'],
                           *(row['process_rss_kb'] for row in batch['samples'])]:
                for role, value in sample.items():
                    role_rss_max[role] = max(role_rss_max.get(role, 0), value)
        telemetry_backlog_max = max(batch['collector_backlog_max_sampled']
                                    for batch in batches)
        aggregate = {'measured_at': datetime.now(timezone.utc).isoformat(),
            'transport': 'independent local synthetic source fixtures; not Adapty HTTP',
            'batch_count': batch_count, 'cycles_per_batch': cycles_per_batch,
            'cycles_completed_total': sum(batch['cycles_completed'] for batch in batches),
            'elapsed_seconds': round(time.monotonic()-started, 3),
            'runtime_storage_bytes_max_per_batch': max(
                batch['runtime_storage_bytes_max_sampled'] for batch in batches),
            'process_rss_kb_max_sampled_by_role': role_rss_max,
            'source_requests_total_before_sum': sum(
                batch['source_requests_total_before'] for batch in batches),
            'source_requests_total_after_sum': sum(
                batch['source_requests_total_after'] for batch in batches),
            'physical_source_calls_total': sum(batch['physical_source_calls']
                                                for batch in batches),
            'source_call_cycles_observed_total': sum(
                batch['source_call_cycles_observed'] for batch in batches),
            'incidents_before_total': sum(batch['history']['incidents_before']
                                          for batch in batches),
            'incidents_after_total': sum(batch['history']['incidents_after']
                                         for batch in batches),
            'new_incidents_total': sum(batch['history']['new_incidents']
                                       for batch in batches),
            'collector_backlog_max_sampled': telemetry_backlog_max,
            'collector_dropped_total': sum(batch['collector_dropped_final']
                                           for batch in batches),
            'limit_bytes_per_runtime': 512*1024*1024,
            'batches': batches}
        self.assertGreaterEqual(aggregate['cycles_completed_total'], 1000, aggregate)
        artifacts = Path(__file__).resolve().parents[2]/'.artifacts'
        artifacts.mkdir(parents=True, exist_ok=True)
        (artifacts/'fulfillment-stress.json').write_text(
            json.dumps(aggregate, indent=2, sort_keys=True)+'\n', encoding='utf-8')

    def _run_stress_batch(self, batch_index, cycles):
        try:
            return self._run_stress_batch_body(batch_index, cycles)
        except Exception as exc:
            artifacts = Path(__file__).resolve().parents[2]/'.artifacts'
            artifacts.mkdir(parents=True, exist_ok=True)
            failure = {'batch_index': batch_index, 'cycle_target': cycles,
                'status': 'failed', 'error_type': type(exc).__name__,
                'error': str(exc)[:4096], 'traceback': traceback.format_exc(limit=8)}
            (artifacts/f'fulfillment-stress-batch-{batch_index:02d}-failure.json').write_text(
                json.dumps(failure, indent=2, sort_keys=True)+'\n', encoding='utf-8')
            raise

    def _run_stress_batch_body(self, batch_index, cycles):
        batch_started = time.monotonic()
        with tempfile.TemporaryDirectory(
                prefix=f'reconcile-fulfillment-stress-{batch_index:02d}-') as root:
            with FulfillmentDemo(Path(root), live_bootstrap_pending=True) as demo:
                base = demo.urls['engine']
                code, accepted = public_request(base, '/api/recovery/simulation', {
                    'action': 'bootstrap', 'operation_key': 'uat-stress-bootstrap'})
                self.assertIn(code, (200, 202), accepted)
                bootstrap = wait_for(base, '/api/recovery/simulation',
                    lambda state: state['bootstrap_status'] == 'failed'
                        or state['bootstrap_status'] == 'completed' and 'result' in state)
                self.assertEqual(bootstrap['bootstrap_status'], 'completed', bootstrap)

                wait_for(base, '/api/recovery/monitor?cursor=0&limit=1',
                    lambda state: state['telemetry']['queued'] == 0
                        and state['telemetry']['dropped'] == 0, timeout=30)
                baseline = paged_items(base, '/api/recovery/monitor', limit=200)
                self.assertEqual(len(baseline), 1,
                    f'Expected one aggregate bootstrap incident; public summaries='+
                    repr([(row['id'], row['status'], row['affected_accounts'],
                        row['repaired_accounts']) for row in baseline]))
                self.assertEqual(baseline[0]['affected_accounts'], 24)
                self.assertEqual(baseline[0]['repaired_accounts'], 23)
                unresolved_before = {row['id'] for row in baseline if row['status'] == 'unresolved'}
                self.assertEqual(len(unresolved_before), 1)
                source_before = demo.source_fixture_status()['source_requests_total']
                before_measurement = demo.measurements()
                self.assertEqual(set(before_measurement['process_rss_kb']),
                                 {'provider', 'lumen', 'engine'})
                self.assertTrue(all(isinstance(value, int) and value > 0
                                    for value in before_measurement['process_rss_kb'].values()))
                _, baseline_fulfillments = public_request(base,
                    '/api/recovery/fulfillments?cursor=0&limit=200')
                self.assertEqual(baseline_fulfillments['pagination']['total'], 100)
                permanent_account = next(item for item in baseline_fulfillments['items']
                    if item['status'] != 'verified_application')
                permanent_user = permanent_account['key']['customer_id']
                eligible_users = {item['key']['customer_id']
                    for item in baseline_fulfillments['items']
                    if item['application']['gate']['allowed'] is True}
                self.assertEqual(len(eligible_users), 99)
                unresolved_incident = next(row for row in baseline
                    if row['status'] == 'unresolved')
                _, old_audit_before = public_request(base,
                    '/api/recovery/audit?'+urlencode({'incident_id': unresolved_incident['id']}))
                old_trace_code, old_trace_before = public_request(base,
                    f"/api/recovery/incidents/{unresolved_incident['id']}/trace")
                self.assertEqual(old_trace_code, 200, old_trace_before)
                initial_affected_users = {row['user_id'] for row in old_trace_before['traces']}
                self.assertEqual(len(initial_affected_users), 24)
                initial_receipt_events = {row['event_id'] for row in
                    old_trace_before['processing_receipts']}
                healthy_cohort = eligible_users-initial_affected_users
                self.assertEqual(len(healthy_cohort), 76)
                baseline_fulfillments = wait_for(base,
                    '/api/recovery/fulfillments?cursor=0&limit=200',
                    lambda page: page['coverage']['complete']
                        and page['pagination']['total'] == 100
                        and all(row['status'] == 'verified_application'
                            for row in page['items']
                            if row['key']['customer_id'] in healthy_cohort), timeout=60)
                export_start = (datetime.fromisoformat(
                    unresolved_incident['detected_at'].replace('Z', '+00:00'))
                    - timedelta(seconds=1)).astimezone(timezone.utc)
                baseline_export_params = urlencode({'from': export_start.isoformat().replace(
                    '+00:00', 'Z'), 'to': (datetime.now(timezone.utc)+timedelta(seconds=1)).isoformat().replace(
                        '+00:00', 'Z'), 'format': 'json'})
                _, baseline_export = public_request(base,
                    '/api/recovery/export?'+baseline_export_params)
                self.assertEqual(baseline_export['incident_count'], 1)
                old_export_record = baseline_export['incidents'][0]
                self.assertEqual(old_export_record['id'], unresolved_incident['id'])

                timeout_user = sorted(healthy_cohort)[0]
                _, timeout_before_report = public_request(base, '/api/recovery/report')
                timeout_before = next(row for row in timeout_before_report['accounts']
                    if row['id'] == timeout_user)
                self.assertTrue(timeout_before['gate']['allowed'])
                timeout_body = {'action': 'once',
                    'operation_key': 'uat-timeout-after-commit',
                    'fault_mode': 'timeout_after_commit'}
                timeout_source_before = demo.source_fixture_status()['source_requests_total']
                with ThreadPoolExecutor(max_workers=4) as executor:
                    timeout_duplicates = list(executor.map(lambda _: public_request(
                        base, '/api/recovery/simulation', timeout_body), range(4)))
                self.assertTrue(all(code in (200, 202) for code, _ in timeout_duplicates))
                timeout_ids = {body['simulation_id'] for _, body in timeout_duplicates}
                self.assertEqual(len(timeout_ids), 1)
                self.assertEqual(sum(not body.get('duplicate')
                                     for _, body in timeout_duplicates), 1)
                timeout_done = wait_for(base, '/api/recovery/simulation',
                    lambda state: state['simulation_id'] in timeout_ids
                        and state['status'] in ('completed', 'failed'))
                self.assertEqual(timeout_done['status'], 'completed', timeout_done)
                timeout_cycle = timeout_done.get('last_cycle') or timeout_done.get('result') or {}
                self.assertEqual(timeout_cycle['user_id'], timeout_user)
                self.assertEqual(timeout_cycle['fault_mode'], 'timeout_after_commit')
                self.assertEqual(timeout_cycle['handler_outcome'], 'completed')
                self.assertEqual(timeout_cycle['recovery_status'], 'no_recovery_needed')
                self.assertIsNone(timeout_cycle['incident_id'])
                self.assertEqual(timeout_cycle['handler_result']['reason'], 'committed_readback')
                self.assertTrue(any(step['name'] == 'projection_commit'
                    and step['result'] == 'committed'
                    for step in timeout_cycle['handler_result']['steps']))
                timeout_source_after = demo.source_fixture_status()['source_requests_total']
                self.assertLessEqual(timeout_cycle['source_calls'],
                    timeout_source_after-timeout_source_before)
                _, timeout_after_report = public_request(base, '/api/recovery/report')
                timeout_after = next(row for row in timeout_after_report['accounts']
                    if row['id'] == timeout_user)
                self.assertTrue(timeout_after['gate']['allowed'])
                self.assertGreater(timeout_after['projection_revision'],
                                   timeout_before['projection_revision'])
                _, timeout_duplicate = public_request(base,
                    '/api/recovery/simulation', timeout_body)
                self.assertTrue(timeout_duplicate['duplicate'])
                self.assertEqual(timeout_duplicate['simulation_id'],
                                 next(iter(timeout_ids)))
                _, timeout_after_duplicate_report = public_request(base,
                    '/api/recovery/report')
                timeout_after_duplicate = next(row for row in
                    timeout_after_duplicate_report['accounts']
                    if row['id'] == timeout_user)
                self.assertEqual(timeout_after_duplicate['projection_revision'],
                                 timeout_after['projection_revision'])

                duplicate_body = {'action': 'once',
                    'operation_key': 'uat-stress-concurrent-once',
                    'fault_mode': 'handler_precommit'}
                first_cycle_source_before = demo.source_fixture_status()['source_requests_total']
                with ThreadPoolExecutor(max_workers=4) as executor:
                    duplicates = list(executor.map(lambda _: public_request(
                        base, '/api/recovery/simulation', duplicate_body), range(4)))
                self.assertTrue(all(code in (200, 202) for code, _ in duplicates))
                simulation_ids = {body['simulation_id'] for _, body in duplicates}
                self.assertEqual(len(simulation_ids), 1)
                concurrent_done = wait_for(base, '/api/recovery/simulation',
                    lambda state: state['simulation_id'] in simulation_ids
                        and state['status'] in ('completed', 'failed'))
                self.assertEqual(concurrent_done['status'], 'completed', concurrent_done)
                self.assertEqual(concurrent_done['completed'], 1)
                first_cycle = concurrent_done.get('result') or concurrent_done.get('last_cycle') or {}
                self.assertIn(first_cycle['user_id'], healthy_cohort,
                    'The next healthy cohort must exclude all24 bootstrap accounts')
                self.assertEqual(first_cycle['handler_outcome'], 'failed',
                    f'Expected one real precommit failure; public cycle={first_cycle!r}; '
                    f'simulation={concurrent_done!r}')
                self.assertTrue(first_cycle['incident_id'])
                pre_cycle_row = next(row for row in baseline_fulfillments['items']
                    if row['key']['customer_id'] == first_cycle['user_id'])
                self.assertEqual(pre_cycle_row['status'], 'verified_application')
                if first_cycle['recovery_status'] != 'completed':
                    _, recovery_audit = public_request(base,
                        '/api/recovery/audit?'+urlencode({'incident_id': first_cycle['incident_id']}))
                    _, recovery_monitor = public_request(base,
                        '/api/recovery/monitor?cursor=0&limit=50&status=unresolved')
                    reason_counts = {}
                    for account in recovery_audit.get('accounts', []):
                        key = f"{account.get('status')}/{account.get('reason')}"
                        reason_counts[key] = reason_counts.get(key, 0)+1
                    action_counts = {}
                    for action in recovery_audit.get('actions', []):
                        action_counts[action.get('status')] = action_counts.get(
                            action.get('status'), 0)+1
                    self.fail(json.dumps({'cycle': first_cycle,
                        'incident': recovery_audit.get('incident'),
                        'recovery': recovery_audit.get('recovery'),
                        'account_reason_counts': reason_counts,
                        'action_status_counts': action_counts,
                        'unresolved_monitor': [{'id': row['id'], 'status': row['status'],
                            'affected_accounts': row['affected_accounts'],
                            'repaired_accounts': row['repaired_accounts']}
                            for row in recovery_monitor.get('incidents', [])]}, sort_keys=True))
                self.assertIsInstance(first_cycle['source_calls'], int)
                first_cycle_source_after = demo.source_fixture_status()['source_requests_total']
                self.assertLessEqual(first_cycle['source_calls'],
                    first_cycle_source_after-first_cycle_source_before)
                first_repair = wait_for(base,
                    '/api/recovery/monitor?cursor=0&limit=200&status=repaired',
                    lambda page: any(row['id'] == first_cycle['incident_id']
                                     for row in page['incidents']))
                first_incident = next(row for row in first_repair['incidents']
                    if row['id'] == first_cycle['incident_id'])
                self.assertGreaterEqual(first_incident['affected_accounts'], 1)
                self.assertLess(first_incident['affected_accounts'], 24)
                _, first_cycle_audit = public_request(base,
                    '/api/recovery/audit?'+urlencode({'incident_id': first_cycle['incident_id']}))
                self.assertEqual(first_cycle_audit['incident']['trigger_user_id'],
                                 first_cycle['user_id'])
                self.assertTrue(all(action['account_id'] in healthy_cohort
                                    for action in first_cycle_audit['actions']))
                first_cycle_trace_code, first_cycle_trace = public_request(base,
                    f"/api/recovery/incidents/{first_cycle['incident_id']}/trace")
                self.assertEqual(first_cycle_trace_code, 200, first_cycle_trace)
                first_cycle_record = concurrent_done.get('last_cycle') or first_cycle
                handler_readback = first_cycle_record.get('handler_result') or {}
                handler_trace_id = handler_readback.get('trace_id')
                self.assertTrue(handler_trace_id, first_cycle_record)
                first_cycle_user_traces = [row for row in first_cycle_trace['traces']
                    if row['user_id'] == first_cycle['user_id']]
                post_failure_traces = [row for row in first_cycle_user_traces
                    if row.get('status') == 'discrepancy'
                        and row.get('processing_outcome') == 'failed'
                        and row.get('processing_trace_id') == handler_trace_id]
                self.assertTrue(post_failure_traces,
                    f'No public trace is linked to the failed handler: '
                    f'traces={first_cycle_user_traces!r}; cycle={first_cycle_record!r}')
                first_cycle_trace_user = max(post_failure_traces,
                    key=lambda row: row.get('created_at') or '')
                self.assertEqual(first_cycle_trace_user['status'], 'discrepancy',
                    f'Same-version verified regression must bypass grace: '
                    f'trace={first_cycle_trace_user!r}; cycle={first_cycle_record!r}')
                self.assertNotEqual(first_cycle_trace_user['reason'], 'normal_processing_window',
                    'A verified same-version projection regression must bypass new-version grace')
                first_cycle_receipt_events = {row['event_id'] for row in
                    first_cycle_trace['processing_receipts']}
                self.assertFalse(initial_receipt_events & first_cycle_receipt_events,
                    'A new healthy incident must not rebind bootstrap processing receipts')

                code, continuous = public_request(base, '/api/recovery/simulation', {
                    'action': 'continuous', 'operation_key': 'uat-stress-continuous',
                    'fault_mode': 'handler_precommit'})
                self.assertIn(code, (200, 202), continuous)
                continuous_id = continuous['simulation_id']
                first_continuous_state = wait_for(base, '/api/recovery/simulation',
                    lambda state: state['simulation_id'] == continuous_id
                        and state['status'] == 'running' and state['completed'] >= 1,
                    timeout=90, interval=.05)
                first_continuous_cycle = first_continuous_state['last_cycle']
                self.assertIn(first_continuous_cycle['user_id'], healthy_cohort)
                self.assertNotEqual(first_continuous_cycle['incident_id'],
                                    first_cycle['incident_id'])
                self.assertEqual(first_continuous_cycle['handler_outcome'], 'failed')
                self.assertEqual(first_continuous_cycle['recovery_status'], 'completed')
                wait_for(base, '/api/recovery/monitor?cursor=0&limit=50&status=repaired',
                    lambda page: any(row['id'] == first_continuous_cycle['incident_id']
                                     for row in page['incidents']))
                continuous_handler_result = first_continuous_cycle.get('handler_result') or {}
                continuous_trace_id = continuous_handler_result.get('trace_id')
                self.assertTrue(continuous_trace_id, first_continuous_cycle)
                continuous_trace_path = (
                    f"/api/recovery/incidents/{first_continuous_cycle['incident_id']}/trace")
                continuous_trace = wait_for(base, continuous_trace_path,
                    lambda trace: any(row.get('user_id') == first_continuous_cycle['user_id']
                        and row.get('processing_trace_id') == continuous_trace_id
                        and row.get('processing_outcome') == 'failed'
                        and row.get('status') == 'discrepancy'
                        for row in trace.get('traces', [])))
                continuous_post_failure = [row for row in continuous_trace['traces']
                    if row.get('user_id') == first_continuous_cycle['user_id']
                        and row.get('processing_trace_id') == continuous_trace_id
                        and row.get('processing_outcome') == 'failed'
                        and row.get('status') == 'discrepancy']
                self.assertTrue(continuous_post_failure,
                    f'No public discrepancy trace is linked to the observed failed handler: '
                    f'trace={continuous_trace!r}; cycle={first_continuous_cycle!r}')
                continuous_trace_user = max(continuous_post_failure,
                    key=lambda row: row.get('created_at') or '')
                self.assertNotEqual(continuous_trace_user['reason'],
                                    'normal_processing_window')
                continuous_receipt_events = {row['event_id'] for row in
                    continuous_trace['processing_receipts']}
                self.assertFalse(first_cycle_receipt_events & continuous_receipt_events,
                    'A new healthy incident must not rebind earlier processing receipts')
                code, stop = public_request(base, '/api/recovery/simulation', {'action': 'stop'})
                self.assertIn(code, (200, 202), stop)
                stopped_before_restart = wait_for(base, '/api/recovery/simulation',
                    lambda state: state['simulation_id'] == continuous_id
                        and state['status'] == 'stopped')
                self.assertGreaterEqual(stopped_before_restart['completed'],
                                        first_continuous_state['completed'])
                self.assertGreaterEqual(stopped_before_restart['last_cycle']['cycle_no'],
                                        first_continuous_cycle['cycle_no'])

                demo.restart_engine()
                persisted = wait_for(base, '/api/recovery/simulation',
                    lambda state: state['simulation_id'] == continuous_id
                        and state['status'] == 'stopped')
                self.assertEqual(persisted['completed'], stopped_before_restart['completed'])
                self.assertEqual(persisted['last_cycle'], stopped_before_restart['last_cycle'])
                code, configured = public_request(base, '/api/recovery/simulation', {
                    'action': 'configure', 'clock_scale': 1000})
                self.assertEqual(code, 200, configured)
                self.assertTrue(configured['demo_only'])
                code, resumed = public_request(base, '/api/recovery/simulation', {
                    'action': 'resume', 'simulation_id': continuous_id})
                self.assertIn(code, (200, 202), resumed)
                self.assertEqual(resumed['simulation_id'], continuous_id)
                self.assertTrue(resumed['resumed'])
                saved_cycle_no = stopped_before_restart['last_cycle']['cycle_no']
                latest = wait_for(base, '/api/recovery/simulation',
                    lambda state: state['simulation_id'] == continuous_id
                        and state['status'] == 'running'
                        and state['completed'] > stopped_before_restart['completed'],
                    timeout=90, interval=.05)
                self.assertGreater(latest['last_cycle']['cycle_no'], saved_cycle_no)

                deadline = time.monotonic()+600
                samples = []
                source_calls_by_cycle = {
                    first_continuous_cycle['cycle_no']: first_continuous_cycle['source_calls'],
                    latest['last_cycle']['cycle_no']: latest['last_cycle']['source_calls']}
                cycle_results = {
                    first_continuous_cycle['cycle_no']: first_continuous_cycle,
                    latest['last_cycle']['cycle_no']: latest['last_cycle']}
                next_sample = 100
                while time.monotonic() < deadline:
                    _, latest = public_request(base, '/api/recovery/simulation')
                    if latest['status'] in ('failed', 'stopped'):
                        break
                    if latest.get('last_cycle'):
                        cycle = latest['last_cycle']
                        self.assertIn(cycle['user_id'], healthy_cohort,
                            'The continuous generator must exclude all24 bootstrap accounts')
                        source_calls_by_cycle[cycle['cycle_no']] = cycle['source_calls']
                        cycle_results[cycle['cycle_no']] = cycle
                    if latest['completed'] >= next_sample:
                        samples.append({'completed': latest['completed'],
                            **demo.measurements(),
                            'telemetry': public_request(base,
                                '/api/recovery/monitor?cursor=0&limit=1')[1]['telemetry']})
                        next_sample += 100
                    if latest['completed'] >= cycles:
                        break
                    time.sleep(.05)
                self.assertIsNotNone(latest)
                self.assertGreaterEqual(latest['completed'], cycles, latest)
                last_observed_completed = latest['completed']
                last_observed_cycle_no = latest['last_cycle']['cycle_no']
                code, stop = public_request(base, '/api/recovery/simulation', {'action': 'stop'})
                self.assertIn(code, (200, 202), stop)
                final = wait_for(base, '/api/recovery/simulation',
                    lambda state: state['status'] == 'stopped', timeout=120)
                self.assertGreaterEqual(final['completed'], cycles)
                self.assertGreaterEqual(final['completed'], last_observed_completed)
                self.assertGreaterEqual(final['last_cycle']['cycle_no'], last_observed_cycle_no)
                self.assertTrue(source_calls_by_cycle)
                self.assertTrue(all(isinstance(value, int) and value >= 0
                                    for value in source_calls_by_cycle.values()))
                self.assertTrue(cycle_results)
                repeated_cycles = sorted(cycle_results.values(), key=lambda item: item['cycle_no'])
                self.assertTrue(repeated_cycles)
                self.assertTrue(all(item['handler_outcome'] == 'failed'
                                    and item['recovery_status'] == 'completed'
                                    for item in repeated_cycles))

                unresolved_final = paged_items(base,
                    '/api/recovery/monitor?status=unresolved', limit=50)
                repaired_final = paged_items(base,
                    '/api/recovery/monitor?status=repaired', limit=50)
                final_incidents = unresolved_final+repaired_final
                final_by_id = {row['id']: row for row in final_incidents}
                self.assertTrue(set(unresolved_before) <= set(final_by_id))
                old_incident_after = final_by_id[next(iter(unresolved_before))]
                self.assertEqual(old_incident_after, baseline[0])
                self.assertEqual(old_incident_after['status'], 'unresolved')
                baseline_ids = {row['id'] for row in baseline}
                new_incidents = [row for row in final_incidents if row['id'] not in baseline_ids]
                self.assertTrue(new_incidents)
                self.assertTrue(all(row['status'] == 'repaired' for row in new_incidents))
                self.assertTrue(all(0 < row['affected_accounts'] < 24
                                    for row in new_incidents))
                _, old_audit_after = public_request(base,
                    '/api/recovery/audit?'+urlencode({'incident_id': unresolved_incident['id']}))
                for key in ('incident', 'recovery', 'plans', 'actions'):
                    self.assertEqual(old_audit_after[key], old_audit_before[key],
                        f'Unresolved account recovery history changed in {key}')
                old_trace_after_code, old_trace_after = public_request(base,
                    f"/api/recovery/incidents/{unresolved_incident['id']}/trace")
                self.assertEqual(old_trace_after_code, 200, old_trace_after)
                for key in ('incident', 'expectations', 'traces', 'processing_receipts',
                            'activity', 'provenance'):
                    self.assertEqual(old_trace_after[key], old_trace_before[key],
                        f'New episodes changed immutable old trace field {key}')
                _, final_fulfillments = public_request(base,
                    '/api/recovery/fulfillments?cursor=0&limit=200')
                self.assertEqual(final_fulfillments['pagination']['total'], 100)
                final_transaction_by_user = {row['key']['customer_id']:
                    row['key']['transaction_id'] for row in final_fulfillments['items']}
                baseline_transaction_by_user = {row['key']['customer_id']:
                    row['key']['transaction_id'] for row in baseline_fulfillments['items']}
                self.assertEqual(final_transaction_by_user, baseline_transaction_by_user)
                self.assertEqual(len(set(final_transaction_by_user.values())), 100)

                stress_export_params = urlencode({'from': export_start.isoformat().replace(
                    '+00:00', 'Z'), 'to': (datetime.now(timezone.utc)+timedelta(seconds=1)).isoformat().replace(
                        '+00:00', 'Z'), 'format': 'json'})
                export_code, stress_export = public_request(base,
                    '/api/recovery/export?'+stress_export_params)
                self.assertEqual(export_code, 200, stress_export)
                self.assertEqual(stress_export['incident_count'], len(final_incidents))
                exported_by_id = {record['id']: record for record in stress_export['incidents']}
                self.assertEqual(len(exported_by_id), stress_export['incident_count'])
                self.assertEqual(set(exported_by_id), set(final_by_id))
                exported_old = exported_by_id[unresolved_incident['id']]
                for key in ('plans', 'actions', 'automatic_recovery'):
                    self.assertEqual(exported_old[key], old_export_record[key],
                        f'Unresolved account export history changed in {key}')
                for incident in new_incidents:
                    record = exported_by_id[incident['id']]
                    trigger_user = record['incident'].get('trigger_user_id')
                    self.assertIn(trigger_user, healthy_cohort)
                    plan_targets = {user_id for plan in record['plans']
                        for user_id in plan.get('ids', [])}
                    action_targets = {action['account_id'] for action in record['actions']}
                    retry_targets = {user_id for decision in record['automatic_recovery']
                        for user_id in (decision.get('outcome') or {}).get('selected_ids', [])}
                    targets = plan_targets | action_targets | retry_targets | {trigger_user}
                    self.assertTrue(targets <= healthy_cohort,
                        f'New incident {incident["id"]} targeted outside its healthy cohort')
                continuous_incidents = [exported_by_id[incident['id']]
                    for incident in new_incidents
                    if incident['id'] != first_cycle['incident_id']]
                continuous_incident_ids = {record['id'] for record in continuous_incidents}
                self.assertEqual(len(continuous_incident_ids), final['completed'])
                self.assertTrue(all(cycle['incident_id'] in continuous_incident_ids
                                    for cycle in repeated_cycles),
                    'Every observed completed cycle must map to one distinct public incident')
                episodes_by_user = {}
                for incident in new_incidents:
                    record = exported_by_id[incident['id']]
                    trigger_user = record['incident'].get('trigger_user_id')
                    episodes_by_user.setdefault(trigger_user, []).append(record['id'])
                self.assertGreaterEqual(len(episodes_by_user.get(first_cycle['user_id'], [])), 2,
                    'The once control and continuous replay must retain distinct episodes for '
                    'the same healthy user')
                self.assertTrue(all(len(incident_ids) == len(set(incident_ids))
                                    for incident_ids in episodes_by_user.values()))
                source_after = demo.source_fixture_status()
                self.assertGreater(source_after['source_requests_total'], source_before)
                after_measurement = demo.measurements()
                for measured in [after_measurement, *samples]:
                    self.assertEqual(set(measured['process_rss_kb']),
                                     {'provider', 'lumen', 'engine'})
                    self.assertTrue(all(isinstance(value, int) and value > 0
                                        for value in measured['process_rss_kb'].values()))
                file_ceiling = max([before_measurement['runtime_storage_bytes'],
                    after_measurement['runtime_storage_bytes']]
                    + [row['runtime_storage_bytes'] for row in samples])
                self.assertLess(file_ceiling, 512*1024*1024)
                telemetry_samples = [row['telemetry'] for row in samples]
                telemetry_final = public_request(base,
                    '/api/recovery/monitor?cursor=0&limit=1')[1]['telemetry']
                self.assertTrue(all(item['dropped'] == 0 for item in telemetry_samples+[telemetry_final]))
                self.assertTrue(all(item['queued'] < 800 for item in telemetry_samples+[telemetry_final]))

                artifact = {'measured_at': datetime.now(timezone.utc).isoformat(),
                    'transport': 'independent local synthetic source fixture; not Adapty HTTP',
                    'batch_index': batch_index, 'cycle_target': cycles,
                    'cycles_completed': final['completed'], 'demo_clock_scale': 1000,
                    'elapsed_seconds': round(time.monotonic()-batch_started, 3),
                    'source_requests_total_before': source_before,
                    'source_requests_total_after': source_after['source_requests_total'],
                    'physical_source_calls': source_after['source_requests_total']-source_before,
                    'source_calls_by_observed_cycle': [
                        {'cycle_no': cycle_no, 'physical_source_call_delta': source_calls}
                        for cycle_no, source_calls in sorted(source_calls_by_cycle.items())],
                    'source_call_cycles_observed': len(source_calls_by_cycle),
                    'fixture_profile_requests_total_after':
                        source_after['fixture_profile_requests_total'],
                    'fixture_refresh_requests_total_after':
                        source_after['fixture_refresh_requests_total'],
                    'runtime_storage_bytes_before': before_measurement['runtime_storage_bytes'],
                    'runtime_storage_bytes_after': after_measurement['runtime_storage_bytes'],
                    'runtime_storage_bytes_max_sampled': file_ceiling,
                    'process_rss_kb_before': before_measurement['process_rss_kb'],
                    'process_rss_kb_after': after_measurement['process_rss_kb'],
                    'samples': samples,
                    'history': {'incidents_before': len(baseline),
                        'incidents_after': len(final_incidents),
                        'new_incidents': len(new_incidents),
                        'permanent_account_excluded': permanent_user,
                        'unresolved_id_preserved': next(iter(unresolved_before)),
                        'fulfillment_versions_before': baseline_fulfillments['pagination']['total'],
                        'fulfillment_versions_after': final_fulfillments['pagination']['total'],
                        'unique_transactions_after': len({row['key']['transaction_id']
                            for row in final_fulfillments['items']})},
                    'collector_backlog_final': telemetry_final['queued'],
                    'collector_backlog_max_sampled': max(
                        [telemetry_final['queued']] + [item['queued'] for item in telemetry_samples]),
                    'collector_accepted_final': telemetry_final['accepted'],
                    'collector_dropped_final': telemetry_final['dropped'],
                    'limit_bytes': 512*1024*1024}
                self.assertLess(artifact['runtime_storage_bytes_max_sampled'],
                                artifact['limit_bytes'])
                artifacts = Path(__file__).resolve().parents[2]/'.artifacts'
                artifacts.mkdir(parents=True, exist_ok=True)
                (artifacts/f'fulfillment-stress-batch-{batch_index:02d}.json').write_text(
                    json.dumps(artifact, indent=2, sort_keys=True)+'\n', encoding='utf-8')
                return artifact


if __name__ == '__main__':
    unittest.main()
