#!/usr/bin/env python3
"""Black-box acceptance against a running, isolated LIVE_ADAPTY_SEEDED demo.

Uses public HTTP only. Injects a local fault and explicitly approves its repair.
Never imports the engine, reads its database, or modifies an Adapty profile.
"""
from __future__ import annotations

import argparse
from datetime import datetime, timezone
import json
from pathlib import Path
import time
from urllib.error import HTTPError
from urllib.parse import urlsplit
from urllib.request import Request, urlopen


def request(base, path, body=None, expected=(200,), timeout=120):
    payload = None if body is None else json.dumps(body).encode()
    req = Request(base + path, data=payload, headers={'Content-Type': 'application/json'})
    try:
        response = urlopen(req, timeout=timeout)
    except HTTPError as error:
        response = error
    with response:
        result = json.load(response)
        if response.status not in expected:
            raise AssertionError(f'{path}: HTTP {response.status}: {result}')
        return result


def wait_job(base, job_id, timeout=300):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        job = request(base, '/api/recovery/jobs/' + job_id)
        if job['status'] == 'failed':
            raise AssertionError('Recovery job failed: ' + json.dumps(job))
        if job['status'] == 'completed':
            return job
        time.sleep(0.5)
    raise AssertionError('Recovery job timed out: ' + job_id)


def run(base):
    status = request(base, '/api/recovery/live/status')
    assert status['mode'] == 'LIVE_ADAPTY_SEEDED', 'This harness requires the isolated live demo'
    catalog = status['cli_catalog']
    assert catalog['product_count'] == len(catalog['products']) == 6
    assert 'adapty/' in catalog['cli_version'] and len(catalog['source_hash']) == 64
    initial = request(base, '/api/recovery/report')
    assert initial['mode'] == 'LIVE_ADAPTY_SEEDED'
    assert len(initial['accounts']) == 100
    assert initial.get('incident') is None, 'Use a fresh local runtime; do not overwrite a prior demo'
    original = {a['id']: a for a in initial['accounts']}
    assert all(a['gate']['allowed'] for a in original.values()), 'All selected demo accounts must start healthy'
    print('100 live source accounts and healthy Lumen gates observed.', flush=True)
    injected = request(base, '/api/recovery/live/incident', {'action': 'inject'}, (200, 202))
    deadline = time.monotonic() + 180
    while time.monotonic() < deadline:
        report = request(base, '/api/recovery/report')
        incident = report.get('incident')
        pending = [j for j in report.get('jobs', []) if j['status'] in ('queued', 'running')]
        if incident and not pending and report['summary']['confirmed'] == 24:
            break
        time.sleep(1)
    else:
        raise AssertionError('One customer denial did not automatically detect the 24-account cohort')
    assert report['summary']['in_scope'] == 100
    selected = [a['id'] for a in report['accounts'] if a['eligible']]
    assert len(selected) == 24
    assert all(a['payment_state'] == 'not_independently_verified' for a in report['accounts'])
    assert all(a['adapty_active'] for a in report['accounts'])
    assert {a['id'] for a in report['accounts'] if not a['gate']['allowed']} == set(selected)
    snapshot_id = incident['snapshot_id']
    snapshot = request(base, '/api/recovery/snapshots/' + snapshot_id)
    assert snapshot.get('provider_evidence', []) == [], 'Seeded entitlements are not payment proof'
    assert snapshot.get('entitlement_evidence'), 'Explicit source entitlement evidence is required'
    plan = request(base, '/api/recovery/plans', {'ids': selected, 'incident_id': incident['id']})
    assert {a['type'] for a in plan['entries']} == {'resync_access', 'verify_gate'}
    assert len(plan['entries']) == 48
    execution = {'plan_id': plan['id'], 'plan_hash': plan['plan_hash']}
    request(base, '/api/recovery/executions', execution, (409, 403))
    request(base, '/api/recovery/approvals', {**execution, 'actor': 'Live integration acceptance operator'})
    accepted = request(base, '/api/recovery/executions', execution, (202,))
    duplicate = request(base, '/api/recovery/executions', execution, (202,))
    assert duplicate['job_id'] == accepted['job_id'], 'Concurrent duplicate execution must reuse its job'
    print('24 discrepancies detected; exact 48-step repair approved and executing.', flush=True)
    job = wait_job(base, accepted['job_id'])
    final = request(base, '/api/recovery/report')
    assert final['recovery']['access_verified'] == 24, final['recovery']
    assert final['recovery']['unresolved'] == 0, final['recovery']
    assert len(final['actions']) == 48
    assert all(a['status'] == 'verified' for a in final['actions']), final['actions']
    assert all(a['owner'] == 'Lumen' or a['owner'].lower().startswith('lumen') for a in final['actions'])
    assert all(a['gate']['allowed'] for a in final['accounts'])
    assert {a['id'] for a in final['accounts']} == set(original)
    assert request(base, '/api/recovery/snapshots/' + snapshot_id) == snapshot
    lumen_url = status['lumen_url']
    assert urlsplit(lumen_url).hostname in ('127.0.0.1', 'localhost'), 'Lumen gate must be local'
    for user_id in selected:
        gate = request(lumen_url, '/premium/export', {'user_id': user_id})
        assert gate['allowed'] is True, (user_id, gate)
    deadline = time.monotonic() + 60
    while time.monotonic() < deadline:
        coverage = request(lumen_url, '/_demo/collector/coverage')
        if coverage.get('queued') == 0 and coverage.get('last_error') is None:
            break
        time.sleep(0.5)
    else:
        raise AssertionError('SDK outbox did not deliver its recorded observations')
    assert coverage.get('dropped') == 0, coverage
    audit = request(base, '/api/recovery/audit')
    events = audit['collector_events']
    assert {'source_entitlement_observed', 'access_projection_changed', 'feature_access_decided'} <= {e['kind'] for e in events}
    trigger_id = injected['gate']['event_id']
    assert snapshot['cohort_signature']['trigger_event_id'] == trigger_id
    trigger = next(e for e in events if e['event_id'] == trigger_id)
    assert trigger['kind'] == 'feature_access_decided' and trigger['details']['decision'] == 'deny'
    assert trigger['app_user_id'] == incident['trigger_user_id']
    assert {e['app_user_id'] for e in events if e['kind'] == 'access_projection_changed'} == set(selected)
    serialized = json.dumps(audit)
    assert not any(value in serialized for value in ('secret_live_', 'adapty-secret.key', 'secret_key_file'))
    assert len(audit['actions']) == 48
    return {'checked_at': datetime.now(timezone.utc).isoformat(), 'mode': final['mode'],
            'app_id': status.get('app_id'), 'scope': 100, 'confirmed': 24,
            'verified_gates': 24, 'unresolved': 0, 'actions': 48,
            'payment_verification': 'not_independently_verified',
            'provenance': 'official_synthetic_seed', 'remote_repair_writes': 0,
            'incident_id': incident['id'], 'plan_id': plan['id'], 'job_id': job['id'],
            'snapshot_immutable': True, 'duplicate_execution_reused': True,
            'sdk_events_received': len(events), 'incident_triggered_by_sdk': True,
            'cli_catalog': {k: v for k, v in catalog.items() if k != 'products'},
            'local_incident_response': injected, 'report': final}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--url', required=True)
    parser.add_argument('--output', type=Path)
    args = parser.parse_args()
    parsed = urlsplit(args.url)
    if parsed.scheme != 'http' or parsed.hostname not in ('127.0.0.1', 'localhost') or parsed.path not in ('', '/'):
        parser.error('URL must be a local HTTP demo origin')
    result = run(args.url.rstrip('/'))
    if args.output:
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_text(json.dumps(result, indent=2) + '\n')
    print(json.dumps({k: v for k, v in result.items() if k not in ('report', 'local_incident_response')}, indent=2))


if __name__ == '__main__':
    main()
