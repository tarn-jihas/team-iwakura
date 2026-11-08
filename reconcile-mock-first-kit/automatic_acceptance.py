#!/usr/bin/env python3
"""Public-HTTP acceptance for automatic recovery against a fresh local live demo."""
from __future__ import annotations

import argparse
from collections import Counter
from datetime import datetime, timezone
import json
from pathlib import Path
import sys
import tempfile
import time
from urllib.parse import urlsplit
from uuid import uuid4

from live_acceptance import request


def wait_monitor(base, predicate, timeout=300):
    deadline = time.monotonic()+timeout
    while time.monotonic() < deadline:
        monitor = request(base, '/api/recovery/monitor')
        if predicate(monitor):
            return monitor
        if monitor['simulation']['status'] == 'failed':
            raise AssertionError('Simulation failed: '+str(monitor['simulation'].get('error')))
        time.sleep(.5)
    raise AssertionError('Automatic recovery timed out: '+json.dumps(monitor))


def public_failure_diagnostics(base, monitor, job_id=None):
    report = request(base, '/api/recovery/report')
    account_reasons = Counter((item.get('status'), item.get('reason'))
                              for item in report.get('accounts', []))
    incidents = []
    for row in monitor.get('incidents', []):
        audit = request(base, '/api/recovery/audit?incident_id='+row['id'])
        action_users = sorted({action['account_id'] for action in audit.get('actions', [])})
        trigger_user = (audit.get('incident') or {}).get('trigger_user_id')
        unresolved_users = (audit.get('recovery') or {}).get('unresolved_ids', [])
        target_users = sorted(set(action_users+unresolved_users+
            ([] if not trigger_user else [trigger_user])))
        by_id = {item['id']: item for item in audit.get('accounts', [])}
        incidents.append({'incident_id': row['id'], 'status': row['status'],
            'affected_accounts': row['affected_accounts'],
            'repaired_accounts': row['repaired_accounts'],
            'trigger_user_id': trigger_user, 'target_user_ids': target_users,
            'target_account_statuses': [
                {'id': user_id, 'status': by_id[user_id].get('status'),
                 'reason': by_id[user_id].get('reason'),
                 'eligible': by_id[user_id].get('eligible')}
                for user_id in target_users if user_id in by_id],
            'action_statuses': dict(Counter(action['status']
                for action in audit.get('actions', []))),
            'plan_count': len(audit.get('plans', [])),
            'recovery': audit.get('recovery'),
            'fault_status': audit.get('fault_status')})
    journal = request(base, '/api/recovery/journal')
    job = None if not job_id else request(base, '/api/recovery/jobs/'+job_id)
    return {'monitor_statuses': dict(Counter(item['status']
                for item in monitor.get('incidents', []))),
        'simulation': monitor.get('simulation'), 'job': job,
        'recent_public_journal': [{'action': item['action'], 'details': item['details']}
            for item in journal.get('events', [])[-20:]],
        'current_account_reasons': {f'{status}/{reason}': count
            for (status, reason), count in account_reasons.items()},
        'current_coverage': report.get('coverage'), 'incident_attribution': incidents}


def run(base):
    initial = request(base, '/api/recovery/monitor')
    assert initial['mode'] in ('LIVE_ADAPTY_SEEDED', 'LOCAL_ADAPTY_FIXTURE')
    assert initial['automation']['enabled'] is True
    assert initial['automation']['policy_id'] == 'local-fulfillment-resync-v2'
    assert initial['connection']['total_accounts'] == 100
    assert initial['connection']['active_accounts'] == 100
    assert initial['connection']['catalog_product_count'] == (
        1 if initial['mode'] == 'LOCAL_ADAPTY_FIXTURE' else 6)
    assert initial['incidents'] == [], 'Use a fresh local runtime'
    status = request(base, '/api/recovery/live/status')
    lumen_url = status['lumen_url']
    assert urlsplit(lumen_url).hostname == '127.0.0.1'
    injected = request(base, '/api/recovery/live/incident', {'action': 'inject'}, (200, 202))
    assert injected['gate']['status'] == 403
    monitor = wait_monitor(base, lambda value: len(value['incidents']) == 1
        and value['incidents'][0]['status'] in ('repaired', 'unresolved'))
    first = monitor['incidents'][0]
    if first['status'] != 'repaired':
        report = request(base, '/api/recovery/report?incident_id='+first['id'])
        reasons = Counter((row.get('status'), row.get('reason')) for row in report.get('accounts', []))
        raise AssertionError(json.dumps({'incident': first, 'coverage': report.get('coverage'),
            'account_reasons': {f'{status}/{reason}': count
                for (status, reason), count in reasons.items()}}, sort_keys=True))
    assert first['affected_accounts'] == first['repaired_accounts'] == 24
    timestamps = [datetime.fromisoformat(first[key].replace('Z', '+00:00'))
                  for key in ('detected_at', 'repair_started_at', 'repaired_at')]
    assert timestamps == sorted(timestamps)
    assert first['duration_ms'] >= 0
    report = request(base, '/api/recovery/report?incident_id='+first['id'])
    assert report['recovery']['access_verified'] == 24 and report['recovery']['unresolved'] == 0
    assert len(report['actions']) == 48
    assert all(action['status'] == 'verified' and action['owner'].lower() == 'lumen'
               for action in report['actions'])
    targets = {action['account_id'] for action in report['actions']}
    assert len(targets) == 24
    snapshot_id = report['plans'][0]['snapshot_id']
    snapshot = request(base, '/api/recovery/snapshots/'+snapshot_id)
    assert snapshot['provider_evidence'] == []
    assert len(snapshot['entitlement_evidence']) == 100
    trigger = snapshot['incident']['trigger_event_id']
    assert trigger == injected['gate']['event_id'] or trigger.startswith('fulfillment:')
    assert snapshot['incident']['trigger_user_id'] in targets
    assert {row['id'] for row in snapshot['accounts'] if row['status']=='confirmed'} == targets
    if snapshot['cohort_signature'] is not None:
        assert snapshot['cohort_signature']['trigger_event_id'] == injected['gate']['event_id']
    for account in targets:
        assert request(lumen_url, '/premium/export', {'user_id': account})['allowed'] is True
    audit = request(base, '/api/recovery/audit?incident_id='+first['id'])
    assert audit['approvals']
    assert all(row['actor'] == 'policy:local-fulfillment-resync-v2' for row in audit['approvals'])
    assert not any(token in json.dumps(audit) for token in ('secret_live_', 'adapty-secret.key'))
    print('Automatic 100-account scan: 24 affected, 48 verified actions, 24 real gates. No operator approval calls.', flush=True)

    operation = {'action': 'start', 'operation_key': 'uat-'+uuid4().hex}
    accepted = request(base, '/api/recovery/simulation', operation, (200, 202))
    duplicate = request(base, '/api/recovery/simulation', operation, (200, 202))
    assert accepted['job_id'] == duplicate['job_id'] and duplicate['duplicate'] is True
    try:
        final = wait_monitor(base, lambda value: value['simulation']['status'] == 'completed'
            and value['simulation']['completed'] == 3)
    except AssertionError as exc:
        failed_monitor = request(base, '/api/recovery/monitor')
        raise AssertionError(json.dumps({'simulation_error': str(exc),
            'operation_key': operation['operation_key'],
            **public_failure_diagnostics(base, failed_monitor, accepted['job_id'])},
            sort_keys=True)) from exc
    assert final['simulation']['total'] == 3
    assert len(final['incidents']) == 4, final
    assert final['summary']['incidents'] == final['summary']['fixed'] == 4
    assert final['summary']['needs_attention'] == 0
    assert all(item['status'] == 'repaired' and item['affected_accounts'] == item['repaired_accounts']
               for item in final['incidents'])
    assert next(item for item in final['incidents'] if item['id'] == first['id']) == first, 'Closed history changed'
    assert request(base, '/api/recovery/snapshots/'+snapshot_id) == snapshot
    current = request(base, '/api/recovery/report')
    assert len(current['accounts']) == 100
    assert all(account['gate']['allowed'] for account in current['accounts'])
    deadline = time.monotonic()+60
    while time.monotonic() < deadline:
        coverage = request(lumen_url, '/_demo/collector/coverage')
        if coverage['queued'] == 0 and coverage['last_error'] is None:
            break
        time.sleep(.5)
    else:
        raise AssertionError('SDK outbox did not drain: '+json.dumps(coverage))
    assert coverage['dropped'] == 0
    print('Three randomized server scenarios recovered; history and snapshot stayed stable.', flush=True)
    return {'checked_at': datetime.now(timezone.utc).isoformat(),
        'mode': final['mode'], 'scope': 100, 'initial_affected': 24,
        'initial_verified_gates': 24, 'operator_approval_requests': 0,
        'simulation_incidents': 3, 'total_repaired_incidents': 4,
        'duplicate_simulation_reused': True, 'historical_result_stable': True,
        'snapshot_immutable': True, 'sdk_coverage': coverage, 'monitor': final,
        'payment_verification': 'not_independently_verified', 'remote_repair_writes': 0}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--url', help='existing loopback demo URL; defaults to an isolated fixture')
    parser.add_argument('--output', type=Path)
    args = parser.parse_args()
    if args.url:
        parsed = urlsplit(args.url)
        if parsed.scheme != 'http' or parsed.hostname != '127.0.0.1' or parsed.path not in ('', '/'):
            parser.error('URL must be a local HTTP demo origin')
        result = run(args.url.rstrip('/'))
    else:
        sys.path.insert(0, str(Path(__file__).resolve().parent/'acceptance'))
        from support.fulfillment_fixture import FulfillmentDemo
        with tempfile.TemporaryDirectory(prefix='reconcile-auto-acceptance-') as folder:
            with FulfillmentDemo(Path(folder)) as demo:
                result = run(demo.urls['engine'])
    if args.output:
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_text(json.dumps(result, indent=2)+'\n')
    print(json.dumps({key: value for key, value in result.items() if key != 'monitor'}, indent=2))


if __name__ == '__main__':
    main()
