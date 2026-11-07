#!/usr/bin/env python3
"""Three-process, loopback-only activation recovery simulator."""
from __future__ import annotations

import argparse
from datetime import datetime, timedelta, timezone
import hashlib
import hmac
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import ipaddress
import json
import mimetypes
import os
from pathlib import Path
import secrets
import sqlite3
import socket
import stat
import threading
import time
from urllib.parse import parse_qs, urlencode, unquote, urlsplit
from uuid import uuid4

import recovery_domain as domain
import recovery_contracts
import recovery_scenarios

HERE = Path(__file__).resolve().parent
STATIC = HERE.parent / 'Reconcile' / 'dist'
BODY_LIMIT = 1024 * 1024
MAX_JOB_WORKERS = 8


class RecoveryError(ValueError):
    def __init__(self, message, status=400):
        super().__init__(message)
        self.status = status


class InternalHTTPError(OSError):
    def __init__(self, status, payload=None, retry_after=None):
        super().__init__('Internal simulator HTTP '+str(status))
        self.status, self.payload, self.retry_after = status, payload, retry_after


class RateLimitError(RecoveryError):
    def __init__(self, retry_after):
        super().__init__('Simulator rate limit', 429)
        self.retry_after = max(1, int(retry_after))


def canonical(value):
    return json.dumps(value, sort_keys=True, separators=(',', ':'), ensure_ascii=False,
                      allow_nan=False).encode('utf-8')


def digest(value):
    return hashlib.sha256(canonical(value)).hexdigest()


def parse_time(value, label='timestamp'):
    if not isinstance(value, str) or not value.strip():
        raise RecoveryError('Invalid '+label)
    try:
        result = datetime.fromisoformat(value.strip().replace('Z', '+00:00'))
    except ValueError as exc:
        raise RecoveryError('Invalid '+label) from exc
    if result.tzinfo is None or result.utcoffset() is None:
        raise RecoveryError(label+' must include a timezone')
    return result.astimezone(timezone.utc)


def iso(value):
    return value.astimezone(timezone.utc).isoformat(timespec='seconds').replace('+00:00', 'Z')


def _loopback(value, expected_path=None):
    if not isinstance(value, str) or len(value) > 512:
        raise ValueError('URL must be a loopback HTTP URL')
    parsed = urlsplit(value)
    if (parsed.scheme != 'http' or not parsed.hostname or parsed.username or parsed.password
            or parsed.query or parsed.fragment):
        raise ValueError('URL must be a loopback HTTP URL')
    try:
        loopback = parsed.hostname.lower().rstrip('.') == 'localhost' or ipaddress.ip_address(parsed.hostname).is_loopback
        port = parsed.port or 80
    except ValueError as exc:
        raise ValueError('URL must be a loopback HTTP URL') from exc
    if not loopback or not 1 <= port <= 65535:
        raise ValueError('URL must be a loopback HTTP URL')
    path = parsed.path.rstrip('/')
    if expected_path is not None and path != expected_path:
        raise ValueError('URL path must be '+expected_path)
    if expected_path is None and path:
        raise ValueError('Simulator base URL must not include a path')
    return parsed


def load_key(path, create=False):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    if not path.exists():
        if not create:
            raise ValueError('Shared key file is missing')
        raw = secrets.token_bytes(32).hex().encode('ascii') + b'\n'
        descriptor = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        try:
            os.write(descriptor, raw)
            os.fsync(descriptor)
        finally:
            os.close(descriptor)
    info = path.lstat()
    if stat.S_ISLNK(info.st_mode) or info.st_mode & 0o077:
        raise ValueError('Shared key file must be a private regular file with mode 0600')
    if not stat.S_ISREG(info.st_mode):
        raise ValueError('Shared key file must be a regular file')
    value = path.read_bytes().strip()
    try:
        key = bytes.fromhex(value.decode('ascii'))
    except (ValueError, UnicodeDecodeError):
        key = value
    if len(key) < 32:
        raise ValueError('Shared key must contain at least 32 bytes')
    return key


def internal_signature(key, method, path, timestamp, body):
    material = (b'recovery-internal-v1\n' + method.upper().encode('ascii') + b'\n'
                + path.encode('utf-8') + b'\n' + str(timestamp).encode('ascii') + b'\n'
                + hashlib.sha256(body).hexdigest().encode('ascii'))
    return hmac.new(key, material, hashlib.sha256).hexdigest()


def internal_request(key, base_url, method, path, body=None, timeout=5, retries=3):
    import http.client
    parsed = _loopback(base_url)
    raw = b'' if body is None else canonical(body)
    target = path
    timestamp = int(time.time())
    signature = internal_signature(key, method, target, timestamp, raw)
    headers = {'X-Recovery-Timestamp': str(timestamp), 'X-Recovery-Signature': signature}
    if body is not None:
        headers['Content-Type'] = 'application/json'
    attempt = 0
    while True:
        connection = http.client.HTTPConnection(parsed.hostname, parsed.port or 80, timeout=timeout)
        try:
            connection.request(method, target, body=raw if body is not None else None, headers=headers)
            response = connection.getresponse()
            payload = response.read(BODY_LIMIT + 1)
            if len(payload) > BODY_LIMIT:
                raise InternalHTTPError(502, {'error': 'Simulator response too large'})
            if response.status == 429:
                try:
                    delay = max(0.0, float(response.getheader('Retry-After', '1')))
                except ValueError:
                    delay = 1.0
                if attempt >= retries or delay > 5.0:
                    try:
                        decoded = json.loads(payload) if payload else {}
                    except json.JSONDecodeError:
                        decoded = {'error': 'Rate limited'}
                    raise InternalHTTPError(429, decoded, response.getheader('Retry-After'))
                attempt += 1
                time.sleep(delay)
                continue
            try:
                decoded = json.loads(payload) if payload else {}
            except json.JSONDecodeError:
                decoded = {'error': 'Invalid simulator response'}
            if response.status < 200 or response.status >= 300:
                raise InternalHTTPError(response.status, decoded,
                                        response.getheader('Retry-After'))
            return decoded
        finally:
            connection.close()


def _conn(path):
    return domain.connect(path)


def _meta(db, key, default=None):
    return domain._meta(db, key, default)


def _set_meta(db, key, value):
    domain._set_meta(db, key, value)


def _json(value):
    return json.dumps(value, ensure_ascii=False, separators=(',', ':'), allow_nan=False)


def _parse_query(path):
    split = urlsplit(path)
    return split.path, parse_qs(split.query, keep_blank_values=True)


def _one(query, key, default=None):
    values = query.get(key)
    return default if values is None else values[0]


class RecoveryService:
    def __init__(self, role, port, db_path, key_file, *, provider_url=None,
                 lumen_url=None, collector_url=None, demo=False):
        self.role = role
        self.port = port
        self.db_path = Path(db_path).resolve()
        self.key_file = Path(key_file).resolve()
        self.key = load_key(self.key_file, create=(role == 'provider'))
        self.provider_url = self._base(provider_url, 'provider_url', required=role in ('engine', 'lumen'))
        self.lumen_url = self._base(lumen_url, 'lumen_url', required=role == 'engine')
        self.collector_url = self._collector(collector_url, required=role == 'lumen')
        self.demo = bool(demo)
        self.adapty_db = self.db_path.with_name(self.db_path.stem + '-adapty.sqlite3')
        self.outbox_db = self.db_path.with_name(self.db_path.stem + '-outbox.sqlite3')
        self._jobs_lock = threading.Lock()
        self._mutation_lock = threading.RLock()
        self._active_jobs = set()
        self.server = None
        self.sdk = None
        self._sdk_thread_started = False
        if role == 'provider':
            domain.init_provider(self.db_path, self.adapty_db)
        elif role == 'lumen':
            domain.init_lumen(self.db_path)
            self._init_sdk()
        else:
            self._init_engine()
            self._init_legacy()
            self._resume_jobs()

    @staticmethod
    def _base(value, name, required=False):
        if value is None:
            if required:
                raise ValueError('--'+name.replace('_', '-')+' is required for this role')
            return None
        parsed = _loopback(value)
        return f'http://{parsed.hostname}:{parsed.port or 80}'

    @staticmethod
    def _collector(value, required=False):
        if value is None:
            if required:
                raise ValueError('--collector-url is required for the Lumen role')
            return None
        parsed = _loopback(value, '/api/recovery/collector')
        return f'http://{parsed.hostname}:{parsed.port or 80}/api/recovery/collector'

    def _init_sdk(self):
        from recovery_sdk import CollectorSDK, http_transport
        db = _conn(self.db_path)
        try:
            manifest = domain.manifest(db)
        finally:
            db.close()
        self.outbox_db = self.db_path.with_name(self.db_path.stem+'-'+manifest['run_id']+'-outbox.sqlite3')
        self.sdk = CollectorSDK(self.key, manifest['run_id'], manifest['app'],
                                http_transport(self.collector_url), outbox_path=self.outbox_db,
                                collector_url=self.collector_url, environment=manifest['environment'])
        if not self._sdk_thread_started:
            thread = threading.Thread(target=self._flush_sdk, name='recovery-sdk-flush', daemon=True)
            thread.start()
            self._sdk_thread_started = True

    def _flush_sdk(self):
        while True:
            try:
                self.sdk.flush()
            except Exception:
                pass
            time.sleep(1)

    def _init_engine(self):
        db = _conn(self.db_path)
        try:
            for statement in (
                'CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY,value TEXT NOT NULL)',
                'CREATE TABLE IF NOT EXISTS incidents(id TEXT PRIMARY KEY,trigger_event_id TEXT UNIQUE,incident_json TEXT NOT NULL,created_at TEXT NOT NULL)',
                'CREATE TABLE IF NOT EXISTS snapshots(id TEXT PRIMARY KEY,incident_id TEXT NOT NULL,created_at TEXT NOT NULL,scenario_created_at TEXT NOT NULL,snapshot_hash TEXT NOT NULL,snapshot_json TEXT NOT NULL)',
                'CREATE TABLE IF NOT EXISTS jobs(id TEXT PRIMARY KEY,kind TEXT NOT NULL,status TEXT NOT NULL,payload TEXT NOT NULL,error TEXT,result TEXT,created_at TEXT NOT NULL,started_at TEXT,updated_at TEXT NOT NULL)',
                'CREATE TABLE IF NOT EXISTS plans(id TEXT PRIMARY KEY,plan_hash TEXT NOT NULL,incident_id TEXT NOT NULL,snapshot_id TEXT NOT NULL,plan_json TEXT NOT NULL,status TEXT NOT NULL,created_at_wall TEXT NOT NULL,expires_at_wall TEXT NOT NULL,scenario_expires_at TEXT NOT NULL)',
                'CREATE TABLE IF NOT EXISTS approvals(plan_id TEXT PRIMARY KEY,plan_hash TEXT NOT NULL,actor TEXT NOT NULL,approved_at_wall TEXT NOT NULL)',
                'CREATE TABLE IF NOT EXISTS actions(id TEXT PRIMARY KEY,plan_id TEXT NOT NULL,account_id TEXT,owner TEXT NOT NULL,target TEXT NOT NULL,preconditions TEXT NOT NULL,status TEXT NOT NULL,started_at TEXT,finished_at TEXT,evidence_ref TEXT,result TEXT)',
                'CREATE TABLE IF NOT EXISTS collector_events(event_id TEXT PRIMARY KEY,payload_hash TEXT NOT NULL,event_json TEXT NOT NULL,recorded_at TEXT NOT NULL,provenance TEXT NOT NULL)',
                'CREATE TABLE IF NOT EXISTS collector_assessments(event_id TEXT PRIMARY KEY,result TEXT NOT NULL)',
                'CREATE TABLE IF NOT EXISTS journal(seq INTEGER PRIMARY KEY AUTOINCREMENT,at TEXT NOT NULL,action TEXT NOT NULL,details TEXT NOT NULL)',
            ):
                db.execute(statement)
            if not _meta(db, 'initialized', False):
                try:
                    provider_manifest = internal_request(self.key, self.provider_url, 'GET', '/internal/manifest')
                    lumen_manifest = internal_request(self.key, self.lumen_url, 'GET', '/internal/manifest')
                except Exception as exc:
                    raise ValueError('Provider and Lumen must be started before engine') from exc
                if (provider_manifest.get('run_id') != lumen_manifest.get('run_id')
                        or provider_manifest.get('app') != lumen_manifest.get('app')
                        or provider_manifest.get('environment') != lumen_manifest.get('environment')):
                    raise ValueError('Simulator role scopes do not match')
                for key, value in provider_manifest.items():
                    _set_meta(db, key, value)
                _set_meta(db, 'logical_elapsed_seconds', 0)
                _set_meta(db, 'initialized', True)
            db.execute("UPDATE jobs SET status='queued',started_at=NULL WHERE status='running'")
        finally:
            db.close()

    def _init_legacy(self):
        import paid_access
        import reconcile_mock
        root = self.db_path.parent / 'runtime' / 'legacy'
        paid_access.STATE, paid_access.EVAL = root / 'access_state.json', root / 'access_oracle.json'
        reconcile_mock.STATE, reconcile_mock.EVAL = root / 'state.json', root / 'oracle.json'
        if not paid_access.STATE.exists():
            paid_access.ensure()
        if not reconcile_mock.STATE.exists():
            reconcile_mock.seed()

    def _resume_jobs(self):
        db = _conn(self.db_path)
        try:
            ids = [row[0] for row in db.execute("SELECT id FROM jobs WHERE status='queued' ORDER BY created_at")]
        finally:
            db.close()
        for job_id in ids:
            self._launch_job(job_id)

    def _record(self, action, details):
        db = _conn(self.db_path)
        try:
            db.execute('INSERT INTO journal(at,action,details) VALUES(?,?,?)',
                       (self.wall_now(), action, _json(details)))
        finally:
            db.close()

    @staticmethod
    def wall_now():
        return iso(datetime.now(timezone.utc))

    def scenario_now(self):
        db = _conn(self.db_path)
        try:
            return domain.logical_now(db)
        finally:
            db.close()

    def _manifest(self):
        db = _conn(self.db_path)
        try:
            return domain.manifest(db)
        finally:
            db.close()

    def _set_scenario_meta(self, key, value):
        db = _conn(self.db_path)
        try:
            db.execute('BEGIN IMMEDIATE')
            _set_meta(db, key, value)
            db.execute('COMMIT')
        except Exception:
            if db.in_transaction:
                db.execute('ROLLBACK')
            raise
        finally:
            db.close()

    def _pages(self, base_url, path):
        items, cursor, total, seen = [], None, None, set()
        while True:
            if cursor is not None:
                if cursor in seen:
                    raise RecoveryError('Source pagination cursor repeated', 502)
                seen.add(cursor)
            params = {'limit': '1000'}
            if cursor is not None:
                params['cursor'] = cursor
            result = internal_request(self.key, base_url, 'GET', path+'?'+urlencode(params))
            if not isinstance(result, dict) or not isinstance(result.get('items'), list):
                raise RecoveryError('Source returned an invalid page', 502)
            if total is None:
                total = result.get('total')
                if isinstance(total, bool) or not isinstance(total, int) or total < 0:
                    raise RecoveryError('Source returned an invalid total', 502)
            items.extend(result['items'])
            cursor = result.get('next_cursor')
            if cursor is None:
                break
            if len(items) >= total or not result['items']:
                raise RecoveryError('Source cursor does not match reported total', 502)
        if len(items) != total:
            raise RecoveryError('Source pagination is incomplete', 502)
        return items

    def _observations(self):
        gaps = []
        def pages(base, path, label):
            try:
                return self._pages(base, path)
            except Exception as exc:
                gaps.append(label+':'+(str(exc.status) if isinstance(exc, InternalHTTPError) else type(exc).__name__))
                return []
        providers = pages(self.provider_url, '/internal/provider/accounts', 'provider_registry')
        evidence = pages(self.provider_url, '/internal/provider/evidence', 'provider_evidence')
        profiles = pages(self.provider_url, '/internal/adapty/profiles', 'adapty_profiles')
        manifest = self._manifest()
        source_history = (pages(self.provider_url, '/internal/provider/history', 'official_source_history')
                          if manifest.get('scenario') == 'offline' else [])
        try:
            catalog = internal_request(self.key, self.provider_url, 'GET', '/internal/adapty/catalog')
        except Exception as exc:
            gaps.append('adapty_catalog:'+(str(exc.status) if isinstance(exc, InternalHTTPError) else type(exc).__name__))
            catalog = {'items': [], 'revision': None}
        clients = pages(self.lumen_url, '/internal/lumen/accounts', 'client_registry')
        history_hash = hashlib.sha256()
        for item in source_history:
            history_hash.update(domain.canonical(item).encode('utf-8'))
        source_history_summary = ({'record_count': len(source_history),
                                   'record_hash': history_hash.hexdigest(),
                                   'provenance': manifest.get('provenance'),
                                   'payment_verification': 'unverified_synthetic_history',
                                   'adapty_coverage': 'not_observed',
                                   'client_gate_coverage': 'not_observed'}
                                  if manifest.get('scenario') == 'offline' else None)
        provider_by_id = {row['user_id']: row for row in providers}
        evidence_by_id = {}
        for row in evidence:
            if row.get('user_id'):
                evidence_by_id.setdefault(row['user_id'], []).append(row)
        profiles_by_id = {row['user_id']: row for row in profiles}
        clients_by_id = {row['user_id']: row for row in clients}
        scope_ids = sorted(set(provider_by_id) | set(clients_by_id)
                           | {row['user_id'] for row in evidence if row.get('user_id')})
        return {'provider_accounts': providers, 'provider_evidence': evidence,
                'adapty_profiles': profiles, 'catalog': catalog,
                'lumen_accounts': clients, 'provider_by_id': provider_by_id,
                'evidence_by_id': evidence_by_id, 'profiles_by_id': profiles_by_id,
                'clients_by_id': clients_by_id, 'scope_ids': scope_ids,
                'source_history_summary': source_history_summary,
                'observed_at': self.wall_now(), 'scenario_observed_at': iso(self.scenario_now()),
                'complete': not gaps, 'gaps': gaps,
                'orphan_provider_records': sum(not row.get('user_id') for row in evidence)}

    def _classify(self, observations, incident):
        manifest = self._manifest()
        now = self.scenario_now()
        start, end = parse_time(incident['window_start']), parse_time(incident['window_end'])
        supported = manifest['scenario'] in ('stripe', 'paddle', 'custom')
        catalog = observations['catalog'].get('items', [])
        mapped = {(item['provider'], item['product_id'], item['price_id']) for item in catalog
                  if item.get('status') == 'mapped'}
        rows = []
        trigger = incident.get('trigger_user_id')
        trigger_records = observations['evidence_by_id'].get(trigger, [])
        trigger_evidence = self._latest_evidence(trigger_records)
        signature = incident.get('cohort_signature')
        trigger_signature = None
        if signature:
            trigger_signature = (signature.get('product_id'), signature.get('price_id'),
                                 signature.get('catalog_mapped_at_incident'))
        elif trigger_evidence:
            trigger_mapping = any(item['provider'] == manifest['scenario']
                                  and item['product_id'] == trigger_evidence.get('product_id')
                                  and item['price_id'] == trigger_evidence.get('price_id')
                                  and item.get('status') == 'mapped' for item in catalog)
            try:
                trigger_time = parse_time(trigger_evidence['occurred_at'])
                trigger_in_window = start <= trigger_time < end
            except (KeyError, RecoveryError):
                trigger_in_window = False
            if trigger_in_window and self._valid_evidence(trigger_evidence):
                trigger_signature = (trigger_evidence.get('product_id'),
                                     trigger_evidence.get('price_id'), trigger_mapping)
        for user_id in observations['scope_ids']:
            provider = observations['provider_by_id'].get(user_id)
            client = observations['clients_by_id'].get(user_id)
            profile = observations['profiles_by_id'].get(user_id)
            records = observations['evidence_by_id'].get(user_id, [])
            evidence = self._latest_evidence(records)
            gate = client.get('gate') if client else {'allowed': None, 'reason': 'client_not_observed'}
            identity_ok = bool(provider and client and provider['identity_status'] == 'mapped'
                               and client['identity_status'] == 'mapped'
                               and provider['provider_customer_id'] == client['provider_customer_id']
                               and evidence and evidence.get('provider_customer_id') == provider['provider_customer_id']
                               and evidence.get('user_id') == user_id)
            status, reason, eligible = 'inconclusive', 'source_unavailable', False
            in_window = False
            valid_evidence = self._valid_evidence(evidence) if evidence else False
            if evidence:
                try:
                    occurred = parse_time(evidence['occurred_at'], 'provider occurrence time')
                    observed = parse_time(evidence['observed_at'], 'provider observation time')
                    in_window = start <= occurred < end
                    age = (now - observed).total_seconds()
                except (KeyError, RecoveryError, TypeError):
                    age, in_window = float('inf'), False
            else:
                age = float('inf')
            if not observations['complete']:
                reason = 'coverage_incomplete'
            elif not identity_ok:
                reason = 'identity_unknown' if provider or client else 'account_not_observed'
            elif not evidence:
                reason = 'provider_evidence_unavailable'
            elif not valid_evidence:
                reason = 'provider_evidence_invalid'
            elif age < 0 or age > domain.FRESHNESS_TTL:
                reason = 'provider_evidence_stale'
            elif evidence.get('payment_state') not in ('paid', 'pending'):
                reason = 'payment_state_unsupported'
            elif evidence.get('access_basis') not in ('paid_period', 'trial', 'grace', 'manual'):
                reason = 'access_basis_unsupported'
            elif evidence.get('refund_state') not in ('none', 'refunded', 'revoked'):
                reason = 'refund_state_unsupported'
            elif (evidence.get('payment_state') != 'paid' or evidence.get('access_basis') != 'paid_period'
                  or evidence.get('amount_minor', 0) <= 0 or evidence.get('refund_state') != 'none'):
                status, reason = 'legitimate_denial', self._payment_reason(evidence)
            elif not self._evidence_current(evidence, now):
                status, reason = 'legitimate_denial', ('subscription_not_started'
                    if parse_time(evidence['starts_at']) > now else 'subscription_expired')
            elif client is None:
                reason = 'client_access_not_observed'
            elif not client['policy_enabled'] or gate.get('reason') == 'policy_restricted':
                status, reason = 'policy_denial', 'policy_restricted'
            elif gate.get('allowed'):
                status, reason = 'healthy', 'access_allowed'
            elif not in_window or trigger_signature is None:
                status, reason = 'potential', 'purchase_outside_incident_signature'
            elif (evidence.get('product_id'), evidence.get('price_id')) != trigger_signature[:2]:
                status, reason = 'potential', 'different_product_or_configuration_signature'
            elif profile and profile.get('status') == 'active' and not self._profile_matches(profile, evidence, user_id, now):
                reason = 'adapty_profile_purchase_mismatch'
            elif profile and self._profile_matches(profile, evidence, user_id, now):
                status, reason, eligible = 'confirmed', 'access_not_delivered', supported
            elif (manifest['scenario'] in ('apple', 'google')
                  and (not profile or profile.get('status') != 'active')):
                status, reason = 'confirmed', 'awaiting_client_action'
            elif not profile or profile.get('status') != 'active':
                status, reason, eligible = 'confirmed', 'activation_missing', supported
            else:
                status, reason = 'inconclusive', 'adapty_profile_not_current'
            product_id = (evidence or {}).get('product_id') or (profile or {}).get('product_id')
            price_id = (evidence or {}).get('price_id')
            current_profile = None if profile is None else bool(profile.get('status') == 'active'
                                                                and self._profile_current(profile, now))
            refs = []
            if evidence:
                refs.append(evidence['evidence_ref'])
            if profile is not None:
                refs.append('adapty://profile/'+user_id)
            if client is not None:
                refs.append('lumen://access/'+user_id)
            rows.append({'id': user_id, 'status': status, 'reason': reason,
                         'eligible': bool(eligible), 'provider': manifest['scenario'],
                         'product_id': product_id, 'price_id': price_id,
                         'payment_state': (evidence or {}).get('payment_state'),
                         'adapty_active': current_profile,
                         'gate': {'allowed': gate.get('allowed'),
                                  'reason': gate.get('reason', 'client_not_observed')},
                         'evidence_refs': refs,
                         'evidence_hash': (evidence or {}).get('evidence_hash'),
                         'occurred_at': (evidence or {}).get('occurred_at'),
                         'observed_at': (evidence or {}).get('observed_at'),
                         'identity_revision': (client or {}).get('identity_revision'),
                         'policy_revision': (client or {}).get('policy_revision'),
                         'projection_revision': (client or {}).get('projection_revision'),
                         'cache_revision': (client or {}).get('cache_revision'),
                         'adapty_revision': (profile or {}).get('revision'),
                         'catalog_mapped': bool(evidence and (manifest['scenario'], evidence['product_id'], evidence['price_id']) in mapped)})
        return rows

    @staticmethod
    def _latest_evidence(records):
        def key(row):
            try:
                return parse_time(row.get('occurred_at')).timestamp(), parse_time(row.get('observed_at')).timestamp()
            except (RecoveryError, TypeError, AttributeError):
                return float('-inf'), float('-inf')
        return max(records, key=key, default=None)

    @staticmethod
    def _valid_evidence(evidence):
        if not isinstance(evidence, dict):
            return False
        for name in ('transaction_id','provider_customer_id','product_id','price_id','payment_state',
                     'access_basis','currency','refund_state','evidence_hash','evidence_ref'):
            if not isinstance(evidence.get(name), str) or not evidence[name]:
                return False
        amount = evidence.get('amount_minor')
        if isinstance(amount, bool) or not isinstance(amount, int):
            return False
        if len(evidence['currency']) != 3 or not evidence['currency'].isalpha() or not evidence['currency'].isascii():
            return False
        try:
            if parse_time(evidence['starts_at']) >= parse_time(evidence['expires_at']):
                return False
            parse_time(evidence['occurred_at'])
            parse_time(evidence['observed_at'])
        except (KeyError, RecoveryError):
            return False
        return True

    @staticmethod
    def _payment_reason(evidence):
        if evidence.get('refund_state') not in (None, 'none'):
            return 'refunded_or_revoked'
        if evidence.get('payment_state') != 'paid':
            return 'payment_'+str(evidence.get('payment_state', 'unknown'))
        if evidence.get('access_basis') != 'paid_period':
            return 'unsupported_access_basis'
        if evidence.get('amount_minor', 0) <= 0:
            return 'non_positive_payment'
        return 'payment_not_eligible'

    @staticmethod
    def _evidence_current(evidence, now):
        try:
            return (parse_time(evidence['starts_at']) <= now < parse_time(evidence['expires_at']))
        except (KeyError, RecoveryError):
            return False

    def _source_fresh(self, evidence):
        try:
            age = (self.scenario_now()-parse_time(evidence['observed_at'])).total_seconds()
            return 0 <= age <= domain.FRESHNESS_TTL
        except (KeyError, RecoveryError):
            return False

    @staticmethod
    def _profile_current(profile, now):
        try:
            return parse_time(profile['expires_at']) > now
        except (KeyError, RecoveryError, TypeError):
            return False

    def _profile_matches(self, profile, evidence, user_id, now):
        return bool(profile and evidence and profile.get('status') == 'active'
                    and profile.get('product_id') == evidence.get('product_id')
                    and profile.get('transaction_id') == evidence.get('transaction_id')
                    and profile.get('expires_at') == evidence.get('expires_at')
                    and profile.get('entitlement_hash') == domain.digest({
                        'user_id': user_id, 'product_id': evidence.get('product_id'),
                        'expires_at': evidence.get('expires_at')})
                    and self._profile_current(profile, now))

    def _collector_events(self, incident):
        start, end = parse_time(incident['window_start']), parse_time(incident['window_end'])
        db = _conn(self.db_path)
        try:
            result = []
            for row in db.execute('SELECT event_json FROM collector_events ORDER BY recorded_at'):
                event = json.loads(row['event_json'])
                try:
                    occurred = parse_time(event['occurred_at'])
                except RecoveryError:
                    continue
                if start <= occurred < end:
                    result.append(event)
            return result
        finally:
            db.close()

    def _capture_snapshot(self, incident_id):
        incident = self._get_incident(incident_id)
        observations = self._observations()
        if not incident.get('cohort_signature'):
            trigger_evidence = self._latest_evidence(
                observations['evidence_by_id'].get(incident['trigger_user_id'], []))
            catalog_items = observations['catalog'].get('items', [])
            if trigger_evidence and self._valid_evidence(trigger_evidence):
                try:
                    occurred = parse_time(trigger_evidence['occurred_at'])
                    within_window = parse_time(incident['window_start']) <= occurred < parse_time(incident['window_end'])
                except RecoveryError:
                    within_window = False
                if within_window:
                    incident['cohort_signature'] = {
                        'provider': self._manifest()['scenario'],
                        'product_id': trigger_evidence['product_id'],
                        'price_id': trigger_evidence['price_id'],
                        'catalog_mapped_at_incident': any(item['provider'] == self._manifest()['scenario']
                            and item['product_id'] == trigger_evidence['product_id']
                            and item['price_id'] == trigger_evidence['price_id']
                            and item['status'] == 'mapped' for item in catalog_items),
                        'evidence_hash': trigger_evidence['evidence_hash'],
                    }
        history = self._collector_events(incident)
        accounts = self._classify(observations, incident)
        event_users = {event.get('app_user_id') for event in history if event.get('app_user_id')}
        window_start, window_end = parse_time(incident['window_start']), parse_time(incident['window_end'])
        expected_event_users = set()
        for item in observations['provider_evidence']:
            if not item.get('user_id'):
                continue
            try:
                if window_start <= parse_time(item['occurred_at']) < window_end:
                    expected_event_users.add(item['user_id'])
            except (KeyError, RecoveryError):
                continue
        missing_event_users = expected_event_users-event_users
        future_seconds = max(0, int((window_end-self.scenario_now()).total_seconds()))
        inconclusive_accounts = sum(account['status'] == 'inconclusive' for account in accounts)
        coverage_gaps = list(observations['gaps'])
        if not history:
            coverage_gaps.append('customer_event_history_not_observed')
        elif missing_event_users:
            coverage_gaps.append('customer_event_history_incomplete')
        if future_seconds:
            coverage_gaps.append('future_incident_window_not_observed')
        if inconclusive_accounts:
            coverage_gaps.append('inconclusive_account_observations')
        snapshot_id = 'snapshot-'+uuid4().hex
        snapshot = {'id': snapshot_id, 'incident_id': incident_id,
                    'manifest': self._manifest(), 'incident': incident,
                    'created_at': self.wall_now(),
                    'scenario_observed_at': observations['scenario_observed_at'],
                    'observation_basis': 'current_state_at_snapshot; historical_events_are_actual_received_events',
                    'accounts': accounts,
                    'provider_evidence': observations['provider_evidence'],
                    'provider_accounts': observations['provider_accounts'],
                    'adapty_profiles': observations['adapty_profiles'],
                    'adapty_catalog': observations['catalog'],
                    'lumen_accounts': observations['lumen_accounts'],
                    'historical_events': history,
                    'cohort_signature': incident.get('cohort_signature'),
                    'coverage': {'complete': observations['complete'] and not coverage_gaps,
                                 'gaps': coverage_gaps,
                                 'observed_at': observations['observed_at'],
                                 'provider_accounts': len(observations['provider_accounts']),
                                 'provider_evidence': len(observations['provider_evidence']),
                                 'adapty_profiles': len(observations['adapty_profiles']),
                                 'lumen_accounts': len(observations['lumen_accounts']),
                                 'scope_accounts': len(observations['scope_ids']),
                                 'orphan_provider_records': observations['orphan_provider_records'],
                                 'source_history': observations.get('source_history_summary'),
                                 'customer_event_users_observed': len(event_users),
                                 'customer_event_users_missing': len(missing_event_users),
                                 'future_window_remaining_seconds': future_seconds,
                                 'inconclusive_accounts': inconclusive_accounts}}
        snapshot['snapshot_hash'] = digest(snapshot)
        db = _conn(self.db_path)
        try:
            db.execute('BEGIN IMMEDIATE')
            db.execute('INSERT INTO snapshots VALUES(?,?,?,?,?,?)',
                       (snapshot_id, incident_id, snapshot['created_at'], snapshot['scenario_observed_at'],
                        snapshot['snapshot_hash'], _json(snapshot)))
            current = json.loads(db.execute('SELECT incident_json FROM incidents WHERE id=?',
                                            (incident_id,)).fetchone()[0])
            if not current.get('first_snapshot_id'):
                current['first_snapshot_id'] = snapshot_id
            current['snapshot_id'] = snapshot_id
            if incident.get('cohort_signature') and not current.get('cohort_signature'):
                current['cohort_signature'] = incident['cohort_signature']
            current['confirmed_ids'] = sorted(set(current.get('confirmed_ids', [])) |
                                             {item['id'] for item in accounts if item['status'] == 'confirmed'})
            current['assessment_summary'] = self._snapshot_summary(snapshot)
            current['status'] = 'scanned'
            db.execute('UPDATE incidents SET incident_json=? WHERE id=?', (_json(current), incident_id))
            db.execute('COMMIT')
        except Exception:
            if db.in_transaction:
                db.execute('ROLLBACK')
            raise
        finally:
            db.close()
        return snapshot

    def _get_incident(self, incident_id):
        db = _conn(self.db_path)
        try:
            row = db.execute('SELECT incident_json FROM incidents WHERE id=?', (incident_id,)).fetchone()
            if row is None:
                raise RecoveryError('Unknown incident', 404)
            return json.loads(row['incident_json'])
        finally:
            db.close()

    def _get_job(self, job_id):
        db = _conn(self.db_path)
        try:
            row = db.execute('SELECT * FROM jobs WHERE id=?', (job_id,)).fetchone()
            if row is None:
                raise RecoveryError('Unknown job', 404)
            result = {'id': row['id'], 'kind': row['kind'], 'status': row['status']}
            if row['error']:
                result['error'] = row['error']
            if row['result']:
                result['result'] = json.loads(row['result'])
            return result
        finally:
            db.close()

    def _new_job(self, kind, payload):
        job_id, now = 'job-'+uuid4().hex, self.wall_now()
        db = _conn(self.db_path)
        try:
            db.execute('INSERT INTO jobs(id,kind,status,payload,created_at,updated_at) VALUES(?,?,?,?,?,?)',
                       (job_id, kind, 'queued', _json(payload), now, now))
        finally:
            db.close()
        self._launch_job(job_id)
        return job_id

    def _launch_job(self, job_id):
        with self._jobs_lock:
            if job_id in self._active_jobs or len(self._active_jobs) >= MAX_JOB_WORKERS:
                return
            self._active_jobs.add(job_id)
            thread = threading.Thread(target=self._job_worker, args=(job_id,), daemon=True,
                                     name='recovery-'+job_id)
            thread.start()

    def _job_worker(self, job_id):
        try:
            self._run_job(job_id)
        finally:
            with self._jobs_lock:
                self._active_jobs.discard(job_id)
            self._resume_jobs()

    def _run_job(self, job_id):
        db = _conn(self.db_path)
        try:
            row = db.execute('SELECT kind,payload,status FROM jobs WHERE id=?', (job_id,)).fetchone()
            if row is None or row['status'] != 'queued':
                return
            db.execute("UPDATE jobs SET status='running',started_at=COALESCE(started_at,?),updated_at=? WHERE id=?",
                       (self.wall_now(), self.wall_now(), job_id))
            kind, payload = row['kind'], json.loads(row['payload'])
        finally:
            db.close()
        try:
            if kind in ('incident', 'scan'):
                snapshot = self._capture_snapshot(payload['incident_id'])
                result = {'incident_id': payload['incident_id'], 'snapshot_id': snapshot['id'],
                          'snapshot_hash': snapshot['snapshot_hash'],
                          'summary': self._snapshot_summary(snapshot)}
            elif kind == 'execution':
                result = self._execute_plan(payload['plan_id'], payload['plan_hash'])
            else:
                raise RecoveryError('Unknown job type')
            self._set_job(job_id, 'completed', result=result)
        except RecoveryError as exc:
            self._set_job(job_id, 'failed', error=str(exc))
        except Exception:
            self._set_job(job_id, 'failed', error='job_failed')

    def _set_job(self, job_id, status, *, result=None, error=None):
        db = _conn(self.db_path)
        try:
            db.execute('UPDATE jobs SET status=?,error=?,result=?,updated_at=? WHERE id=?',
                       (status, error, None if result is None else _json(result), self.wall_now(), job_id))
        finally:
            db.close()

    @staticmethod
    def _snapshot_summary(snapshot):
        counts = {}
        for account in snapshot['accounts']:
            counts[account['status']] = counts.get(account['status'], 0) + 1
        return {'in_scope': len(snapshot['accounts']),
                'evaluated': len(snapshot['accounts'])-counts.get('inconclusive', 0),
                'confirmed': counts.get('confirmed', 0),
                'inconclusive': counts.get('inconclusive', 0)}

    def _start_incident(self, user_id, occurred_at=None, window_start=None, window_end=None,
                        trigger_event_id=None):
        manifest = self._manifest()
        if not isinstance(user_id, str) or not user_id.strip() or len(user_id) > 256:
            raise RecoveryError('Invalid user_id')
        if (window_start is None) != (window_end is None):
            raise RecoveryError('window_start and window_end must be supplied together')
        at = self.scenario_now() if occurred_at is None else parse_time(occurred_at, 'occurred_at')
        start = parse_time(window_start, 'window_start') if window_start is not None else at-timedelta(minutes=5)
        end = parse_time(window_end, 'window_end') if window_end is not None else at+timedelta(minutes=5)
        if start >= end or (end-start).total_seconds() > 90*86400:
            raise RecoveryError('Incident window is invalid')
        if at < start or at > end:
            raise RecoveryError('occurred_at must fall inside the incident window')
        incident_id = 'incident-'+digest({'run_id': manifest['run_id'], 'user_id': user_id,
                                          'window_start': iso(start), 'window_end': iso(end),
                                          'trigger_event_id': trigger_event_id})[:20]
        incident = {'id': incident_id, 'run_id': manifest['run_id'], 'app': manifest['app'],
                    'environment': manifest['environment'], 'window_start': iso(start),
                    'window_end': iso(end), 'trigger_user_id': user_id,
                    'snapshot_id': None, 'first_snapshot_id': None,
                    'status': 'queued', 'trigger_event_id': trigger_event_id}
        db = _conn(self.db_path)
        try:
            db.execute('BEGIN IMMEDIATE')
            existing = db.execute('SELECT id,incident_json FROM incidents WHERE id=?', (incident_id,)).fetchone()
            if existing is None:
                for candidate in db.execute('SELECT id,incident_json FROM incidents ORDER BY rowid DESC'):
                    saved = json.loads(candidate['incident_json'])
                    if (saved['trigger_user_id'] == user_id and saved['window_start'] == iso(start)
                            and saved['window_end'] == iso(end) and saved['run_id'] == manifest['run_id']):
                        existing = candidate
                        break
            if trigger_event_id:
                existing = db.execute('SELECT id,incident_json FROM incidents WHERE trigger_event_id=?', (trigger_event_id,)).fetchone() or existing
            if existing:
                incident = json.loads(existing['incident_json'])
                job = db.execute('SELECT id FROM jobs WHERE payload LIKE ? ORDER BY created_at DESC LIMIT 1',
                                 ('%'+incident['id']+'%',)).fetchone()
                db.execute('COMMIT')
                return incident['id'], job['id'] if job else None
            job_id, now = 'job-'+uuid4().hex, self.wall_now()
            db.execute('INSERT INTO incidents VALUES(?,?,?,?)',
                       (incident_id, trigger_event_id, _json(incident), now))
            db.execute('INSERT INTO jobs(id,kind,status,payload,created_at,updated_at) VALUES(?,?,?,?,?,?)',
                       (job_id, 'incident', 'queued', _json({'incident_id': incident_id}), now, now))
            db.execute('COMMIT')
        except Exception:
            if db.in_transaction:
                db.execute('ROLLBACK')
            raise
        finally:
            db.close()
        self._record('incident_created', {'incident_id': incident_id, 'trigger_user_id': user_id})
        self._launch_job(job_id)
        return incident_id, job_id

    def _start_scan(self, incident_id):
        self._get_incident(incident_id)
        job_id = self._new_job('scan', {'incident_id': incident_id})
        self._record('scan_queued', {'incident_id': incident_id, 'job_id': job_id})
        return job_id

    def _load_snapshot(self, snapshot_id):
        db = _conn(self.db_path)
        try:
            row = db.execute('SELECT snapshot_json FROM snapshots WHERE id=?', (snapshot_id,)).fetchone()
            if row is None:
                raise RecoveryError('Unknown snapshot', 404)
            return json.loads(row['snapshot_json'])
        finally:
            db.close()

    def _latest_snapshot(self, incident_id=None):
        db = _conn(self.db_path)
        try:
            if incident_id:
                row = db.execute('SELECT snapshot_json FROM snapshots WHERE incident_id=? ORDER BY created_at DESC,rowid DESC LIMIT 1',
                                 (incident_id,)).fetchone()
            else:
                row = db.execute('SELECT snapshot_json FROM snapshots ORDER BY created_at DESC,rowid DESC LIMIT 1').fetchone()
            return None if row is None else json.loads(row['snapshot_json'])
        finally:
            db.close()

    def _create_plan(self, body):
        if not isinstance(body, dict) or set(body) != {'ids', 'incident_id'}:
            raise RecoveryError('Plan request fields do not match the contract')
        ids = body['ids']
        if (not isinstance(ids, list) or not ids or len(ids) > 10000
                or any(not isinstance(value, str) or not value or len(value) > 256 for value in ids)
                or len(set(ids)) != len(ids)):
            raise RecoveryError('ids must be a non-empty list of unique account IDs')
        incident = self._get_incident(body['incident_id'])
        snapshot = self._latest_snapshot(incident['id'])
        if snapshot is None:
            raise RecoveryError('Incident has no completed snapshot', 409)
        account_by_id = {row['id']: row for row in snapshot['accounts']}
        probe_only = self._unverified_target_ids(incident['id'])
        selected = []
        for user_id in ids:
            row = account_by_id.get(user_id)
            if row is None:
                raise RecoveryError('Account is outside the snapshot scope', 409)
            if not row['eligible'] and not (row['status'] == 'healthy' and user_id in probe_only):
                raise RecoveryError('Account is not eligible: '+user_id, 409)
            selected.append(row)
        manifest = snapshot['manifest']
        provider = manifest['scenario']
        supported = provider in ('stripe', 'paddle', 'custom')
        profile_by_id = {row['user_id']: row for row in snapshot['adapty_profiles']}
        evidence_by_id = {}
        for item in snapshot['provider_evidence']:
            if item.get('user_id'):
                evidence_by_id.setdefault(item['user_id'], []).append(item)
        catalog = snapshot['adapty_catalog']
        catalog_items = catalog.get('items', [])
        entries = []
        mapping_groups = {}
        for account in selected:
            evidence = self._latest_evidence(evidence_by_id[account['id']])
            key = (evidence['product_id'], evidence['price_id'])
            mapping_groups.setdefault(key, evidence)
        for (product_id, price_id), evidence in sorted(mapping_groups.items()):
            is_mapped = any(item['provider'] == provider and item['product_id'] == product_id
                            and item['price_id'] == price_id and item['status'] == 'mapped'
                            for item in catalog_items)
            if not is_mapped:
                entries.append(self._entry(None, 'adapty', 'repair_catalog',
                    {'provider': provider, 'product_id': product_id, 'price_id': price_id,
                     'future_purchase_scope': 'all future purchases using this product and price'},
                    {'catalog_revision': catalog.get('revision', 0)}))
        for account in selected:
            user_id = account['id']
            profile = profile_by_id.get(user_id)
            evidence = self._latest_evidence(evidence_by_id[user_id])
            if not self._profile_matches(profile, evidence, user_id, parse_time(snapshot['scenario_observed_at'])):
                entries.append(self._entry(user_id, 'adapty', 'validate_purchase',
                    {'provider': provider, 'transaction_id': evidence['transaction_id'],
                     'product_id': evidence['product_id'], 'price_id': evidence['price_id']},
                    {'evidence_hash': evidence['evidence_hash'], 'identity_revision': account['identity_revision']}))
        for account in selected:
            if account['gate']['allowed'] and account['id'] in probe_only:
                continue
            profile = profile_by_id.get(account['id'])
            evidence = self._latest_evidence(evidence_by_id[account['id']])
            entries.append(self._entry(account['id'], 'lumen', 'resync_access',
                {'product_id': evidence['product_id'], 'transaction_id': evidence['transaction_id']},
                {'projection_revision': account['projection_revision'],
                 'identity_revision': account['identity_revision'],
                 'policy_revision': account['policy_revision'],
                 'profile_revision': None if profile is None else profile['revision'],
                 'profile_hash': None if profile is None else profile.get('entitlement_hash'),
                 'evidence_hash': evidence['evidence_hash']}))
        for account in selected:
            entries.append(self._entry(account['id'], 'lumen', 'verify_gate',
                {'feature': recovery_scenarios.FEATURE},
                {'projection_revision': account['projection_revision'],
                 'policy_revision': account['policy_revision']}))
        created_wall = datetime.now(timezone.utc)
        created_scenario = self.scenario_now()
        expires_wall = created_wall+timedelta(seconds=300)
        expires_scenario = created_scenario+timedelta(seconds=300)
        steps = [
            {'id': 'catalog', 'title': 'Repair the Adapty catalog',
             'description': ('Add the missing product and price mapping. This also affects future purchases using this price.'
                             if any(item['type'] == 'repair_catalog' for item in entries)
                             else 'Confirm the product and price are already mapped.'),
             'owner': 'adapty', 'status': 'ready',
             'expected_effect': 'Enable supported purchase validation for the selected product and price.'},
            {'id': 'validate', 'title': 'Validate provider purchases',
             'description': 'Validate only the selected provider transactions against current paid-period evidence.',
             'owner': 'adapty', 'status': 'ready', 'selected_ids': ids,
             'expected_effect': 'Create or refresh the corresponding Adapty profiles.'},
            {'id': 'resync', 'title': 'Resync Lumen access',
             'description': 'Update each selected client projection using the freshly read Adapty profile and expected revision.',
             'owner': 'lumen', 'status': 'ready', 'selected_ids': ids,
             'expected_effect': 'Deliver the paid entitlement to the application feature gate.'},
            {'id': 'verify', 'title': 'Verify the feature gate',
             'description': 'Probe the actual Lumen gate for every selected account after resync.',
             'owner': 'lumen', 'status': 'ready', 'selected_ids': ids,
             'expected_effect': 'Confirm allowed access for the selected feature.'},
        ]
        required_steps = {item['type'] for item in entries}
        steps = [step for step in steps if {'catalog': 'repair_catalog', 'validate': 'validate_purchase',
                 'resync': 'resync_access', 'verify': 'verify_gate'}[step['id']] in required_steps]
        plan = {'id': 'plan-'+uuid4().hex, 'incident_id': incident['id'],
                'snapshot_id': snapshot['id'], 'snapshot_hash': snapshot['snapshot_hash'],
                'app': manifest['app'], 'environment': manifest['environment'],
                'run_id': manifest['run_id'], 'provider': provider,
                'ids': ids, 'target_count': len(ids), 'created_at': iso(created_wall),
                'scenario_created_at': iso(created_scenario), 'expires_at': iso(expires_wall),
                'scenario_expires_at': iso(expires_scenario),
                'timestamp_kind': 'wall_and_scenario_clock', 'entries': entries,
                'steps': steps,
                'expected_effect': {'activation_target': len(ids), 'access_target': len(ids),
                                    'manual_grant': False, 'future_purchase_scope': any(item['type'] == 'repair_catalog' for item in entries)}}
        plan['plan_hash'] = digest(plan)
        db = _conn(self.db_path)
        try:
            db.execute('INSERT INTO plans VALUES(?,?,?,?,?,?,?,?,?)',
                       (plan['id'], plan['plan_hash'], plan['incident_id'], plan['snapshot_id'],
                        _json(plan), 'pending_approval', iso(created_wall), iso(expires_wall),
                        plan['scenario_expires_at']))
        finally:
            db.close()
        self._record('plan_created', {'plan_id': plan['id'], 'plan_hash': plan['plan_hash'],
                                     'snapshot_id': plan['snapshot_id'], 'target_count': len(ids)})
        return plan

    @staticmethod
    def _entry(account_id, owner, action_type, target, preconditions):
        return {'id': 'action-'+uuid4().hex, 'account_id': account_id,
                'owner': owner, 'type': action_type, 'target': target,
                'preconditions': preconditions, 'status': 'accepted',
                'started_at': None, 'finished_at': None,
                'evidence_ref': None, 'next_step': action_type}

    def _load_plan(self, plan_id):
        db = _conn(self.db_path)
        try:
            row = db.execute('SELECT * FROM plans WHERE id=?', (plan_id,)).fetchone()
            if row is None:
                raise RecoveryError('Unknown plan', 404)
            plan = json.loads(row['plan_json'])
            return row, plan
        finally:
            db.close()

    def _require_plan_hash(self, plan, value):
        if not isinstance(value, str) or not hmac.compare_digest(plan['plan_hash'], value):
            raise RecoveryError('Plan hash does not match', 409)

    def _approve(self, body):
        if not isinstance(body, dict) or set(body) != {'plan_id', 'plan_hash', 'actor'}:
            raise RecoveryError('Approval fields do not match the contract')
        if not isinstance(body['actor'], str) or not body['actor'].strip() or len(body['actor']) > 100:
            raise RecoveryError('Invalid actor')
        row, plan = self._load_plan(body['plan_id'])
        self._require_plan_hash(plan, body['plan_hash'])
        if datetime.now(timezone.utc) >= parse_time(row['expires_at_wall']) or self.scenario_now() >= parse_time(row['scenario_expires_at']):
            raise RecoveryError('Plan approval window expired', 409)
        db = _conn(self.db_path)
        try:
            db.execute('BEGIN IMMEDIATE')
            previous = db.execute('SELECT * FROM approvals WHERE plan_id=?', (plan['id'],)).fetchone()
            if previous:
                if previous['plan_hash'] != plan['plan_hash'] or previous['actor'] != body['actor']:
                    raise RecoveryError('Plan already has a different approval', 409)
                db.execute('COMMIT')
                return {'plan_id': plan['id'], 'plan_hash': plan['plan_hash'],
                        'actor': previous['actor'], 'approved_at': previous['approved_at_wall'],
                        'duplicate': True}
            now = self.wall_now()
            db.execute('INSERT INTO approvals VALUES(?,?,?,?)',
                       (plan['id'], plan['plan_hash'], body['actor'].strip(), now))
            db.execute("UPDATE plans SET status='approved' WHERE id=?", (plan['id'],))
            db.execute('COMMIT')
        except Exception:
            if db.in_transaction:
                db.execute('ROLLBACK')
            raise
        finally:
            db.close()
        self._record('plan_approved', {'plan_id': plan['id'], 'actor': body['actor'].strip()})
        return {'plan_id': plan['id'], 'plan_hash': plan['plan_hash'],
                'actor': body['actor'].strip(), 'approved_at': now, 'duplicate': False}

    def _start_execution(self, body):
        if not isinstance(body, dict) or set(body) != {'plan_id', 'plan_hash'}:
            raise RecoveryError('Execution fields do not match the contract')
        row, plan = self._load_plan(body['plan_id'])
        self._require_plan_hash(plan, body['plan_hash'])
        db = _conn(self.db_path)
        try:
            approval = db.execute('SELECT * FROM approvals WHERE plan_id=?', (plan['id'],)).fetchone()
            if not approval or approval['plan_hash'] != plan['plan_hash']:
                raise RecoveryError('Plan requires a separate approval', 409)
            if datetime.now(timezone.utc) >= parse_time(row['expires_at_wall']) or self.scenario_now() >= parse_time(row['scenario_expires_at']):
                raise RecoveryError('Plan approval window expired', 409)
            if row['status'] not in ('approved', 'executing', 'completed', 'partial', 'unknown_outcome'):
                raise RecoveryError('Plan is not executable', 409)
            previous = None
            for item in db.execute("SELECT id,status,payload FROM jobs WHERE kind='execution' ORDER BY created_at"):
                if json.loads(item['payload']).get('plan_id') == plan['id']:
                    previous = item
                    break
            if previous:
                return {'job_id': previous['id'], 'plan_id': plan['id'],
                        'status': previous['status'], 'duplicate': True}
        finally:
            db.close()
        # Do the complete read-only source/config/client preflight before
        # accepting an asynchronous execution job. No remote state is changed.
        self._preflight(plan)
        db = _conn(self.db_path)
        try:
            db.execute('BEGIN IMMEDIATE')
            approval = db.execute('SELECT * FROM approvals WHERE plan_id=?', (plan['id'],)).fetchone()
            current_plan = db.execute('SELECT * FROM plans WHERE id=?', (plan['id'],)).fetchone()
            if not approval or approval['plan_hash'] != plan['plan_hash']:
                raise RecoveryError('Plan requires a separate approval', 409)
            if datetime.now(timezone.utc) >= parse_time(current_plan['expires_at_wall']) or self.scenario_now() >= parse_time(current_plan['scenario_expires_at']):
                raise RecoveryError('Plan approval window expired', 409)
            if current_plan['status'] not in ('approved', 'executing', 'completed', 'partial', 'unknown_outcome'):
                raise RecoveryError('Plan is not executable', 409)
            previous = None
            for item in db.execute("SELECT id,status,payload FROM jobs WHERE kind='execution' ORDER BY created_at"):
                if json.loads(item['payload']).get('plan_id') == plan['id']:
                    previous = item
                    break
            if previous:
                db.execute('COMMIT')
                return {'job_id': previous['id'], 'plan_id': plan['id'],
                        'status': previous['status'], 'duplicate': True}
            job_id, now = 'job-'+uuid4().hex, self.wall_now()
            db.execute('INSERT INTO jobs(id,kind,status,payload,created_at,updated_at) VALUES(?,?,?,?,?,?)',
                       (job_id, 'execution', 'queued', _json({'plan_id': plan['id'],
                        'plan_hash': plan['plan_hash']}), now, now))
            db.execute("UPDATE plans SET status='executing' WHERE id=?", (plan['id'],))
            db.execute('COMMIT')
        except Exception:
            if db.in_transaction:
                db.execute('ROLLBACK')
            raise
        finally:
            db.close()
        self._record('execution_queued', {'plan_id': plan['id'], 'job_id': job_id})
        self._launch_job(job_id)
        return {'job_id': job_id, 'plan_id': plan['id'], 'status': 'queued', 'duplicate': False}

    def _preflight(self, plan):
        if datetime.now(timezone.utc) >= parse_time(plan['expires_at']):
            raise RecoveryError('Plan wall-clock TTL expired', 409)
        if self.scenario_now() >= parse_time(plan['scenario_expires_at']):
            raise RecoveryError('Plan scenario-clock TTL expired', 409)
        if plan['app'] != self._manifest()['app'] or plan['environment'] != self._manifest()['environment'] or plan['run_id'] != self._manifest()['run_id']:
            raise RecoveryError('Plan scope changed', 409)
        observations = self._observations()
        incident = self._get_incident(plan['incident_id'])
        current = {row['id']: row for row in self._classify(observations, incident)}
        snapshot = self._load_snapshot(plan['snapshot_id'])
        original = {row['id']: row for row in snapshot['accounts']}
        probe_only = self._unverified_target_ids(plan['incident_id'])
        for user_id in plan['ids']:
            before, after = original[user_id], current.get(user_id)
            if after is None or not (after['eligible'] or (after['status'] == 'healthy' and user_id in probe_only)):
                raise RecoveryError('Plan preflight failed: account is no longer eligible', 409)
            for key in ('evidence_hash', 'identity_revision', 'policy_revision', 'projection_revision', 'cache_revision', 'adapty_revision'):
                if before.get(key) != after.get(key):
                    raise RecoveryError('Plan preflight failed: '+key+' changed', 409)
        if observations['catalog'].get('revision') != snapshot['adapty_catalog'].get('revision'):
            raise RecoveryError('Plan preflight failed: catalog revision changed', 409)
        if digest(observations['catalog'].get('items', [])) != digest(snapshot['adapty_catalog'].get('items', [])):
            raise RecoveryError('Plan preflight failed: catalog mapping changed', 409)
        # Every selected row was checked before action intents are persisted.
        return observations

    def _action_rows(self, plan_id):
        db = _conn(self.db_path)
        try:
            return {row['id']: dict(row) for row in db.execute('SELECT * FROM actions WHERE plan_id=?', (plan_id,))}
        finally:
            db.close()

    def _save_action(self, entry, plan_id, status, *, started=False, result=None, evidence_ref=None):
        now = self.wall_now()
        db = _conn(self.db_path)
        try:
            db.execute('BEGIN IMMEDIATE')
            row = db.execute('SELECT * FROM actions WHERE id=?', (entry['id'],)).fetchone()
            started_at = now if started and (row is None or row['started_at'] is None) else (None if row is None else row['started_at'])
            finished_at = now if status in ('verified', 'failed', 'unknown_outcome', 'blocked', 'awaiting_client_action') else (None if row is None else row['finished_at'])
            db.execute('INSERT INTO actions(id,plan_id,account_id,owner,target,preconditions,status,started_at,finished_at,evidence_ref,result) VALUES(?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET status=excluded.status,started_at=COALESCE(actions.started_at,excluded.started_at),finished_at=excluded.finished_at,evidence_ref=COALESCE(excluded.evidence_ref,actions.evidence_ref),result=COALESCE(excluded.result,actions.result)',
                       (entry['id'], plan_id, entry['account_id'], entry['owner'], _json(entry['target']),
                        _json(entry['preconditions']), status, started_at, finished_at, evidence_ref,
                        None if result is None else _json(result)))
            db.execute('COMMIT')
        except Exception:
            if db.in_transaction:
                db.execute('ROLLBACK')
            raise
        finally:
            db.close()

    def _existing_action(self, action_id):
        db = _conn(self.db_path)
        try:
            row = db.execute('SELECT * FROM actions WHERE id=?', (action_id,)).fetchone()
            return None if row is None else dict(row)
        finally:
            db.close()

    def _read_remote_action(self, owner, operation_key):
        if owner == 'adapty':
            result = internal_request(self.key, self.provider_url, 'GET',
                                      '/internal/adapty/action?'+urlencode({'operation_key': operation_key}))
        else:
            result = internal_request(self.key, self.lumen_url, 'GET',
                                      '/internal/lumen/action?'+urlencode({'operation_key': operation_key}))
        return result

    def _remote_post(self, owner, endpoint, body, operation_key):
        base = self.provider_url if owner == 'adapty' else self.lumen_url
        try:
            result = internal_request(self.key, base, 'POST', endpoint, body)
            return result, None
        except Exception as exc:
            try:
                readback = self._read_remote_action(owner, operation_key)
            except Exception:
                readback = None
            if isinstance(readback, dict) and readback.get('accepted') is True:
                return readback, None
            if isinstance(exc, InternalHTTPError) and exc.status < 500 and exc.status != 429:
                return None, 'blocked' if exc.status in (400, 404, 409, 422) else 'failed'
            return None, 'unknown_outcome'

    def _operation_result(self, entry, plan_id, owner, endpoint, body, *, allow_new=True):
        prior = self._existing_action(entry['id'])
        if prior and prior['status'] in ('verified', 'failed', 'blocked', 'awaiting_client_action'):
            return None if not prior['result'] else json.loads(prior['result']), prior['status']
        operation_key = entry['id']
        if prior and prior['started_at']:
            try:
                result = self._read_remote_action(owner, operation_key)
            except Exception:
                result = None
            if isinstance(result, dict) and result.get('accepted') is True:
                return result, 'verified'
            self._save_action(entry, plan_id, 'unknown_outcome', result={'reason': 'readback_not_found'})
            return None, 'unknown_outcome'
        if not allow_new:
            self._save_action(entry, plan_id, 'blocked', result={'reason': 'restart_requires_new_preview'})
            return None, 'blocked'
        self._save_action(entry, plan_id, 'accepted', started=True)
        request = {**body, 'operation_key': operation_key}
        result, status = self._remote_post(owner, endpoint, request, operation_key)
        if status:
            self._save_action(entry, plan_id, status, result={'reason': 'remote_result_unavailable'})
            return None, status
        return result, 'verified'

    def _profile(self, user_id):
        result = internal_request(self.key, self.provider_url, 'GET',
                                  '/internal/adapty/profile?'+urlencode({'user': user_id}))
        return result

    @staticmethod
    def _validation_wire(provider, user_id, transaction_id):
        if provider in ('stripe', 'paddle'):
            return recovery_contracts.validation_request(provider, user_id, transaction_id)
        if provider == 'custom':
            return {'method':'POST','path':'/custom-store/transactions/validate',
                    'content_type':'application/json',
                    'body':{'customer_user_id':user_id,'transaction_id':transaction_id}}
        raise RecoveryError('awaiting_client_action', 409)

    def _probe(self, user_id):
        return internal_request(self.key, self.lumen_url, 'POST', '/internal/lumen/probe',
                                {'user_id': user_id, 'feature': recovery_scenarios.FEATURE,
                                 'initiator': 'reconcile_probe'})

    def _execute_plan(self, plan_id, supplied_hash):
        row, plan = self._load_plan(plan_id)
        self._require_plan_hash(plan, supplied_hash)
        db = _conn(self.db_path)
        try:
            approval = db.execute('SELECT * FROM approvals WHERE plan_id=?', (plan_id,)).fetchone()
            if not approval or approval['plan_hash'] != plan['plan_hash']:
                raise RecoveryError('Plan requires a separate approval', 409)
        finally:
            db.close()
        existing = self._action_rows(plan_id)
        resuming = bool(existing)
        if not resuming:
            self._preflight(plan)
            db = _conn(self.db_path)
            try:
                db.execute('BEGIN IMMEDIATE')
                for entry in plan['entries']:
                    db.execute('INSERT INTO actions(id,plan_id,account_id,owner,target,preconditions,status) VALUES(?,?,?,?,?,?,?)',
                               (entry['id'], plan_id, entry['account_id'], entry['owner'],
                                _json(entry['target']), _json(entry['preconditions']), 'accepted'))
                db.execute('COMMIT')
            except Exception:
                if db.in_transaction:
                    db.execute('ROLLBACK')
                raise
            finally:
                db.close()
        outcomes = {}
        config_ok = True
        for entry in plan['entries']:
            if entry['type'] != 'repair_catalog':
                continue
            catalog_body = {key: entry['target'][key]
                            for key in ('provider', 'product_id', 'price_id')}
            result, status = self._operation_result(entry, plan_id, 'adapty',
                '/internal/adapty/catalog/repair', catalog_body, allow_new=not resuming)
            if status == 'verified' and result:
                cat = internal_request(self.key, self.provider_url, 'GET', '/internal/adapty/catalog')
                is_mapped = any(item['provider'] == entry['target']['provider']
                                and item['product_id'] == entry['target']['product_id']
                                and item['price_id'] == entry['target']['price_id']
                                and item['status'] == 'mapped' for item in cat.get('items', []))
                if not is_mapped:
                    status = 'unknown_outcome'
            config_ok = config_ok and status == 'verified'
            self._save_action(entry, plan_id, status, result=result,
                              evidence_ref='adapty://catalog/'+entry['target']['price_id'])
            outcomes[entry['id']] = status

        validation_ok = {}
        for entry in plan['entries']:
            if entry['type'] != 'validate_purchase':
                continue
            if not config_ok:
                self._save_action(entry, plan_id, 'blocked', result={'reason': 'catalog_prerequisite_not_verified'})
                validation_ok[entry['account_id']] = False
                outcomes[entry['id']] = 'blocked'
                continue
            result, status = self._operation_result(entry, plan_id, 'adapty',
                '/internal/adapty/validate', {'provider': plan['provider'],
                                               'transaction_id': entry['target']['transaction_id'],
                                               'user_id': entry['account_id'],
                                               'wire_request': self._validation_wire(plan['provider'],
                                                   entry['account_id'], entry['target']['transaction_id'])}, allow_new=not resuming)
            if status == 'verified':
                profile = self._profile(entry['account_id'])
                status = ('verified' if profile and profile.get('status') == 'active'
                          and profile.get('transaction_id') == entry['target']['transaction_id']
                          and profile.get('entitlement_hash') == (result or {}).get('entitlement_hash')
                          else 'unknown_outcome')
                if status == 'unknown_outcome':
                    result = {'reason': 'profile_readback_mismatch'}
            validation_ok[entry['account_id']] = status == 'verified'
            self._save_action(entry, plan_id, status, result=result,
                              evidence_ref='adapty://profile/'+entry['account_id'])
            outcomes[entry['id']] = status

        for entry in plan['entries']:
            if entry['type'] != 'resync_access':
                continue
            if not config_ok or validation_ok.get(entry['account_id']) is False:
                self._save_action(entry, plan_id, 'blocked', result={'reason': 'activation_prerequisite_not_verified'})
                outcomes[entry['id']] = 'blocked'
                continue
            fresh = self._observations()
            current = next((item for item in self._classify(fresh, self._get_incident(plan['incident_id']))
                            if item['id'] == entry['account_id']), None)
            source = self._latest_evidence(fresh['evidence_by_id'].get(entry['account_id'], []))
            profile = fresh['profiles_by_id'].get(entry['account_id'])
            if (not current or current['status'] not in ('confirmed', 'healthy')
                    or current['evidence_hash'] != entry['preconditions']['evidence_hash']
                    or current['identity_revision'] != entry['preconditions']['identity_revision']
                    or current['policy_revision'] != entry['preconditions']['policy_revision']
                    or not self._profile_matches(profile, source, entry['account_id'], self.scenario_now())):
                self._save_action(entry, plan_id, 'blocked', result={'reason': 'fresh_payment_or_profile_precondition_changed'})
                outcomes[entry['id']] = 'blocked'
                continue
            entitlement = {'product_id': profile['product_id'], 'expires_at': profile['expires_at'],
                           'entitlement_hash': profile['entitlement_hash'],
                           'transaction_id': profile['transaction_id']}
            body = {'user_id': entry['account_id'],
                    'expected_revision': entry['preconditions']['projection_revision'],
                    'entitlement': entitlement}
            result, status = self._operation_result(entry, plan_id, 'lumen',
                '/internal/lumen/resync', body, allow_new=not resuming)
            self._save_action(entry, plan_id, status, result=result,
                              evidence_ref='lumen://access/'+entry['account_id'])
            outcomes[entry['id']] = status

        for entry in plan['entries']:
            if entry['type'] != 'verify_gate':
                continue
            resync = next((item for item in plan['entries'] if item['type'] == 'resync_access'
                           and item['account_id'] == entry['account_id']), None)
            resync_row = self._existing_action(resync['id']) if resync else None
            if resync and (not resync_row or resync_row['status'] != 'verified'):
                self._save_action(entry, plan_id, 'blocked', result={'reason': 'resync_not_verified'})
                outcomes[entry['id']] = 'blocked'
                continue
            prior = self._existing_action(entry['id'])
            if prior and prior['status'] in ('verified', 'failed', 'unknown_outcome'):
                outcomes[entry['id']] = prior['status']
                continue
            self._save_action(entry, plan_id, 'accepted', started=True)
            try:
                gate = self._probe(entry['account_id'])
                status = 'verified' if gate.get('allowed') is True else 'failed'
                result = {'allowed': bool(gate.get('allowed')), 'reason': gate.get('reason')}
            except Exception:
                try:
                    gate = internal_request(self.key, self.lumen_url, 'GET',
                        '/internal/lumen/access?'+urlencode({'user': entry['account_id']}))
                    status = 'unknown_outcome'
                    result = {'reason': 'independent_gate_probe_unavailable',
                              'readback_gate': {'allowed': bool(gate.get('allowed')),
                                                'reason': gate.get('reason')}}
                except Exception:
                    status, result = 'unknown_outcome', {'reason': 'probe_readback_unavailable'}
            self._save_action(entry, plan_id, status, result=result,
                              evidence_ref='lumen://probe/'+entry['account_id'])
            outcomes[entry['id']] = status

        access = self._capture_snapshot(plan['incident_id'])
        profiles = {item['user_id']: item for item in access['adapty_profiles']}
        evidence_by_id = {}
        for item in access['provider_evidence']:
            if item.get('user_id'):
                evidence_by_id.setdefault(item['user_id'], []).append(item)
        activated_ids = set()
        for user_id in plan['ids']:
            profile = profiles.get(user_id)
            source = self._latest_evidence(evidence_by_id.get(user_id, []))
            if (profile and source and profile.get('status') == 'active'
                    and profile.get('product_id') == source.get('product_id')
                    and profile.get('transaction_id') == source.get('transaction_id')
                    and profile.get('entitlement_hash') == domain.digest({'user_id': user_id,
                        'product_id': source.get('product_id'), 'expires_at': source.get('expires_at')})
                    and self._profile_current(profile, self.scenario_now())
                    and self._evidence_current(source, self.scenario_now())
                    and source.get('payment_state') == 'paid'
                    and source.get('access_basis') == 'paid_period'
                    and source.get('refund_state') == 'none'
                    and self._source_fresh(source)):
                activated_ids.add(user_id)
        activated = len(activated_ids)
        gate_rows = {row['user_id']: row for row in access['lumen_accounts']}
        verified_probe_ids = set()
        for entry in plan['entries']:
            if entry['type'] != 'verify_gate':
                continue
            action = self._existing_action(entry['id'])
            action_result = json.loads(action['result']) if action and action['result'] else {}
            if action and action['status'] == 'verified' and action_result.get('allowed') is True:
                verified_probe_ids.add(entry['account_id'])
        accessible_ids = {user_id for user_id in plan['ids'] if user_id in activated_ids
                          and user_id in gate_rows and gate_rows[user_id]['gate']['allowed']
                          and user_id in verified_probe_ids}
        accessible = len(accessible_ids)
        result = {'plan_id': plan_id, 'snapshot_id': access['id'],
                  'target_count': len(plan['ids']), 'activation_verified': activated,
                  'access_verified': accessible, 'unresolved': len(plan['ids'])-accessible,
                  'action_statuses': outcomes,
                  'unresolved_ids': [user_id for user_id in plan['ids']
                                     if user_id not in accessible_ids]}
        status = 'completed' if accessible == len(plan['ids']) else 'partial'
        db = _conn(self.db_path)
        try:
            db.execute('UPDATE plans SET status=? WHERE id=?', (status, plan_id))
        finally:
            db.close()
        self._record('execution_finished', result)
        return result

    def _plans(self):
        db = _conn(self.db_path)
        try:
            rows = list(db.execute('SELECT plan_json,status FROM plans ORDER BY created_at_wall,rowid'))
            return [{**json.loads(row['plan_json']), 'status': row['status']} for row in rows]
        finally:
            db.close()

    def _actions(self):
        db = _conn(self.db_path)
        try:
            rows = list(db.execute('SELECT * FROM actions ORDER BY started_at,id'))
            return [{'id': row['id'], 'plan_id': row['plan_id'], 'account_id': row['account_id'], 'owner': row['owner'],
                     'target': json.loads(row['target']), 'preconditions': json.loads(row['preconditions']),
                     'status': row['status'], 'started_at': row['started_at'],
                     'finished_at': row['finished_at'], 'evidence_ref': row['evidence_ref'],
                     'next_step': self._next_step(row['status']),
                     **({'result': json.loads(row['result'])} if row['result'] else {})} for row in rows]
        finally:
            db.close()

    @staticmethod
    def _next_step(status):
        return {'verified': 'none', 'failed': 'review_failure', 'unknown_outcome': 'read_back_before_retry',
                'blocked': 'resolve_precondition', 'awaiting_client_action': 'complete_client_action',
                'accepted': 'execute_after_approval'}.get(status, 'review')

    def _jobs(self):
        db = _conn(self.db_path)
        try:
            rows = list(db.execute('SELECT id,kind,status,error,result,created_at,updated_at FROM jobs ORDER BY created_at DESC LIMIT 100'))
            return [{'id': row['id'], 'kind': row['kind'], 'status': row['status'],
                     'created_at': row['created_at'], 'updated_at': row['updated_at'],
                     **({'error': row['error']} if row['error'] else {}),
                     **({'result': json.loads(row['result'])} if row['result'] else {})} for row in rows]
        finally:
            db.close()

    def _target_ids(self, plans):
        return {user_id for plan in plans for user_id in plan.get('ids', [])}

    def _unverified_target_ids(self, incident_id):
        latest = {}
        for plan in self._plans():
            if plan['incident_id'] != incident_id:
                continue
            for entry in plan['entries']:
                if entry['type'] == 'verify_gate':
                    action = self._existing_action(entry['id'])
                    if action:
                        latest[entry['account_id']] = action['status']
        return {user_id for user_id, status in latest.items() if status != 'verified'}

    def _report(self, incident_id=None):
        manifest = self._manifest()
        incident = None
        db = _conn(self.db_path)
        try:
            incidents = [json.loads(row['incident_json']) for row in db.execute(
                'SELECT incident_json FROM incidents ORDER BY created_at DESC,rowid DESC')]
            incident = next((item for item in incidents if item['id'] == incident_id), None) if incident_id else (incidents[0] if incidents else None)
            if incident_id and incident is None:
                raise RecoveryError('Unknown incident', 404)
        finally:
            db.close()
        snapshot = self._latest_snapshot(incident['id']) if incident else None
        first_snapshot = None
        if incident and incident.get('first_snapshot_id'):
            first_snapshot = self._load_snapshot(incident['first_snapshot_id'])
        observations = None
        gaps = []
        try:
            observations = self._observations()
            gaps.extend(observations['gaps'])
        except Exception as exc:
            gaps.append('source_unavailable:'+type(exc).__name__)
        if observations:
            if incident and snapshot:
                accounts = self._classify(observations, incident)
            else:
                accounts = self._unclassified_accounts(observations)
            if incident and snapshot:
                coverage = {**snapshot['coverage'],
                            'complete': bool(snapshot['coverage']['complete'] and not gaps),
                            'gaps': list(dict.fromkeys(snapshot['coverage']['gaps']+gaps)),
                            'observed_at': observations['observed_at']}
            else:
                coverage = {'complete': False,
                            'gaps': gaps + ['incident_not_scanned'],
                            'observed_at': observations['observed_at'],
                            'provider_accounts': len(observations['provider_accounts']),
                            'provider_evidence': len(observations['provider_evidence']),
                            'adapty_profiles': len(observations['adapty_profiles']),
                            'lumen_accounts': len(observations['lumen_accounts'])}
        elif snapshot:
            accounts = snapshot['accounts']
            coverage = {**snapshot['coverage'], 'complete': False,
                        'gaps': gaps, 'observed_at': self.wall_now()}
        else:
            accounts = []
            coverage = {'complete': False, 'gaps': gaps or ['not_observed'], 'observed_at': self.wall_now()}
        if observations and observations.get('source_history_summary'):
            coverage['source_history'] = observations['source_history_summary']
        try:
            collector = internal_request(self.key, self.lumen_url, 'GET', '/internal/lumen/collector-coverage')
            if collector.get('queued') or collector.get('dropped'):
                coverage['gaps'] = list(dict.fromkeys(coverage['gaps'] + ['collector_delivery_incomplete']))
                coverage['complete'] = False
            coverage['collector'] = collector
        except Exception:
            coverage['gaps'] = list(dict.fromkeys(coverage['gaps'] + ['collector_coverage_unavailable']))
            coverage['complete'] = False
        plans = [plan for plan in self._plans() if incident and plan['incident_id'] == incident['id']]
        plan_ids = {plan['id'] for plan in plans}
        actions, jobs = [action for action in self._actions() if action['plan_id'] in plan_ids], self._jobs()
        targets = self._target_ids([plan for plan in plans if plan['status'] != 'pending_approval'])
        latest_plan = plans[-1]['id'] if plans else None
        activation_verified = access_verified = 0
        activated_ids, accessible_ids = set(), set()
        verification_by_user = {}
        for plan in plans:
            for entry in plan['entries']:
                if entry['type'] == 'verify_gate':
                    action = self._existing_action(entry['id'])
                    if not action:
                        continue
                    action_result = json.loads(action['result']) if action and action['result'] else {}
                    verification_by_user[entry['account_id']] = bool(action and action['status'] == 'verified'
                                                                     and action_result.get('allowed') is True)
        if observations:
            profiles = observations['profiles_by_id']
            evidence_by_id = observations['evidence_by_id']
            clients = observations['clients_by_id']
            now = self.scenario_now()
            for user_id in targets:
                source = self._latest_evidence(evidence_by_id.get(user_id, []))
                profile = profiles.get(user_id)
                provider, client = observations['provider_by_id'].get(user_id), clients.get(user_id)
                identity_ok = bool(provider and client and source and provider['identity_status'] == 'mapped'
                                   and client['identity_status'] == 'mapped' and client['policy_enabled']
                                   and provider['provider_customer_id'] == client['provider_customer_id'] == source.get('provider_customer_id'))
                if (observations['complete'] and identity_ok and self._valid_evidence(source)
                        and source['amount_minor'] > 0 and source and profile and profile.get('status') == 'active'
                        and profile.get('product_id') == source.get('product_id')
                        and profile.get('transaction_id') == source.get('transaction_id')
                        and profile.get('entitlement_hash') == domain.digest({'user_id': user_id,
                            'product_id': source.get('product_id'), 'expires_at': source.get('expires_at')})
                        and self._profile_current(profile, now)
                        and self._evidence_current(source, now)
                        and source.get('access_basis') == 'paid_period'
                        and self._source_fresh(source)
                        and source.get('payment_state') == 'paid'
                        and source.get('refund_state') == 'none'):
                    activated_ids.add(user_id)
                    client = clients.get(user_id)
                    if client and client['gate'].get('allowed') and verification_by_user.get(user_id):
                        accessible_ids.add(user_id)
            activation_verified = len(activated_ids)
            access_verified = len(accessible_ids)
            by_id = {item['id']: item for item in accounts}
            for user_id in targets:
                if user_id not in by_id:
                    continue
                if user_id in accessible_ids:
                    by_id[user_id]['status'] = 'restored'
                    by_id[user_id]['reason'] = 'activation_and_access_verified'
                    by_id[user_id]['eligible'] = False
                elif user_id in activated_ids:
                    by_id[user_id]['status'] = 'pending_verification'
                    by_id[user_id]['reason'] = ('independent_gate_probe_not_verified'
                        if by_id[user_id]['gate']['allowed'] else by_id[user_id]['gate']['reason'])
                    by_id[user_id]['eligible'] = True
                elif by_id[user_id]['status'] in ('healthy', 'restored'):
                    by_id[user_id]['status'] = 'inconclusive'
                    by_id[user_id]['reason'] = 'recovery_evidence_changed'
                    by_id[user_id]['eligible'] = False
        baseline_accounts = first_snapshot['accounts'] if first_snapshot else accounts
        baseline = self._snapshot_summary({'accounts': baseline_accounts}) if incident and first_snapshot else {
            'in_scope': len(accounts), 'evaluated': 0, 'confirmed': 0, 'inconclusive': 0}
        confirmed_ids = set(incident.get('confirmed_ids', [])) if incident else set()
        root_cause = 'not_assessed'
        root_cause_certainty = 'not_assessed'
        if incident and first_snapshot:
            missing_catalog = bool(confirmed_ids and first_snapshot.get('cohort_signature')
                                   and first_snapshot['cohort_signature']['catalog_mapped_at_incident'] is False)
            root_cause = ('confirmed_catalog_mapping_missing' if missing_catalog else
                          'client_delivery_discrepancy' if confirmed_ids else 'no_confirmed_cause')
            root_cause_certainty = 'confirmed' if missing_catalog else (
                'inconclusive' if baseline['inconclusive'] or not first_snapshot['coverage']['complete']
                else 'correlated')
            if observations and observations['complete'] and missing_catalog:
                catalog = observations['catalog'].get('items', [])
                causes_remaining = any(account.get('price_id') and account.get('status') == 'confirmed'
                    and not any(item['price_id'] == account['price_id'] and item['status'] == 'mapped'
                                for item in catalog) for account in first_snapshot['accounts'])
                if not causes_remaining:
                    root_cause = 'configuration_repaired'
        assessment = self._snapshot_summary({'accounts': accounts}) if incident else baseline
        summary = {'in_scope': assessment['in_scope'], 'evaluated': assessment['evaluated'],
                   'confirmed': len(confirmed_ids), 'inconclusive': assessment['inconclusive'],
                   'excluded': sum(item['id'] not in confirmed_ids and item['status'] not in ('inconclusive','potential') for item in accounts),
                   'potential': sum(item['status'] == 'potential' for item in accounts)}
        incident_public = None if incident is None else {
            key: incident[key] for key in ('id','window_start','window_end','trigger_user_id','snapshot_id','status')}
        if incident_public and targets:
            incident_public['status'] = ('access_verified' if access_verified == len(targets) else
                                         'partial_recovery' if access_verified else 'recovery_unresolved')
        return {'mode': 'FULL_MOCK',
                'manifest': {**manifest, 'logical_now': iso(self.scenario_now()),
                             'wall_now': self.wall_now(), 'time_basis': 'scenario_clock_for_provider_and_client; wall_clock_for_approval_ttl'},
                'incident': incident_public, 'summary': summary, 'assessment': assessment,
                'incidents': [{'id': item['id'], 'trigger_user_id': item['trigger_user_id'],
                              'status': item['status'], 'confirmed': len(item.get('confirmed_ids', [])),
                              'inconclusive': item.get('assessment_summary', {}).get('inconclusive', 0)} for item in incidents],
                'recovery': {'target_count': len(targets), 'activation_verified': activation_verified,
                             'access_verified': access_verified,
                             'unresolved': max(0, len(targets)-access_verified),
                             'unresolved_ids': sorted(targets-accessible_ids),
                             'root_cause_status': root_cause,
                             'root_cause_certainty': root_cause_certainty,
                             'latest_plan_id': latest_plan},
                'accounts': accounts, 'coverage': coverage, 'actions': actions,
                'plans': [{'id': item['id'], 'plan_hash': item['plan_hash'],
                           'incident_id': item['incident_id'], 'snapshot_id': item['snapshot_id'],
                           'status': item['status'], 'target_count': item['target_count'],
                           'created_at': item['created_at'], 'expires_at': item['expires_at']}
                          for item in plans],
                'jobs': jobs}

    def _unclassified_accounts(self, observations):
        result = []
        manifest = self._manifest()
        for user_id in observations['scope_ids']:
            provider = observations['provider_by_id'].get(user_id)
            client = observations['clients_by_id'].get(user_id)
            evidence = self._latest_evidence(observations['evidence_by_id'].get(user_id, []))
            profile = observations['profiles_by_id'].get(user_id)
            gate = client.get('gate') if client else {'allowed': None, 'reason': 'client_not_observed'}
            result.append({'id': user_id, 'status': 'unclassified', 'reason': 'no_incident_scan',
                           'eligible': False, 'provider': manifest['scenario'],
                           'product_id': (evidence or {}).get('product_id') or (profile or {}).get('product_id'),
                           'price_id': (evidence or {}).get('price_id'),
                           'payment_state': (evidence or {}).get('payment_state'),
                           'adapty_active': None if profile is None else profile.get('status') == 'active',
                           'gate': {'allowed': gate.get('allowed'),
                                    'reason': gate.get('reason', 'client_not_observed')},
                           'evidence_refs': ([evidence['evidence_ref']] if evidence else [])})
        return result

    def _evidence(self, user_id):
        if not isinstance(user_id, str) or not user_id:
            raise RecoveryError('user query is required')
        observations = self._observations()
        if user_id not in observations['scope_ids']:
            raise RecoveryError('Unknown account', 404)
        source_history = []
        if self._manifest().get('scenario') == 'offline':
            result = internal_request(self.key, self.provider_url, 'GET',
                '/internal/provider/history?'+urlencode({'user': user_id, 'limit': 1000}))
            source_history = result.get('items', [])
        return {'user_id': user_id, 'provider_account': observations['provider_by_id'].get(user_id),
                'provider_evidence': observations['evidence_by_id'].get(user_id, []),
                'source_history': source_history,
                'adapty_profile': observations['profiles_by_id'].get(user_id),
                'lumen_access': observations['clients_by_id'].get(user_id),
                'observed_at': observations['observed_at']}

    def _audit(self, incident_id=None):
        report = self._report(incident_id)
        db = _conn(self.db_path)
        try:
            snapshots = [json.loads(row['snapshot_json']) for row in db.execute('SELECT snapshot_json FROM snapshots ORDER BY created_at')]
            approvals = [{'plan_id': row['plan_id'], 'plan_hash': row['plan_hash'], 'actor': row['actor'],
                          'approved_at': row['approved_at_wall']} for row in db.execute('SELECT * FROM approvals ORDER BY approved_at_wall')]
            collector = [json.loads(row['event_json']) for row in db.execute('SELECT event_json FROM collector_events ORDER BY recorded_at')]
            journal = [{'at': row['at'], 'action': row['action'], 'details': json.loads(row['details'])}
                       for row in db.execute('SELECT * FROM journal ORDER BY seq')]
        finally:
            db.close()
        return {**report, 'snapshots': snapshots, 'approvals': approvals,
                'collector_events': collector, 'journal': journal}

    def _journal(self):
        db = _conn(self.db_path)
        try:
            return {'events': [{'at': row['at'], 'action': row['action'],
                                'details': json.loads(row['details'])}
                               for row in db.execute('SELECT * FROM journal ORDER BY seq DESC LIMIT 500')]}
        finally:
            db.close()

    def _service_manifest(self, path):
        db = _conn(path)
        try:
            return domain.manifest(db)
        finally:
            db.close()

    def _provider_get(self, path, query):
        if path == '/internal/manifest':
            return self._service_manifest(self.db_path)
        if domain.provider_fault_active(self.db_path, 'fault_provider_outage'):
            raise RecoveryError('Provider simulator is unavailable', 503)
        limited = domain.consume_provider_fault(self.db_path, 'fault_rate_limit_remaining')
        if limited['active']:
            raise RateLimitError(limited['retry_after'])
        if path == '/internal/provider/accounts':
            return domain.provider_accounts(self.db_path, _one(query, 'cursor'), self._limit(query))
        if path == '/internal/provider/evidence':
            return domain.provider_evidence(self.db_path, _one(query, 'user'),
                                            _one(query, 'cursor'), self._limit(query))
        if path == '/internal/provider/history':
            return domain.provider_history(self.db_path, _one(query, 'user'),
                                           _one(query, 'cursor'), self._limit(query))
        if path == '/internal/adapty/profile':
            user_id = _one(query, 'user')
            if not user_id:
                raise RecoveryError('user query is required')
            return domain.adapty_profiles(self.adapty_db, user_id)
        if path == '/internal/adapty/profiles':
            return domain.adapty_profiles(self.adapty_db, cursor=_one(query, 'cursor'),
                                          limit=self._limit(query))
        if path == '/internal/adapty/catalog':
            return domain.adapty_catalog(self.adapty_db)
        if path == '/internal/adapty/action':
            operation_key = _one(query, 'operation_key')
            if not operation_key:
                raise RecoveryError('operation_key query is required')
            return domain.adapty_operation(self.adapty_db, operation_key)
        raise RecoveryError('Not found', 404)

    def _provider_post(self, path, body):
        if path in ('/internal/adapty/catalog/repair', '/internal/adapty/validate'):
            if domain.provider_fault_active(self.db_path, 'fault_provider_outage'):
                raise RecoveryError('Provider simulator is unavailable', 503)
            limited = domain.consume_provider_fault(self.db_path, 'fault_rate_limit_remaining')
            if limited['active']:
                raise RateLimitError(limited['retry_after'])
        if path == '/internal/adapty/catalog/repair':
            return domain.repair_catalog(self.adapty_db, body), False
        if path == '/internal/adapty/validate':
            if not isinstance(body, dict) or set(body) != {'provider','transaction_id','user_id','wire_request','operation_key'}:
                raise RecoveryError('Validation fields do not match the contract')
            provider, user_id, transaction_id = body['provider'], body['user_id'], body['transaction_id']
            wire = body['wire_request']
            if provider in ('stripe', 'paddle'):
                expected = recovery_contracts.validation_request(provider, user_id, transaction_id)
                normalized = recovery_contracts.validate_request(provider, wire)
                if wire != expected or normalized['customer_user_id'] != user_id:
                    raise RecoveryError('Provider validation request is not bound to this user and transaction')
            elif provider == 'custom':
                expected = {'method':'POST','path':'/custom-store/transactions/validate',
                            'content_type':'application/json',
                            'body':{'customer_user_id':user_id,'transaction_id':transaction_id}}
                if wire != expected:
                    raise RecoveryError('Invalid custom store transaction request')
            else:
                raise RecoveryError('awaiting_client_action', 409)
            trace = {'provider':provider,'method':wire['method'],'path':wire['path'],
                     'content_type':wire['content_type'],'body':wire['body']}
            normalized_body = {'provider':provider,'transaction_id':transaction_id,
                               'user_id':user_id,'operation_key':body['operation_key'],
                               'contract_trace':trace}
            result = domain.provider_validate(self.db_path, self.adapty_db, normalized_body)
            if not result.get('duplicate') and domain.consume_provider_fault(
                    self.db_path, 'fault_validation_timeout_remaining')['active']:
                return None, True
            return result, False
        if path == '/internal/demo/reset':
            self._require_demo()
            if not isinstance(body, dict) or set(body) != {'scenario', 'variant', 'run_id'}:
                raise RecoveryError('Reset fields do not match the contract')
            domain.init_provider(self.db_path, self.adapty_db, body['scenario'], body['variant'],
                                 reset=True, run_id=body['run_id'])
            return {'manifest': self._service_manifest(self.db_path)}, False
        if path == '/internal/demo/advance':
            self._require_demo()
            if not isinstance(body, dict) or set(body) != {'seconds'}:
                raise RecoveryError('Advance fields do not match the contract')
            provider = domain.advance_clock(self.db_path, body['seconds'])
            adapty = domain.advance_clock(self.adapty_db, body['seconds'])
            return {'logical_now': provider['logical_now'], 'adapty_logical_now': adapty['logical_now']}, False
        if path == '/internal/demo/fault':
            self._require_demo()
            if not isinstance(body, dict) or 'fault' not in body:
                raise RecoveryError('Fault request is invalid')
            result = domain.provider_demo_fault(self.db_path, body['fault'],
                active=body.get('active', True), user_id=body.get('user_id'),
                state=body.get('state'))
            if body['fault'] == 'different_cause':
                result['adapty'] = domain.adapty_demo_fault(self.adapty_db, body['fault'], body.get('user_id'))
            return result, False
        raise RecoveryError('Not found', 404)

    @staticmethod
    def _limit(query):
        value = _one(query, 'limit', '500')
        try:
            return int(value)
        except (TypeError, ValueError) as exc:
            raise RecoveryError('Invalid limit') from exc

    def _lumen_get(self, path, query):
        if path == '/internal/manifest':
            return self._service_manifest(self.db_path)
        if path == '/internal/lumen/accounts':
            return domain.lumen_accounts(self.db_path, _one(query, 'cursor'), self._limit(query))
        if path == '/internal/lumen/access':
            user_id = _one(query, 'user')
            if not user_id:
                raise RecoveryError('user query is required')
            return domain.lumen_access(self.db_path, user_id)
        if path == '/internal/lumen/action':
            operation_key = _one(query, 'operation_key')
            if not operation_key:
                raise RecoveryError('operation_key query is required')
            return domain.lumen_action(self.db_path, operation_key)
        if path == '/internal/lumen/collector-coverage':
            return self.sdk.coverage()
        raise RecoveryError('Not found', 404)

    def _lumen_post(self, path, body):
        if path == '/internal/lumen/resync':
            if not isinstance(body, dict) or set(body) != {'user_id','expected_revision','entitlement','operation_key'}:
                raise RecoveryError('Resync fields do not match the contract')
            prior = domain.lumen_action(self.db_path, body['operation_key'])
            if prior:
                return domain.lumen_resync(self.db_path, body)
            try:
                profile = internal_request(self.key, self.provider_url, 'GET',
                    '/internal/adapty/profile?'+urlencode({'user': body['user_id']}))
            except Exception as exc:
                raise RecoveryError('Fresh Adapty profile read failed', 503) from exc
            expected = body['entitlement']
            if (not profile or profile.get('status') != 'active'
                    or profile.get('product_id') != expected.get('product_id')
                    or profile.get('expires_at') != expected.get('expires_at')
                    or profile.get('transaction_id') != expected.get('transaction_id')
                    or profile.get('entitlement_hash') != expected.get('entitlement_hash')):
                raise RecoveryError('Fresh Adapty profile does not match requested entitlement', 409)
            return domain.lumen_resync(self.db_path, body)
        if path == '/internal/lumen/probe':
            if domain.lumen_fault_active(self.db_path, 'fault_probe_outage'):
                raise RecoveryError('Lumen gate probe is unavailable', 503)
            user_id, feature = self._probe_body(body)
            result = domain.lumen_access(self.db_path, user_id)
            self._emit_gate(user_id, feature, result, 'reconcile_probe')
            return result
        if path == '/internal/demo/reset':
            self._require_demo()
            if not isinstance(body, dict) or set(body) != {'scenario','variant','run_id'}:
                raise RecoveryError('Reset fields do not match the contract')
            domain.init_lumen(self.db_path, body['scenario'], body['variant'],
                              reset=True, run_id=body['run_id'])
            self._init_sdk()
            return {'manifest': self._service_manifest(self.db_path)}, False
        if path == '/internal/demo/advance':
            self._require_demo()
            if not isinstance(body, dict) or set(body) != {'seconds'}:
                raise RecoveryError('Advance fields do not match the contract')
            return domain.advance_clock(self.db_path, body['seconds']), False
        if path == '/internal/demo/fault':
            self._require_demo()
            if not isinstance(body, dict) or 'fault' not in body:
                raise RecoveryError('Fault request is invalid')
            if body['fault'] == 'self_heal':
                user_id = body.get('user_id')
                profile = internal_request(self.key, self.provider_url, 'GET',
                    '/internal/adapty/profile?'+urlencode({'user': user_id}))
                entitlement = None
                if profile and profile.get('status') == 'active':
                    entitlement = {'product_id': profile['product_id'], 'expires_at': profile['expires_at'],
                                   'entitlement_hash': profile['entitlement_hash']}
            else:
                entitlement = body.get('entitlement')
            return domain.lumen_demo_fault(self.db_path, body['fault'],
                active=body.get('active', True), user_id=body.get('user_id'),
                status=body.get('status'), entitlement=entitlement), False
        raise RecoveryError('Not found', 404)

    @staticmethod
    def _probe_body(body):
        if not isinstance(body, dict) or set(body) != {'user_id','feature','initiator'}:
            raise RecoveryError('Probe fields do not match the contract')
        if body['feature'] != recovery_scenarios.FEATURE or body['initiator'] != 'reconcile_probe':
            raise RecoveryError('Unsupported probe scope')
        if not isinstance(body['user_id'], str) or not body['user_id']:
            raise RecoveryError('Invalid user_id')
        return body['user_id'], body['feature']

    def _emit_gate(self, user_id, feature, result, initiator):
        if initiator == 'customer_demo' and domain.lumen_fault_active(self.db_path, 'fault_suppress_customer_telemetry'):
            return None
        try:
            return self.sdk.emit('feature_access_decided', user_id, iso(self.scenario_now()), {
                'feature': feature, 'decision': 'allow' if result['allowed'] else 'deny',
                'reason_code': result['reason'], 'projection_version': 'lumen-projection-v2',
                'cache_version': 'lumen-cache-v2', 'policy_version': 'access-policy-v2',
                'adapter_version': 'lumen-adapter-v2', 'initiator': initiator,
            })
        except Exception:
            # Telemetry is best effort; gate decisions must remain available.
            return None

    def _require_demo(self):
        if not self.demo:
            raise RecoveryError('Demo controls are disabled', 404)

    def _demo(self, body):
        with self._mutation_lock:
            return self._demo_locked(body)

    def _demo_locked(self, body):
        self._require_demo()
        if not isinstance(body, dict) or not isinstance(body.get('action'), str):
            raise RecoveryError('Demo request requires an action')
        action = body['action']
        if action == 'reset':
            if set(body) - {'action','scenario','variant'} or body.get('scenario') not in ('stripe','paddle','custom','apple','google','offline'):
                raise RecoveryError('Reset fields do not match the contract')
            variant = body.get('variant', 0)
            if isinstance(variant, bool) or variant not in (0,1):
                raise RecoveryError('variant must be 0 or 1')
            db = _conn(self.db_path)
            try:
                if db.execute("SELECT 1 FROM jobs WHERE status IN ('queued','running') LIMIT 1").fetchone():
                    raise RecoveryError('Cannot reset while recovery jobs are running', 409)
            finally:
                db.close()
            run_id = 'activation-'+body['scenario']+'-'+uuid4().hex[:12]
            reset_body = {'scenario': body['scenario'], 'variant': variant, 'run_id': run_id}
            internal_request(self.key, self.provider_url, 'POST', '/internal/demo/reset',
                             reset_body, timeout=30)
            internal_request(self.key, self.lumen_url, 'POST', '/internal/demo/reset',
                             reset_body, timeout=30)
            manifest = internal_request(self.key, self.provider_url, 'GET', '/internal/manifest')
            db = _conn(self.db_path)
            try:
                db.execute('BEGIN IMMEDIATE')
                for table in ('incidents','snapshots','jobs','plans','approvals','actions',
                              'collector_events','collector_assessments','journal','meta'):
                    db.execute('DELETE FROM '+table)
                for key, value in manifest.items():
                    _set_meta(db, key, value)
                _set_meta(db, 'logical_elapsed_seconds', 0)
                _set_meta(db, 'fault_collector_outage', False)
                _set_meta(db, 'initialized', True)
                db.execute('COMMIT')
            except Exception:
                if db.in_transaction:
                    db.execute('ROLLBACK')
                raise
            finally:
                db.close()
            self._record('demo_reset', {'scenario': body['scenario'], 'variant': variant,
                                        'run_id': manifest['run_id']})
            return {'manifest': manifest, 'report': self._report()}
        if action == 'advance':
            if set(body) != {'action','seconds'}:
                raise RecoveryError('Advance fields do not match the contract')
            seconds = body['seconds']
            if isinstance(seconds, bool) or not isinstance(seconds, int) or not 1 <= seconds <= 86400:
                raise RecoveryError('seconds must be an integer from 1 to 86400')
            provider = internal_request(self.key, self.provider_url, 'POST',
                                        '/internal/demo/advance', {'seconds': seconds})
            lumen = internal_request(self.key, self.lumen_url, 'POST',
                                     '/internal/demo/advance', {'seconds': seconds})
            result = domain.advance_clock(self.db_path, seconds)
            self._record('clock_advanced', {'seconds': seconds, 'logical_now': result['logical_now']})
            return {'logical_now': result['logical_now'], 'provider': provider, 'lumen': lumen}
        if action == 'fault':
            if set(body) - {'action','fault','active','user_id','state','status'}:
                raise RecoveryError('Unknown fault request field')
            fault = body.get('fault')
            if fault == 'collector_outage':
                if set(body) != {'action','fault','active'} or not isinstance(body['active'], bool):
                    raise RecoveryError('collector_outage requires a boolean active field')
                self._set_scenario_meta('fault_collector_outage', body['active'])
                return {'fault': fault, 'active': body['active']}
            provider_faults = {'provider_outage','validation_timeout_after_commit','rate_limit',
                               'source_stale','refund','lifecycle','identity','different_cause'}
            lumen_faults = {'self_heal','probe_outage','suppress_customer_telemetry','cache_skip_once'}
            if fault in provider_faults:
                result = self._provider_demo_fault(body)
                if fault == 'identity':
                    lumen_result = internal_request(self.key, self.lumen_url, 'POST',
                        '/internal/demo/fault', {'fault': 'identity', 'user_id': body.get('user_id'),
                                                'status': body.get('status')})
                    result['lumen'] = lumen_result
                if fault == 'different_cause':
                    lumen_result = internal_request(self.key, self.lumen_url, 'POST',
                        '/internal/demo/fault', {'fault': 'different_cause', 'user_id': body.get('user_id')})
                    result['lumen'] = lumen_result
                return result
            if fault in lumen_faults:
                fields = {'action','fault'}
                if fault in ('probe_outage','suppress_customer_telemetry'):
                    fields.add('active')
                    if set(body) != fields or not isinstance(body['active'], bool):
                        raise RecoveryError('Fault fields do not match the contract')
                else:
                    fields.add('user_id')
                    if set(body) != fields or not isinstance(body['user_id'], str) or not body['user_id']:
                        raise RecoveryError('Fault fields do not match the contract')
                forwarded = {key: value for key, value in body.items() if key != 'action'}
                return internal_request(self.key, self.lumen_url, 'POST', '/internal/demo/fault', forwarded)
            raise RecoveryError('Unsupported demo fault')
        raise RecoveryError('Unsupported demo action')

    def _provider_demo_fault(self, body):
        fault = body.get('fault')
        if fault in ('provider_outage','validation_timeout_after_commit','rate_limit'):
            if set(body) != {'action','fault','active'} or not isinstance(body['active'], bool):
                raise RecoveryError('Fault fields do not match the contract')
        elif fault in ('source_stale','refund'):
            if set(body) != {'action','fault','user_id'}:
                raise RecoveryError('Fault fields do not match the contract')
        elif fault == 'lifecycle':
            if set(body) != {'action','fault','user_id','state'}:
                raise RecoveryError('Fault fields do not match the contract')
        elif fault == 'identity':
            if set(body) != {'action','fault','user_id','status'}:
                raise RecoveryError('Fault fields do not match the contract')
        elif fault == 'different_cause':
            if set(body) != {'action','fault','user_id'}:
                raise RecoveryError('Fault fields do not match the contract')
        forwarded = {key: value for key, value in body.items() if key != 'action'}
        if fault == 'identity':
            forwarded['state'] = forwarded.pop('status')
        return internal_request(self.key, self.provider_url, 'POST', '/internal/demo/fault', forwarded)

    def _collect(self, envelope, signature):
        with self._mutation_lock:
            return self._collect_locked(envelope, signature)

    def _collect_locked(self, envelope, signature):
        from recovery_sdk import validate_event
        if not isinstance(envelope, dict) or set(envelope) != {'schema_version','event','sent_at'}:
            raise RecoveryError('Invalid collector envelope')
        sent_at = envelope['sent_at']
        if isinstance(sent_at, bool) or not isinstance(sent_at, int) or abs(time.time()-sent_at) > 300:
            raise RecoveryError('Collector signature expired', 401)
        expected = hmac.new(self.key, canonical(envelope), hashlib.sha256).hexdigest()
        if not isinstance(signature, str) or not hmac.compare_digest(expected, signature):
            raise RecoveryError('Invalid collector signature', 401)
        manifest = self._manifest()
        if type(envelope['schema_version']) is not int or envelope['schema_version'] != 1:
            raise RecoveryError('Unsupported collector schema version')
        event = envelope['event']
        try:
            validate_event(event, run_id=manifest['run_id'], app=manifest['app'],
                           environment=manifest['environment'])
        except Exception as exc:
            raise RecoveryError(str(exc)) from exc
        event_hash = digest(event)
        db = _conn(self.db_path)
        try:
            db.execute('BEGIN IMMEDIATE')
            if any(event[field] != _meta(db, field) for field in ('run_id', 'app', 'environment')):
                raise RecoveryError('Collector scope changed before persistence', 409)
            prior = db.execute('SELECT payload_hash FROM collector_events WHERE event_id=?',
                               (event['event_id'],)).fetchone()
            if prior:
                if prior['payload_hash'] != event_hash:
                    raise RecoveryError('Collector event ID has another payload', 409)
                db.execute('COMMIT')
                duplicate = True
            else:
                db.execute('INSERT INTO collector_events VALUES(?,?,?,?,?)',
                           (event['event_id'], event_hash, _json(event), self.wall_now(), 'client_simulator'))
                db.execute('COMMIT')
                duplicate = False
        except Exception:
            if db.in_transaction:
                db.execute('ROLLBACK')
            raise
        finally:
            db.close()
        incident_id, job_id = None, None
        db = _conn(self.db_path)
        try:
            assessed = db.execute('SELECT result FROM collector_assessments WHERE event_id=?',
                                  (event['event_id'],)).fetchone()
        finally:
            db.close()
        customer_event = (event['kind'] == 'mobile_observation' or
                          (event['kind'] == 'feature_access_decided'
                           and event['details'].get('initiator') == 'customer_demo'))
        if not assessed and customer_event:
            at = parse_time(event['occurred_at'])
            db = _conn(self.db_path)
            try:
                candidates = [json.loads(row[0]) for row in db.execute(
                    'SELECT incident_json FROM incidents ORDER BY created_at DESC,rowid DESC')]
                matching = next((item for item in candidates
                                 if parse_time(item['window_start']) <= at < parse_time(item['window_end'])), None)
                pending = None if matching is None else db.execute(
                    "SELECT id FROM jobs WHERE kind='scan' AND status='queued' AND payload=? LIMIT 1",
                    (_json({'incident_id': matching['id']}),)).fetchone()
            finally:
                db.close()
            if matching:
                incident_id = matching['id']
                job_id = pending['id'] if pending else self._start_scan(incident_id)
            elif (event['details'].get('decision') == 'deny'
                  or event['details'].get('observation_kind') in ('access_denied', 'purchase_succeeded')):
                incident_id, job_id = self._start_incident(event['app_user_id'], event['occurred_at'],
                                                         trigger_event_id=event['event_id'])
        if assessed:
            decision = json.loads(assessed['result'])
            incident_id, job_id = decision['incident_id'], decision['job_id']
        else:
            db = _conn(self.db_path)
            try:
                db.execute('INSERT OR IGNORE INTO collector_assessments VALUES(?,?)',
                           (event['event_id'], _json({'incident_id': incident_id, 'job_id': job_id})))
            finally:
                db.close()
        return {'accepted': True, 'duplicate': duplicate,
                'event_id': event['event_id'], 'event_hash': event_hash,
                **({'incident_id': incident_id, 'job_id': job_id} if incident_id else {})}

    def _mobile_observation(self, body):
        from recovery_sdk import validate_event
        required = {'event_id', 'user_id', 'kind', 'occurred_at', 'details'}
        if not isinstance(body, dict) or set(body) != required or not isinstance(body['details'], dict):
            raise RecoveryError('Mobile event fields do not match the contract')
        detail_keys = {'transaction_id', 'product_id', 'price_id', 'feature', 'reason_code'}
        if set(body['details']) - detail_keys:
            raise RecoveryError('Only allowlisted mobile metadata is accepted')
        details = {'observation_kind': body['kind'], **{key: body['details'].get(key) for key in detail_keys}}
        manifest = self._manifest()
        event_id = 'mobile:'+str(body['event_id'])
        event = {'schema_version': 1, 'event_id': event_id, 'run_id': manifest['run_id'],
                 'app': manifest['app'], 'environment': manifest['environment'],
                 'app_user_id': body['user_id'], 'kind': 'mobile_observation',
                 'occurred_at': body['occurred_at'], 'correlation_id': event_id,
                 'source_event_id': body['event_id'], 'details': details}
        validate_event(event)
        result = domain.mobile_event(self.db_path, body)
        # Stable event identity makes replay safe after a crash between these two stores.
        receipt = self.sdk.emit('mobile_observation', body['user_id'], body['occurred_at'], details,
                                event_id=event_id, correlation_id=event_id, source_event_id=body['event_id'])
        return {**result, 'telemetry_queued': receipt.get('queued', False)}

    def _proxy_lumen_gate(self, body):
        import http.client
        if not isinstance(body, dict) or set(body) - {'user_id','feature'} or not isinstance(body.get('user_id'), str):
            raise RecoveryError('Gate request fields do not match the contract')
        feature = body.get('feature', recovery_scenarios.FEATURE)
        if feature != recovery_scenarios.FEATURE:
            raise RecoveryError('Unsupported feature')
        parsed = _loopback(self.lumen_url)
        connection = http.client.HTTPConnection(parsed.hostname, parsed.port or 80, timeout=10)
        try:
            connection.request('POST', '/mock/lumen/export', body=canonical({'user_id': body['user_id'],
                'feature': feature}), headers={'Content-Type':'application/json'})
            response = connection.getresponse()
            data = response.read(BODY_LIMIT+1)
            try:
                result = json.loads(data) if data else {}
            except json.JSONDecodeError:
                result = {'error':'Invalid Lumen response'}
            return response.status, result
        finally:
            connection.close()


import reconcile_mock as _legacy


class RecoveryHandler(_legacy.Handler):
    server_version = 'ReconcileRecovery/1'

    def log_message(self, *_):
        pass

    def respond(self, data, status=200, ctype='application/json', extra_headers=None):
        raw = data if isinstance(data, bytes) else (json.dumps(data, ensure_ascii=False,
            separators=(',', ':'), allow_nan=False)+'\n').encode('utf-8')
        self.send_response(status)
        self.send_header('Content-Type', ctype)
        self.send_header('Content-Length', str(len(raw)))
        self.send_header('Cache-Control', 'no-store')
        for key, value in (extra_headers or {}).items():
            self.send_header(key, value)
        self.end_headers()
        self.wfile.write(raw)

    @property
    def service(self):
        return self.server.service

    def _error(self, exc):
        if isinstance(exc, RateLimitError):
            return self.respond({'error': str(exc)}, 429,
                                extra_headers={'Retry-After': str(exc.retry_after)})
        if isinstance(exc, RecoveryError):
            return self.respond({'error': str(exc)}, exc.status)
        if isinstance(exc, (ValueError, KeyError, TypeError, json.JSONDecodeError)):
            return self.respond({'error': str(exc) or 'Invalid request'}, 400)
        return self.respond({'error': 'Internal error'}, 500)

    def _read_body(self):
        content_type = self.headers.get('Content-Type', '').split(';', 1)[0].strip().lower()
        if content_type != 'application/json':
            raise RecoveryError('Content-Type must be application/json', 415)
        try:
            length = int(self.headers.get('Content-Length', '-1'))
        except ValueError as exc:
            raise RecoveryError('Invalid Content-Length') from exc
        if length < 0:
            raise RecoveryError('Content-Length required')
        if length > BODY_LIMIT:
            raise RecoveryError('Request body too large', 413)
        raw = self.rfile.read(length)
        def bad_constant(_):
            raise ValueError('Invalid JSON number')
        try:
            body = json.loads(raw or b'{}', parse_constant=bad_constant)
        except (json.JSONDecodeError, UnicodeDecodeError) as exc:
            raise RecoveryError('Invalid JSON body') from exc
        return raw, body

    def _verify_internal(self, raw):
        try:
            timestamp = int(self.headers.get('X-Recovery-Timestamp', ''))
        except ValueError as exc:
            raise RecoveryError('Invalid internal authentication time', 401) from exc
        if abs(time.time()-timestamp) > 300:
            raise RecoveryError('Internal authentication expired', 401)
        expected = internal_signature(self.service.key, self.command, self.path, timestamp, raw)
        supplied = self.headers.get('X-Recovery-Signature', '')
        if not hmac.compare_digest(expected, supplied):
            raise RecoveryError('Invalid internal authentication', 401)

    @staticmethod
    def _legacy_path(path, method, role):
        if role != 'engine' or path.startswith('/api/recovery/') or path == '/health':
            return False
        return path.startswith('/api/') or path.startswith('/mock/')

    def do_GET(self):
        path, query = _parse_query(self.path)
        if self._legacy_path(path, 'GET', self.service.role):
            return super().do_GET()
        try:
            if path == '/health':
                body = {'role': self.service.role, 'ready': True, 'port': self.server.server_port}
                if self.service.role == 'lumen':
                    body['collector_coverage'] = self.service.sdk.coverage()
                return self.respond(body)
            if self.service.role in ('provider','lumen') and path.startswith('/internal/'):
                if not self.write_origin_ok():
                    return self.respond({'error':'loopback same-origin request required'}, 403)
                self._verify_internal(b'')
                body = (self.service._provider_get(path, query) if self.service.role == 'provider'
                        else self.service._lumen_get(path, query))
                return self.respond(body)
            if self.service.role == 'lumen' and path == '/_demo/collector/coverage':
                if not self.service.demo:
                    return self.respond({'error':'not found'}, 404)
                return self.respond(self.service.sdk.coverage())
            if self.service.role != 'engine':
                return self.respond({'error':'not found'}, 404)
            if path == '/api/recovery/report':
                return self.respond(self.service._report(_one(query, 'incident_id')))
            if path == '/api/recovery/audit':
                return self.respond(self.service._audit(_one(query, 'incident_id')))
            if path == '/api/recovery/journal':
                return self.respond(self.service._journal())
            if path == '/api/recovery/evidence':
                return self.respond(self.service._evidence(_one(query, 'user')))
            if path.startswith('/api/recovery/jobs/'):
                return self.respond(self.service._get_job(unquote(path.rsplit('/', 1)[-1])))
            if path.startswith('/api/recovery/snapshots/'):
                return self.respond(self.service._load_snapshot(unquote(path.rsplit('/', 1)[-1])))
            if path.startswith('/api/recovery/'):
                return self.respond({'error':'not found'}, 404)
            return self._static(path)
        except Exception as exc:
            return self._error(exc)

    def _static(self, path):
        if path == '/':
            path = '/recovery.html'
        elif path == '/analytics.html':
            path = '/index.html'
        decoded = unquote(path)
        if (not decoded.startswith('/') or '\x00' in decoded or '\\' in decoded
                or any(part in ('', '.', '..') or part.startswith('.') for part in Path(decoded).parts[1:])):
            return self.respond({'error':'not found'}, 404)
        parts = Path(decoded.lstrip('/')).parts
        if (not parts or any(part.lower() in ('runtime','_evaluation','.env','.openai','.aws','.codex') for part in parts)
                or Path(parts[-1]).suffix.lower() in ('.py','.pyc','.pyo','.sqlite','.sqlite3','.db','.key','.json')):
            return self.respond({'error':'not found'}, 404)
        root = STATIC.resolve()
        try:
            asset = (root/Path(*parts)).resolve(strict=True)
        except OSError:
            return self.respond({'error':'not found'}, 404)
        if not asset.is_relative_to(root) or not asset.is_file():
            return self.respond({'error':'not found'}, 404)
        ctype = mimetypes.guess_type(asset.name)[0] or 'application/octet-stream'
        return self.respond(asset.read_bytes(), ctype=ctype)

    def do_POST(self):
        path, query = _parse_query(self.path)
        if self._legacy_path(path, 'POST', self.service.role):
            return super().do_POST()
        try:
            if not self.write_origin_ok():
                return self.respond({'error':'loopback same-origin request required'}, 403)
            raw, body = self._read_body()
            if self.service.role in ('provider','lumen') and path.startswith('/internal/'):
                self._verify_internal(raw)
                result = (self.service._provider_post(path, body) if self.service.role == 'provider'
                          else self.service._lumen_post(path, body))
                close = False
                if isinstance(result, tuple):
                    result, close = result
                if close:
                    self.close_connection = True
                    try:
                        self.connection.shutdown(socket.SHUT_RDWR)
                    except OSError:
                        pass
                    self.connection.close()
                    return
                return self.respond(result)
            if self.service.role == 'engine':
                return self._engine_post(path, query, raw, body)
            if self.service.role == 'lumen':
                if path in ('/mock/lumen/export','/premium/export','/lumen/export'):
                    return self._public_gate(body)
                if path == '/mobile/events':
                    return self.respond(self.service._mobile_observation(body))
                return self.respond({'error':'not found'}, 404)
            return self.respond({'error':'not found'}, 404)
        except Exception as exc:
            return self._error(exc)

    def _engine_post(self, path, query, raw, body):
        with self.service._mutation_lock:
            return self._engine_post_locked(path, query, raw, body)

    def _engine_post_locked(self, path, query, raw, body):
        if path == '/api/recovery/collector':
            if domain.provider_fault_active(self.service.db_path, 'fault_collector_outage'):
                return self.respond({'error':'Collector is temporarily unavailable'}, 503)
            signature = self.headers.get('X-Reconcile-Signature', '')
            return self.respond(self.service._collect(body, signature))
        if path == '/api/recovery/incidents':
            if not isinstance(body, dict):
                return self.respond({'error':'Object required'}, 400)
            allowed = {'user_id','occurred_at','window_start','window_end','app','environment','run_id'}
            if set(body)-allowed:
                return self.respond({'error':'Unknown incident field'}, 400)
            manifest = self.service._manifest()
            for key in ('app','environment','run_id'):
                if key in body and body[key] != manifest[key]:
                    return self.respond({'error':'Unknown app, environment or run scope'}, 409)
            incident_id, job_id = self.service._start_incident(body.get('user_id'), body.get('occurred_at'),
                body.get('window_start'), body.get('window_end'))
            return self.respond({'job_id':job_id,'incident_id':incident_id}, 202)
        if path == '/api/recovery/scans':
            if not isinstance(body, dict) or set(body) != {'incident_id'}:
                return self.respond({'error':'Scan fields do not match the contract'}, 400)
            job_id = self.service._start_scan(body['incident_id'])
            return self.respond({'job_id':job_id,'incident_id':body['incident_id']}, 202)
        if path == '/api/recovery/plans':
            return self.respond(self.service._create_plan(body))
        if path == '/api/recovery/approvals':
            return self.respond(self.service._approve(body))
        if path == '/api/recovery/executions':
            return self.respond(self.service._start_execution(body), 202)
        if path == '/api/recovery/demo':
            return self.respond(self.service._demo(body))
        if path in ('/api/recovery/lumen/export','/lumen/export'):
            status, result = self.service._proxy_lumen_gate(body)
            return self.respond(result, status)
        if path.startswith('/api/recovery/'):
            return self.respond({'error':'not found'}, 404)
        return self.respond({'error':'not found'}, 404)

    def _public_gate(self, body):
        if not isinstance(body, dict) or set(body)-{'user_id','feature'}:
            return self.respond({'error':'Gate request fields do not match the contract'}, 400)
        user_id = body.get('user_id')
        feature = body.get('feature', recovery_scenarios.FEATURE)
        if not isinstance(user_id, str) or not user_id or len(user_id) > 256:
            return self.respond({'error':'Invalid user_id'}, 400)
        if feature != recovery_scenarios.FEATURE:
            return self.respond({'error':'Unsupported feature'}, 400)
        result = domain.lumen_access(self.service.db_path, user_id)
        receipt = self.service._emit_gate(user_id, feature, result, 'customer_demo')
        if receipt:
            result = {**result, 'event_id': receipt.get('event_id'),
                      'event_hash': receipt.get('event_hash'),
                      'telemetry_queued': receipt.get('queued', False)}
        return self.respond(result, 200 if result['allowed'] else 403)


class RecoveryHTTPServer(ThreadingHTTPServer):
    allow_reuse_address = True
    daemon_threads = True

    def __init__(self, service):
        self.service = service
        super().__init__(('127.0.0.1', service.port), RecoveryHandler)


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--role', required=True, choices=('engine','provider','lumen'))
    parser.add_argument('--port', required=True, type=int)
    parser.add_argument('--db', required=True, type=Path)
    parser.add_argument('--key-file', required=True, type=Path)
    parser.add_argument('--provider-url')
    parser.add_argument('--lumen-url')
    parser.add_argument('--collector-url')
    parser.add_argument('--demo', action='store_true')
    args = parser.parse_args(argv)
    if not 0 <= args.port <= 65535:
        parser.error('--port must be between 0 and 65535')
    service = RecoveryService(args.role, args.port, args.db, args.key_file,
                              provider_url=args.provider_url, lumen_url=args.lumen_url,
                              collector_url=args.collector_url, demo=args.demo)
    server = RecoveryHTTPServer(service)
    service.server = server
    print(json.dumps({'port': server.server_port, 'role': args.role}, separators=(',', ':')),
          flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.shutdown()
        server.server_close()


if __name__ == '__main__':
    main()
