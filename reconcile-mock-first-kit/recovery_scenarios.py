"""Deterministic, explicitly synthetic activation-recovery scenarios."""
from __future__ import annotations

from datetime import datetime, timedelta, timezone

APP = 'mock-lumen-activation'
ENVIRONMENT = 'Production'
FEATURE = 'premium_export'
SCENARIO_NOW = '2026-11-07T12:00:00Z'
PROVENANCE = 'synthetic_extension'


def build_scenario(scenario='stripe', variant=0):
    if scenario not in ('stripe', 'paddle', 'custom', 'apple', 'google'):
        raise ValueError('Unsupported recovery scenario')
    if isinstance(variant, bool) or variant not in (0, 1):
        raise ValueError('variant must be 0 or 1')
    prefix = 'v1-' if variant else ''
    now = datetime.fromisoformat(SCENARIO_NOW.replace('Z', '+00:00'))
    accounts, evidence, profiles, mappings, policies, access = [], [], [], [], [], []
    for index in range(100):
        user_id = f'{prefix}u{index:05d}'
        if variant:
            # Keep the distribution while changing every cohort's identity.
            cohort = (index * 37) % 100
        else:
            cohort = index
        kind = ('activation_missing' if cohort < 24 else
                'healthy' if cohort < 84 else
                'expired' if cohort < 90 else
                'policy_denial' if cohort < 94 else
                'identity_unknown' if cohort < 97 else
                'stale' if cohort == 97 else
                'unavailable')
        customer_id = f'cust-{prefix}u{index:05d}'
        identity = 'unknown' if kind == 'identity_unknown' else 'mapped'
        accounts.append({'user_id': user_id, 'provider_customer_id': customer_id,
                         'identity_status': identity, 'provenance': PROVENANCE})
        mappings.append({'user_id': user_id, 'provider_customer_id': customer_id,
                         'status': identity})
        policies.append({'user_id': user_id, 'feature': FEATURE,
                         'enabled': kind != 'policy_denial'})

        has_evidence = kind not in ('unavailable',)
        paid = kind not in ('identity_unknown',)
        if has_evidence and paid:
            is_affected = kind == 'activation_missing'
            is_expired = kind == 'expired'
            starts = now - (timedelta(seconds=120 + index % 90) if is_affected
                            else timedelta(days=365 if is_expired else 30))
            expires = now - timedelta(days=1) if is_expired else now + timedelta(days=335)
            observed = now - timedelta(seconds=1200 if kind == 'stale' else 20)
            occurred = (now - timedelta(seconds=120 + index % 90) if is_affected
                        else now - timedelta(seconds=60) if kind == 'policy_denial'
                        else starts)
            product_id = 'premium.annual'
            price_id = 'price_annual_new' if is_affected else 'price_annual_current'
            payment_state = 'paid' if not is_expired else 'paid'
            evidence.append({
                'transaction_id': f'txn-{prefix}u{index:05d}',
                'original_transaction_id': f'orig-{prefix}u{index:05d}',
                'provider_customer_id': customer_id,
                'user_id': user_id if identity == 'mapped' else None,
                'product_id': product_id, 'price_id': price_id,
                'payment_state': payment_state,
                'access_basis': 'paid_period',
                'starts_at': starts.isoformat().replace('+00:00', 'Z'),
                'expires_at': expires.isoformat().replace('+00:00', 'Z'),
                'amount_minor': 999, 'currency': 'USD',
                'refund_state': 'none', 'occurred_at': occurred.isoformat().replace('+00:00', 'Z'),
                'observed_at': observed.isoformat().replace('+00:00', 'Z'),
                'evidence_ref': f'provider://{scenario}/{prefix}u{index:05d}',
                'provenance': PROVENANCE,
            })
        profile_active = kind in ('healthy', 'policy_denial')
        profiles.append({'user_id': user_id, 'status': 'active' if profile_active else 'missing',
                         'product_id': 'premium.annual' if profile_active else None,
                         'expires_at': (now + timedelta(days=335)).isoformat().replace('+00:00', 'Z') if profile_active else None})
        client_active = kind in ('healthy', 'policy_denial')
        gate_reason = ('policy_restricted' if kind == 'policy_denial' else
                       'subscription_expired' if kind == 'expired' else
                       'identity_unavailable' if kind == 'identity_unknown' else
                       'subscription_inactive' if not client_active else 'allowed')
        access.append({'user_id': user_id, 'active': client_active,
                       'expires_at': expires.isoformat().replace('+00:00', 'Z') if kind in ('activation_missing', 'healthy', 'policy_denial', 'stale') else
                       (now - timedelta(days=1)).isoformat().replace('+00:00', 'Z') if kind == 'expired' else None,
                       'gate_reason': gate_reason,
                       'stale_once': is_affected and index == 0 if (is_affected := kind == 'activation_missing') else False})
    catalog = [{'provider': scenario, 'product_id': 'premium.annual',
                'price_id': 'price_annual_current', 'status': 'mapped', 'revision': 1}]
    return {
        'manifest': {'app': APP, 'environment': ENVIRONMENT,
                     'scenario': scenario, 'variant': variant,
                     'run_id': f'activation-{scenario}-20261107-v{variant}',
                     'scenario_now': SCENARIO_NOW, 'provenance': PROVENANCE},
        'accounts': accounts, 'evidence': evidence, 'profiles': profiles,
        'mappings': mappings, 'policies': policies, 'access': access,
        'catalog': catalog,
    }


def build_offline_manifest(run_id=None):
    """Describe the pinned source-only fixture without making app observations."""
    import hackathon_data

    source = hackathon_data.verify_files()
    run_id = run_id or 'activation-offline-'+source['revision'][:8]
    if (not isinstance(run_id, str) or not run_id or len(run_id) > 96
            or any(not (char.isalnum() or char in '._-') for char in run_id)):
        raise ValueError('Invalid offline run_id')
    customer_prefix = 'lumen_'+run_id.replace('-', '_').replace('.', '_')
    return {'app': APP, 'environment': ENVIRONMENT, 'scenario': 'offline',
            'variant': 0, 'run_id': run_id, 'scenario_now': source['scenario_anchor'],
            'provenance': source['provenance'],
            'source_revision': source['revision'],
            'source_user_count': source['files']['users.csv.gz']['rows'],
            'source_transaction_count': source['files']['transactions.csv.gz']['rows'],
            'source_file_checksums': {name: spec['sha256'] for name, spec in source['files'].items()},
            'payment_verification': 'unverified_synthetic_history',
            'adapty_coverage': 'not_observed',
            'client_gate_coverage': 'not_observed',
            'customer_id_mapping': f'offline u00042 -> {customer_prefix}_00042'}
