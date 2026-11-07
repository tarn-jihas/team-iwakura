"""Read-only Adapty integration for the isolated synthetic-seed demo."""
from __future__ import annotations

from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
from email.utils import parsedate_to_datetime
import http.client
import json
from pathlib import Path
import stat
import time
from uuid import uuid4

import recovery_domain as domain

API_HOST = 'api.adapty.io'
API_PATH = '/api/v2/server-side-api/profile/'
APP_ID = '46a573aa-8c90-4b4b-ba72-2349ae9fb030'
APP_TITLE = 'Lumen - AI Photo Editor (Hackathon)'
ENVIRONMENT = 'hackathon_seed'
SOURCE_ENVIRONMENT = 'Production'
PROVENANCE = 'official_synthetic_seed'
PAYMENT_VERIFICATION = 'not_independently_verified'
MAX_PROFILE_BYTES = 1024 * 1024
MAX_RETRIES = 2


class LiveSourceError(RuntimeError):
    def __init__(self, code, status=503):
        self.code = code
        self.status = status
        super().__init__('Adapty source unavailable (' + code + ')')


def wall_now():
    return datetime.now(timezone.utc).isoformat(timespec='seconds').replace('+00:00', 'Z')


def _time(value):
    if not isinstance(value, str):
        raise ValueError('timestamp missing')
    result = datetime.fromisoformat(value.replace('Z', '+00:00'))
    if result.tzinfo is None or result.utcoffset() is None:
        raise ValueError('timestamp timezone missing')
    return result.astimezone(timezone.utc)


def _text(value):
    return isinstance(value, str) and bool(value.strip()) and value == value.strip()


def load_config(path):
    path = Path(path).resolve(strict=True)
    if not path.is_file():
        raise ValueError('Live config must be a regular file')
    try:
        config = json.loads(path.read_text(encoding='utf-8'))
    except (OSError, json.JSONDecodeError) as exc:
        raise ValueError('Live config is invalid') from exc
    seed = config.get('seed') if isinstance(config, dict) else None
    user_ids = config.get('customer_user_ids') if isinstance(config, dict) else None
    secret_file = config.get('secret_key_file') if isinstance(config, dict) else None
    if (not isinstance(config, dict) or config.get('app_id') != APP_ID
            or config.get('title') != APP_TITLE or config.get('environment') != ENVIRONMENT
            or config.get('source_environment', SOURCE_ENVIRONMENT) != SOURCE_ENVIRONMENT
            or not isinstance(seed, dict) or not _text(seed.get('revision'))
            or not _text(seed.get('run_prefix'))
            or not isinstance(user_ids, list) or len(user_ids) != 100
            or any(not _text(value) or len(value) > 256 for value in user_ids)
            or len(set(user_ids)) != 100 or not isinstance(secret_file, str)
            or not Path(secret_file).is_absolute()):
        raise ValueError('Live config scope is invalid')
    return {**config, 'customer_user_ids': list(user_ids), 'secret_key_file': str(Path(secret_file))}


def public_config(config):
    return {'app_id': APP_ID, 'app_title': APP_TITLE,
            'environment': ENVIRONMENT, 'source_environment': SOURCE_ENVIRONMENT,
            'seed_revision': config['seed']['revision'],
            'seed_run_prefix': config['seed']['run_prefix'],
            'provenance': PROVENANCE, 'payment_verification': PAYMENT_VERIFICATION}


def _load_secret(path):
    path = Path(path)
    info = path.lstat()
    if stat.S_ISLNK(info.st_mode) or not stat.S_ISREG(info.st_mode) or info.st_mode & 0o077:
        raise ValueError('Adapty key file must be a private regular file')
    value = path.read_bytes().strip()
    if not value or len(value) > 4096:
        raise ValueError('Adapty key file is invalid')
    return value.decode('utf-8')


def _retry_delay(value):
    try:
        return min(2.0, max(0.0, float(value)))
    except (TypeError, ValueError):
        try:
            return min(2.0, max(0.0, (parsedate_to_datetime(value)-datetime.now(timezone.utc)).total_seconds()))
        except (TypeError, ValueError, OverflowError):
            return 1.0


class AdaptyReader:
    """Fixed-host, HTTPS-only GET adapter. Tests inject a per-customer transport."""

    def __init__(self, config, transport=None):
        self.config = config
        self._api_key = _load_secret(config['secret_key_file'])
        self.transport = transport or self._https_get

    def _https_get(self, customer_user_id):
        headers = {'Authorization': 'Api-Key ' + self._api_key,
                   'adapty-customer-user-id': customer_user_id,
                   'Accept': 'application/json'}
        for attempt in range(MAX_RETRIES + 1):
            connection = http.client.HTTPSConnection(API_HOST, timeout=5)
            try:
                connection.request('GET', API_PATH, headers=headers)
                response = connection.getresponse()
                body = response.read(MAX_PROFILE_BYTES + 1)
                if len(body) > MAX_PROFILE_BYTES:
                    raise LiveSourceError('response_too_large')
                if response.status == 429:
                    if attempt >= MAX_RETRIES:
                        raise LiveSourceError('rate_limited', 503)
                    delay = _retry_delay(response.getheader('Retry-After'))
                    if delay >= 2.0:
                        raise LiveSourceError('rate_limited', 503)
                    time.sleep(delay)
                    continue
                if response.status != 200:
                    raise LiveSourceError('http_' + str(response.status), 503)
                return body
            except LiveSourceError:
                raise
            except (OSError, http.client.HTTPException, TimeoutError) as exc:
                raise LiveSourceError('transport_error', 503) from exc
            finally:
                connection.close()
        raise LiveSourceError('rate_limited', 503)

    def read(self, customer_user_id):
        try:
            payload = self.transport(customer_user_id)
            raw = payload if isinstance(payload, dict) else json.loads(payload)
            if isinstance(raw, dict) and isinstance(raw.get('data'), dict):
                raw = raw['data']
            if not isinstance(raw, dict):
                raise ValueError('profile object required')
            return normalize_profile(raw, self.config, customer_user_id)
        except LiveSourceError:
            raise
        except (ValueError, TypeError, json.JSONDecodeError, UnicodeDecodeError) as exc:
            raise LiveSourceError('invalid_profile', 502) from exc


def normalize_profile(raw, config, customer_user_id, now=None):
    """Keep exact raw source for the snapshot; exclude only Adapty's read timestamp from its fingerprint."""
    observed_at = wall_now() if now is None else now.astimezone(timezone.utc).isoformat(timespec='seconds').replace('+00:00', 'Z')
    fingerprint_source = dict(raw)
    fingerprint_source.pop('timestamp', None)
    fingerprint_source.pop('observed_at', None)
    source_fingerprint = domain.digest(fingerprint_source)
    result = {'user_id': customer_user_id, 'provider_customer_id': customer_user_id,
              'app_id': raw.get('app_id'), 'profile_id': raw.get('profile_id'),
              'source_fingerprint': source_fingerprint,
              'source_revision': source_fingerprint, 'observed_at': observed_at,
              'raw_source_profile': raw, 'identity_match':
                  raw.get('app_id') == APP_ID and raw.get('customer_user_id') == customer_user_id
                  and _text(raw.get('profile_id')),
              'status': 'unknown', 'reason': 'source_profile_uncertain',
              'entitlement': None, 'provenance': PROVENANCE,
              'payment_verification': PAYMENT_VERIFICATION}
    if not result['identity_match']:
        result['reason'] = 'identity_scope_mismatch'
        return result
    levels = raw.get('access_levels')
    subscriptions = raw.get('subscriptions')
    if not isinstance(levels, list) or not isinstance(subscriptions, list):
        return result
    candidates = [item for item in levels if isinstance(item, dict)
                  and item.get('access_level_id') == 'premium']
    if not candidates:
        result.update(status='inactive', reason='premium_entitlement_absent')
        return result
    now = datetime.now(timezone.utc) if now is None else now.astimezone(timezone.utc)
    evaluated = []
    for level in candidates:
        transaction_id, product_id = level.get('store_transaction_id'), level.get('store_product_id')
        if not _text(transaction_id) or not _text(product_id) or type(level.get('is_in_grace_period')) is not bool:
            continue
        start_value = level.get('starts_at') or level.get('purchased_at')
        try:
            starts_at, expires_at = _time(start_value), _time(level.get('expires_at'))
        except (ValueError, TypeError):
            continue
        if expires_at <= starts_at:
            continue
        matching = [item for item in subscriptions if isinstance(item, dict)
                    and item.get('store_transaction_id') == transaction_id
                    and item.get('store_product_id') == product_id]
        subscription = next((item for item in matching
                             if item.get('environment') == SOURCE_ENVIRONMENT), None)
        if (subscription is None or level.get('store') not in ('app_store', 'play_store')
                or type(subscription.get('is_in_grace_period')) is not bool):
            continue
        if (level.get('store') != subscription.get('store')
                or subscription.get('billing_issue_detected_at') is not None
                or any(subscription.get(key) is not None for key in
                       ('refunded_at', 'revoked_at', 'chargeback_at'))
                or any(level.get(key) is not None for key in
                       ('billing_issue_detected_at', 'refunded_at', 'revoked_at', 'chargeback_at'))):
            continue
        try:
            if _time(subscription.get('expires_at')) != expires_at:
                continue
        except (ValueError, TypeError):
            continue
        status = str(subscription.get('status', '')).lower()
        offer = level.get('offer')
        subscription_offer = subscription.get('offer')
        offer_type = ' '.join(str(value).lower() for value in (
            offer.get('type', '') if isinstance(offer, dict) else offer or '',
            subscription_offer.get('type', '') if isinstance(subscription_offer, dict)
            else subscription_offer or ''))
        trial = (subscription.get('is_trial_period') is True
                 or subscription.get('is_trial') is True
                 or status in ('trial', 'trialing') or 'trial' in offer_type)
        grace = level['is_in_grace_period'] or subscription.get('is_in_grace_period') is True
        if status and status not in ('active', 'expired', 'cancelled', 'canceled', 'renewal_cancelled'):
            continue
        allowed_cancellation_reasons = {'', 'voluntarily_cancelled', 'canceled_by_customer',
                                         'cancelled_by_customer', 'user_cancelled'}
        cancellation_reasons = {str(item.get('cancellation_reason') or '').lower()
                                for item in (level, subscription)}
        if cancellation_reasons - allowed_cancellation_reasons:
            continue
        eligible = starts_at <= now < expires_at and not trial and not grace
        reason = ('trial_period' if trial else 'grace_period' if grace else
                  'subscription_not_started' if starts_at > now else
                  'subscription_expired' if expires_at <= now else 'active')
        evaluated.append((eligible, expires_at, reason, level, subscription, starts_at))
    if not evaluated:
        result.update(status='unknown', reason='premium_source_binding_uncertain')
        return result
    active = [item for item in evaluated if item[0]]
    eligible, expires_at, reason, level, subscription, starts_at = max(
        active or evaluated, key=lambda item: item[1])
    entitlement = {
        'user_id': customer_user_id, 'provider_customer_id': customer_user_id,
        'app_id': APP_ID, 'profile_id': raw['profile_id'],
        'access_level_id': 'premium', 'product_id': level['store_product_id'],
        'transaction_id': level['store_transaction_id'],
        'starts_at': starts_at.isoformat(timespec='seconds').replace('+00:00', 'Z'),
        'purchased_at': level.get('purchased_at'),
        'expires_at': expires_at.isoformat(timespec='seconds').replace('+00:00', 'Z'),
        'is_in_grace_period': level['is_in_grace_period'],
        'subscription_environment': subscription.get('environment'),
        'source_fingerprint': source_fingerprint,
        'source_revision': source_fingerprint, 'observed_at': observed_at,
        'provenance': PROVENANCE, 'payment_verification': PAYMENT_VERIFICATION,
        'raw_source_profile': raw,
    }
    entitlement['entitlement_hash'] = domain.digest({
        'user_id': customer_user_id, 'product_id': entitlement['product_id'],
        'expires_at': entitlement['expires_at']})
    result.update(status='active' if eligible else 'inactive', reason=reason,
                  entitlement=entitlement)
    return result


def _schema(db):
    for statement in (
        'CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY,value TEXT NOT NULL)',
        'CREATE TABLE IF NOT EXISTS live_profiles(user_id TEXT PRIMARY KEY,profile_json TEXT NOT NULL,error_code TEXT)',
        'CREATE TABLE IF NOT EXISTS live_catalog(id INTEGER PRIMARY KEY CHECK(id=1),catalog_json TEXT NOT NULL)',
    ):
        db.execute(statement)


def init_provider(provider_path, adapty_path, config, reader):
    from adapty_seed_setup import read_cli_catalog

    catalog = read_cli_catalog(APP_ID)
    products = catalog.get('products')
    if (catalog.get('app_id') != APP_ID or type(catalog.get('product_count')) is not int
            or not isinstance(products, list) or len(products) != catalog['product_count']
            or not _text(catalog.get('cli_version')) or not _text(catalog.get('observed_at'))
            or not isinstance(catalog.get('source_hash'), str) or len(catalog['source_hash']) != 64
            or any(char not in '0123456789abcdef' for char in catalog['source_hash'])):
        raise ValueError('Adapty CLI catalog scope is invalid')
    catalog_metadata = {'catalog_provenance': 'official_adapty_cli_seed',
        'catalog_product_count': catalog['product_count'],
        'catalog_source_hash': catalog['source_hash'],
        'catalog_cli_version': catalog['cli_version'],
        'catalog_observed_at': catalog['observed_at']}
    provider, adapty = domain.connect(provider_path), domain.connect(adapty_path)
    try:
        for statement in (
            'CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY,value TEXT NOT NULL)',
            'CREATE TABLE IF NOT EXISTS provider_accounts(user_id TEXT PRIMARY KEY,provider_customer_id TEXT NOT NULL UNIQUE,identity_status TEXT NOT NULL,provenance TEXT NOT NULL)',
            'CREATE TABLE IF NOT EXISTS provider_evidence(transaction_id TEXT PRIMARY KEY,original_transaction_id TEXT NOT NULL,provider_customer_id TEXT NOT NULL,user_id TEXT,product_id TEXT NOT NULL,price_id TEXT NOT NULL,payment_state TEXT NOT NULL,access_basis TEXT NOT NULL,starts_at TEXT NOT NULL,expires_at TEXT NOT NULL,amount_minor INTEGER NOT NULL,currency TEXT NOT NULL,refund_state TEXT NOT NULL,occurred_at TEXT NOT NULL,observed_at TEXT NOT NULL,evidence_ref TEXT NOT NULL,evidence_hash TEXT NOT NULL,provenance TEXT NOT NULL)',
            'CREATE TABLE IF NOT EXISTS provider_observations(id INTEGER PRIMARY KEY AUTOINCREMENT,transaction_id TEXT NOT NULL,observed_at TEXT NOT NULL,evidence_hash TEXT NOT NULL,evidence_json TEXT NOT NULL)',
        ):
            provider.execute(statement)
        _schema(provider)
        for statement in (
            'CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY,value TEXT NOT NULL)',
            'CREATE TABLE IF NOT EXISTS catalog(provider TEXT NOT NULL,product_id TEXT NOT NULL,price_id TEXT NOT NULL,status TEXT NOT NULL,revision INTEGER NOT NULL,PRIMARY KEY(provider,price_id))',
            'CREATE TABLE IF NOT EXISTS operations(operation_key TEXT PRIMARY KEY,kind TEXT NOT NULL,request_hash TEXT NOT NULL,result TEXT NOT NULL,created_at TEXT NOT NULL)',
        ):
            adapty.execute(statement)
        manifest = domain._meta(provider, 'initialized')
        if not manifest:
            run_id = config['seed']['run_prefix'] + '-' + config['seed']['revision'][:8] + '-' + uuid4().hex[:10]
            values = {**public_config(config), 'app': APP_ID, 'scenario': 'live_adapty',
                      'scenario_now': wall_now(), 'run_id': run_id,
                      'customer_registry_hash': domain.digest(sorted(config['customer_user_ids'])),
                      'customer_count': len(config['customer_user_ids']),
                      **catalog_metadata}
            provider.execute('BEGIN IMMEDIATE')
            try:
                for table in ('live_profiles', 'provider_observations', 'provider_evidence',
                              'provider_accounts', 'meta'):
                    provider.execute('DELETE FROM ' + table)
                for key, value in values.items():
                    domain._set_meta(provider, key, value)
                domain._set_meta(provider, 'logical_elapsed_seconds', 0)
                for user_id in config['customer_user_ids']:
                    provider.execute('INSERT INTO provider_accounts VALUES(?,?,?,?)',
                        (user_id, user_id, 'unknown', PROVENANCE))
                    provider.execute('INSERT INTO live_profiles VALUES(?,?,?)',
                        (user_id, domain.canonical({'user_id': user_id, 'status': 'unknown',
                         'reason': 'source_not_observed', 'observed_at': None,
                         'entitlement': None, 'identity_match': False,
                         'provenance': PROVENANCE,
                         'payment_verification': PAYMENT_VERIFICATION}), 'source_not_observed'))
                domain._set_meta(provider, 'initialized', True)
                provider.execute('INSERT OR REPLACE INTO live_catalog VALUES(1,?)',
                                 (domain.canonical(catalog),))
                provider.execute('COMMIT')
            except Exception:
                if provider.in_transaction:
                    provider.execute('ROLLBACK')
                raise
            for table in ('meta', 'catalog', 'operations'):
                adapty.execute('DELETE FROM ' + table)
            for key, value in values.items():
                domain._set_meta(adapty, key, value)
            domain._set_meta(adapty, 'initialized', True)
        else:
            saved = domain.manifest(provider)
            if (saved.get('scenario') != 'live_adapty'
                    or saved.get('seed_revision') != config['seed']['revision']
                    or saved.get('seed_run_prefix') != config['seed']['run_prefix']
                    or saved.get('customer_registry_hash') != domain.digest(sorted(config['customer_user_ids']))
                    or saved.get('app') != APP_ID or saved.get('environment') != ENVIRONMENT):
                raise ValueError('Live runtime does not match the configured seed')
            values = catalog_metadata
            provider.execute('BEGIN IMMEDIATE')
            try:
                for key in ('catalog_provenance', 'catalog_product_count',
                            'catalog_source_hash', 'catalog_cli_version', 'catalog_observed_at'):
                    domain._set_meta(provider, key, values[key])
                provider.execute('INSERT OR REPLACE INTO live_catalog VALUES(1,?)',
                                 (domain.canonical(catalog),))
                provider.execute('COMMIT')
            except Exception:
                if provider.in_transaction:
                    provider.execute('ROLLBACK')
                raise
    finally:
        provider.close()
        adapty.close()
    refresh_profiles(provider_path, config, reader, config['customer_user_ids'])


def refresh_profiles(provider_path, config, reader, user_ids):
    if (not isinstance(user_ids, list) or not user_ids or len(user_ids) > 100
            or len(set(user_ids)) != len(user_ids)
            or any(user_id not in config['customer_user_ids'] for user_id in user_ids)):
        raise ValueError('Live refresh scope is invalid')
    results = {}
    with ThreadPoolExecutor(max_workers=8) as executor:
        futures = {user_id: executor.submit(reader.read, user_id) for user_id in user_ids}
        for user_id, future in futures.items():
            try:
                profile = future.result()
                results[user_id] = (profile, None)
            except LiveSourceError as exc:
                results[user_id] = ({'user_id': user_id, 'provider_customer_id': user_id,
                    'status': 'unknown', 'reason': exc.code, 'identity_match': False,
                    'source_fingerprint': None, 'source_revision': None,
                    'observed_at': None, 'entitlement': None, 'provenance': PROVENANCE,
                    'payment_verification': PAYMENT_VERIFICATION}, exc.code)
    db = domain.connect(provider_path)
    try:
        db.execute('BEGIN IMMEDIATE')
        for user_id, (profile, error) in results.items():
            db.execute('INSERT INTO live_profiles VALUES(?,?,?) ON CONFLICT(user_id) DO UPDATE SET profile_json=excluded.profile_json,error_code=excluded.error_code',
                       (user_id, domain.canonical(profile), error))
            db.execute('UPDATE provider_accounts SET identity_status=? WHERE user_id=?',
                       ('mapped' if profile.get('identity_match') else 'unknown', user_id))
        db.execute('COMMIT')
    except Exception:
        if db.in_transaction:
            db.execute('ROLLBACK')
        raise
    finally:
        db.close()
    return {'requested': len(user_ids), 'observed': sum(not error for _, error in results.values()),
            'active': sum(profile.get('status') == 'active' for profile, _ in results.values()),
            'source_observed_at': wall_now()}


def profile(provider_path, user_id):
    db = domain.connect(provider_path)
    try:
        row = db.execute('SELECT profile_json,error_code FROM live_profiles WHERE user_id=?', (user_id,)).fetchone()
        if row is None:
            raise KeyError('Unknown account')
        if row['error_code']:
            raise LiveSourceError(row['error_code'])
        return json.loads(row['profile_json'])
    finally:
        db.close()


def profiles(provider_path, cursor=None, limit=500):
    db = domain.connect(provider_path)
    try:
        offset = domain._cursor(cursor, limit)
        rows = db.execute('SELECT profile_json FROM live_profiles ORDER BY user_id LIMIT ? OFFSET ?',
                          (limit, offset)).fetchall()
        total = db.execute('SELECT COUNT(*) FROM live_profiles').fetchone()[0]
        items = [json.loads(row['profile_json']) for row in rows]
        return {'items': items, 'next_cursor': str(offset+len(items)) if offset+len(items) < total else None,
                'total': total}
    finally:
        db.close()


def status(provider_path):
    result = profiles(provider_path, limit=100)
    items = result['items']
    now = datetime.now(timezone.utc)
    active = []
    for item in items:
        entitlement = item.get('entitlement')
        try:
            if (item.get('status') == 'active' and entitlement
                    and _time(entitlement['starts_at']) <= now < _time(entitlement['expires_at'])
                    and entitlement.get('is_in_grace_period') is False):
                active.append(item)
        except (KeyError, TypeError, ValueError):
            continue
    observed = [item['observed_at'] for item in items if item.get('observed_at')]
    mapped = sum(bool(item.get('identity_match')) for item in items)
    return {'account_count': result['total'], 'active_count': len(active),
            'observed_count': len(observed), 'identity_match_count': mapped,
            'source_observed_at': max(observed) if observed else None,
            'provider_evidence_count': 0,
            'provenance': PROVENANCE,
            'payment_verification': PAYMENT_VERIFICATION,
            'cli_catalog': catalog(provider_path)}


def catalog(provider_path):
    db = domain.connect(provider_path)
    try:
        row = db.execute('SELECT catalog_json FROM live_catalog WHERE id=1').fetchone()
        if row is None:
            raise ValueError('Adapty CLI catalog has not been observed')
        result = json.loads(row['catalog_json'])
        return {**result, 'provenance': 'official_adapty_cli_seed'}
    finally:
        db.close()


def entitlement_rows(provider_path):
    result = profiles(provider_path, limit=100)
    return [item['entitlement'] for item in result['items'] if item.get('entitlement')]
