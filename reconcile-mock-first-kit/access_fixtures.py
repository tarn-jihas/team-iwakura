"""Synthetic access-recovery population; never a downloaded provider ledger."""
from __future__ import annotations

from datetime import datetime
import hashlib
import json

SCENARIO_NOW = '2026-11-03T00:12:04Z'
DEFAULT_START = '2026-11-03T00:05:00Z'
DEFAULT_END = '2026-11-03T00:10:00Z'
AFFECTED = [
    'u00000', 'u00295', 'u00308', 'u00315', 'u00348', 'u00420',
    'u00426', 'u00436', 'u00591', 'u00663', 'u00773', 'u00798',
    'u00950', 'u00998', 'u01029', 'u01064', 'u01078', 'u01217',
    'u01223', 'u01224', 'u01238', 'u01256', 'u01367', 'u01459',
]


def _canonical(value):
    return json.dumps(value, sort_keys=True, ensure_ascii=False,
                      separators=(',', ':'), allow_nan=False).encode('utf-8')


def _hash(value):
    return hashlib.sha256(_canonical(value)).hexdigest()


def _epoch(value):
    return datetime.fromisoformat(value.replace('Z', '+00:00')).timestamp()


def build_population(variant=0):
    """Return app-shaped inputs and a separate private evaluation oracle."""
    if isinstance(variant, bool) or not isinstance(variant, int) or variant not in (0, 1):
        raise ValueError('variant must be 0 or 1')
    other_ids = [f'u{2000 + index:05d}' for index in range(76)]
    all_ids = AFFECTED + other_ids if variant == 0 else [
        'v1-' + user_id for user_id in AFFECTED + other_ids
    ]
    affected = AFFECTED[:] if variant == 0 else ['v1-' + user_id for user_id in other_ids[:24]]
    remaining = [user_id for user_id in all_ids if user_id not in affected]
    expired, restricted, ambiguous, unavailable, stale = (
        remaining[:6], remaining[6:10], remaining[10:13],
        remaining[13:14], remaining[14:16],
    )
    healthy = remaining[16:]

    registry, mappings, sources, policies = [], {}, {}, {}
    for user_id in all_ids:
        registry.append({'app_user_id': user_id, 'environment': 'Production'})
        mappings[user_id] = {'status': 'mapped', 'provider_user_id': user_id}
        if user_id in ambiguous:
            mappings[user_id] = {
                'status': 'ambiguous',
                'provider_user_ids': [user_id + '-a', user_id + '-b'],
            }
        policies[user_id] = {
            'feature': 'premium_export',
            'enabled': user_id not in restricted,
            'policy_version': 'access-policy-v1',
        }
        if user_id in unavailable:
            mappings[user_id] = {'status': 'mapped', 'provider_user_id': user_id}
            continue
        observed = '2026-11-02T23:00:00Z' if user_id in stale else SCENARIO_NOW
        starts_at = '2026-08-04T00:00:00Z'
        expires_at = '2026-11-02T00:00:00Z' if user_id in expired else '2027-08-04T00:00:00Z'
        source = {
            'provider_user_id': user_id,
            'product_id': 'premium.annual',
            'subscription_group': 'premium',
            'period_type': 'annual',
            'environment': 'Production',
            'status': 'active' if _epoch(expires_at) > _epoch(SCENARIO_NOW) else 'expired',
            'starts_at': starts_at,
            'expires_at': expires_at,
            'observed_at': observed,
        }
        source['source_hash'] = _hash(source)
        sources[user_id] = source

    oracle = {
        'variant': variant,
        'affected_ids': affected,
        'expected_counts': {
            'confirmed': 24, 'healthy': 60, 'legitimate_denial': 6,
            'policy_denial': 4, 'inconclusive': 6,
        },
    }
    return {
        'registry': registry,
        'mappings': mappings,
        'source_entitlements': sources,
        'feature_policy': policies,
        'affected_ids': affected,
    }, oracle


def evaluation_record(oracle):
    """Content for the private fixture oracle, never read by detection."""
    return {
        'private_fixture_oracle_not_read_by_engine': True,
        'scenario': 'synthetic reconstruction from supplied incident document',
        **oracle,
    }
