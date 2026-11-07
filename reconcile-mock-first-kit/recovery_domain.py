"""SQLite stores and decision rules for the isolated activation simulator."""
from __future__ import annotations

from datetime import datetime, timedelta, timezone
import hashlib
import json
from pathlib import Path
import sqlite3

import recovery_scenarios

APP = recovery_scenarios.APP
ENVIRONMENT = recovery_scenarios.ENVIRONMENT
FEATURE = recovery_scenarios.FEATURE
FRESHNESS_TTL = 900


def canonical(value):
    return json.dumps(value, sort_keys=True, separators=(',', ':'), ensure_ascii=False,
                      allow_nan=False)


def digest(value):
    return hashlib.sha256(canonical(value).encode('utf-8')).hexdigest()


def connect(path):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    db = sqlite3.connect(path, timeout=15, isolation_level=None)
    db.row_factory = sqlite3.Row
    db.execute('PRAGMA busy_timeout=15000')
    db.execute('PRAGMA foreign_keys=ON')
    return db


def _schema(db, statements):
    for statement in statements:
        db.execute(statement)


def _rows(db, query, params=()):
    return [dict(row) for row in db.execute(query, params)]


def _meta(db, name, default=None):
    row = db.execute('SELECT value FROM meta WHERE key=?', (name,)).fetchone()
    return default if row is None else json.loads(row['value'])


def _set_meta(db, name, value):
    db.execute('INSERT INTO meta(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value',
               (name, canonical(value)))


def _time(value, name='timestamp'):
    if not isinstance(value, str):
        raise ValueError('Invalid '+name)
    try:
        result = datetime.fromisoformat(value.replace('Z', '+00:00'))
    except ValueError as exc:
        raise ValueError('Invalid '+name) from exc
    if result.tzinfo is None or result.utcoffset() is None:
        raise ValueError(name+' must include a timezone')
    return result.astimezone(timezone.utc)


def iso(value):
    return value.astimezone(timezone.utc).isoformat(timespec='seconds').replace('+00:00', 'Z')


def init_provider(path, adapty_path, scenario='stripe', variant=0, reset=False, run_id=None):
    if isinstance(variant, bool) or variant not in (0, 1) or (scenario == 'offline' and variant != 0):
        raise ValueError('variant must be 0 for the offline scenario or 0 or 1 otherwise')
    provider, adapty = connect(path), connect(adapty_path)
    try:
        _schema(provider, [
            'CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY,value TEXT NOT NULL)',
            'CREATE TABLE IF NOT EXISTS provider_accounts(user_id TEXT PRIMARY KEY,provider_customer_id TEXT NOT NULL UNIQUE,identity_status TEXT NOT NULL,provenance TEXT NOT NULL)',
            'CREATE TABLE IF NOT EXISTS provider_evidence(transaction_id TEXT PRIMARY KEY,original_transaction_id TEXT NOT NULL,provider_customer_id TEXT NOT NULL,user_id TEXT,product_id TEXT NOT NULL,price_id TEXT NOT NULL,payment_state TEXT NOT NULL,access_basis TEXT NOT NULL,starts_at TEXT NOT NULL,expires_at TEXT NOT NULL,amount_minor INTEGER NOT NULL,currency TEXT NOT NULL,refund_state TEXT NOT NULL,occurred_at TEXT NOT NULL,observed_at TEXT NOT NULL,evidence_ref TEXT NOT NULL,evidence_hash TEXT NOT NULL,provenance TEXT NOT NULL)',
            'CREATE TABLE IF NOT EXISTS provider_observations(id INTEGER PRIMARY KEY AUTOINCREMENT,transaction_id TEXT NOT NULL,observed_at TEXT NOT NULL,evidence_hash TEXT NOT NULL,evidence_json TEXT NOT NULL)',
        ])
        _schema(adapty, [
            'CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY,value TEXT NOT NULL)',
            'CREATE TABLE IF NOT EXISTS catalog(provider TEXT NOT NULL,product_id TEXT NOT NULL,price_id TEXT NOT NULL,status TEXT NOT NULL,revision INTEGER NOT NULL,PRIMARY KEY(provider,price_id))',
            'CREATE TABLE IF NOT EXISTS profiles(user_id TEXT PRIMARY KEY,status TEXT NOT NULL,product_id TEXT,expires_at TEXT,transaction_id TEXT,revision INTEGER NOT NULL,updated_at TEXT NOT NULL,entitlement_hash TEXT)',
            'CREATE TABLE IF NOT EXISTS operations(operation_key TEXT PRIMARY KEY,kind TEXT NOT NULL,request_hash TEXT NOT NULL,result TEXT NOT NULL,created_at TEXT NOT NULL)',
        ])
        data = None if scenario == 'offline' else recovery_scenarios.build_scenario(scenario, variant)
        manifest = (recovery_scenarios.build_offline_manifest(run_id) if scenario == 'offline'
                    else data['manifest'])
        if run_id is not None and scenario != 'offline':
            if (not isinstance(run_id, str) or not run_id or len(run_id) > 96
                    or any(not (char.isalnum() or char in '._-') for char in run_id)):
                raise ValueError('Invalid run_id')
            manifest = {**manifest, 'run_id': run_id}
            data['manifest'] = manifest
        if reset or not _meta(provider, 'initialized', False):
            if scenario == 'offline':
                import hackathon_data
                provider.execute('BEGIN IMMEDIATE')
                try:
                    for table in ('provider_evidence','provider_observations','provider_accounts','meta'):
                        provider.execute('DELETE FROM '+table)
                    for table in ('transactions','users','provenance'):
                        exists = provider.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?",
                                                  (table,)).fetchone()
                        if exists:
                            provider.execute('DELETE FROM '+table)
                    for name, value in manifest.items():
                        _set_meta(provider, name, value)
                    _set_meta(provider, 'logical_elapsed_seconds', 0)
                    provider.execute('COMMIT')
                except Exception:
                    provider.execute('ROLLBACK')
                    raise
                import_db = sqlite3.connect(path, timeout=15)
                try:
                    imported = hackathon_data.import_offline(import_db)
                finally:
                    import_db.close()
                prefix = 'lumen_'+manifest['run_id'].replace('-', '_').replace('.', '_')
                provider.execute('BEGIN IMMEDIATE')
                try:
                    provider.executemany('INSERT INTO provider_accounts VALUES(?,?,?,?)',
                        ((user_id, prefix+'_'+user_id[1:], 'unknown', manifest['provenance'])
                         for (user_id,) in provider.execute('SELECT id FROM users ORDER BY id')))
                    _set_meta(provider, 'official_import', imported)
                    _set_meta(provider, 'initialized', True)
                    provider.execute('COMMIT')
                except Exception:
                    provider.execute('ROLLBACK')
                    raise
            else:
                provider.execute('BEGIN IMMEDIATE')
                try:
                    provider.execute('DELETE FROM provider_evidence')
                    provider.execute('DELETE FROM provider_observations')
                    provider.execute('DELETE FROM provider_accounts')
                    for table in ('transactions','users','provenance'):
                        exists = provider.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?",
                                                  (table,)).fetchone()
                        if exists:
                            provider.execute('DELETE FROM '+table)
                    provider.execute('DELETE FROM meta')
                    for name, value in manifest.items():
                        _set_meta(provider, name, value)
                    _set_meta(provider, 'logical_elapsed_seconds', 0)
                    for account in data['accounts']:
                        provider.execute('INSERT INTO provider_accounts VALUES(?,?,?,?)',
                                         (account['user_id'], account['provider_customer_id'],
                                          account['identity_status'], account['provenance']))
                    for item in data['evidence']:
                        clean = {**item, 'evidence_hash': digest(item)}
                        provider.execute('INSERT INTO provider_evidence VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
                            tuple(clean[name] for name in ('transaction_id','original_transaction_id','provider_customer_id','user_id','product_id','price_id','payment_state','access_basis','starts_at','expires_at','amount_minor','currency','refund_state','occurred_at','observed_at','evidence_ref','evidence_hash','provenance')))
                        provider.execute('INSERT INTO provider_observations(transaction_id,observed_at,evidence_hash,evidence_json) VALUES(?,?,?,?)',
                                         (clean['transaction_id'], clean['observed_at'], clean['evidence_hash'], canonical(clean)))
                    _set_meta(provider, 'initialized', True)
                    provider.execute('COMMIT')
                except Exception:
                    provider.execute('ROLLBACK')
                    raise
        if reset or not _meta(adapty, 'initialized', False):
            adapty.execute('BEGIN IMMEDIATE')
            try:
                adapty.execute('DELETE FROM operations')
                adapty.execute('DELETE FROM profiles')
                adapty.execute('DELETE FROM catalog')
                adapty.execute('DELETE FROM meta')
                for name, value in manifest.items():
                    _set_meta(adapty, name, value)
                _set_meta(adapty, 'logical_elapsed_seconds', 0)
                if scenario != 'offline':
                    for item in data['catalog']:
                        adapty.execute('INSERT INTO catalog VALUES(?,?,?,?,?)',
                                       (item['provider'], item['product_id'], item['price_id'],
                                        item['status'], item['revision']))
                    for item in data['profiles']:
                        profile_hash = digest({'user_id': item['user_id'], 'product_id': item['product_id'],
                                               'expires_at': item['expires_at']}) if item['status'] == 'active' else None
                        adapty.execute('INSERT INTO profiles VALUES(?,?,?,?,?,?,?,?)',
                                       (item['user_id'], item['status'], item['product_id'],
                                        item['expires_at'], None, 1, manifest['scenario_now'], profile_hash))
                _set_meta(adapty, 'initialized', True)
                adapty.execute('COMMIT')
            except Exception:
                adapty.execute('ROLLBACK')
                raise
    finally:
        provider.close()
        adapty.close()


def init_lumen(path, scenario='stripe', variant=0, reset=False, run_id=None):
    if isinstance(variant, bool) or variant not in (0, 1) or (scenario == 'offline' and variant != 0):
        raise ValueError('variant must be 0 for the offline scenario or 0 or 1 otherwise')
    db = connect(path)
    _schema(db, [
        'CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY,value TEXT NOT NULL)',
        'CREATE TABLE IF NOT EXISTS accounts(user_id TEXT PRIMARY KEY,provider_customer_id TEXT,identity_status TEXT NOT NULL,provenance TEXT NOT NULL)',
        'CREATE TABLE IF NOT EXISTS mappings(user_id TEXT PRIMARY KEY,provider_customer_id TEXT,status TEXT NOT NULL,revision INTEGER NOT NULL)',
        'CREATE TABLE IF NOT EXISTS policies(user_id TEXT PRIMARY KEY,feature TEXT NOT NULL,enabled INTEGER NOT NULL,revision INTEGER NOT NULL)',
        'CREATE TABLE IF NOT EXISTS access(user_id TEXT PRIMARY KEY,active INTEGER NOT NULL,expires_at TEXT,entitlement_hash TEXT,projection_revision INTEGER NOT NULL,cache_revision INTEGER NOT NULL,cache_active INTEGER NOT NULL,cache_expires_at TEXT,cache_entitlement_hash TEXT,cache_invalidated INTEGER NOT NULL,stale_once INTEGER NOT NULL,updated_at TEXT NOT NULL)',
        'CREATE TABLE IF NOT EXISTS actions(operation_key TEXT PRIMARY KEY,request_hash TEXT NOT NULL,result TEXT NOT NULL,created_at TEXT NOT NULL)',
        'CREATE TABLE IF NOT EXISTS mobile_events(event_id TEXT PRIMARY KEY,event_json TEXT NOT NULL,received_at TEXT NOT NULL)',
    ])
    try:
        if reset or not _meta(db, 'initialized', False):
            data = None if scenario == 'offline' else recovery_scenarios.build_scenario(scenario, variant)
            manifest = (recovery_scenarios.build_offline_manifest(run_id) if scenario == 'offline'
                        else data['manifest'])
            if run_id is not None and scenario != 'offline':
                if (not isinstance(run_id, str) or not run_id or len(run_id) > 96
                        or any(not (char.isalnum() or char in '._-') for char in run_id)):
                    raise ValueError('Invalid run_id')
                manifest = {**manifest, 'run_id': run_id}
                data['manifest'] = manifest
            db.execute('BEGIN IMMEDIATE')
            try:
                for table in ('mobile_events','actions','access','policies','mappings','accounts','meta'):
                    db.execute('DELETE FROM '+table)
                for name, value in manifest.items():
                    _set_meta(db, name, value)
                _set_meta(db, 'logical_elapsed_seconds', 0)
                if scenario != 'offline':
                    scenario_evidence = {item['user_id']: item for item in data['evidence'] if item['user_id']}
                    for account in data['accounts']:
                        db.execute('INSERT INTO accounts VALUES(?,?,?,?)',
                                   (account['user_id'], account['provider_customer_id'],
                                    account['identity_status'], account['provenance']))
                    for item in data['mappings']:
                        db.execute('INSERT INTO mappings VALUES(?,?,?,?)',
                                   (item['user_id'], item['provider_customer_id'], item['status'], 1))
                    for item in data['policies']:
                        db.execute('INSERT INTO policies VALUES(?,?,?,?)',
                                   (item['user_id'], item['feature'], int(item['enabled']), 1))
                    for item in data['access']:
                        start_active = bool(item['active'])
                        source = scenario_evidence.get(item['user_id'])
                        product_id = source['product_id'] if source else None
                        entitlement_hash = digest({'user_id': item['user_id'], 'product_id': product_id,
                                                   'expires_at': item['expires_at']}) if start_active else None
                        db.execute('INSERT INTO access VALUES(?,?,?,?,?,?,?,?,?,?,?,?)',
                            (item['user_id'], int(start_active), item['expires_at'], entitlement_hash,
                             1, 1, int(start_active), item['expires_at'], entitlement_hash, 0,
                             int(item['stale_once']), manifest['scenario_now']))
                _set_meta(db, 'initialized', True)
                db.execute('COMMIT')
            except Exception:
                db.execute('ROLLBACK')
                raise
    finally:
        db.close()


def init_live_lumen(path, live_manifest, profiles):
    if (live_manifest.get('customer_count') != 100 or len(profiles) != 100
            or any(not item.get('observed_at') or not item.get('identity_match')
                   for item in profiles)):
        raise ValueError('Live Adapty bootstrap requires 100 observed matching profiles')
    db = connect(path)
    _schema(db, [
        'CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY,value TEXT NOT NULL)',
        'CREATE TABLE IF NOT EXISTS accounts(user_id TEXT PRIMARY KEY,provider_customer_id TEXT,identity_status TEXT NOT NULL,provenance TEXT NOT NULL)',
        'CREATE TABLE IF NOT EXISTS mappings(user_id TEXT PRIMARY KEY,provider_customer_id TEXT,status TEXT NOT NULL,revision INTEGER NOT NULL)',
        'CREATE TABLE IF NOT EXISTS policies(user_id TEXT PRIMARY KEY,feature TEXT NOT NULL,enabled INTEGER NOT NULL,revision INTEGER NOT NULL)',
        'CREATE TABLE IF NOT EXISTS access(user_id TEXT PRIMARY KEY,active INTEGER NOT NULL,expires_at TEXT,entitlement_hash TEXT,projection_revision INTEGER NOT NULL,cache_revision INTEGER NOT NULL,cache_active INTEGER NOT NULL,cache_expires_at TEXT,cache_entitlement_hash TEXT,cache_invalidated INTEGER NOT NULL,stale_once INTEGER NOT NULL,updated_at TEXT NOT NULL)',
        'CREATE TABLE IF NOT EXISTS actions(operation_key TEXT PRIMARY KEY,request_hash TEXT NOT NULL,result TEXT NOT NULL,created_at TEXT NOT NULL)',
        'CREATE TABLE IF NOT EXISTS mobile_events(event_id TEXT PRIMARY KEY,event_json TEXT NOT NULL,received_at TEXT NOT NULL)',
        'CREATE TABLE IF NOT EXISTS live_fault_tags(user_id TEXT PRIMARY KEY,handler_version TEXT NOT NULL,config_version TEXT NOT NULL,occurred_at TEXT NOT NULL)',
    ])
    try:
        if _meta(db, 'initialized', False):
            current = manifest(db)
            if current.get('scenario') != 'live_adapty' or current.get('run_id') != live_manifest.get('run_id'):
                raise ValueError('Live Lumen runtime scope changed')
            return
        db.execute('BEGIN IMMEDIATE')
        try:
            now = iso(datetime.now(timezone.utc))
            for name, value in live_manifest.items():
                _set_meta(db, name, value)
            _set_meta(db, 'scenario_now', now)
            _set_meta(db, 'logical_elapsed_seconds', 0)
            for profile in profiles:
                user_id = profile['user_id']
                entitlement = profile.get('entitlement')
                active = bool(profile.get('status') == 'active' and entitlement)
                customer_id = profile.get('provider_customer_id', user_id)
                # The configured app/customer registry is the local identity map; source validation is separate.
                identity = 'mapped' if customer_id == user_id else 'unknown'
                db.execute('INSERT INTO accounts VALUES(?,?,?,?)',
                           (user_id, customer_id, identity, _meta(db, 'provenance')))
                db.execute('INSERT INTO mappings VALUES(?,?,?,?)',
                           (user_id, customer_id, identity, 1))
                db.execute('INSERT INTO policies VALUES(?,?,?,?)', (user_id, FEATURE, 1, 1))
                expires_at = entitlement.get('expires_at') if active else None
                entitlement_hash = entitlement.get('entitlement_hash') if active else None
                db.execute('INSERT INTO access VALUES(?,?,?,?,?,?,?,?,?,?,?,?)',
                    (user_id, int(active), expires_at, entitlement_hash, 1, 1,
                     int(active), expires_at, entitlement_hash, 0, 0,
                     profile.get('observed_at') or now))
            _set_meta(db, 'initialized', True)
            db.execute('COMMIT')
        except Exception:
            if db.in_transaction:
                db.execute('ROLLBACK')
            raise
    finally:
        db.close()


def manifest(db):
    return {row['key']: json.loads(row['value']) for row in db.execute('SELECT key,value FROM meta')
            if row['key'] not in ('logical_elapsed_seconds', 'last_advance_at', 'initialized')}


def logical_now(db):
    base = _time(_meta(db, 'scenario_now'), 'scenario_now')
    elapsed = _meta(db, 'logical_elapsed_seconds', 0)
    return base + timedelta(seconds=elapsed)


def _app_now(db):
    return datetime.now(timezone.utc) if _meta(db, 'scenario') == 'live_adapty' else logical_now(db)


def advance_clock(path, seconds):
    if isinstance(seconds, bool) or not isinstance(seconds, int) or not 1 <= seconds <= 86400:
        raise ValueError('seconds must be an integer from 1 to 86400')
    db = connect(path)
    try:
        db.execute('BEGIN IMMEDIATE')
        _set_meta(db, 'logical_elapsed_seconds', _meta(db, 'logical_elapsed_seconds', 0) + seconds)
        _set_meta(db, 'last_advance_at', iso(logical_now(db)))
        db.execute('COMMIT')
        return {'logical_now': iso(logical_now(db))}
    except Exception:
        db.execute('ROLLBACK')
        raise
    finally:
        db.close()


def provider_accounts(path, cursor=None, limit=500):
    db = connect(path)
    try:
        offset = _cursor(cursor, limit)
        rows = _rows(db, 'SELECT user_id,provider_customer_id,identity_status,provenance FROM provider_accounts ORDER BY user_id LIMIT ? OFFSET ?', (limit, offset))
        total = db.execute('SELECT COUNT(*) FROM provider_accounts').fetchone()[0]
        return {'items': rows, 'next_cursor': str(offset+len(rows)) if offset+len(rows) < total else None,
                'total': total}
    finally:
        db.close()


def provider_evidence(path, user_id=None, cursor=None, limit=500):
    db = connect(path)
    try:
        offset = _cursor(cursor, limit)
        if user_id is not None:
            rows = _rows(db, 'SELECT * FROM provider_evidence WHERE user_id=? ORDER BY occurred_at,transaction_id LIMIT ? OFFSET ?', (user_id, limit, offset))
            total = db.execute('SELECT COUNT(*) FROM provider_evidence WHERE user_id=?', (user_id,)).fetchone()[0]
        else:
            rows = _rows(db, 'SELECT * FROM provider_evidence ORDER BY transaction_id LIMIT ? OFFSET ?', (limit, offset))
            total = db.execute('SELECT COUNT(*) FROM provider_evidence').fetchone()[0]
        return {'items': rows, 'next_cursor': str(offset+len(rows)) if offset+len(rows) < total else None, 'total': total}
    finally:
        db.close()


def provider_history(path, user_id=None, cursor=None, limit=500):
    """Return source fixture rows as explicitly unverified history, never receipts."""
    db = connect(path)
    try:
        if _meta(db, 'scenario') != 'offline':
            raise ValueError('Source history is available only in the offline scenario')
        offset = _cursor(cursor, limit)
        if user_id is None:
            rows = _rows(db, 'SELECT user_id,seq,raw FROM transactions ORDER BY user_id,seq LIMIT ? OFFSET ?',
                         (limit, offset))
            total = db.execute('SELECT COUNT(*) FROM transactions').fetchone()[0]
        else:
            rows = _rows(db, 'SELECT user_id,seq,raw FROM transactions WHERE user_id=? ORDER BY seq LIMIT ? OFFSET ?',
                         (user_id, limit, offset))
            total = db.execute('SELECT COUNT(*) FROM transactions WHERE user_id=?', (user_id,)).fetchone()[0]
        items = [{'source_user_id': row['user_id'],
                  'source_transaction_id': row['user_id']+':'+str(row['seq']),
                  'payment_verification': 'unverified_synthetic_history',
                  'transaction': json.loads(row['raw'])} for row in rows]
        return {'items': items,
                'next_cursor': str(offset+len(rows)) if offset+len(rows) < total else None,
                'total': total}
    finally:
        db.close()


def adapty_profiles(path, user_id=None, cursor=None, limit=500):
    db = connect(path)
    try:
        if user_id is not None:
            row = db.execute('SELECT * FROM profiles WHERE user_id=?', (user_id,)).fetchone()
            return None if row is None else dict(row)
        offset = _cursor(cursor, limit)
        rows = _rows(db, 'SELECT * FROM profiles ORDER BY user_id LIMIT ? OFFSET ?', (limit, offset))
        total = db.execute('SELECT COUNT(*) FROM profiles').fetchone()[0]
        return {'items': rows, 'next_cursor': str(offset+len(rows)) if offset+len(rows) < total else None,
                'total': total}
    finally:
        db.close()


def adapty_catalog(path):
    db = connect(path)
    try:
        return {'items': _rows(db, 'SELECT * FROM catalog ORDER BY provider,price_id'),
                'revision': db.execute('SELECT COALESCE(MAX(revision),0) FROM catalog').fetchone()[0]}
    finally:
        db.close()


def _cursor(cursor, limit):
    if isinstance(limit, bool) or not isinstance(limit, int) or not 1 <= limit <= 1000:
        raise ValueError('limit must be an integer from 1 to 1000')
    if cursor in (None, ''):
        return 0
    if not isinstance(cursor, str) or not cursor.isdigit():
        raise ValueError('Invalid cursor')
    return int(cursor)


def _current(evidence, now):
    return (_time(evidence['starts_at'], 'starts_at') <= now <
            _time(evidence['expires_at'], 'expires_at'))


def provider_validate(provider_path, adapty_path, body):
    required = {'provider', 'transaction_id', 'user_id', 'operation_key', 'contract_trace'}
    if not isinstance(body, dict) or set(body) != required:
        raise ValueError('Validation fields do not match the contract')
    for name in required - {'contract_trace'}:
        if not isinstance(body[name], str) or not body[name].strip() or len(body[name]) > 256:
            raise ValueError('Invalid '+name)
    if not all(char.isalnum() or char in '._:-' for char in body['operation_key']):
        raise ValueError('Invalid operation_key')
    trace = body['contract_trace']
    if (not isinstance(trace, dict)
            or set(trace) != {'provider', 'method', 'path', 'content_type', 'body'}
            or trace['provider'] != body['provider']
            or not all(isinstance(trace[name], str) and trace[name]
                       for name in ('method', 'path', 'content_type'))
            or not isinstance(trace['body'], dict)):
        raise ValueError('Invalid provider request contract trace')
    provider = connect(provider_path)
    adapty = connect(adapty_path)
    adapty.execute('BEGIN IMMEDIATE')
    try:
        scenario = _meta(adapty, 'scenario')
        if body['provider'] != scenario:
            raise ValueError('Provider does not match this scenario')
        if scenario not in ('stripe', 'paddle', 'custom'):
            raise ValueError('awaiting_client_action')
        now = logical_now(provider)
        previous = adapty.execute('SELECT request_hash,result FROM operations WHERE operation_key=?',
                                  (body['operation_key'],)).fetchone()
        if previous:
            if previous['request_hash'] != digest(body):
                raise ValueError('Operation key already has a different request')
            result = json.loads(previous['result'])
            adapty.execute('COMMIT')
            return {**result, 'duplicate': True}
        evidence_row = provider.execute('SELECT * FROM provider_evidence WHERE transaction_id=?',
                                        (body['transaction_id'],)).fetchone()
        if evidence_row is None:
            raise ValueError('Provider transaction not found')
        evidence = dict(evidence_row)
        account = provider.execute('SELECT identity_status FROM provider_accounts WHERE user_id=?',
                                   (body['user_id'],)).fetchone()
        if (account is None or account['identity_status'] != 'mapped'
                or evidence['user_id'] != body['user_id']):
            raise ValueError('Provider transaction identity does not match the requested user')
        if evidence['payment_state'] != 'paid' or evidence['access_basis'] != 'paid_period' or evidence['amount_minor'] <= 0 or evidence['refund_state'] != 'none' or not _current(evidence, now):
            raise ValueError('Provider transaction is not a current paid period')
        if (now - _time(evidence['observed_at'], 'observed_at')).total_seconds() < 0 or (now - _time(evidence['observed_at'], 'observed_at')).total_seconds() > FRESHNESS_TTL:
            raise ValueError('Provider evidence is stale')
        mapping = adapty.execute('SELECT * FROM catalog WHERE provider=? AND price_id=?',
                                 (scenario, evidence['price_id'])).fetchone()
        if not mapping or mapping['status'] != 'mapped' or mapping['product_id'] != evidence['product_id']:
            raise ValueError('Provider product and price are not mapped in the Adapty catalog')
        entitlement_hash = digest({'user_id': body['user_id'], 'product_id': evidence['product_id'],
                                   'expires_at': evidence['expires_at']})
        result = {'accepted': True, 'user_id': body['user_id'],
                  'transaction_id': evidence['transaction_id'], 'product_id': evidence['product_id'],
                  'price_id': evidence['price_id'], 'expires_at': evidence['expires_at'],
                  'evidence_hash': evidence['evidence_hash'], 'entitlement_hash': entitlement_hash,
                  'request_contract': body['contract_trace'],
                  'profile_revision': 1}
        adapty.execute('INSERT INTO profiles(user_id,status,product_id,expires_at,transaction_id,revision,updated_at,entitlement_hash) VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(user_id) DO UPDATE SET status=excluded.status,product_id=excluded.product_id,expires_at=excluded.expires_at,transaction_id=excluded.transaction_id,revision=profiles.revision+1,updated_at=excluded.updated_at,entitlement_hash=excluded.entitlement_hash',
                       (body['user_id'], 'active', evidence['product_id'], evidence['expires_at'],
                        evidence['transaction_id'], 1, iso(now), result['entitlement_hash']))
        revision = adapty.execute('SELECT revision FROM profiles WHERE user_id=?', (body['user_id'],)).fetchone()[0]
        result['profile_revision'] = revision
        adapty.execute('INSERT INTO operations VALUES(?,?,?,?,?)',
                       (body['operation_key'], 'validate', digest(body), canonical(result), iso(now)))
        adapty.execute('COMMIT')
        return {**result, 'duplicate': False}
    except Exception:
        if adapty.in_transaction:
            adapty.execute('ROLLBACK')
        raise
    finally:
        provider.close()
        adapty.close()


def repair_catalog(adapty_path, body):
    required = {'provider', 'product_id', 'price_id', 'operation_key'}
    if not isinstance(body, dict) or set(body) != required:
        raise ValueError('Catalog repair fields do not match the contract')
    for name in required:
        if not isinstance(body[name], str) or not body[name].strip() or len(body[name]) > 256:
            raise ValueError('Invalid '+name)
    db = connect(adapty_path)
    db.execute('BEGIN IMMEDIATE')
    try:
        now = logical_now(db)
        if body['provider'] != _meta(db, 'scenario'):
            raise ValueError('Provider does not match this scenario')
        if not all(char.isalnum() or char in '._:-' for char in body['operation_key']):
            raise ValueError('Invalid operation_key')
        previous = db.execute('SELECT request_hash,result FROM operations WHERE operation_key=?', (body['operation_key'],)).fetchone()
        if previous:
            if previous['request_hash'] != digest(body):
                raise ValueError('Operation key already has a different request')
            db.execute('COMMIT')
            return {**json.loads(previous['result']), 'duplicate': True}
        conflict = db.execute('SELECT * FROM catalog WHERE provider=? AND price_id=?',
                              (body['provider'], body['price_id'])).fetchone()
        if conflict and conflict['product_id'] != body['product_id']:
            raise ValueError('Price is already mapped to another product')
        if conflict:
            revision = conflict['revision']
        else:
            revision = db.execute('SELECT COALESCE(MAX(revision),0)+1 FROM catalog').fetchone()[0]
            db.execute('INSERT INTO catalog VALUES(?,?,?,?,?)',
                       (body['provider'], body['product_id'], body['price_id'], 'mapped', revision))
        result = {'accepted': True, 'provider': body['provider'],
                  'product_id': body['product_id'], 'price_id': body['price_id'],
                  'catalog_revision': revision}
        db.execute('INSERT INTO operations VALUES(?,?,?,?,?)',
                   (body['operation_key'], 'catalog_repair', digest(body), canonical(result), iso(now)))
        db.execute('COMMIT')
        return {**result, 'duplicate': False}
    except Exception:
        if db.in_transaction:
            db.execute('ROLLBACK')
        raise
    finally:
        db.close()


def _gate(db, user_id):
    account = db.execute('SELECT * FROM accounts WHERE user_id=?', (user_id,)).fetchone()
    if account is None:
        raise KeyError('Unknown account')
    mapping = db.execute('SELECT * FROM mappings WHERE user_id=?', (user_id,)).fetchone()
    access = db.execute('SELECT * FROM access WHERE user_id=?', (user_id,)).fetchone()
    policy = db.execute('SELECT * FROM policies WHERE user_id=?', (user_id,)).fetchone()
    result = {'allowed': False, 'reason': 'identity_unavailable', 'projection_revision': 0, 'cache_revision': 0}
    if mapping is None or mapping['status'] != 'mapped':
        return {**result, 'reason': 'identity_unavailable'}
    if not policy['enabled'] or policy['feature'] != FEATURE:
        return {'allowed': False, 'reason': 'policy_restricted',
                'projection_revision': access['projection_revision'], 'cache_revision': access['cache_revision']}
    if access['cache_invalidated'] or access['cache_revision'] != access['projection_revision']:
        return {'allowed': False, 'reason': 'cache_stale',
                'projection_revision': access['projection_revision'], 'cache_revision': access['cache_revision']}
    now = _app_now(db)
    if not access['cache_expires_at'] or _time(access['cache_expires_at'], 'expires_at') <= now:
        return {'allowed': False, 'reason': 'subscription_expired',
                'projection_revision': access['projection_revision'], 'cache_revision': access['cache_revision']}
    if not access['cache_active']:
        return {'allowed': False, 'reason': 'subscription_inactive',
                'projection_revision': access['projection_revision'], 'cache_revision': access['cache_revision']}
    return {'allowed': True, 'reason': 'allowed',
            'projection_revision': access['projection_revision'], 'cache_revision': access['cache_revision']}


def lumen_accounts(path, cursor=None, limit=500):
    db = connect(path)
    try:
        offset = _cursor(cursor, limit)
        ids = [row[0] for row in db.execute('SELECT user_id FROM accounts ORDER BY user_id LIMIT ? OFFSET ?', (limit, offset))]
        items = []
        for user_id in ids:
            account = dict(db.execute('SELECT * FROM accounts WHERE user_id=?', (user_id,)).fetchone())
            mapping = dict(db.execute('SELECT * FROM mappings WHERE user_id=?', (user_id,)).fetchone())
            policy = dict(db.execute('SELECT * FROM policies WHERE user_id=?', (user_id,)).fetchone())
            access = dict(db.execute('SELECT * FROM access WHERE user_id=?', (user_id,)).fetchone())
            gate = _gate(db, user_id)
            fault = None
            if _meta(db, 'scenario') == 'live_adapty':
                tag = db.execute('SELECT handler_version,config_version,occurred_at FROM live_fault_tags WHERE user_id=?',
                                 (user_id,)).fetchone()
                fault = None if tag is None else dict(tag)
            items.append({'user_id': user_id, 'provider_customer_id': account['provider_customer_id'],
                          'identity_status': mapping['status'], 'identity_revision': mapping['revision'],
                          'policy_enabled': bool(policy['enabled']), 'policy_revision': policy['revision'],
                          'gate': gate, 'projection_revision': access['projection_revision'],
                          'cache_revision': access['cache_revision'], 'access_active': bool(access['active']),
                          'access_expires_at': access['expires_at'],
                          'entitlement_hash': access['entitlement_hash'],
                          **({'delivery_signature': fault} if _meta(db, 'scenario') == 'live_adapty' else {})})
        total = db.execute('SELECT COUNT(*) FROM accounts').fetchone()[0]
        return {'items': items, 'next_cursor': str(offset+len(items)) if offset+len(items) < total else None,
                'total': total}
    finally:
        db.close()


def lumen_access(path, user_id):
    db = connect(path)
    try:
        access = db.execute('SELECT * FROM access WHERE user_id=?', (user_id,)).fetchone()
        if access is None:
            raise KeyError('Unknown account')
        return {**_gate(db, user_id), 'user_id': user_id,
                'active': bool(access['active']), 'expires_at': access['expires_at'],
                'entitlement_hash': access['entitlement_hash'],
                'identity_revision': db.execute('SELECT revision FROM mappings WHERE user_id=?', (user_id,)).fetchone()[0],
                'policy_revision': db.execute('SELECT revision FROM policies WHERE user_id=?', (user_id,)).fetchone()[0]}
    finally:
        db.close()


def lumen_resync(path, body):
    required = {'user_id', 'expected_revision', 'entitlement', 'operation_key'}
    if not isinstance(body, dict) or set(body) != required:
        raise ValueError('Resync fields do not match the contract')
    if not isinstance(body['user_id'], str) or not body['user_id'] or len(body['user_id']) > 256:
        raise ValueError('Invalid user_id')
    if isinstance(body['expected_revision'], bool) or not isinstance(body['expected_revision'], int) or body['expected_revision'] < 1:
        raise ValueError('Invalid expected_revision')
    entitlement = body['entitlement']
    required_entitlement = {'product_id', 'expires_at', 'entitlement_hash', 'transaction_id'}
    if not isinstance(entitlement, dict) or set(entitlement) not in (required_entitlement,
            required_entitlement | {'source_fingerprint'}):
        raise ValueError('Invalid entitlement')
    if any(not isinstance(entitlement[key], str) or not entitlement[key] for key in entitlement):
        raise ValueError('Invalid entitlement')
    if 'source_fingerprint' in entitlement and (len(entitlement['source_fingerprint']) != 64
            or any(char not in '0123456789abcdef' for char in entitlement['source_fingerprint'])):
        raise ValueError('Invalid source fingerprint')
    if digest({'user_id': body['user_id'], 'product_id': entitlement['product_id'],
               'expires_at': entitlement['expires_at']}) != entitlement['entitlement_hash']:
        raise ValueError('Invalid entitlement hash')
    db = connect(path)
    db.execute('BEGIN IMMEDIATE')
    try:
        if _meta(db, 'scenario') == 'live_adapty' and 'source_fingerprint' not in entitlement:
            raise ValueError('Live resync requires a source fingerprint')
        if _meta(db, 'scenario') != 'live_adapty' and 'source_fingerprint' in entitlement:
            raise ValueError('Source fingerprint is supported only for live resync')
        now = iso(_app_now(db))
        previous = db.execute('SELECT request_hash,result FROM actions WHERE operation_key=?', (body['operation_key'],)).fetchone()
        if previous:
            if previous['request_hash'] != digest(body):
                raise ValueError('Operation key already has a different request')
            db.execute('COMMIT')
            return {**json.loads(previous['result']), 'duplicate': True}
        account = db.execute('SELECT * FROM accounts WHERE user_id=?', (body['user_id'],)).fetchone()
        mapping = db.execute('SELECT * FROM mappings WHERE user_id=?', (body['user_id'],)).fetchone()
        policy = db.execute('SELECT * FROM policies WHERE user_id=?', (body['user_id'],)).fetchone()
        row = db.execute('SELECT * FROM access WHERE user_id=?', (body['user_id'],)).fetchone()
        if account is None or mapping['status'] != 'mapped':
            raise ValueError('Lumen identity is not mapped')
        if not policy['enabled']:
            raise ValueError('Lumen policy blocks this feature')
        if row['projection_revision'] != body['expected_revision']:
            raise ValueError('Lumen access revision changed')
        expiry = _time(entitlement['expires_at'], 'expires_at')
        if expiry <= _app_now(db):
            raise ValueError('Entitlement is expired')
        next_revision = row['projection_revision'] + 1
        skip_cache = bool(row['stale_once'])
        before = {'active': bool(row['active']), 'premium': bool(row['active']),
                  'expires_at': row['expires_at'], 'projection_revision': row['projection_revision'],
                  'cache_revision': row['cache_revision'], 'source_hash': row['entitlement_hash'],
                  'invalidated': bool(row['cache_invalidated'])}
        if skip_cache:
            db.execute('UPDATE access SET active=1,expires_at=?,entitlement_hash=?,projection_revision=?,stale_once=0,cache_invalidated=1,updated_at=? WHERE user_id=?',
                       (entitlement['expires_at'], entitlement['entitlement_hash'], next_revision, now, body['user_id']))
        else:
            db.execute('UPDATE access SET active=1,expires_at=?,entitlement_hash=?,projection_revision=?,cache_revision=?,cache_active=1,cache_expires_at=?,cache_entitlement_hash=?,cache_invalidated=0,updated_at=? WHERE user_id=?',
                       (entitlement['expires_at'], entitlement['entitlement_hash'], next_revision,
                        next_revision, entitlement['expires_at'], entitlement['entitlement_hash'], now, body['user_id']))
        result = {'accepted': True, 'user_id': body['user_id'],
                  'projection_revision': next_revision,
                  'cache_revision': row['cache_revision'] if skip_cache else next_revision,
                  'cache_skipped': skip_cache, 'operation_key': body['operation_key']}
        if _meta(db, 'scenario') == 'live_adapty':
            source_hash = entitlement['source_fingerprint']
            result.update(before=before, after={'active': True, 'premium': True,
                'expires_at': entitlement['expires_at'], 'projection_revision': next_revision,
                'cache_revision': row['cache_revision'] if skip_cache else next_revision,
                'source_hash': source_hash, 'invalidated': bool(skip_cache)},
                source_hash=source_hash, policy_version='premium-policy-v1',
                adapter_version='adapty-profile-read-v1',
                projection_version=_meta(db, 'live_handler_version', 'lumen-handler-v2'),
                config_version=_meta(db, 'live_config_version', 'premium-export-v2'))
            db.execute('DELETE FROM live_fault_tags WHERE user_id=?', (body['user_id'],))
        db.execute('INSERT INTO actions VALUES(?,?,?,?)',
                   (body['operation_key'], digest(body), canonical(result), now))
        db.execute('COMMIT')
        return {**result, 'duplicate': False}
    except Exception:
        if db.in_transaction:
            db.execute('ROLLBACK')
        raise
    finally:
        db.close()


def lumen_live_inject_fault(path, user_ids, handler_version, config_version, occurred_at,
                            fault_kind='missed_projection'):
    if (not isinstance(user_ids, list) or not 2 <= len(user_ids) <= 24
            or len(set(user_ids)) != len(user_ids)
            or any(not isinstance(user_id, str) or not user_id for user_id in user_ids)
            or not isinstance(handler_version, str) or not handler_version
            or not isinstance(config_version, str) or not config_version
            or fault_kind not in ('stale_cache', 'missed_projection', 'out_of_order')):
        raise ValueError('Live fault request is invalid')
    at = iso(_time(occurred_at, 'fault occurrence time'))
    db = connect(path)
    db.execute('BEGIN IMMEDIATE')
    try:
        if _meta(db, 'scenario') != 'live_adapty':
            raise ValueError('Live fault is supported only in the live scenario')
        changed = []
        for user_id in user_ids:
            access = db.execute('SELECT * FROM access WHERE user_id=?', (user_id,)).fetchone()
            mapping = db.execute('SELECT status FROM mappings WHERE user_id=?', (user_id,)).fetchone()
            policy = db.execute('SELECT enabled FROM policies WHERE user_id=?', (user_id,)).fetchone()
            if (access is None or mapping is None or mapping['status'] != 'mapped'
                    or policy is None or not policy['enabled'] or not _gate(db, user_id)['allowed']
                    or not access['entitlement_hash']):
                raise ValueError('Live fault target is not currently healthy')
            before = {'active': bool(access['active']), 'premium': bool(access['active']),
                      'expires_at': access['expires_at'],
                      'projection_revision': access['projection_revision'],
                      'cache_revision': access['cache_revision'],
                      'source_hash': access['entitlement_hash'], 'invalidated': False}
            next_revision = access['projection_revision'] + 1
            if fault_kind == 'stale_cache':
                db.execute('UPDATE access SET projection_revision=?,updated_at=? WHERE user_id=?',
                           (next_revision, at, user_id))
                after_active, after_expires, after_cache_revision = True, access['expires_at'], access['cache_revision']
                after_invalidated = False
            elif fault_kind == 'missed_projection':
                db.execute('UPDATE access SET active=0,projection_revision=?,cache_revision=?,cache_active=0,cache_invalidated=0,updated_at=? WHERE user_id=?',
                           (next_revision, next_revision, at, user_id))
                after_active, after_expires, after_cache_revision = False, access['expires_at'], next_revision
                after_invalidated = False
            else:
                expired_at = iso(_time(at, 'fault occurrence time')-timedelta(seconds=1))
                db.execute('UPDATE access SET expires_at=?,projection_revision=?,cache_revision=?,cache_expires_at=?,cache_invalidated=0,updated_at=? WHERE user_id=?',
                           (expired_at, next_revision, next_revision, expired_at, at, user_id))
                after_active, after_expires, after_cache_revision = True, expired_at, next_revision
                after_invalidated = False
            db.execute('INSERT OR REPLACE INTO live_fault_tags VALUES(?,?,?,?)',
                       (user_id, handler_version, config_version, at))
            changed.append({'user_id': user_id, 'before': before,
                'after': {'active': after_active, 'premium': after_active, 'expires_at': after_expires,
                          'projection_revision': next_revision, 'cache_revision': after_cache_revision,
                          'source_hash': access['entitlement_hash'], 'invalidated': after_invalidated},
                'source_hash': access['entitlement_hash'],
                'projection_revision': next_revision,
                'cache_revision': after_cache_revision,
                'policy_version': 'premium-policy-v1',
                'adapter_version': 'adapty-profile-read-v1'})
        _set_meta(db, 'live_fault_injected', True)
        _set_meta(db, 'live_fault_account_count', len(changed))
        _set_meta(db, 'live_fault_handler_version', handler_version)
        _set_meta(db, 'live_fault_config_version', config_version)
        _set_meta(db, 'live_fault_occurred_at', at)
        _set_meta(db, 'live_fault_kind', fault_kind)
        _set_meta(db, 'live_handler_version', handler_version)
        _set_meta(db, 'live_config_version', config_version)
        db.execute('COMMIT')
        return {'injected': True, 'fault_kind': fault_kind, 'account_count': len(changed),
                'handler_version': handler_version, 'config_version': config_version,
                'occurred_at': at, 'accounts': changed}
    except Exception:
        if db.in_transaction:
            db.execute('ROLLBACK')
        raise
    finally:
        db.close()


def lumen_live_fault_status(path):
    db = connect(path)
    try:
        if _meta(db, 'scenario') != 'live_adapty':
            raise ValueError('Live status is supported only in the live scenario')
        return {'injected': bool(_meta(db, 'live_fault_injected', False)),
                'fault_kind': _meta(db, 'live_fault_kind'),
                'account_count': _meta(db, 'live_fault_account_count', 0),
                'handler_version': _meta(db, 'live_fault_handler_version'),
                'config_version': _meta(db, 'live_fault_config_version'),
                'occurred_at': _meta(db, 'live_fault_occurred_at')}
    finally:
        db.close()


def lumen_action(path, operation_key):
    db = connect(path)
    try:
        row = db.execute('SELECT result FROM actions WHERE operation_key=?', (operation_key,)).fetchone()
        return None if row is None else json.loads(row['result'])
    finally:
        db.close()


def mobile_event(path, body):
    required = {'event_id', 'user_id', 'kind', 'occurred_at', 'details'}
    if not isinstance(body, dict) or set(body) != required:
        raise ValueError('Mobile event fields do not match the contract')
    if any(not isinstance(body[name], str) or not body[name].strip() or len(body[name]) > 256
           for name in ('event_id', 'user_id', 'kind', 'occurred_at')):
        raise ValueError('Invalid mobile event metadata')
    if body['kind'] not in ('purchase_succeeded', 'subscription_profile_updated', 'access_denied'):
        raise ValueError('Unsupported mobile event kind')
    if not isinstance(body['details'], dict) or set(body['details']) - {'transaction_id','product_id','price_id','feature','reason_code'}:
        raise ValueError('Only allowlisted mobile metadata is accepted')
    _time(body['occurred_at'], 'occurred_at')
    db = connect(path)
    try:
        if not db.execute('SELECT 1 FROM accounts WHERE user_id=?', (body['user_id'],)).fetchone():
            raise KeyError('Unknown account')
        raw = canonical(body)
        previous = db.execute('SELECT event_json FROM mobile_events WHERE event_id=?', (body['event_id'],)).fetchone()
        if previous and previous['event_json'] != raw:
            raise ValueError('Mobile event ID already has a different payload')
        if not previous:
            db.execute('INSERT INTO mobile_events VALUES(?,?,?)',
                       (body['event_id'], raw, iso(logical_now(db))))
        return {'accepted': True, 'trusted_payment_evidence': False,
                'event_id': body['event_id'], 'duplicate': bool(previous)}
    finally:
        db.close()


def adapty_operation(path, operation_key):
    db = connect(path)
    try:
        row = db.execute('SELECT result FROM operations WHERE operation_key=?', (operation_key,)).fetchone()
        return None if row is None else json.loads(row['result'])
    finally:
        db.close()


def adapty_demo_fault(path, fault, user_id):
    if fault != 'different_cause' or not isinstance(user_id, str) or not user_id:
        raise ValueError('Unsupported Adapty demo fault')
    db = connect(path)
    try:
        now = iso(logical_now(db))
        cursor = db.execute("UPDATE profiles SET status='missing',product_id=NULL,expires_at=NULL,transaction_id=NULL,revision=revision+1,updated_at=?,entitlement_hash=NULL WHERE user_id=?",
                            (now, user_id))
        if not cursor.rowcount:
            raise KeyError('Unknown account')
        return {'fault': fault, 'user_id': user_id, 'status': 'missing'}
    finally:
        db.close()


def provider_observations(path, user_id=None):
    db = connect(path)
    try:
        if user_id is None:
            rows = _rows(db, 'SELECT * FROM provider_observations ORDER BY id')
        else:
            rows = _rows(db, 'SELECT * FROM provider_observations WHERE transaction_id IN (SELECT transaction_id FROM provider_evidence WHERE user_id=?) ORDER BY id', (user_id,))
        for row in rows:
            row['evidence'] = json.loads(row.pop('evidence_json'))
        return rows
    finally:
        db.close()


def provider_demo_fault(path, fault, *, active=True, user_id=None, state=None):
    db = connect(path)
    try:
        if fault in ('provider_outage', 'validation_timeout_after_commit', 'rate_limit'):
            if not isinstance(active, bool):
                raise ValueError('active must be a boolean')
            db.execute('BEGIN IMMEDIATE')
            if fault == 'provider_outage':
                _set_meta(db, 'fault_provider_outage', active)
            elif fault == 'validation_timeout_after_commit':
                _set_meta(db, 'fault_validation_timeout_remaining', active)
            else:
                _set_meta(db, 'fault_rate_limit_remaining', 1 if active else 0)
                _set_meta(db, 'fault_rate_limit_retry_after', 1)
            db.execute('COMMIT')
            return {'fault': fault, 'active': active}
        if fault == 'source_stale':
            state = 'stale'
        elif fault == 'refund':
            state = 'refunded'
        if fault not in ('source_stale', 'refund', 'lifecycle', 'identity', 'different_cause'):
            raise ValueError('Unsupported provider demo fault')
        if not isinstance(user_id, str) or not user_id:
            raise ValueError('user_id is required')
        if fault == 'lifecycle' and state not in ('pending', 'trial', 'grace', 'manual', 'refunded', 'expired'):
            raise ValueError('Unsupported lifecycle state')
        db.execute('BEGIN IMMEDIATE')
        account = db.execute('SELECT * FROM provider_accounts WHERE user_id=?', (user_id,)).fetchone()
        if account is None:
            raise KeyError('Unknown account')
        if fault == 'identity':
            if state not in ('mapped', 'unknown'):
                raise ValueError('identity state must be mapped or unknown')
            db.execute('UPDATE provider_accounts SET identity_status=? WHERE user_id=?', (state, user_id))
            db.execute('COMMIT')
            return {'fault': fault, 'user_id': user_id, 'status': state}
        row = db.execute('SELECT * FROM provider_evidence WHERE user_id=? ORDER BY occurred_at DESC LIMIT 1', (user_id,)).fetchone()
        if row is None:
            raise ValueError('No provider evidence exists for this account')
        item = dict(row)
        now = logical_now(db)
        if fault == 'source_stale':
            item['observed_at'] = iso(now-timedelta(seconds=1800))
        elif fault == 'different_cause':
            item['price_id'] = 'price_annual_other'
            item['occurred_at'] = iso(now-timedelta(seconds=60))
            item['observed_at'] = iso(now-timedelta(seconds=20))
        elif state == 'pending':
            item['payment_state'] = 'pending'
        elif state in ('trial', 'grace', 'manual'):
            item['access_basis'] = state
        elif state == 'refunded':
            item['refund_state'] = 'refunded'
        elif state == 'expired':
            item['expires_at'] = iso(now-timedelta(seconds=1))
        item['evidence_hash'] = digest({key: value for key, value in item.items() if key != 'evidence_hash'})
        columns = tuple(key for key in item if key != 'transaction_id')
        db.execute('UPDATE provider_evidence SET '+','.join(name+'=?' for name in columns)+' WHERE transaction_id=?',
                   tuple(item[name] for name in columns)+(item['transaction_id'],))
        db.execute('INSERT INTO provider_observations(transaction_id,observed_at,evidence_hash,evidence_json) VALUES(?,?,?,?)',
                   (item['transaction_id'], item['observed_at'], item['evidence_hash'], canonical(item)))
        db.execute('COMMIT')
        return {'fault': fault, 'user_id': user_id, 'state': state or fault,
                'evidence_hash': item['evidence_hash']}
    except Exception:
        if db.in_transaction:
            db.execute('ROLLBACK')
        raise
    finally:
        db.close()


def provider_fault_active(path, name):
    db = connect(path)
    try:
        return bool(_meta(db, name, False))
    finally:
        db.close()


def consume_provider_fault(path, name):
    db = connect(path)
    try:
        db.execute('BEGIN IMMEDIATE')
        if name == 'fault_rate_limit_remaining':
            remaining = _meta(db, name, 0)
            if remaining:
                _set_meta(db, name, remaining-1)
                result = {'active': True, 'retry_after': _meta(db, 'fault_rate_limit_retry_after', 1)}
            else:
                result = {'active': False}
        else:
            result = {'active': bool(_meta(db, name, False))}
            if result['active']:
                _set_meta(db, name, False)
        db.execute('COMMIT')
        return result
    except Exception:
        if db.in_transaction:
            db.execute('ROLLBACK')
        raise
    finally:
        db.close()


def lumen_demo_fault(path, fault, *, active=True, user_id=None, status=None, entitlement=None):
    db = connect(path)
    try:
        if fault in ('probe_outage', 'suppress_customer_telemetry'):
            if not isinstance(active, bool):
                raise ValueError('active must be a boolean')
            _set_meta(db, 'fault_'+fault, active)
            return {'fault': fault, 'active': active}
        if fault not in ('identity', 'self_heal', 'cache_skip_once', 'different_cause'):
            raise ValueError('Unsupported Lumen demo fault')
        if not isinstance(user_id, str) or not user_id:
            raise ValueError('user_id is required')
        db.execute('BEGIN IMMEDIATE')
        if fault == 'identity':
            if status not in ('mapped', 'unknown'):
                raise ValueError('status must be mapped or unknown')
            cursor = db.execute('UPDATE mappings SET status=?,revision=revision+1 WHERE user_id=?', (status, user_id))
            if not cursor.rowcount:
                raise KeyError('Unknown account')
            db.execute('UPDATE accounts SET identity_status=? WHERE user_id=?', (status, user_id))
            result = {'fault': fault, 'user_id': user_id, 'status': status}
        elif fault == 'cache_skip_once':
            cursor = db.execute('UPDATE access SET stale_once=1 WHERE user_id=?', (user_id,))
            if not cursor.rowcount:
                raise KeyError('Unknown account')
            result = {'fault': fault, 'user_id': user_id, 'active': True}
        elif fault == 'different_cause':
            cursor = db.execute('UPDATE access SET active=0,projection_revision=projection_revision+1,cache_revision=cache_revision+1,cache_active=0,cache_invalidated=0,updated_at=? WHERE user_id=?',
                                (iso(logical_now(db)), user_id))
            if not cursor.rowcount:
                raise KeyError('Unknown account')
            result = {'fault': fault, 'user_id': user_id, 'active': False}
        else:
            row = db.execute('SELECT * FROM access WHERE user_id=?', (user_id,)).fetchone()
            policy = db.execute('SELECT enabled FROM policies WHERE user_id=?', (user_id,)).fetchone()
            mapping = db.execute('SELECT status FROM mappings WHERE user_id=?', (user_id,)).fetchone()
            if row is None or not policy or not policy['enabled'] or not mapping or mapping['status'] != 'mapped':
                raise ValueError('Lumen account is not eligible to self-heal')
            if entitlement is None:
                # A demo refresh with no active Adapty profile can update the
                # client projection version, but it must not create access.
                revision = row['projection_revision']+1
                db.execute('UPDATE access SET projection_revision=?,cache_revision=?,updated_at=? WHERE user_id=?',
                           (revision, revision, iso(logical_now(db)), user_id))
                result = {'fault': fault, 'user_id': user_id, 'healed': False,
                          'status': 'no_current_entitlement',
                          'projection_revision': revision}
                db.execute('COMMIT')
                return result
            if not isinstance(entitlement, dict) or set(entitlement) != {'product_id','expires_at','entitlement_hash'}:
                raise ValueError('Current Adapty entitlement is required')
            if digest({'user_id': user_id, 'product_id': entitlement['product_id'],
                       'expires_at': entitlement['expires_at']}) != entitlement['entitlement_hash']:
                raise ValueError('Invalid entitlement hash')
            if _time(entitlement['expires_at']) <= logical_now(db):
                raise ValueError('Entitlement is expired')
            revision = row['projection_revision']+1
            db.execute('UPDATE access SET active=1,expires_at=?,entitlement_hash=?,projection_revision=?,cache_revision=?,cache_active=1,cache_expires_at=?,cache_entitlement_hash=?,cache_invalidated=0,updated_at=? WHERE user_id=?',
                       (entitlement['expires_at'], entitlement['entitlement_hash'], revision, revision,
                        entitlement['expires_at'], entitlement['entitlement_hash'], iso(logical_now(db)), user_id))
            result = {'fault': fault, 'user_id': user_id, 'projection_revision': revision}
        db.execute('COMMIT')
        return result
    except Exception:
        if db.in_transaction:
            db.execute('ROLLBACK')
        raise
    finally:
        db.close()


def lumen_fault_active(path, name):
    db = connect(path)
    try:
        return bool(_meta(db, name, False))
    finally:
        db.close()
