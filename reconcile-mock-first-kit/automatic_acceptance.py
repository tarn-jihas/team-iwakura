#!/usr/bin/env python3
"""Public-HTTP acceptance for automatic recovery against a fresh local live demo."""
from __future__ import annotations

import argparse
from datetime import datetime, timezone
import json
from pathlib import Path
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


def run(base):
    initial = request(base, '/api/recovery/monitor')
    assert initial['mode'] == 'LIVE_ADAPTY_SEEDED'
    assert initial['automation']['enabled'] is True
    assert initial['automation']['policy_id'] == 'local-entitlement-resync-v1'
    assert initial['connection']['total_accounts'] == 100
    assert initial['connection']['active_accounts'] == 100
    assert initial['connection']['catalog_product_count'] == 6
    assert initial['incidents'] == [], 'Use a fresh local runtime'
    status = request(base, '/api/recovery/live/status')
    lumen_url = status['lumen_url']
    assert urlsplit(lumen_url).hostname == '127.0.0.1'
    injected = request(base, '/api/recovery/live/incident', {'action': 'inject'}, (200, 202))
    assert injected['gate']['status'] == 403
    monitor = wait_monitor(base, lambda value: len(value['incidents']) == 1
        and value['incidents'][0]['status'] in ('repaired', 'unresolved'))
    first = monitor['incidents'][0]
    assert first['status'] == 'repaired', first
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
    assert snapshot['cohort_signature']['trigger_event_id'] == injected['gate']['event_id']
    for account in targets:
        assert request(lumen_url, '/premium/export', {'user_id': account})['allowed'] is True
    audit = request(base, '/api/recovery/audit?incident_id='+first['id'])
    assert audit['approvals']
    assert all(row['actor'] == 'policy:local-entitlement-resync-v1' for row in audit['approvals'])
    assert not any(token in json.dumps(audit) for token in ('secret_live_', 'adapty-secret.key'))
    print('Automatic 100-account scan: 24 affected, 48 verified actions, 24 real gates. No operator approval calls.', flush=True)

    operation = {'action': 'start', 'operation_key': 'uat-'+uuid4().hex}
    accepted = request(base, '/api/recovery/simulation', operation, (200, 202))
    duplicate = request(base, '/api/recovery/simulation', operation, (200, 202))
    assert accepted['job_id'] == duplicate['job_id'] and duplicate['duplicate'] is True
    final = wait_monitor(base, lambda value: value['simulation']['status'] == 'completed'
        and value['simulation']['completed'] == 3)
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
    parser.add_argument('--url', required=True)
    parser.add_argument('--output', type=Path)
    args = parser.parse_args()
    parsed = urlsplit(args.url)
    if parsed.scheme != 'http' or parsed.hostname != '127.0.0.1' or parsed.path not in ('', '/'):
        parser.error('URL must be a local HTTP demo origin')
    result = run(args.url.rstrip('/'))
    if args.output:
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_text(json.dumps(result, indent=2)+'\n')
    print(json.dumps({key: value for key, value in result.items() if key != 'monitor'}, indent=2))


if __name__ == '__main__':
    main()
