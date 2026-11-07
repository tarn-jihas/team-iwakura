"""Local Lumen subscription consumer and its actual premium-access gate."""
from __future__ import annotations

from copy import deepcopy
from datetime import datetime, timedelta, timezone
from uuid import NAMESPACE_URL, uuid5

APP = 'mock-lumen-access'
ENVIRONMENT = 'Production'
FEATURE = 'premium_export'
POLICY_VERSION = 'access-policy-v1'
ADAPTER_VERSION = 'lumen-adapter-v1'
PROJECTION_VERSION = 'lumen-projection-v1'
CACHE_VERSION = 'lumen-cache-v1'
FRESHNESS_TTL = 900
FAULTY_HANDLER = 'cancel-handler-v1'
FIXED_HANDLER = 'cancel-handler-v2'


def now(state):
    base = datetime.fromisoformat(state['manifest']['scenario_now'].replace('Z', '+00:00'))
    return (base + timedelta(seconds=state['logical_elapsed_seconds'])).astimezone(timezone.utc)


def iso(value):
    return value.astimezone(timezone.utc).isoformat(timespec='seconds').replace('+00:00', 'Z')


def _event_id(state, name, user_id):
    sequence = state['event_seq']
    state['event_seq'] += 1
    return str(uuid5(NAMESPACE_URL, f"{state['manifest']['run_id']}/lumen/{sequence}/{name}/{user_id}"))


def emit(state, sdk, kind, user_id, occurred_at, details, *, event_id=None,
         source_event_id=None, correlation_id=None):
    event_id = event_id or _event_id(state, kind, user_id)
    return sdk.emit(kind, user_id, occurred_at, details, event_id=event_id,
                    source_event_id=source_event_id or event_id,
                    correlation_id=correlation_id or event_id)


def _projection_from_source(source, at):
    active = source_current(source, at)
    return {
        'active': active,
        'premium': active,
        'expires_at': source.get('expires_at') if source else None,
        'revision': 1,
        'projection_revision': 1,
        'source_hash': source.get('source_hash') if source else 'unavailable',
    }


def _cache_from_projection(projection, at):
    return {
        'active': projection['active'],
        'premium': projection['premium'],
        'expires_at': projection['expires_at'],
        'cache_revision': 1,
        'projection_revision': projection['projection_revision'],
        'source_hash': projection['source_hash'],
        'invalidated': False,
        'cached_at': iso(at),
    }


def new_state(population, manifest):
    at = datetime.fromisoformat(manifest['scenario_now'].replace('Z', '+00:00'))
    projections, caches = {}, {}
    for row in population['registry']:
        user_id = row['app_user_id']
        projection = _projection_from_source(population['source_entitlements'].get(user_id), at)
        projections[user_id] = projection
        caches[user_id] = _cache_from_projection(projection, at)
    return {
        'manifest': manifest,
        'logical_elapsed_seconds': 0,
        'registry': population['registry'],
        'mappings': population['mappings'],
        'source_entitlements': population['source_entitlements'],
        'feature_policy': population['feature_policy'],
        'projection': projections,
        'cache': caches,
        'consumer': {'mode': 'faulty', 'handler_version': FAULTY_HANDLER},
        'event_seq': 0,
        'processed_cancellations': [],
        '_fault_controls': {'skip_cache_once': True},
    }


def snapshot(value):
    """Return only state fields accepted by the collector contract."""
    if value is None:
        return {}
    keys = ('active', 'premium', 'expires_at', 'revision', 'cache_revision',
            'projection_revision', 'source_hash', 'invalidated', 'cached_at')
    return {key: value[key] for key in keys if key in value}


def source_current(source, at):
    if (not isinstance(source, dict) or source.get('period_type') != 'annual'
            or source.get('product_id') != 'premium.annual'
            or source.get('environment') != ENVIRONMENT or source.get('status') != 'active'):
        return False
    try:
        starts = datetime.fromisoformat(source['starts_at'].replace('Z', '+00:00'))
        expires = datetime.fromisoformat(source['expires_at'].replace('Z', '+00:00'))
    except (KeyError, TypeError, ValueError):
        return False
    if starts.tzinfo is None or expires.tzinfo is None:
        return False
    return starts <= at < expires


def identity_status(state, user_id):
    mapping = state['mappings'].get(user_id)
    if not mapping or mapping.get('status') != 'mapped':
        return mapping.get('status', 'unavailable') if mapping else 'unavailable'
    provider_user_id = mapping.get('provider_user_id')
    if not isinstance(provider_user_id, str) or not provider_user_id:
        return 'unavailable'
    source = state['source_entitlements'].get(user_id)
    if source and source.get('provider_user_id') != provider_user_id:
        return 'source_mismatch'
    owners = [app_user_id for app_user_id, item in state['mappings'].items()
              if item.get('status') == 'mapped' and item.get('provider_user_id') == provider_user_id]
    if len(owners) != 1:
        return 'ambiguous'
    return 'mapped'


def source_for_user(state, user_id):
    return deepcopy(state['source_entitlements'].get(user_id)) if identity_status(state, user_id) == 'mapped' else None


def freshness(source, at):
    if not isinstance(source, dict):
        return 'unavailable'
    try:
        observed = datetime.fromisoformat(source['observed_at'].replace('Z', '+00:00'))
    except (KeyError, TypeError, ValueError):
        return 'unavailable'
    return 'fresh' if 0 <= (at - observed).total_seconds() <= FRESHNESS_TTL else 'stale'


def read_source(state, user_id, sdk):
    identity = identity_status(state, user_id)
    source = source_for_user(state, user_id)
    observed_at = iso(now(state))
    details = {
        'source_hash': source.get('source_hash') if source else 'unavailable',
        'starts_at': source.get('starts_at') if source else None,
        'expires_at': source.get('expires_at') if source else None,
        'adapter_version': ADAPTER_VERSION,
        'outcome': 'observed' if source else 'unavailable',
        'reason_code': 'none' if source else ('source_unavailable' if identity == 'mapped' else 'identity_'+identity),
    }
    emit(state, sdk, 'source_entitlement_observed', user_id, observed_at, details)
    return deepcopy(source)


def assess_gate(state, user_id, feature=FEATURE):
    at = now(state)
    identity = identity_status(state, user_id)
    if identity != 'mapped':
        reason = ('identity_ambiguous' if identity == 'ambiguous'
                  else 'identity_mismatch' if identity == 'source_mismatch'
                  else 'identity_unavailable')
        return {'allowed': False, 'reason': reason, 'projection_revision': 0, 'cache_revision': 0}
    policy = state['feature_policy'].get(user_id, {})
    if not policy.get('enabled', False) or policy.get('feature') != feature:
        return {'allowed': False, 'reason': 'policy_restricted',
                'projection_revision': state['projection'].get(user_id, {}).get('projection_revision', 0),
                'cache_revision': state['cache'].get(user_id, {}).get('cache_revision', 0)}
    projection = state['projection'].get(user_id)
    cache = state['cache'].get(user_id)
    if not cache or not projection:
        return {'allowed': False, 'reason': 'cache_unavailable', 'projection_revision': 0, 'cache_revision': 0}
    result = {'projection_revision': projection['projection_revision'],
              'cache_revision': cache['cache_revision']}
    if cache.get('invalidated') or cache.get('projection_revision') != projection.get('projection_revision'):
        return {'allowed': False, 'reason': 'cache_stale', **result}
    expiry = cache.get('expires_at')
    if not expiry or expiry <= iso(at):
        return {'allowed': False, 'reason': 'subscription_expired', **result}
    if not cache.get('active') or not cache.get('premium'):
        return {'allowed': False, 'reason': 'subscription_inactive', **result}
    return {'allowed': True, 'reason': 'allowed', **result}


def gate(state, sdk, user_id, initiator='customer_demo', feature=FEATURE):
    result = assess_gate(state, user_id, feature)
    details = {
        'feature': feature,
        'decision': 'allow' if result['allowed'] else 'deny',
        'reason_code': result['reason'],
        'projection_version': PROJECTION_VERSION,
        'cache_version': CACHE_VERSION,
        'policy_version': POLICY_VERSION,
        'adapter_version': ADAPTER_VERSION,
        'initiator': initiator,
    }
    event_id = _event_id(state, 'feature_access_decided', user_id)
    receipt = sdk.emit('feature_access_decided', user_id, iso(now(state)), details,
                       event_id=event_id, source_event_id=event_id,
                       correlation_id=event_id)
    response = {**result, 'preview': 'Lumen Premium export preview' if result['allowed'] else None,
                'event_id': receipt['event_id'], 'event_hash': receipt['event_hash']}
    return response


def send_cancellation(state, sdk, user_id, occurred_at=None):
    if user_id not in {row['app_user_id'] for row in state['registry']}:
        raise ValueError('Unknown Lumen account')
    at = occurred_at or iso(now(state))
    handler = state['consumer']['handler_version']
    source_event_id = _event_id(state, 'subscription_renewal_cancelled', user_id)
    processed_at = at
    common = {'event_type': 'subscription_renewal_cancelled',
              'handler_version': handler, 'received_at': at,
              'processed_at': processed_at, 'outcome': 'accepted'}
    emit(state, sdk, 'webhook_received', user_id, at, common,
         event_id=source_event_id, source_event_id=source_event_id,
         correlation_id=source_event_id)

    before = deepcopy(state['projection'].get(user_id, {}))
    source = source_for_user(state, user_id)
    if handler == FAULTY_HANDLER:
        after = {**before, 'active': False, 'premium': False,
                 'revision': before.get('revision', 0) + 1,
                 'projection_revision': before.get('projection_revision', 0) + 1}
    else:
        current = source_current(source, now(state))
        after = {**before, 'active': current, 'premium': current,
                 'expires_at': source.get('expires_at') if source else None,
                 'source_hash': source.get('source_hash') if source else 'unavailable',
                 'revision': before.get('revision', 0) + 1,
                 'projection_revision': before.get('projection_revision', 0) + 1}
    state['projection'][user_id] = after
    state['cache'][user_id] = _cache_from_projection(after, now(state))
    state['cache'][user_id]['cache_revision'] = before.get('revision', 0) + 1
    transition = {
        'event_type': 'subscription_renewal_cancelled',
        'handler_version': handler,
        'projection_version': PROJECTION_VERSION,
        'cache_version': CACHE_VERSION,
        'source_hash': after.get('source_hash', 'unavailable'),
        'before': snapshot(before), 'after': snapshot(after),
        'processed_at': processed_at, 'reason_code': 'renewal_cancelled',
        'cache_invalidated': True,
    }
    emit(state, sdk, 'access_projection_changed', user_id, at, transition,
         source_event_id=source_event_id, correlation_id=source_event_id)
    completed = {**common, 'outcome': 'completed', 'reason_code': 'handler_completed'}
    emit(state, sdk, 'handler_completed', user_id, at, completed,
         source_event_id=source_event_id, correlation_id=source_event_id)
    state['processed_cancellations'].append({
        'app_user_id': user_id, 'source_event_id': source_event_id,
        'event_type': 'subscription_renewal_cancelled', 'handler_version': handler,
        'received_at': at, 'processed_at': processed_at, 'outcome': 'completed',
    })
    return {'event_id': source_event_id, 'handler_version': handler,
            'projection_revision': after['projection_revision']}


def set_handler(state, mode):
    if mode not in ('faulty', 'fixed'):
        raise ValueError('mode must be faulty or fixed')
    state['consumer'] = {
        'mode': mode,
        'handler_version': FAULTY_HANDLER if mode == 'faulty' else FIXED_HANDLER,
    }
    return deepcopy(state['consumer'])


def resync(state, sdk, user_id, source, action_id, *, skip_cache=False):
    if identity_status(state, user_id) != 'mapped' or not source_current(source, now(state)):
        raise ValueError('Only a current supported entitlement can be resynced')
    before = deepcopy(state['projection'][user_id])
    before_cache = deepcopy(state['cache'][user_id])
    source_hash = source['source_hash']
    source_event_id = _event_id(state, 'resync', user_id)
    base = {'action_id': action_id, 'source_hash': source_hash,
            'expected_revision': before['revision'],
            'policy_version': POLICY_VERSION, 'adapter_version': ADAPTER_VERSION,
            'projection_version': PROJECTION_VERSION, 'cache_version': CACHE_VERSION,
            'outcome': 'requested', 'reason_code': 'approved_resync'}
    receipts = [emit(state, sdk, 'resync_requested', user_id, iso(now(state)), base,
                     event_id=source_event_id, source_event_id=source_event_id,
                     correlation_id=source_event_id)]

    after = {**before, 'active': True, 'premium': True,
             'expires_at': source['expires_at'], 'source_hash': source_hash,
             'revision': before['revision'] + 1,
             'projection_revision': before['projection_revision'] + 1}
    state['projection'][user_id] = after
    if not skip_cache:
        cache = {
            'active': after['active'], 'premium': after['premium'],
            'expires_at': after['expires_at'],
            'cache_revision': before_cache['cache_revision'] + 1,
            'projection_revision': after['projection_revision'],
            'source_hash': source_hash, 'invalidated': False,
            'cached_at': iso(now(state)),
        }
        state['cache'][user_id] = cache

    changed = {**base, 'outcome': 'projection_updated',
               'before': snapshot(before), 'after': snapshot(after),
               'cache_invalidated': not skip_cache}
    receipts.append(emit(state, sdk, 'access_projection_changed', user_id,
                         iso(now(state)), changed,
                         source_event_id=source_event_id,
                         correlation_id=source_event_id))
    completion = {**base, 'outcome': 'accepted',
                  'reason_code': 'cache_refresh_skipped' if skip_cache else 'resync_completed',
                  'processed_at': iso(now(state)),
                  'cache_invalidated': not skip_cache,
                  'actual_revision': after['revision']}
    receipts.append(emit(state, sdk, 'resync_completed', user_id,
                         iso(now(state)), completion,
                         source_event_id=source_event_id,
                         correlation_id=source_event_id))
    return {
        'transport_accepted': True,
        'cache_refreshed': not skip_cache,
        'before': {'projection': snapshot(before), 'cache': snapshot(before_cache)},
        'after': {'projection': snapshot(after), 'cache': snapshot(state['cache'][user_id])},
        'receipts': receipts,
    }
