#!/usr/bin/env python3
"""Synthetic, approval-gated Lumen access recovery demo."""
from __future__ import annotations

import argparse
from collections import Counter
from copy import deepcopy
from datetime import datetime, timedelta, timezone
import json
import os
from pathlib import Path
import secrets
from threading import RLock
from tempfile import TemporaryDirectory
from uuid import NAMESPACE_URL, uuid5

import access_fixtures
import lumen_app
from collector_sdk import CollectorAuthError, CollectorSDK, KINDS, digest, ingest_event

HERE = Path(__file__).resolve().parent
STATE = HERE / 'runtime' / 'access_state.json'
EVAL = HERE / '_evaluation' / 'access_oracle.json'
STATE_LOCK = RLock()

APP = lumen_app.APP
ENVIRONMENT = lumen_app.ENVIRONMENT
FEATURE = lumen_app.FEATURE
EVENT_TYPE = 'subscription_renewal_cancelled'
PLAN_TTL = 300
MAX_ADVANCE_SECONDS = 86400
SUPPORTED_HANDLERS = frozenset((lumen_app.FAULTY_HANDLER, lumen_app.FIXED_HANDLER))


class APIError(ValueError):
    def __init__(self, message, status=400):
        super().__init__(message)
        self.status = status


def _atomic_json(path, value):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(path.name + '.tmp')
    content = json.dumps(value, ensure_ascii=False, indent=2, allow_nan=False) + '\n'
    descriptor = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    try:
        if hasattr(os, 'fchmod'):
            os.fchmod(descriptor, 0o600)
        with os.fdopen(descriptor, 'w') as output:
            descriptor = -1
            output.write(content)
            output.flush()
            os.fsync(output.fileno())
    finally:
        if descriptor >= 0:
            os.close(descriptor)
    temporary.replace(path)


def read():
    with STATE_LOCK:
        return json.loads(Path(STATE).read_text())


def save(state):
    with STATE_LOCK:
        _atomic_json(STATE, state)


def _now(state):
    return lumen_app.iso(lumen_app.now(state))


def _parse_time(value, label):
    if not isinstance(value, str) or not value.strip():
        raise APIError('Invalid '+label)
    try:
        parsed = datetime.fromisoformat(value.strip().replace('Z', '+00:00'))
    except ValueError as exc:
        raise APIError('Invalid '+label) from exc
    if parsed.tzinfo is None or parsed.utcoffset() is None:
        raise APIError(label+' must include a timezone')
    return parsed.astimezone(timezone.utc)


def _body(body):
    if not isinstance(body, dict):
        raise APIError('Request body must be an object')
    return body


def _sdk_for_state(state):
    key = state['_collector_key']

    def in_process_transport(envelope, signature):
        return _ingest_state(state, envelope, signature)

    return CollectorSDK(key, state['manifest']['run_id'], APP, in_process_transport)


def _ingest_state(state, envelope, signature):
    return ingest_event(state['collector']['events'], state['collector']['seen'],
                        state['_collector_key'], state['manifest']['run_id'], APP,
                        envelope, signature)


def collector(envelope, signature):
    """External HTTP sink. Internal SDK calls use the same ingest_event path."""
    with STATE_LOCK:
        state = read()
        try:
            receipt = _ingest_state(state, envelope, signature)
        except CollectorAuthError as exc:
            raise APIError(str(exc), 401) from exc
        save(state)
        return receipt


def seed(variant=0):
    if isinstance(variant, bool) or variant not in (0, 1):
        raise APIError('variant must be 0 or 1')
    population, oracle = access_fixtures.build_population(variant)
    run_id = f'mock-lumen-access-20261103-v{variant}'
    manifest = {
        'run_id': run_id,
        'app': APP,
        'environment': ENVIRONMENT,
        'scenario_now': access_fixtures.SCENARIO_NOW,
        'policy_version': lumen_app.POLICY_VERSION,
        'adapter_version': lumen_app.ADAPTER_VERSION,
        'provenance': 'synthetic reconstruction from the supplied incident document; no downloaded or live source ledger',
    }
    state = lumen_app.new_state(population, manifest)
    state.update({
        '_collector_key': secrets.token_hex(32),
        'collector': {'events': [], 'seen': {}},
        'incident': None,
        'last_scan': None,
        'scan_sequence': 0,
        'plans': {},
        'approvals': {},
        'actions': {},
        'verification': {},
        'recovery_target_ids': [],
        'latest_plan_id': None,
        'history': [],
    })
    sdk = _sdk_for_state(state)
    start = datetime.fromisoformat(access_fixtures.DEFAULT_START.replace('Z', '+00:00'))
    for index, user_id in enumerate(population['affected_ids']):
        occurred_at = lumen_app.iso(start + timedelta(seconds=index))
        lumen_app.send_cancellation(state, sdk, user_id, occurred_at)
    with STATE_LOCK:
        _atomic_json(EVAL, access_fixtures.evaluation_record(oracle))
        save(state)
    return report()


def ensure():
    """Seed only at startup when state is absent; never from a GET handler."""
    with STATE_LOCK:
        if not Path(STATE).exists():
            return seed()
    return report()


def _history(state, action, **details):
    state['history'].append({'action': action, 'at': _now(state), **details})
    del state['history'][:-20]


def _parse_incident(body, state):
    body = _body(body)
    manifest = state['manifest']
    if body.get('run_id', manifest['run_id']) != manifest['run_id']:
        raise APIError('Unknown run; refresh the access report', 409)
    if body.get('app', APP) != APP or body.get('environment', ENVIRONMENT) != ENVIRONMENT:
        raise APIError('Unknown app or environment scope')
    event_type = body.get('event_type', EVENT_TYPE)
    handler_version = body.get('handler_version', lumen_app.FAULTY_HANDLER)
    feature = body.get('feature', FEATURE)
    if event_type != EVENT_TYPE:
        raise APIError('Unsupported incident event type')
    if handler_version not in SUPPORTED_HANDLERS:
        raise APIError('Unsupported handler version')
    if feature != FEATURE:
        raise APIError('Unsupported feature')
    start = _parse_time(body.get('window_start', access_fixtures.DEFAULT_START), 'window_start')
    end = _parse_time(body.get('window_end', access_fixtures.DEFAULT_END), 'window_end')
    if start >= end:
        raise APIError('Incident window must end after it starts')
    if (end - start).total_seconds() > 90 * 86400:
        raise APIError('Incident window exceeds the supported 90 day limit')
    incident_material = {
        'run_id': manifest['run_id'], 'app': APP, 'environment': ENVIRONMENT,
        'window_start': lumen_app.iso(start), 'window_end': lumen_app.iso(end),
        'event_type': event_type, 'handler_version': handler_version,
        'feature': feature,
    }
    incident_id = 'incident-' + digest(incident_material)[:20]
    return {'id': incident_id, **incident_material}


def _in_window(value, start, end):
    try:
        parsed = _parse_time(value, 'event timestamp')
    except APIError:
        return False
    return start <= parsed < end


def _scan_causal_events(state, incident):
    start = _parse_time(incident['window_start'], 'window_start')
    end = _parse_time(incident['window_end'], 'window_end')
    events = state['collector']['events']
    candidates = {}
    for event in events:
        details = event['details']
        if (event['run_id'] != incident['run_id'] or event['app'] != incident['app']
                or details.get('event_type') != incident['event_type']
                or details.get('handler_version') != incident['handler_version']
                or not _in_window(event['occurred_at'], start, end)):
            continue
        if event['kind'] not in ('webhook_received', 'handler_completed', 'access_projection_changed'):
            continue
        user_id = event['app_user_id']
        source_id = event['source_event_id']
        ref = candidates.setdefault(user_id, {}).setdefault(source_id, {
            'candidate': False, 'completed': False, 'transition': False,
            'source_event_id': source_id,
        })
        if event['kind'] == 'webhook_received':
            ref['candidate'] = True
    for event in events:
        source_records = candidates.get(event['app_user_id'], {})
        ref = source_records.get(event['source_event_id'])
        if not ref or not _in_window(event['occurred_at'], start, end):
            continue
        details = event['details']
        if details.get('handler_version') != incident['handler_version']:
            continue
        if (event['kind'] == 'handler_completed' and details.get('outcome') == 'completed'
                and _in_window(details.get('processed_at'), start, end)):
            ref['completed'] = True
        if (event['kind'] == 'access_projection_changed'
                and details.get('event_type') == incident['event_type']
                and _in_window(details.get('processed_at'), start, end)
                and details.get('before') != details.get('after')):
            ref['transition'] = True
    return candidates


def _best_candidate(candidates):
    if isinstance(candidates, dict) and isinstance(candidates.get('candidate'), bool):
        return candidates
    records = list(candidates.values())
    return max(records, key=lambda record: (record['completed'], record['transition'])) if records else None


def _customer_denial(state, user_id):
    return any(event['kind'] == 'feature_access_decided'
               and event['app_user_id'] == user_id
               and event['details'].get('initiator') == 'customer_demo'
               and event['details'].get('decision') == 'deny'
               for event in state['collector']['events'])


def _account_rows(state):
    incident = state['incident']
    scan = state.get('last_scan')
    per_user = scan.get('causal', {}) if scan else {}
    at = lumen_app.now(state)
    target_ids = set(state.get('recovery_target_ids', []))
    accounts = []
    for row in state['registry']:
        user_id = row['app_user_id']
        identity = lumen_app.identity_status(state, user_id)
        source = state['source_entitlements'].get(user_id)
        source_freshness = lumen_app.freshness(source, at)
        source_current = lumen_app.source_current(source, at)
        gate = lumen_app.assess_gate(state, user_id, incident['feature'] if incident else FEATURE)
        candidate_event = _best_candidate(per_user.get(user_id, {}))
        candidate = bool(candidate_event and candidate_event['candidate'])
        processing_complete = bool(candidate_event and candidate_event['completed']
                                   and candidate_event['transition'])
        policy = state['feature_policy'].get(user_id, {})
        latest_verification = state['verification'].get(user_id)

        eligible = False
        if user_id in target_ids:
            verified = bool(latest_verification and latest_verification['allowed']
                            and gate['allowed'])
            if verified and _verification_current(state, user_id, latest_verification, gate):
                status, reason = 'restored', 'access_verified_through_gate'
            else:
                status, reason = 'pending_verification', (
                    'verification_context_stale' if latest_verification and latest_verification['allowed']
                    else 'verification_gate_denied' if latest_verification else 'awaiting_verification'
                )
                eligible = bool(latest_verification and not latest_verification['allowed']
                                and identity == 'mapped'
                                and source_freshness == 'fresh' and source_current
                                and policy.get('enabled') and not gate['allowed']
                                and gate['reason'] in ('subscription_inactive', 'cache_stale')
                                and processing_complete)
        elif not scan:
            status, reason = 'outside_incident', 'detection_required'
        elif identity != 'mapped':
            status, reason = 'inconclusive', {
                'ambiguous': 'ambiguous_or_many_to_one_identity_mapping',
                'source_mismatch': 'mapping_source_identity_mismatch',
            }.get(identity, 'ambiguous_or_unavailable_identity_mapping')
        elif source_freshness != 'fresh':
            status, reason = 'inconclusive', 'source_unavailable_or_stale'
        elif not source:
            status, reason = 'inconclusive', 'source_unavailable_or_stale'
        elif (source.get('period_type') != 'annual' or source.get('product_id') != 'premium.annual'
              or source.get('environment') != ENVIRONMENT):
            status, reason = 'inconclusive', 'unsupported_entitlement_shape'
        elif not source_current:
            starts = _parse_time(source['starts_at'], 'source starts_at')
            expires = _parse_time(source['expires_at'], 'source expires_at')
            if starts <= at and expires <= at:
                status, reason = 'legitimate_denial', 'source_entitlement_expired'
            else:
                status, reason = 'inconclusive', 'source_entitlement_not_current'
        elif not policy.get('enabled') or policy.get('feature') != FEATURE:
            status, reason = 'policy_denial', 'feature_policy_denies_access'
        elif (processing_complete and not gate['allowed']
              and gate['reason'] in ('subscription_inactive', 'cache_stale')):
            status, reason, eligible = 'confirmed', 'active_entitlement_denied_after_cancellation', True
        elif gate['allowed']:
            status, reason = 'healthy', 'premium_gate_allows_access'
        elif candidate and not processing_complete:
            status, reason = 'inconclusive', 'cancellation_processing_incomplete'
        elif candidate:
            status, reason = 'inconclusive', 'cancellation_did_not_cause_subscription_denial'
        else:
            status, reason = 'inconclusive', 'active_entitlement_denied_without_incident_evidence'

        accounts.append({
            'id': user_id,
            'status': status,
            'reason': reason,
            'source_active': source_current,
            'source_expires_at': source.get('expires_at') if source else None,
            'source_freshness': source_freshness,
            'gate': {key: gate[key] for key in ('allowed', 'reason', 'projection_revision', 'cache_revision')},
            'observed_customer_denial': _customer_denial(state, user_id),
            'candidate': candidate,
            'eligible': eligible,
        })
    return accounts


def _verification_current(state, user_id, verification, gate):
    source = state['source_entitlements'].get(user_id)
    if not source or not lumen_app.source_current(source, lumen_app.now(state)):
        return False
    if lumen_app.freshness(source, lumen_app.now(state)) != 'fresh':
        return False
    policy = state['feature_policy'].get(user_id, {})
    return bool(
        verification['run_id'] == state['manifest']['run_id']
        and verification['app'] == APP
        and verification['environment'] == ENVIRONMENT
        and verification['source_hash'] == source['source_hash']
        and verification['mapping_hash'] == _mapping_digest(state, user_id)
        and verification['policy'] == policy
        and verification['policy_version'] == state['manifest']['policy_version']
        and verification['adapter_version'] == state['manifest']['adapter_version']
        and verification['projection_revision'] == gate['projection_revision']
        and verification['cache_revision'] == gate['cache_revision']
        and verification['allowed'] and gate['allowed']
    )


def _plan_summaries(state):
    result = []
    for plan in state['plans'].values():
        applied = any(action['plan_id'] == plan['id'] for action in state['actions'].values())
        result.append({
            'id': plan['id'], 'plan_hash': plan['plan_hash'],
            'created_at': plan['created_at'], 'expires_at': plan['expires_at'],
            'status': 'applied' if applied else ('approved' if plan['id'] in state['approvals'] else 'previewed'),
            'target_count': len(plan['entries']), 'retry_of': plan.get('retry_of'),
            'entries': [{'account_id': entry['account_id']} for entry in plan['entries']],
        })
    return result


def _report(state):
    accounts = _account_rows(state)
    counts = Counter(account['status'] for account in accounts)
    target_ids = state.get('recovery_target_ids', [])
    by_id = {account['id']: account for account in accounts}
    verified = sum(1 for user_id in target_ids if by_id.get(user_id, {}).get('status') == 'restored')
    unresolved = max(0, len(target_ids) - verified)
    incident = state.get('incident') or {
        'id': None,
        'window_start': access_fixtures.DEFAULT_START,
        'window_end': access_fixtures.DEFAULT_END,
        'event_type': EVENT_TYPE,
        'handler_version': lumen_app.FAULTY_HANDLER,
        'feature': FEATURE,
    }
    collector_events = state['collector']['events']
    kind_counts = Counter(event['kind'] for event in collector_events)
    unresolved_ids = [user_id for user_id in target_ids
                      if by_id.get(user_id, {}).get('eligible')]
    return {
        'mode': 'FULL_MOCK',
        'manifest': {**deepcopy(state['manifest']),
                     'logical_now': _now(state),
                     'time_basis': 'deterministic scenario clock; demo advance changes logical_now'},
        'consumer': {'mode': state['consumer']['mode'],
                     'handler_version': state['consumer']['handler_version']},
        'incident': deepcopy(incident),
        'summary': {
            'in_scope': len(state['registry']),
            'evaluated': (len(accounts) - counts['inconclusive']) if state.get('last_scan') else 0,
            'confirmed': counts['confirmed'],
            'healthy': counts['healthy'],
            'legitimate_denial': counts['legitimate_denial'],
            'policy_denial': counts['policy_denial'],
            'inconclusive': counts['inconclusive'],
            'restored': counts['restored'],
            'unresolved': unresolved,
            'pending_verification': counts['pending_verification'],
        },
        'recovery': {
            'target_count': len(target_ids),
            'verified_count': verified,
            'unresolved_count': unresolved,
            'root_cause_status': 'pending' if state['consumer']['mode'] == 'faulty' else 'resolved',
            'latest_plan_id': state.get('latest_plan_id'),
            'unresolved_ids': unresolved_ids,
        },
        'accounts': accounts,
        'plans': _plan_summaries(state),
        'history': deepcopy(state['history']),
        'collector': {
            'event_count': len(collector_events),
            'kinds': {kind: kind_counts.get(kind, 0) for kind in sorted(
                ('webhook_received', 'handler_completed', 'access_projection_changed',
                 'feature_access_decided', 'resync_requested', 'resync_completed',
                 'verification_completed', 'source_entitlement_observed'))},
        },
    }


def report():
    with STATE_LOCK:
        return _report(read())


def detect(body):
    with STATE_LOCK:
        state = read()
        incident = _parse_incident(body, state)
        candidates = _scan_causal_events(state, incident)
        sdk = _sdk_for_state(state)
        # Every registry row is probed; only matching webhook rows are candidates.
        for row in state['registry']:
            user_id = row['app_user_id']
            lumen_app.read_source(state, user_id, sdk)
            lumen_app.gate(state, sdk, user_id, initiator='reconcile_probe',
                           feature=incident['feature'])
        state['incident'] = incident
        state['scan_sequence'] += 1
        candidate_ids = sorted(user_id for user_id, events in candidates.items()
                               if any(record['candidate'] for record in events.values()))
        state['last_scan'] = {
            'incident_id': incident['id'],
            'scanned_at': _now(state),
            'sequence': state['scan_sequence'],
            'candidate_ids': candidate_ids,
            'causal': {user_id: _best_candidate(events) for user_id, events in candidates.items()},
        }
        _history(state, 'detection_completed', evaluated=len(state['registry']),
                 candidates=len(candidate_ids), incident_id=incident['id'])
        save(state)
        return _report(state)


def _selected_ids(value):
    if not isinstance(value, list) or not value or len(value) > 100:
        raise APIError('ids must be a non-empty list of eligible account IDs')
    if any(not isinstance(user_id, str) or not user_id.strip() for user_id in value):
        raise APIError('ids must contain account IDs')
    if len(set(value)) != len(value):
        raise APIError('Duplicate account ID')
    return value


def _mapping_digest(state, user_id):
    return digest(state['mappings'].get(user_id))


def _plan_current(state, plan):
    if not state.get('last_scan') or plan['incident_id'] != state['incident']['id']:
        return False
    if plan['run_id'] != state['manifest']['run_id'] or plan['app'] != APP or plan['environment'] != ENVIRONMENT:
        return False
    if plan['policy_version'] != state['manifest']['policy_version'] or plan['adapter_version'] != state['manifest']['adapter_version']:
        return False
    if _parse_time(_now(state), 'scenario time') >= _parse_time(plan['expires_at'], 'plan expires_at'):
        return False
    for entry in plan['entries']:
        user_id = entry['account_id']
        source = state['source_entitlements'].get(user_id)
        mapping = state['mappings'].get(user_id)
        if (not source or not mapping or mapping.get('status') != 'mapped'
                or lumen_app.identity_status(state, user_id) != 'mapped'):
            return False
        if source != entry['source_observation'] or mapping != entry['mapping_observation']:
            return False
        if source.get('source_hash') != entry['source_hash'] or _mapping_digest(state, user_id) != entry['mapping_hash']:
            return False
        if source.get('expires_at') != entry['source_expires_at']:
            return False
        if not lumen_app.source_current(source, lumen_app.now(state)):
            return False
        if lumen_app.freshness(source, lumen_app.now(state)) != 'fresh':
            return False
        policy = state['feature_policy'].get(user_id, {})
        if (not policy.get('enabled') or policy.get('feature') != plan['feature']
                or policy.get('policy_version') != plan['policy_version']):
            return False
        if policy != entry['policy']:
            return False
        projection = lumen_app.snapshot(state['projection'].get(user_id))
        cache = lumen_app.snapshot(state['cache'].get(user_id))
        if projection != entry['before']['projection'] or cache != entry['before']['cache']:
            return False
    return True


def preview(body):
    body = _body(body)
    ids = _selected_ids(body.get('ids'))
    with STATE_LOCK:
        state = read()
        if not state.get('last_scan'):
            raise APIError('Run detection before previewing a recovery plan', 409)
        accounts = {account['id']: account for account in _account_rows(state)}
        retry_of = body.get('retry_of')
        if retry_of is not None:
            original = state['plans'].get(retry_of)
            if not original or not any(action['plan_id'] == retry_of for action in state['actions'].values()):
                raise APIError('retry_of must identify an applied plan', 409)
            eligible_ids = set(_report(state)['recovery']['unresolved_ids'])
        else:
            eligible_ids = {user_id for user_id, account in accounts.items()
                             if account['status'] == 'confirmed' and account['eligible']}
        if not set(ids).issubset(eligible_ids):
            raise APIError('Every selected account must be currently eligible for this repair', 409)
        now = lumen_app.now(state)
        entries = []
        for user_id in ids:
            source = state['source_entitlements'][user_id]
            policy = deepcopy(state['feature_policy'][user_id])
            projection = deepcopy(state['projection'][user_id])
            cache = deepcopy(state['cache'][user_id])
            after_projection = {
                **projection, 'active': True, 'premium': True,
                'expires_at': source['expires_at'], 'source_hash': source['source_hash'],
                'revision': projection['revision'] + 1,
                'projection_revision': projection['projection_revision'] + 1,
            }
            after_cache = {
                'active': True, 'premium': True, 'expires_at': source['expires_at'],
                'cache_revision': cache['cache_revision'] + 1,
                'projection_revision': after_projection['projection_revision'],
                'source_hash': source['source_hash'], 'invalidated': False,
                'cached_at': _now(state),
            }
            entries.append({
                'account_id': user_id,
                'before': {'projection': lumen_app.snapshot(projection),
                           'cache': lumen_app.snapshot(cache)},
                'after': {'projection': lumen_app.snapshot(after_projection),
                          'cache': lumen_app.snapshot(after_cache)},
                'source_hash': source['source_hash'],
                'source_expires_at': source['expires_at'],
                'source_observation': deepcopy(source),
                'mapping_hash': _mapping_digest(state, user_id),
                'mapping_observation': deepcopy(state['mappings'][user_id]),
                'policy': policy,
                'target_revision': after_projection['projection_revision'],
                'cache_revision': after_cache['cache_revision'],
                'policy_version': state['manifest']['policy_version'],
                'adapter_version': state['manifest']['adapter_version'],
                'reason': 'resync_current_annual_entitlement_and_refresh_cache',
            })
        plan_id = 'plan-' + secrets.token_hex(8)
        plan = {
            'id': plan_id,
            'run_id': state['manifest']['run_id'],
            'app': APP,
            'environment': ENVIRONMENT,
            'incident_id': state['incident']['id'],
            'feature': state['incident']['feature'],
            'created_at': _now(state),
            'expires_at': lumen_app.iso(now + timedelta(seconds=PLAN_TTL)),
            'policy_version': state['manifest']['policy_version'],
            'adapter_version': state['manifest']['adapter_version'],
            'retry_of': retry_of,
            'entries': entries,
            'exclusions': [],
        }
        plan['plan_hash'] = digest(plan)
        state['plans'][plan_id] = plan
        _history(state, 'recovery_previewed', plan_id=plan_id, selected=len(entries), retry_of=retry_of)
        save(state)
        return {**deepcopy(plan), 'plan': deepcopy(plan), 'report': _report(state)}


def _require_plan(state, body):
    plan_id = body.get('plan_id')
    plan_hash = body.get('plan_hash')
    if not isinstance(plan_id, str) or not isinstance(plan_hash, str):
        raise APIError('plan_id and plan_hash are required')
    plan = state['plans'].get(plan_id)
    if not plan or plan['plan_hash'] != plan_hash:
        raise APIError('Unknown plan or stale plan hash', 409)
    return plan


def approve(body):
    body = _body(body)
    with STATE_LOCK:
        state = read()
        plan = _require_plan(state, body)
        actor = body.get('actor')
        if not isinstance(actor, str) or not actor.strip() or len(actor.strip()) > 128:
            raise APIError('actor must be a non-empty human review identity')
        if _parse_time(_now(state), 'scenario time') >= _parse_time(plan['expires_at'], 'plan expires_at'):
            raise APIError('Plan has expired; run a fresh preview', 409)
        if plan['id'] in state['approvals']:
            existing = state['approvals'][plan['id']]
            if existing['actor'] == actor.strip() and existing['plan_hash'] == plan['plan_hash']:
                return {'approval': deepcopy(existing), 'plan_id': plan['id'], 'duplicate': True,
                        'report': _report(state)}
            raise APIError('Plan already has a different approval', 409)
        approval = {
            'plan_id': plan['id'], 'plan_hash': plan['plan_hash'],
            'actor': actor.strip(), 'approved_at': _now(state),
            'decision': 'approved',
        }
        state['approvals'][plan['id']] = approval
        _history(state, 'recovery_approved', plan_id=plan['id'], actor=approval['actor'])
        save(state)
        return {'approval': deepcopy(approval), 'plan_id': plan['id'],
                'duplicate': False, 'report': _report(state)}


def apply(body):
    body = _body(body)
    with STATE_LOCK:
        state = read()
        plan = _require_plan(state, body)
        if plan['id'] not in state['approvals']:
            raise APIError('Human approval is required before applying this plan', 409)
        action_ids = [f"{state['manifest']['run_id']}:{plan['id']}:{entry['account_id']}:resync"
                      for entry in plan['entries']]
        if all(action_id in state['actions'] for action_id in action_ids):
            receipts = [deepcopy(state['actions'][action_id]['receipt']) for action_id in action_ids]
            return {'plan_id': plan['id'], 'writes_accepted': 0,
                    'receipts': receipts, 'duplicate': True,
                    'report': _report(state)}
        if not _plan_current(state, plan):
            raise APIError('Plan preconditions changed; detect and preview again', 409)

        sdk = _sdk_for_state(state)
        new_receipts = []
        pending_actions = []
        for entry, action_id in zip(plan['entries'], action_ids):
            if action_id in state['actions']:
                continue
            user_id = entry['account_id']
            source = state['source_entitlements'][user_id]
            skip_cache = bool(state['_fault_controls'].get('skip_cache_once'))
            if skip_cache:
                state['_fault_controls']['skip_cache_once'] = False
            result = lumen_app.resync(state, sdk, user_id, source, action_id,
                                      skip_cache=skip_cache)
            receipt = {
                'action_id': action_id, 'plan_id': plan['id'],
                'account_id': user_id, 'status': 'transport_accepted',
                'event_receipts': result['receipts'],
                'before': result['before'], 'after': result['after'],
            }
            pending_actions.append((action_id, {
                'plan_id': plan['id'], 'account_id': user_id,
                'receipt': receipt, 'recorded_at': _now(state),
            }))
            new_receipts.append(receipt)
        # The preflight covers the full cohort before any state write; save is atomic.
        for action_id, record in pending_actions:
            state['actions'][action_id] = record
        if not state['recovery_target_ids']:
            state['recovery_target_ids'] = [entry['account_id'] for entry in plan['entries']]
        else:
            state['recovery_target_ids'] = list(dict.fromkeys(
                state['recovery_target_ids'] + [entry['account_id'] for entry in plan['entries']]))
        state['latest_plan_id'] = plan['id']
        _history(state, 'recovery_applied', plan_id=plan['id'], writes_accepted=len(new_receipts))
        save(state)
        return {'plan_id': plan['id'], 'writes_accepted': len(new_receipts),
                'receipts': deepcopy(new_receipts), 'duplicate': False,
                'report': _report(state)}


def verify(body):
    body = _body(body)
    with STATE_LOCK:
        state = read()
        plan_id = body.get('plan_id') or state.get('latest_plan_id')
        if not isinstance(plan_id, str) or plan_id not in state['plans']:
            raise APIError('A previously applied plan is required for verification', 409)
        if not any(action['plan_id'] == plan_id for action in state['actions'].values()):
            raise APIError('Apply the approved plan before verification', 409)
        sdk = _sdk_for_state(state)
        verified_now = []
        for user_id in state['recovery_target_ids']:
            user_actions = [action for action in state['actions'].values()
                            if action['account_id'] == user_id]
            if not user_actions:
                raise APIError('Recovery target has no accepted resync action', 409)
            action = user_actions[-1]
            action_id = action['receipt']['action_id']
            gate = lumen_app.gate(state, sdk, user_id, initiator='reconcile_probe',
                                  feature=FEATURE)
            verification_id = str(uuid5(NAMESPACE_URL,
                                        f"{state['manifest']['run_id']}/{plan_id}/{user_id}/verification/{state['event_seq']}"))
            details = {
                'feature': FEATURE,
                'decision': 'allow' if gate['allowed'] else 'deny',
                'outcome': 'verified' if gate['allowed'] else 'failed',
                'reason_code': gate['reason'],
                'action_id': action_id,
                'policy_version': state['manifest']['policy_version'],
                'adapter_version': state['manifest']['adapter_version'],
                'projection_version': lumen_app.PROJECTION_VERSION,
                'cache_version': lumen_app.CACHE_VERSION,
                'actual_revision': gate['projection_revision'],
            }
            receipt = lumen_app.emit(state, sdk, 'verification_completed', user_id,
                                     _now(state), details,
                                     event_id=verification_id,
                                     source_event_id=gate['event_id'],
                                     correlation_id=gate['event_id'])
            state['verification'][user_id] = {
                'plan_id': plan_id, 'allowed': gate['allowed'],
                'reason': gate['reason'], 'verified_at': _now(state),
                'run_id': state['manifest']['run_id'], 'app': APP,
                'environment': ENVIRONMENT,
                'source_hash': (state['source_entitlements'].get(user_id) or {}).get('source_hash'),
                'mapping_hash': _mapping_digest(state, user_id),
                'policy': deepcopy(state['feature_policy'].get(user_id, {})),
                'policy_version': state['manifest']['policy_version'],
                'adapter_version': state['manifest']['adapter_version'],
                'projection_revision': gate['projection_revision'],
                'cache_revision': gate['cache_revision'],
                'action_id': action_id, 'applied_plan_id': action['plan_id'],
                'gate_event_id': gate['event_id'], 'gate_event_hash': gate['event_hash'],
                'event_id': receipt['event_id'], 'event_hash': receipt['event_hash'],
            }
            verified_now.append({'account_id': user_id, 'allowed': gate['allowed'],
                                 'reason': gate['reason'], 'response_ref': receipt['event_id']})
        _history(state, 'verification_completed', plan_id=plan_id,
                 verified=sum(item['allowed'] for item in verified_now),
                 unresolved=sum(not item['allowed'] for item in verified_now))
        save(state)
        current = _report(state)
        return {
            'plan_id': plan_id,
            'verified_count': current['recovery']['verified_count'],
            'unresolved_count': current['recovery']['unresolved_count'],
            'unresolved_ids': current['recovery']['unresolved_ids'],
            'observations': verified_now,
            'report': current,
        }


def _find_account(state, user_id):
    if not isinstance(user_id, str) or not user_id.strip():
        raise APIError('user_id is required')
    if user_id not in {row['app_user_id'] for row in state['registry']}:
        raise APIError('Unknown Lumen account', 404)
    return user_id


def gate(user_id, initiator='customer_demo'):
    if initiator not in ('customer_demo', 'reconcile_probe'):
        raise APIError('Unsupported gate initiator')
    with STATE_LOCK:
        state = read()
        user_id = _find_account(state, user_id)
        result = lumen_app.gate(state, _sdk_for_state(state), user_id,
                                initiator=initiator, feature=FEATURE)
        safe = {key: result[key] for key in (
            'allowed', 'reason', 'projection_revision', 'cache_revision',
            'preview', 'event_id', 'event_hash',
        )}
        save(state)
        return safe


def demo(body):
    body = _body(body)
    action = body.get('action')
    if action in ('seed', 'reset'):
        return seed(body.get('variant', 0))
    if action == 'handler':
        with STATE_LOCK:
            state = read()
            try:
                consumer = lumen_app.set_handler(state, body.get('mode'))
            except ValueError as exc:
                raise APIError(str(exc)) from exc
            _history(state, 'handler_mode_changed', mode=consumer['mode'],
                     handler_version=consumer['handler_version'])
            save(state)
            return {'consumer': consumer, 'report': _report(state)}
    if action == 'cancel':
        ids = _selected_ids(body.get('ids'))
        with STATE_LOCK:
            state = read()
            for user_id in ids:
                _find_account(state, user_id)
            sdk = _sdk_for_state(state)
            results = [lumen_app.send_cancellation(state, sdk, user_id) for user_id in ids]
            _history(state, 'demo_cancellation_sent', accounts=len(ids))
            save(state)
            return {'cancellations': results, 'report': _report(state)}
    if action == 'advance':
        seconds = body.get('seconds')
        if isinstance(seconds, bool) or not isinstance(seconds, int) or not 0 <= seconds <= MAX_ADVANCE_SECONDS:
            raise APIError(f'seconds must be an integer from 0 to {MAX_ADVANCE_SECONDS}')
        with STATE_LOCK:
            state = read()
            state['logical_elapsed_seconds'] += seconds
            _history(state, 'scenario_clock_advanced', seconds=seconds, now=_now(state))
            save(state)
            return {'scenario_now': _now(state), 'report': _report(state)}
    raise APIError('Unsupported demo action')


def evidence(user_id):
    with STATE_LOCK:
        state = read()
        user_id = _find_account(state, user_id)
        source = state['source_entitlements'].get(user_id)
        events = [deepcopy(event) for event in state['collector']['events']
                  if event['app_user_id'] == user_id]
        actions = [deepcopy(action) for action in state['actions'].values()
                   if action['account_id'] == user_id]
        gate_outcomes = [event for event in events if event['kind'] == 'feature_access_decided']
        return {
            'manifest': {**deepcopy(state['manifest']),
                         'logical_now': _now(state),
                         'time_basis': 'deterministic scenario clock; demo advance changes logical_now'},
            'account_id': user_id,
            'native_source_entitlement': deepcopy(source),
            'mapping': deepcopy(state['mappings'].get(user_id)),
            'source_hash': source.get('source_hash') if source else None,
            'projection': lumen_app.snapshot(state['projection'].get(user_id)),
            'cache': lumen_app.snapshot(state['cache'].get(user_id)),
            'consumer_and_access_journal': events,
            'gate_outcomes': gate_outcomes,
            'repair_receipts': actions,
            'verification': deepcopy(state['verification'].get(user_id)),
            'provenance': state['manifest']['provenance'],
        }


def audit():
    with STATE_LOCK:
        state = read()
        current = _report(state)
        return {
            'manifest': {**deepcopy(state['manifest']),
                         'logical_now': _now(state),
                         'time_basis': 'deterministic scenario clock; demo advance changes logical_now'},
            'incident': deepcopy(current['incident']),
            'findings': deepcopy(current['accounts']),
            'native_source_entitlements': deepcopy(state['source_entitlements']),
            'mappings': deepcopy(state['mappings']),
            'current_projection': {user_id: lumen_app.snapshot(value)
                                   for user_id, value in state['projection'].items()},
            'current_cache': {user_id: lumen_app.snapshot(value)
                              for user_id, value in state['cache'].items()},
            'plans': deepcopy(list(state['plans'].values())),
            'approvals': deepcopy(list(state['approvals'].values())),
            'actions': deepcopy(list(state['actions'].values())),
            'before_after_observations': [
                {'action_id': action['receipt']['action_id'],
                 'account_id': action['account_id'],
                 'before': action['receipt']['before'],
                 'after': action['receipt']['after']}
                for action in state['actions'].values()
            ],
            'verification': deepcopy(list(state['verification'].values())),
            'collector_events': deepcopy(state['collector']['events']),
            'provenance': state['manifest']['provenance'],
        }


def registry():
    with STATE_LOCK:
        state = read()
        return {
            'manifest': deepcopy(state['manifest']),
            'accounts': [{
                'id': row['app_user_id'],
                'mapping_status': lumen_app.identity_status(state, row['app_user_id']),
                'source_freshness': lumen_app.freshness(
                    state['source_entitlements'].get(row['app_user_id']), lumen_app.now(state)),
            } for row in state['registry']],
        }


def journal(query):
    if query is None:
        query = {}
    if not isinstance(query, dict):
        raise APIError('Journal query must be an object')
    with STATE_LOCK:
        state = read()
        events = state['collector']['events']
        user_id, kind = query.get('user_id'), query.get('kind')
        if user_id is not None:
            _find_account(state, user_id)
        if kind is not None and kind not in KINDS:
            raise APIError('Unsupported collector event kind')
        limit = query.get('limit', 200)
        if isinstance(limit, bool) or not isinstance(limit, int) or not 1 <= limit <= 1000:
            raise APIError('limit must be an integer from 1 to 1000')
        result = [deepcopy(event) for event in events
                  if (user_id is None or event['app_user_id'] == user_id)
                  and (kind is None or event['kind'] == kind)]
        return {'events': result[-limit:], 'total': len(result)}


def _check():
    old_state, old_eval = STATE, EVAL
    with TemporaryDirectory(prefix='paid-access-check-') as directory:
        root = Path(directory)
        globals()['STATE'] = root / 'runtime' / 'access_state.json'
        globals()['EVAL'] = root / '_evaluation' / 'access_oracle.json'
        try:
            seed()
            initial = detect({})
            counts = initial['summary']
            assert (counts['confirmed'], counts['healthy'], counts['legitimate_denial'],
                    counts['policy_denial'], counts['inconclusive']) == (24, 60, 6, 4, 6)
            ids = [account['id'] for account in initial['accounts'] if account['eligible']]
            planned = preview({'ids': ids})
            approve({'plan_id': planned['id'], 'plan_hash': planned['plan_hash'], 'actor': 'local-reviewer'})
            applied = apply({'plan_id': planned['id'], 'plan_hash': planned['plan_hash']})
            assert applied['writes_accepted'] == 24
            verified = verify({'plan_id': planned['id']})
            assert (verified['verified_count'], verified['unresolved_count']) == (23, 1)
            failed_ids = verified['unresolved_ids']
            retry = preview({'ids': failed_ids, 'retry_of': planned['id']})
            approve({'plan_id': retry['id'], 'plan_hash': retry['plan_hash'], 'actor': 'local-reviewer'})
            apply({'plan_id': retry['id'], 'plan_hash': retry['plan_hash']})
            result = verify({'plan_id': retry['id']})
            assert (result['verified_count'], result['unresolved_count']) == (24, 0)
            return result['report']
        finally:
            globals()['STATE'], globals()['EVAL'] = old_state, old_eval


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('command', choices=('seed', 'check', 'report'))
    parser.add_argument('--variant', type=int, default=0, choices=(0, 1))
    args = parser.parse_args(argv)
    result = seed(args.variant) if args.command == 'seed' else _check() if args.command == 'check' else report()
    print(json.dumps(result, ensure_ascii=False, indent=2))


if __name__ == '__main__':
    main()
