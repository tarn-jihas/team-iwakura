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
import random
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
import recovery_live
import recovery_monitor
import recovery_scenarios

HERE = Path(__file__).resolve().parent
STATIC = HERE.parent / 'Reconcile' / 'dist'
BODY_LIMIT = 1024 * 1024
MAX_JOB_WORKERS = 8
AUTOMATIC_POLICY_ID = 'local-entitlement-resync-v1'
SIMULATION_FAULTS = ('stale_cache', 'missed_projection', 'out_of_order')
SIMULATION_GAP_SECONDS = 0.25
SIMULATION_RECOVERY_TIMEOUT = 90


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


def iso_precise(value):
    return value.astimezone(timezone.utc).isoformat(timespec='microseconds').replace('+00:00', 'Z')


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
                 lumen_url=None, collector_url=None, demo=False, live_config=None,
                 auto_repair=False):
        self.role = role
        self.port = port
        self.db_path = Path(db_path).resolve()
        self.key_file = Path(key_file).resolve()
        self.key = load_key(self.key_file, create=(role == 'provider'))
        self.provider_url = self._base(provider_url, 'provider_url', required=role in ('engine', 'lumen'))
        self.lumen_url = self._base(lumen_url, 'lumen_url', required=role == 'engine')
        self.collector_url = self._collector(collector_url, required=role == 'lumen')
        self.demo = bool(demo)
        self.live_config = recovery_live.load_config(live_config) if live_config else None
        if auto_repair and (role != 'engine' or not self.live_config):
            raise ValueError('Automatic repair requires the live engine role')
        self.auto_repair = bool(auto_repair)
        self.live_reader = None
        self.adapty_db = self.db_path.with_name(self.db_path.stem + '-adapty.sqlite3')
        self.outbox_db = self.db_path.with_name(self.db_path.stem + '-outbox.sqlite3')
        self._jobs_lock = threading.Lock()
        self._mutation_lock = threading.RLock()
        self._simulation_inject_lock = threading.Lock()
        self._active_jobs = set()
        self.server = None
        self.sdk = None
        self._sdk_thread_started = False
        if role == 'provider':
            if self.live_config:
                self.live_reader = recovery_live.AdaptyReader(self.live_config)
                recovery_live.init_provider(self.db_path, self.adapty_db,
                                            self.live_config, self.live_reader)
            else:
                domain.init_provider(self.db_path, self.adapty_db)
        elif role == 'lumen':
            if self.live_config:
                live_manifest = internal_request(self.key, self.provider_url,
                                                  'GET', '/internal/manifest')
                bootstrap = internal_request(self.key, self.provider_url,
                    'GET', '/internal/adapty/profiles?limit=100', timeout=60)
                domain.init_live_lumen(self.db_path, live_manifest, bootstrap.get('items', []))
            else:
                domain.init_lumen(self.db_path)
            self._init_sdk()
            if self.live_config:
                self._emit_source_observations(bootstrap.get('items', []))
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

    def _emit_source_observations(self, profiles):
        reason_codes = {'active': 'allowed', 'subscription_expired': 'subscription_expired',
                        'subscription_not_started': 'subscription_inactive',
                        'trial_period': 'subscription_inactive', 'grace_period': 'subscription_inactive',
                        'identity_scope_mismatch': 'identity_mismatch',
                        'premium_entitlement_absent': 'none',
                        'premium_source_binding_uncertain': 'source_unavailable'}
        for profile in profiles:
            if not profile.get('source_fingerprint') or not profile.get('observed_at'):
                continue
            entitlement = profile.get('entitlement') or {}
            reason = reason_codes.get(profile.get('reason'), 'source_unavailable')
            try:
                self.sdk.emit('source_entitlement_observed', profile['user_id'],
                    profile['observed_at'], {
                        'source_hash': profile['source_fingerprint'],
                        'starts_at': entitlement.get('starts_at'),
                        'expires_at': entitlement.get('expires_at'),
                        'adapter_version': 'adapty-profile-read-v1',
                        'outcome': 'observed', 'reason_code': reason})
            except Exception:
                pass

    def _notify_live_source_observations(self, profiles):
        if not profiles:
            return
        items = []
        for profile in profiles:
            if not profile.get('source_fingerprint') or not profile.get('observed_at'):
                continue
            entitlement = profile.get('entitlement') or {}
            items.append({'user_id': profile['user_id'],
                'source_fingerprint': profile['source_fingerprint'],
                'observed_at': profile['observed_at'],
                'starts_at': entitlement.get('starts_at'),
                'expires_at': entitlement.get('expires_at'),
                'reason': profile.get('reason')})
        if items:
            internal_request(self.key, self.lumen_url, 'POST',
                '/internal/lumen/source-observed', {'items': items}, timeout=30)

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
                'CREATE TABLE IF NOT EXISTS automatic_recovery(id TEXT PRIMARY KEY,incident_id TEXT NOT NULL,assessment_snapshot_id TEXT NOT NULL,attempt INTEGER NOT NULL,policy_id TEXT NOT NULL,status TEXT NOT NULL,selected_ids TEXT NOT NULL,auto_job_id TEXT NOT NULL,plan_id TEXT,execution_job_id TEXT,outcome_json TEXT,created_at TEXT NOT NULL,updated_at TEXT NOT NULL,UNIQUE(incident_id,attempt),UNIQUE(incident_id,assessment_snapshot_id))',
                'CREATE TABLE IF NOT EXISTS simulations(id TEXT PRIMARY KEY,operation_key TEXT NOT NULL UNIQUE,status TEXT NOT NULL,sequence_json TEXT NOT NULL,current_index INTEGER NOT NULL,total INTEGER NOT NULL,completed INTEGER NOT NULL,stop_requested INTEGER NOT NULL,current_incident_id TEXT,error TEXT,job_id TEXT NOT NULL UNIQUE,created_at TEXT NOT NULL,updated_at TEXT NOT NULL)',
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
            db.execute("UPDATE simulations SET status='stopped',stop_requested=1,error='Interrupted by server restart',updated_at=? WHERE status='running'",
                       (self.wall_now(),))
            db.execute("UPDATE jobs SET status='failed',error='simulation_interrupted_restart',updated_at=? WHERE kind='simulation' AND status='running'",
                       (self.wall_now(),))
            db.execute("UPDATE jobs SET status='queued',started_at=NULL WHERE status='running' AND kind!='simulation'")
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
            finished = [(row['id'], row['result'], row['error']) for row in db.execute(
                "SELECT j.id,j.result,j.error FROM automatic_recovery a JOIN jobs j ON j.id=a.execution_job_id "
                "WHERE a.status='awaiting_execution' AND j.status IN ('completed','failed')")]
        finally:
            db.close()
        for job_id in ids:
            self._launch_job(job_id)
        for job_id, result, error in finished:
            self._automatic_execution_finished(job_id, json.loads(result) if result else None, error)

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

    @staticmethod
    def wall_now_precise():
        return iso_precise(datetime.now(timezone.utc))

    def scenario_now(self):
        db = _conn(self.db_path)
        try:
            return datetime.now(timezone.utc) if _meta(db, 'scenario') == 'live_adapty' else domain.logical_now(db)
        finally:
            db.close()

    def _manifest(self):
        db = _conn(self.db_path)
        try:
            return domain.manifest(db)
        finally:
            db.close()

    def _internal_request(self, base_url, method, path, body=None, **kwargs):
        return internal_request(self.key, base_url, method, path, body, **kwargs)

    def _simulation_summary(self):
        db = _conn(self.db_path)
        try:
            row = db.execute('SELECT status,completed,total,error FROM simulations '
                             'ORDER BY created_at DESC,rowid DESC LIMIT 1').fetchone()
            if row is None:
                return {'status': 'idle', 'completed': 0, 'total': 0, 'error': None}
            return {'status': 'running' if row['status'] == 'queued' else row['status'],
                    'completed': row['completed'], 'total': row['total'],
                    'error': row['error']}
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

    def _observations(self, fresh_live_ids=None):
        gaps = []
        def pages(base, path, label):
            try:
                return self._pages(base, path)
            except Exception as exc:
                gaps.append(label+':'+(str(exc.status) if isinstance(exc, InternalHTTPError) else type(exc).__name__))
                return []
        providers = pages(self.provider_url, '/internal/provider/accounts', 'provider_registry')
        evidence = pages(self.provider_url, '/internal/provider/evidence', 'provider_evidence')
        manifest = self._manifest()
        if manifest.get('scenario') == 'live_adapty' and fresh_live_ids:
            try:
                refresh = internal_request(self.key, self.provider_url, 'POST',
                    '/internal/live/refresh', {'user_ids': fresh_live_ids}, timeout=60)
                if refresh.get('observed') != len(fresh_live_ids):
                    gaps.append('live_source_observation_incomplete')
            except Exception as exc:
                gaps.append('live_source_refresh:'+(str(exc.status) if isinstance(exc, InternalHTTPError) else type(exc).__name__))
        profiles = pages(self.provider_url, '/internal/adapty/profiles', 'adapty_profiles')
        source_history = (pages(self.provider_url, '/internal/provider/history', 'official_source_history')
                          if manifest.get('scenario') == 'offline' else [])
        try:
            catalog = internal_request(self.key, self.provider_url, 'GET', '/internal/adapty/catalog')
        except Exception as exc:
            gaps.append('adapty_catalog:'+(str(exc.status) if isinstance(exc, InternalHTTPError) else type(exc).__name__))
            catalog = {'items': [], 'revision': None}
        clients = pages(self.lumen_url, '/internal/lumen/accounts', 'client_registry')
        if manifest.get('scenario') == 'live_adapty' and fresh_live_ids:
            fresh_profiles = [item for item in profiles if item.get('user_id') in set(fresh_live_ids)]
            self._notify_live_source_observations(fresh_profiles)
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
        entitlements_by_id = {row['user_id']: row.get('entitlement') for row in profiles
                              if row.get('entitlement')}
        clients_by_id = {row['user_id']: row for row in clients}
        scope_ids = sorted(set(provider_by_id) | set(clients_by_id)
                           | {row['user_id'] for row in evidence if row.get('user_id')})
        if manifest.get('scenario') == 'live_adapty':
            live_source = internal_request(self.key, self.provider_url, 'GET', '/internal/live/status')
            if live_source.get('account_count') != len(providers):
                gaps.append('live_registry_count_mismatch')
            if live_source.get('observed_count') != len(providers):
                gaps.append('live_profiles_not_fully_observed')
            if live_source.get('identity_match_count') != len(providers):
                gaps.append('live_identity_scope_mismatch')
            complete = not gaps
        else:
            live_source = None
            complete = not gaps
        return {'provider_accounts': providers, 'provider_evidence': evidence,
                'adapty_profiles': profiles, 'catalog': catalog,
                'lumen_accounts': clients, 'provider_by_id': provider_by_id,
                'evidence_by_id': evidence_by_id, 'profiles_by_id': profiles_by_id,
                'entitlement_evidence': [item for item in entitlements_by_id.values()],
                'entitlement_by_id': entitlements_by_id, 'live_source': live_source,
                'clients_by_id': clients_by_id, 'scope_ids': scope_ids,
                'source_history_summary': source_history_summary,
                'observed_at': self.wall_now(), 'scenario_observed_at': iso(self.scenario_now()),
                'complete': complete, 'gaps': gaps,
                'orphan_provider_records': sum(not row.get('user_id') for row in evidence)}

    def _classify(self, observations, incident):
        manifest = self._manifest()
        if manifest.get('scenario') == 'live_adapty':
            return self._classify_live(observations, incident)
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

    def _classify_live(self, observations, incident):
        app_id = self._manifest().get('app')
        now = datetime.now(timezone.utc)
        signature = incident.get('cohort_signature') or {}
        rows = []
        for user_id in observations['scope_ids']:
            provider = observations['provider_by_id'].get(user_id)
            client = observations['clients_by_id'].get(user_id)
            profile = observations['profiles_by_id'].get(user_id)
            entitlement = observations['entitlement_by_id'].get(user_id)
            gate = client.get('gate') if client else {'allowed': None, 'reason': 'client_not_observed'}
            identity_ok = bool(provider and client and profile
                and provider.get('identity_status') == 'mapped'
                and client.get('identity_status') == 'mapped'
                and provider.get('provider_customer_id') == client.get('provider_customer_id') == user_id
                and profile.get('identity_match') and profile.get('user_id') == user_id
                and profile.get('app_id') == app_id)
            status, reason, eligible = 'inconclusive', 'source_unavailable', False
            active = False
            source_fresh = False
            if profile and profile.get('observed_at'):
                try:
                    age = (now-parse_time(profile['observed_at'])).total_seconds()
                    source_fresh = 0 <= age <= domain.FRESHNESS_TTL
                except RecoveryError:
                    pass
            if not observations['complete']:
                reason = 'coverage_incomplete'
            elif not identity_ok:
                reason = 'identity_unknown'
            elif not source_fresh:
                reason = 'adapty_profile_stale'
            elif profile.get('status') != 'active' or not entitlement:
                if profile.get('status') == 'inactive':
                    status, reason = 'legitimate_denial', profile.get('reason', 'premium_entitlement_inactive')
                else:
                    reason = profile.get('reason', 'premium_entitlement_uncertain')
            else:
                try:
                    active = (parse_time(entitlement['starts_at']) <= now
                              < parse_time(entitlement['expires_at'])
                              and entitlement.get('is_in_grace_period') is False
                              and entitlement.get('app_id') == app_id
                              and entitlement.get('user_id') == user_id
                              and entitlement.get('provider_customer_id') == user_id)
                except (KeyError, RecoveryError, TypeError):
                    active = False
                if not active:
                    status, reason = 'legitimate_denial', 'premium_entitlement_not_current'
                elif client is None:
                    reason = 'client_access_not_observed'
                elif not client.get('policy_enabled') or gate.get('reason') == 'policy_restricted':
                    status, reason = 'policy_denial', 'policy_restricted'
                elif gate.get('allowed') is True:
                    status, reason = 'healthy', 'access_allowed'
                else:
                    tag = client.get('delivery_signature') or {}
                    try:
                        signature_age = abs((parse_time(incident['occurred_at'])
                            -parse_time(tag.get('occurred_at'))).total_seconds())
                        tag_time = parse_time(tag.get('occurred_at'))
                        in_incident_window = (parse_time(incident['window_start']) <= tag_time
                                              < parse_time(incident['window_end']))
                    except (KeyError, RecoveryError, TypeError):
                        signature_age = float('inf')
                        in_incident_window = False
                    signature_match = bool(signature and tag
                        and tag.get('handler_version') == signature.get('handler_version')
                        and tag.get('config_version') == signature.get('config_version')
                        and signature_age <= 120 and in_incident_window)
                    if signature_match:
                        status, reason, eligible = 'confirmed', 'access_not_delivered', True
                    else:
                        status, reason = 'potential', 'unmatched_delivery_discrepancy'
            current_profile = bool(active and profile and profile.get('status') == 'active')
            refs = []
            if entitlement:
                refs.append('adapty://entitlement/'+user_id)
            if profile:
                refs.append('adapty://profile/'+user_id)
            if client:
                refs.append('lumen://access/'+user_id)
            rows.append({'id': user_id, 'status': status, 'reason': reason,
                'eligible': bool(eligible), 'provider': 'adapty',
                'product_id': (entitlement or {}).get('product_id'), 'price_id': None,
                'payment_state': recovery_live.PAYMENT_VERIFICATION,
                'adapty_active': current_profile, 'source_active': current_profile,
                'gate': {'allowed': gate.get('allowed'),
                         'reason': gate.get('reason', 'client_not_observed')},
                'evidence_refs': refs,
                'evidence_hash': (entitlement or {}).get('source_fingerprint'),
                'occurred_at': incident.get('occurred_at'),
                'observed_at': (entitlement or {}).get('observed_at') or (profile or {}).get('observed_at'),
                'identity_revision': (client or {}).get('identity_revision'),
                'policy_revision': (client or {}).get('policy_revision'),
                'projection_revision': (client or {}).get('projection_revision'),
                'cache_revision': (client or {}).get('cache_revision'),
                'adapty_revision': (profile or {}).get('source_revision'),
                'catalog_mapped': None,
                'entitlement_evidence': entitlement})
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

    def _capture_snapshot(self, incident_id, fresh_live_ids=None, *, schedule_auto=False):
        incident = self._get_incident(incident_id)
        if (self._manifest().get('scenario') == 'live_adapty'
                and not incident.get('snapshot_id') and fresh_live_ids is None):
            fresh_live_ids = [item['user_id'] for item in self._pages(
                self.provider_url, '/internal/provider/accounts')]
        observations = self._observations(fresh_live_ids=fresh_live_ids)
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
        if self._manifest().get('scenario') == 'live_adapty' and not incident.get('cohort_signature'):
            trigger = next((event for event in history
                            if event.get('event_id') == incident.get('trigger_event_id')),
                           None)
            details = {} if trigger is None else trigger.get('details', {})
            if (trigger and details.get('decision') == 'deny'
                    and details.get('initiator') == 'customer_demo'):
                incident['cohort_signature'] = {
                    'handler_version': details.get('projection_version'),
                    'config_version': details.get('cache_version'),
                    'occurred_at': trigger['occurred_at'],
                    'trigger_event_id': trigger['event_id']}
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
                    'entitlement_evidence': observations['entitlement_evidence'],
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
                                 'entitlement_evidence': len(observations['entitlement_evidence']),
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
        automatic_job = None
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
            if (schedule_auto and self.auto_repair
                    and snapshot['manifest'].get('scenario') == 'live_adapty'):
                selected_ids = sorted(row['id'] for row in accounts
                    if row.get('status') == 'confirmed' and row.get('eligible'))
                decision_id = 'auto-'+uuid4().hex
                automatic_job = 'job-'+uuid4().hex if selected_ids else None
                now = self.wall_now()
                cursor = db.execute('INSERT OR IGNORE INTO automatic_recovery VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)',
                    (decision_id, incident_id, snapshot_id, 0, AUTOMATIC_POLICY_ID,
                     'queued' if selected_ids else 'unresolved', _json(selected_ids),
                     automatic_job or '', None, None,
                     None if selected_ids else _json({'reason': 'no_safe_targets'}), now, now))
                if cursor.rowcount:
                    if automatic_job:
                        db.execute('INSERT INTO jobs(id,kind,status,payload,created_at,updated_at) VALUES(?,?,?,?,?,?)',
                            (automatic_job, 'automatic_recovery', 'queued',
                             _json({'decision_id': decision_id}), now, now))
                    db.execute('INSERT INTO journal(at,action,details) VALUES(?,?,?)',
                        (now, 'automatic_recovery_decided', _json({
                            'incident_id': incident_id, 'snapshot_id': snapshot_id,
                            'policy_id': AUTOMATIC_POLICY_ID, 'selected_count': len(selected_ids),
                            'decision': 'resync_and_verify' if selected_ids else 'no_safe_targets'})))
            db.execute('COMMIT')
        except Exception:
            if db.in_transaction:
                db.execute('ROLLBACK')
            raise
        finally:
            db.close()
        # The queued policy job is durable before a worker can observe it.
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
                snapshot = self._capture_snapshot(payload['incident_id'],
                                                   schedule_auto=self.auto_repair)
                result = {'incident_id': payload['incident_id'], 'snapshot_id': snapshot['id'],
                          'snapshot_hash': snapshot['snapshot_hash'],
                          'summary': self._snapshot_summary(snapshot)}
            elif kind == 'execution':
                result = self._execute_plan(payload['plan_id'], payload['plan_hash'])
            elif kind == 'automatic_recovery':
                result = self._run_automatic_recovery(payload['decision_id'])
            elif kind == 'simulation':
                result = self._run_simulation(payload['simulation_id'])
            else:
                raise RecoveryError('Unknown job type')
            self._set_job(job_id, 'completed', result=result)
            if kind == 'execution':
                self._automatic_execution_finished(job_id, result)
        except RecoveryError as exc:
            self._set_job(job_id, 'failed', error=str(exc))
            if kind == 'automatic_recovery':
                self._finish_automatic_decision(payload['decision_id'], 'unresolved',
                                                {'reason': str(exc)})
            elif kind == 'simulation':
                self._finish_simulation(payload['simulation_id'], 'failed', str(exc))
            elif kind == 'execution':
                self._automatic_execution_finished(job_id, None, str(exc))
        except Exception:
            self._set_job(job_id, 'failed', error='job_failed')
            if kind == 'automatic_recovery':
                self._finish_automatic_decision(payload['decision_id'], 'unresolved',
                                                {'reason': 'job_failed'})
            elif kind == 'simulation':
                self._finish_simulation(payload['simulation_id'], 'failed', 'Simulation failed')
            elif kind == 'execution':
                self._automatic_execution_finished(job_id, None, 'job_failed')

    def _set_job(self, job_id, status, *, result=None, error=None):
        db = _conn(self.db_path)
        try:
            db.execute('UPDATE jobs SET status=?,error=?,result=?,updated_at=? WHERE id=?',
                       (status, error, None if result is None else _json(result), self.wall_now(), job_id))
        finally:
            db.close()

    def _finish_automatic_decision(self, decision_id, status, outcome):
        db = _conn(self.db_path)
        try:
            db.execute('UPDATE automatic_recovery SET status=?,outcome_json=?,updated_at=? WHERE id=?',
                       (status, _json(outcome), self.wall_now_precise(), decision_id))
        finally:
            db.close()

    def _run_automatic_recovery(self, decision_id):
        db = _conn(self.db_path)
        try:
            row = db.execute('SELECT * FROM automatic_recovery WHERE id=?', (decision_id,)).fetchone()
            decision = None if row is None else dict(row)
        finally:
            db.close()
        if decision is None:
            raise RecoveryError('Unknown automatic recovery decision', 404)
        if decision['status'] in ('completed', 'unresolved'):
            return {'decision_id': decision_id, 'status': decision['status']}
        if (decision['policy_id'] != AUTOMATIC_POLICY_ID or not self.live_config
                or self._manifest().get('scenario') != 'live_adapty'):
            self._finish_automatic_decision(decision_id, 'unresolved',
                                            {'reason': 'automatic_policy_scope_changed'})
            return {'decision_id': decision_id, 'status': 'unresolved'}
        selected_ids = json.loads(decision['selected_ids'])
        if not selected_ids:
            self._finish_automatic_decision(decision_id, 'unresolved',
                                            {'reason': 'no_safe_targets'})
            return {'decision_id': decision_id, 'status': 'unresolved'}
        try:
            incident = self._get_incident(decision['incident_id'])
            snapshot = self._load_snapshot(decision['assessment_snapshot_id'])
            plan = self._create_live_plan(selected_ids, incident, snapshot,
                                          automatic_decision_id=decision_id)
            actor = 'policy:' + decision['policy_id']
            self._approve({'plan_id': plan['id'], 'plan_hash': plan['plan_hash'], 'actor': actor})
            queued = self._start_execution({'plan_id': plan['id'],
                'plan_hash': plan['plan_hash']}, launch=False)
        except RecoveryError as exc:
            outcome = {'reason': str(exc), 'selected_count': len(selected_ids)}
            self._finish_automatic_decision(decision_id, 'unresolved', outcome)
            self._record('automatic_recovery_unresolved', {
                'decision_id': decision_id, 'incident_id': decision['incident_id'],
                'policy_id': decision['policy_id'], **outcome})
            return {'decision_id': decision_id, 'status': 'unresolved', **outcome}
        db = _conn(self.db_path)
        try:
            db.execute('UPDATE automatic_recovery SET status=?,plan_id=?,execution_job_id=?,updated_at=? WHERE id=?',
                ('awaiting_execution', plan['id'], queued['job_id'], self.wall_now(), decision_id))
        finally:
            db.close()
        job = self._get_job(queued['job_id'])
        if job['status'] in ('completed', 'failed'):
            self._automatic_execution_finished(queued['job_id'], job.get('result'), job.get('error'))
        else:
            self._launch_job(queued['job_id'])
        return {'decision_id': decision_id, 'plan_id': plan['id'],
                'execution_job_id': queued['job_id'], 'status': 'awaiting_execution'}

    def _automatic_execution_finished(self, job_id, result, error=None):
        db = _conn(self.db_path)
        try:
            row = db.execute('SELECT * FROM automatic_recovery WHERE execution_job_id=?',
                             (job_id,)).fetchone()
            decision = None if row is None else dict(row)
        finally:
            db.close()
        if decision is None or decision['status'] != 'awaiting_execution':
            return
        if error or not isinstance(result, dict):
            self._finish_automatic_decision(decision['id'], 'unresolved',
                {'reason': error or 'execution_result_unavailable'})
            return
        if result.get('access_verified') == result.get('target_count') and not result.get('unresolved'):
            if decision['attempt'] == 0:
                snapshot = self._load_snapshot(decision['assessment_snapshot_id'])
                scope_ids = {row['id'] for row in snapshot['accounts']
                             if row.get('status') == 'confirmed'}
                unselected = scope_ids - set(json.loads(decision['selected_ids']))
                if unselected:
                    self._finish_automatic_decision(decision['id'], 'unresolved', {
                        'reason': 'confirmed_targets_outside_safe_policy_scope',
                        'unresolved_ids': sorted(unselected), 'execution': result})
                    return
            else:
                db = _conn(self.db_path)
                try:
                    parent = db.execute('SELECT outcome_json,selected_ids,assessment_snapshot_id '
                        'FROM automatic_recovery '
                        'WHERE incident_id=? AND attempt=0', (decision['incident_id'],)).fetchone()
                finally:
                    db.close()
                if not parent or not parent['outcome_json']:
                    self._finish_automatic_decision(decision['id'], 'unresolved', {
                        'reason': 'retry_parent_outcome_missing', 'execution': result})
                    return
                try:
                    initial = json.loads(parent['outcome_json']) if parent and parent['outcome_json'] else {}
                except json.JSONDecodeError:
                    initial = {}
                if not isinstance(initial, dict) or not isinstance(initial.get('unresolved_ids'), list):
                    self._finish_automatic_decision(decision['id'], 'unresolved', {
                        'reason': 'retry_parent_outcome_invalid', 'execution': result})
                    return
                original = self._load_snapshot(parent['assessment_snapshot_id'])
                scope_ids = {row['id'] for row in original['accounts']
                             if row.get('status') == 'confirmed'}
                remaining = (set(initial['unresolved_ids'])
                    - set(json.loads(decision['selected_ids']))
                    | (scope_ids - set(json.loads(parent['selected_ids']))))
                if remaining:
                    self._finish_automatic_decision(decision['id'], 'unresolved', {
                        'reason': 'retry_left_unresolved_targets',
                        'unresolved_ids': sorted(remaining), 'execution': result})
                    return
            self._finish_automatic_decision(decision['id'], 'completed', result)
            return
        if decision['attempt'] != 0 or not result.get('snapshot_id'):
            self._finish_automatic_decision(decision['id'], 'unresolved', result)
            return
        snapshot = self._load_snapshot(result['snapshot_id'])
        accounts = {row['id']: row for row in snapshot['accounts']}
        probe_only = self._unverified_target_ids(decision['incident_id'])
        retry_ids = []
        for user_id in result.get('unresolved_ids', []):
            row = accounts.get(user_id)
            if not row:
                continue
            safe_resync = row.get('status') == 'confirmed' and row.get('eligible')
            safe_probe = (row.get('status') in ('healthy', 'pending_verification')
                          and row.get('gate', {}).get('allowed') is True
                          and user_id in probe_only)
            safe_pending_resync = (row.get('status') == 'pending_verification'
                                   and row.get('eligible')
                                   and row.get('gate', {}).get('allowed') is False)
            if safe_resync or safe_probe or safe_pending_resync:
                retry_ids.append(user_id)
        if not retry_ids:
            self._finish_automatic_decision(decision['id'], 'unresolved', {
                'reason': 'fresh_assessment_has_no_safe_retry',
                'execution': result})
            return
        auto_job_id, retry_id, now = 'job-'+uuid4().hex, 'auto-'+uuid4().hex, self.wall_now()
        db = _conn(self.db_path)
        try:
            db.execute('BEGIN IMMEDIATE')
            cursor = db.execute('INSERT OR IGNORE INTO automatic_recovery VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)',
                (retry_id, decision['incident_id'], result['snapshot_id'], 1,
                 decision['policy_id'], 'queued', _json(sorted(retry_ids)),
                 auto_job_id, None, None, None, now, now))
            if cursor.rowcount:
                db.execute('INSERT INTO jobs(id,kind,status,payload,created_at,updated_at) VALUES(?,?,?,?,?,?)',
                    (auto_job_id, 'automatic_recovery', 'queued',
                     _json({'decision_id': retry_id}), now, now))
                db.execute("UPDATE automatic_recovery SET status='retry_scheduled',outcome_json=?,updated_at=? WHERE id=?",
                    (_json(result), now, decision['id']))
                db.execute('INSERT INTO journal(at,action,details) VALUES(?,?,?)',
                    (now, 'automatic_recovery_retry_scheduled', _json({
                        'incident_id': decision['incident_id'], 'policy_id': decision['policy_id'],
                        'snapshot_id': result['snapshot_id'], 'target_count': len(retry_ids)})))
            else:
                db.execute("UPDATE automatic_recovery SET status='unresolved',outcome_json=?,updated_at=? WHERE id=?",
                    (_json({'reason': 'retry_already_used', 'execution': result}), now, decision['id']))
            db.execute('COMMIT')
        except Exception:
            if db.in_transaction:
                db.execute('ROLLBACK')
            raise
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
                        trigger_event_id=None, cohort_signature=None):
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
                    'window_end': iso(end), 'occurred_at': iso(at), 'trigger_user_id': user_id,
                    'snapshot_id': None, 'first_snapshot_id': None,
                    'status': 'queued', 'trigger_event_id': trigger_event_id,
                    **({'cohort_signature': cohort_signature} if cohort_signature else {})}
        db = _conn(self.db_path)
        try:
            db.execute('BEGIN IMMEDIATE')
            existing = db.execute('SELECT id,incident_json FROM incidents WHERE id=?', (incident_id,)).fetchone()
            if existing is None and not trigger_event_id:
                for candidate in db.execute('SELECT id,incident_json FROM incidents ORDER BY rowid DESC'):
                    saved = json.loads(candidate['incident_json'])
                    saved_signature = saved.get('cohort_signature') or {}
                    signature_matches = (not cohort_signature and not saved_signature) or bool(
                        cohort_signature and saved_signature
                        and saved_signature.get('handler_version') == cohort_signature.get('handler_version')
                        and saved_signature.get('config_version') == cohort_signature.get('config_version'))
                    if (saved['trigger_user_id'] == user_id and saved['window_start'] == iso(start)
                            and saved['window_end'] == iso(end) and saved['run_id'] == manifest['run_id']
                            and signature_matches):
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
        if snapshot['manifest'].get('scenario') == 'live_adapty':
            return self._create_live_plan(ids, incident, snapshot)
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

    def _create_live_plan(self, ids, incident, snapshot, *, automatic_decision_id=None):
        if automatic_decision_id:
            db = _conn(self.db_path)
            try:
                decision = db.execute('SELECT plan_id FROM automatic_recovery WHERE id=?',
                                      (automatic_decision_id,)).fetchone()
            finally:
                db.close()
            if decision and decision['plan_id']:
                return self._load_plan(decision['plan_id'])[1]
        account_by_id = {row['id']: row for row in snapshot['accounts']}
        profiles_by_id = {row['user_id']: row for row in snapshot['adapty_profiles']}
        entitlement_by_id = {row['user_id']: row for row in snapshot['entitlement_evidence']}
        probe_only = self._unverified_target_ids(incident['id'])
        selected = {}
        for user_id in ids:
            account = account_by_id.get(user_id)
            probe_retry = (user_id in probe_only and account and account.get('status') in
                           ('healthy', 'pending_verification') and account.get('gate', {}).get('allowed'))
            resync_retry = bool(account and account.get('status') == 'pending_verification'
                                and account.get('eligible') and not account.get('gate', {}).get('allowed'))
            if account is None or not (account.get('eligible') and account.get('status') == 'confirmed'
                    or probe_retry or resync_retry):
                raise RecoveryError('Account is not eligible: '+user_id, 409)
            selected[user_id] = account
            if probe_retry:
                continue
            entitlement = entitlement_by_id.get(user_id)
            profile = profiles_by_id.get(user_id)
            if (not entitlement or not profile or profile.get('status') != 'active'
                    or not profile.get('identity_match')
                    or entitlement.get('source_fingerprint') != account.get('evidence_hash')):
                raise RecoveryError('Account source entitlement is not verified: '+user_id, 409)
        created_wall = datetime.now(timezone.utc)
        expires_wall = created_wall+timedelta(seconds=300)
        entries = []
        for user_id in ids:
            account = selected[user_id]
            if (account.get('status') == 'healthy'
                    or account.get('status') == 'pending_verification'
                    and user_id in probe_only and account.get('gate', {}).get('allowed')):
                continue
            profile = profiles_by_id[user_id]
            entitlement = entitlement_by_id[user_id]
            preconditions = {'projection_revision': account['projection_revision'],
                'identity_revision': account['identity_revision'],
                'policy_revision': account['policy_revision'],
                'profile_revision': profile['source_revision'],
                'profile_hash': entitlement['entitlement_hash'],
                'source_fingerprint': entitlement['source_fingerprint'],
                'evidence_hash': entitlement['source_fingerprint']}
            entries.append(self._entry(user_id, 'lumen', 'resync_access',
                {'product_id': entitlement['product_id'],
                 'transaction_id': entitlement['transaction_id']}, preconditions))
        for user_id in ids:
            account = selected[user_id]
            entries.append(self._entry(user_id, 'lumen', 'verify_gate',
                {'feature': recovery_scenarios.FEATURE},
                {'projection_revision': account['projection_revision'],
                 'policy_revision': account['policy_revision']}))
        manifest = snapshot['manifest']
        requires_resync = any(entry['type'] == 'resync_access' for entry in entries)
        steps = []
        if requires_resync:
            steps.append({'id': 'resync', 'title': 'Resync Lumen access',
                 'description': 'Deliver only the freshly verified Adapty entitlements to the selected Lumen accounts.',
                 'owner': 'lumen', 'status': 'ready', 'selected_ids': ids,
                 'expected_effect': 'Restore the current premium entitlement at the application gate.'})
        steps.append({'id': 'verify', 'title': 'Verify the feature gate',
             'description': 'Probe the actual Lumen gate for every selected account after resync.',
             'owner': 'lumen', 'status': 'ready', 'selected_ids': ids,
             'expected_effect': 'Confirm access for the selected premium feature.'})
        plan = {'id': 'plan-'+uuid4().hex, 'incident_id': incident['id'],
            'snapshot_id': snapshot['id'], 'snapshot_hash': snapshot['snapshot_hash'],
            'app': manifest['app'], 'environment': manifest['environment'],
            'run_id': manifest['run_id'], 'provider': 'adapty',
            'recovery_basis': 'adapty_entitlement_delivery', 'ids': ids,
            'target_count': len(ids), 'created_at': iso(created_wall),
            'scenario_created_at': iso(created_wall), 'expires_at': iso(expires_wall),
            'scenario_expires_at': iso(expires_wall), 'timestamp_kind': 'wall_clock',
            'entries': entries, 'steps': steps,
            'expected_effect': {'entitlement_delivery_target': sum(
                    entry['type'] == 'resync_access' for entry in entries),
                'access_target': len(ids), 'manual_grant': False, 'provider_writes': 0,
                'payment_verification': recovery_live.PAYMENT_VERIFICATION}}
        if automatic_decision_id:
            plan['automatic_policy_id'] = AUTOMATIC_POLICY_ID
            plan['automatic_decision_id'] = automatic_decision_id
        plan['plan_hash'] = digest(plan)
        db = _conn(self.db_path)
        existing_plan_id = None
        try:
            db.execute('BEGIN IMMEDIATE')
            if automatic_decision_id:
                decision = db.execute('SELECT plan_id FROM automatic_recovery WHERE id=?',
                                       (automatic_decision_id,)).fetchone()
                if decision and decision['plan_id']:
                    existing_plan_id = decision['plan_id']
                else:
                    db.execute('INSERT INTO plans VALUES(?,?,?,?,?,?,?,?,?)',
                        (plan['id'], plan['plan_hash'], plan['incident_id'], plan['snapshot_id'],
                         _json(plan), 'pending_approval', iso(created_wall), iso(expires_wall),
                         plan['scenario_expires_at']))
                    db.execute("UPDATE automatic_recovery SET plan_id=?,status='plan_created',updated_at=? WHERE id=?",
                               (plan['id'], self.wall_now(), automatic_decision_id))
            else:
                db.execute('INSERT INTO plans VALUES(?,?,?,?,?,?,?,?,?)',
                    (plan['id'], plan['plan_hash'], plan['incident_id'], plan['snapshot_id'],
                     _json(plan), 'pending_approval', iso(created_wall), iso(expires_wall),
                     plan['scenario_expires_at']))
            db.execute('COMMIT')
        except Exception:
            if db.in_transaction:
                db.execute('ROLLBACK')
            raise
        finally:
            db.close()
        if existing_plan_id:
            return self._load_plan(existing_plan_id)[1]
        self._record('plan_created', {'plan_id': plan['id'], 'plan_hash': plan['plan_hash'],
            'snapshot_id': snapshot['id'], 'target_count': len(ids),
            'recovery_basis': 'adapty_entitlement_delivery'})
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

    def _start_execution(self, body, *, launch=True):
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
        if launch:
            self._launch_job(job_id)
        return {'job_id': job_id, 'plan_id': plan['id'], 'status': 'queued', 'duplicate': False}

    def _preflight(self, plan):
        if datetime.now(timezone.utc) >= parse_time(plan['expires_at']):
            raise RecoveryError('Plan wall-clock TTL expired', 409)
        if self.scenario_now() >= parse_time(plan['scenario_expires_at']):
            raise RecoveryError('Plan scenario-clock TTL expired', 409)
        if plan['app'] != self._manifest()['app'] or plan['environment'] != self._manifest()['environment'] or plan['run_id'] != self._manifest()['run_id']:
            raise RecoveryError('Plan scope changed', 409)
        if plan.get('recovery_basis') == 'adapty_entitlement_delivery':
            observations = self._observations(fresh_live_ids=plan['ids'])
            incident = self._get_incident(plan['incident_id'])
            current = {row['id']: row for row in self._classify(observations, incident)}
            snapshot = self._load_snapshot(plan['snapshot_id'])
            original = {row['id']: row for row in snapshot['accounts']}
            probe_only = self._unverified_target_ids(plan['incident_id'])
            for user_id in plan['ids']:
                before, after = original[user_id], current.get(user_id)
                probe_retry = (user_id in probe_only and after and after.get('status') == 'healthy'
                               and after.get('gate', {}).get('allowed'))
                if after is None or not (after.get('eligible') and after.get('status') == 'confirmed'
                                         or probe_retry):
                    raise RecoveryError('Plan preflight failed: account is no longer eligible', 409)
                for key in ('evidence_hash', 'identity_revision', 'policy_revision',
                            'projection_revision', 'cache_revision', 'adapty_revision'):
                    if before.get(key) != after.get(key):
                        raise RecoveryError('Plan preflight failed: '+key+' changed', 409)
            return observations
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
            if plan.get('recovery_basis') == 'adapty_entitlement_delivery':
                prior = self._existing_action(entry['id'])
                if prior and prior['started_at']:
                    result, status = self._operation_result(entry, plan_id, 'lumen',
                        '/internal/lumen/resync', {}, allow_new=False)
                    self._save_action(entry, plan_id, status, result=result,
                        evidence_ref='adapty://entitlement/'+entry['account_id'])
                    outcomes[entry['id']] = status
                    continue
                user_id = entry['account_id']
                fresh = self._observations(fresh_live_ids=[user_id])
                current = next((item for item in self._classify(fresh, self._get_incident(plan['incident_id']))
                                if item['id'] == user_id), None)
                entitlement = fresh['entitlement_by_id'].get(user_id)
                profile = fresh['profiles_by_id'].get(user_id)
                preconditions = entry['preconditions']
                if (not current or current.get('status') != 'confirmed' or not current.get('eligible')
                        or not profile or profile.get('status') != 'active'
                        or not entitlement
                        or entitlement.get('source_fingerprint') != preconditions['source_fingerprint']
                        or current.get('identity_revision') != preconditions['identity_revision']
                        or current.get('policy_revision') != preconditions['policy_revision']
                        or current.get('projection_revision') != preconditions['projection_revision']):
                    self._save_action(entry, plan_id, 'blocked',
                        result={'reason': 'fresh_adapty_entitlement_precondition_changed'})
                    outcomes[entry['id']] = 'blocked'
                    continue
                body = {'user_id': user_id,
                    'expected_revision': preconditions['projection_revision'],
                    'entitlement': {'product_id': entitlement['product_id'],
                        'expires_at': entitlement['expires_at'],
                        'entitlement_hash': entitlement['entitlement_hash'],
                        'transaction_id': entitlement['transaction_id'],
                        'source_fingerprint': entitlement['source_fingerprint']}}
                result, status = self._operation_result(entry, plan_id, 'lumen',
                    '/internal/lumen/resync', body, allow_new=not resuming)
                self._save_action(entry, plan_id, status, result=result,
                    evidence_ref='adapty://entitlement/'+user_id)
                outcomes[entry['id']] = status
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

        access = self._capture_snapshot(plan['incident_id'],
            fresh_live_ids=plan['ids'] if plan.get('recovery_basis') == 'adapty_entitlement_delivery' else None)
        profiles = {item['user_id']: item for item in access['adapty_profiles']}
        entitlement_by_id = {item['user_id']: item for item in access.get('entitlement_evidence', [])}
        evidence_by_id = {}
        for item in access['provider_evidence']:
            if item.get('user_id'):
                evidence_by_id.setdefault(item['user_id'], []).append(item)
        activated_ids = set()
        plan_snapshot_accounts = {row['id']: row for row in self._load_snapshot(plan['snapshot_id'])['accounts']}
        for user_id in plan['ids']:
            profile = profiles.get(user_id)
            source = self._latest_evidence(evidence_by_id.get(user_id, []))
            if plan.get('recovery_basis') == 'adapty_entitlement_delivery':
                entitlement = entitlement_by_id.get(user_id)
                try:
                    active = bool(profile and profile.get('status') == 'active'
                        and profile.get('identity_match') and entitlement
                        and entitlement.get('source_fingerprint') == plan_snapshot_accounts[user_id].get('evidence_hash')
                        and parse_time(entitlement['starts_at']) <= self.scenario_now()
                        < parse_time(entitlement['expires_at'])
                        and entitlement.get('is_in_grace_period') is False)
                except (KeyError, RecoveryError, TypeError):
                    active = False
                if active:
                    activated_ids.add(user_id)
                continue
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
                  'target_count': len(plan['ids']),
                  'access_verified': accessible, 'unresolved': len(plan['ids'])-accessible,
                  'action_statuses': outcomes,
                  'unresolved_ids': [user_id for user_id in plan['ids']
                                     if user_id not in accessible_ids]}
        if plan.get('recovery_basis') == 'adapty_entitlement_delivery':
            result.update(entitlement_verified=activated,
                payment_verification=recovery_live.PAYMENT_VERIFICATION)
        else:
            result['activation_verified'] = activated
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
        if manifest.get('scenario') == 'live_adapty':
            return self._report_live(incident_id)
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

    def _report_live(self, incident_id=None):
        manifest = self._manifest()
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
        first_snapshot = (self._load_snapshot(incident['first_snapshot_id'])
                          if incident and incident.get('first_snapshot_id') else None)
        gaps = []
        try:
            observations = self._observations()
            accounts = (self._classify(observations, incident) if incident and snapshot
                        else self._unclassified_live_accounts(observations))
            if snapshot:
                coverage = {**snapshot['coverage'],
                    'complete': bool(snapshot['coverage']['complete'] and not observations['gaps']),
                    'gaps': list(dict.fromkeys(snapshot['coverage']['gaps']+observations['gaps'])),
                    'observed_at': observations['observed_at']}
            else:
                coverage = {'complete': observations['complete'], 'gaps': observations['gaps'],
                    'observed_at': observations['observed_at'],
                    'provider_accounts': len(observations['provider_accounts']),
                    'provider_evidence': len(observations['provider_evidence']),
                    'entitlement_evidence': len(observations['entitlement_evidence']),
                    'adapty_profiles': len(observations['adapty_profiles']),
                    'lumen_accounts': len(observations['lumen_accounts'])}
        except Exception as exc:
            observations = None
            gaps.append('source_unavailable:'+type(exc).__name__)
            accounts = snapshot['accounts'] if snapshot else []
            coverage = {**(snapshot['coverage'] if snapshot else {}),
                        'complete': False, 'gaps': gaps, 'observed_at': self.wall_now()}
        try:
            collector = internal_request(self.key, self.lumen_url,
                'GET', '/internal/lumen/collector-coverage')
            coverage['collector'] = collector
            if collector.get('queued') or collector.get('dropped'):
                coverage['complete'] = False
                coverage['gaps'] = list(dict.fromkeys(coverage.get('gaps', [])+
                                                       ['collector_delivery_incomplete']))
        except Exception:
            coverage['complete'] = False
            coverage['gaps'] = list(dict.fromkeys(coverage.get('gaps', [])+
                                                   ['collector_coverage_unavailable']))
        plans = [plan for plan in self._plans() if incident and plan['incident_id'] == incident['id']]
        plan_ids = {plan['id'] for plan in plans}
        actions = [action for action in self._actions() if action['plan_id'] in plan_ids]
        jobs = self._jobs()
        active_plans = [plan for plan in plans if plan['status'] != 'pending_approval']
        targets = self._target_ids(active_plans)
        verify_by_user = {}
        for plan in active_plans:
            for entry in plan['entries']:
                if entry['type'] != 'verify_gate':
                    continue
                action = self._existing_action(entry['id'])
                action_result = json.loads(action['result']) if action and action['result'] else {}
                verify_by_user[entry['account_id']] = bool(action and action['status'] == 'verified'
                                                            and action_result.get('allowed') is True)
        entitlement_verified_ids, accessible_ids = set(), set()
        if observations:
            profiles = observations['profiles_by_id']
            entitlements = observations['entitlement_by_id']
            clients = observations['clients_by_id']
            now = datetime.now(timezone.utc)
            for user_id in targets:
                profile, entitlement = profiles.get(user_id), entitlements.get(user_id)
                client = clients.get(user_id)
                if self._live_entitlement_current(profile, entitlement, user_id, now):
                    entitlement_verified_ids.add(user_id)
                    if client and client['gate'].get('allowed') and verify_by_user.get(user_id):
                        accessible_ids.add(user_id)
            by_id = {item['id']: item for item in accounts}
            for user_id in targets:
                row = by_id.get(user_id)
                if row is None:
                    continue
                if user_id in accessible_ids:
                    row['status'], row['reason'], row['eligible'] = 'restored', 'entitlement_and_access_verified', False
                elif user_id in entitlement_verified_ids:
                    row['status'], row['reason'] = 'pending_verification', 'gate_access_not_verified'
                    row['eligible'] = bool(row.get('eligible') or
                        (row['gate'].get('allowed') and user_id in
                         self._unverified_target_ids(incident['id'])))
        confirmed = set(incident.get('confirmed_ids', [])) if incident else set()
        assessment = self._snapshot_summary({'accounts': accounts}) if incident else {
            'in_scope': len(accounts), 'evaluated': 0, 'confirmed': 0, 'inconclusive': 0}
        summary = {'in_scope': assessment['in_scope'], 'evaluated': assessment['evaluated'],
            'confirmed': len(confirmed), 'inconclusive': assessment['inconclusive'],
            'excluded': sum(row['id'] not in confirmed and row['status'] not in ('inconclusive', 'potential')
                            for row in accounts),
            'potential': sum(row['status'] == 'potential' for row in accounts)}
        public_incident = None if incident is None else {
            key: incident[key] for key in ('id', 'window_start', 'window_end', 'occurred_at',
                                            'trigger_user_id', 'snapshot_id', 'status')}
        access_verified = len(accessible_ids)
        if public_incident and targets:
            public_incident['status'] = ('access_verified' if access_verified == len(targets) else
                'partial_recovery' if access_verified else 'recovery_unresolved')
        fault = internal_request(self.key, self.lumen_url, 'GET', '/internal/lumen/live/status')
        return {'mode': 'LIVE_ADAPTY_SEEDED',
            'manifest': {**manifest, 'logical_now': self.wall_now(), 'wall_now': self.wall_now(),
                         'time_basis': 'wall_clock_for_adapty_entitlements_and_lumen_access'},
            'payment_verification': recovery_live.PAYMENT_VERIFICATION,
            'provenance': recovery_live.PROVENANCE,
            'catalog': observations['catalog'] if observations else None,
            'cli_catalog': observations['catalog'] if observations else None,
            'incident': public_incident,
            'summary': summary, 'assessment': assessment,
            'incidents': [{'id': item['id'], 'trigger_user_id': item['trigger_user_id'],
                'status': item['status'], 'confirmed': len(item.get('confirmed_ids', [])),
                'inconclusive': item.get('assessment_summary', {}).get('inconclusive', 0)}
                for item in incidents],
            'recovery': {'target_count': len(targets),
                'entitlement_verified': len(entitlement_verified_ids),
                'access_verified': access_verified,
                'unresolved': max(0, len(targets)-access_verified),
                'unresolved_ids': sorted(targets-accessible_ids),
                'payment_verification': recovery_live.PAYMENT_VERIFICATION,
                'root_cause_status': 'correlated_delivery_issue' if confirmed else 'not_assessed',
                'root_cause_certainty': 'correlated' if confirmed else 'not_assessed',
                'latest_plan_id': plans[-1]['id'] if plans else None},
            'accounts': accounts, 'coverage': coverage, 'actions': actions,
            'fault_status': fault,
            'plans': [{'id': plan['id'], 'plan_hash': plan['plan_hash'],
                'incident_id': plan['incident_id'], 'snapshot_id': plan['snapshot_id'],
                'status': plan['status'], 'target_count': plan['target_count'],
                'created_at': plan['created_at'], 'expires_at': plan['expires_at']}
                for plan in plans], 'jobs': jobs}

    @staticmethod
    def _live_entitlement_current(profile, entitlement, user_id, now):
        if not profile or not entitlement or profile.get('status') != 'active' or not profile.get('identity_match'):
            return False
        try:
            age = (now-parse_time(profile['observed_at'])).total_seconds()
            return bool(0 <= age <= domain.FRESHNESS_TTL
                and entitlement.get('user_id') == user_id
                and entitlement.get('provider_customer_id') == user_id
                and entitlement.get('app_id') == recovery_live.APP_ID
                and entitlement.get('is_in_grace_period') is False
                and parse_time(entitlement['starts_at']) <= now < parse_time(entitlement['expires_at']))
        except (KeyError, RecoveryError, TypeError):
            return False

    def _unclassified_live_accounts(self, observations):
        result = []
        for user_id in observations['scope_ids']:
            provider = observations['provider_by_id'].get(user_id)
            client = observations['clients_by_id'].get(user_id)
            profile = observations['profiles_by_id'].get(user_id)
            entitlement = observations['entitlement_by_id'].get(user_id)
            gate = client.get('gate') if client else {'allowed': None, 'reason': 'client_not_observed'}
            result.append({'id': user_id, 'status': 'unclassified', 'reason': 'no_incident_scan',
                'eligible': False, 'provider': 'adapty',
                'product_id': (entitlement or {}).get('product_id'), 'price_id': None,
                'payment_state': recovery_live.PAYMENT_VERIFICATION,
                'adapty_active': bool(profile and profile.get('status') == 'active'),
                'source_active': bool(profile and profile.get('status') == 'active'),
                'gate': {'allowed': gate.get('allowed'), 'reason': gate.get('reason', 'client_not_observed')},
                'evidence_refs': (['adapty://entitlement/'+user_id] if entitlement else []),
                'evidence_hash': (entitlement or {}).get('source_fingerprint'),
                'observed_at': (entitlement or {}).get('observed_at') or (profile or {}).get('observed_at'),
                'identity_revision': (client or {}).get('identity_revision'),
                'policy_revision': (client or {}).get('policy_revision'),
                'projection_revision': (client or {}).get('projection_revision'),
                'cache_revision': (client or {}).get('cache_revision'),
                'adapty_revision': (profile or {}).get('source_revision'),
                'catalog_mapped': None})
        return result

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
        if self.live_config:
            if path == '/internal/provider/accounts':
                return domain.provider_accounts(self.db_path, _one(query, 'cursor'), self._limit(query))
            if path == '/internal/provider/evidence':
                return domain.provider_evidence(self.db_path, _one(query, 'user'),
                                                _one(query, 'cursor'), self._limit(query))
            if path == '/internal/adapty/profile':
                user_id = _one(query, 'user')
                if user_id not in self.live_config['customer_user_ids']:
                    raise RecoveryError('Unknown live account', 404)
                recovery_live.refresh_profiles(self.db_path, self.live_config,
                                               self.live_reader, [user_id])
                try:
                    return recovery_live.profile(self.db_path, user_id)
                except recovery_live.LiveSourceError as exc:
                    raise RecoveryError('Fresh Adapty profile read failed', exc.status) from exc
            if path == '/internal/adapty/profiles':
                return recovery_live.profiles(self.db_path, _one(query, 'cursor'), self._limit(query))
            if path == '/internal/adapty/catalog':
                return recovery_live.catalog(self.db_path)
            if path == '/internal/live/status':
                return recovery_live.status(self.db_path)
            raise RecoveryError('Not found', 404)
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
        if self.live_config:
            if path == '/internal/live/refresh':
                if not isinstance(body, dict) or set(body) != {'user_ids'}:
                    raise RecoveryError('Live refresh fields do not match the contract')
                try:
                    return recovery_live.refresh_profiles(self.db_path, self.live_config,
                        self.live_reader, body['user_ids'])
                except ValueError as exc:
                    raise RecoveryError(str(exc)) from exc
            raise RecoveryError('Adapty source is read-only in live mode', 404)
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
        if self.live_config and path == '/internal/lumen/live/status':
            return domain.lumen_live_fault_status(self.db_path)
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
            if prior and not self.live_config:
                return domain.lumen_resync(self.db_path, body)
            try:
                profile = internal_request(self.key, self.provider_url, 'GET',
                    '/internal/adapty/profile?'+urlencode({'user': body['user_id']}))
            except Exception as exc:
                raise RecoveryError('Fresh Adapty profile read failed', 503) from exc
            if self.live_config:
                self._emit_source_observations([profile])
            expected = body['entitlement']
            source = (profile or {}).get('entitlement') or {}
            if (not profile or profile.get('status') != 'active'
                    or (source if self.live_config else profile).get('product_id') != expected.get('product_id')
                    or (source if self.live_config else profile).get('expires_at') != expected.get('expires_at')
                    or (source if self.live_config else profile).get('transaction_id') != expected.get('transaction_id')
                    or (source if self.live_config else profile).get('entitlement_hash') != expected.get('entitlement_hash')
                    or self.live_config and (not profile.get('identity_match')
                        or profile.get('source_fingerprint') != expected.get('source_fingerprint'))):
                raise RecoveryError('Fresh Adapty profile does not match requested entitlement', 409)
            result = domain.lumen_resync(self.db_path, body)
            if self.live_config and not result.get('duplicate'):
                self._emit_projection_change(body['user_id'], result, body['operation_key'])
            return result
        if self.live_config and path == '/internal/lumen/source-observed':
            if not isinstance(body, dict) or set(body) != {'items'} or not isinstance(body['items'], list):
                raise RecoveryError('Source observation fields do not match the contract')
            profiles = []
            for item in body['items']:
                if (not isinstance(item, dict) or set(item) != {'user_id','source_fingerprint',
                        'observed_at','starts_at','expires_at','reason'}
                        or item['user_id'] not in self.live_config['customer_user_ids']):
                    raise RecoveryError('Source observation fields do not match the contract')
                profiles.append({'user_id': item['user_id'],
                    'source_fingerprint': item['source_fingerprint'],
                    'observed_at': item['observed_at'], 'reason': item['reason'],
                    'entitlement': {'starts_at': item['starts_at'], 'expires_at': item['expires_at']}})
            self._emit_source_observations(profiles)
            return {'accepted': len(profiles)}
        if self.live_config and path == '/internal/lumen/live/inject':
            required = {'user_ids','handler_version','config_version','occurred_at'}
            if (not isinstance(body, dict) or set(body) - (required | {'fault_kind'})
                    or not required <= set(body)):
                raise RecoveryError('Live fault fields do not match the contract')
            try:
                result = domain.lumen_live_inject_fault(self.db_path, body['user_ids'],
                    body['handler_version'], body['config_version'], body['occurred_at'],
                    body.get('fault_kind', 'missed_projection'))
            except (ValueError, KeyError) as exc:
                raise RecoveryError(str(exc), 409) from exc
            for item in result['accounts']:
                self._emit_projection_change(item['user_id'], item,
                    'live-fault-'+uuid4().hex, occurred_at=result['occurred_at'],
                    handler_version=result['handler_version'],
                    config_version=result['config_version'])
            return {key: value for key, value in result.items() if key != 'accounts'}
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
        handler_version, config_version = 'lumen-projection-v2', 'lumen-cache-v2'
        if self.live_config:
            signature = domain.lumen_live_fault_status(self.db_path)
            if signature['injected']:
                handler_version = signature['handler_version']
                config_version = signature['config_version']
        try:
            occurred_at = (iso_precise(self.scenario_now()) if self.live_config
                           else iso(self.scenario_now()))
            return self.sdk.emit('feature_access_decided', user_id, occurred_at, {
                'feature': feature, 'decision': 'allow' if result['allowed'] else 'deny',
                'reason_code': result['reason'], 'projection_version': handler_version,
                'cache_version': config_version, 'policy_version': 'access-policy-v2',
                'adapter_version': 'lumen-adapter-v2', 'initiator': initiator,
            })
        except Exception:
            # Telemetry is best effort; gate decisions must remain available.
            return None

    def _emit_projection_change(self, user_id, result, action_id, *, occurred_at=None,
                                handler_version=None, config_version=None):
        if not self.sdk or not result or not result.get('before') or not result.get('after'):
            return None
        try:
            return self.sdk.emit('access_projection_changed', user_id,
                occurred_at or self.wall_now(), {
                    'action_id': action_id, 'source_hash': result.get('source_hash') or 'unknown',
                    'expected_revision': result['before']['projection_revision'],
                    'policy_version': result.get('policy_version', 'premium-policy-v1'),
                    'adapter_version': result.get('adapter_version', 'adapty-profile-read-v1'),
                    'projection_version': handler_version or result.get('projection_version', 'lumen-projection-v2'),
                    'cache_version': config_version or result.get('config_version', 'lumen-cache-v2'),
                    'outcome': 'projection_updated', 'before': result['before'],
                    'after': result['after'], 'cache_invalidated': bool(result['after'].get('invalidated'))})
        except Exception:
            return None

    def _require_demo(self):
        if not self.demo:
            raise RecoveryError('Demo controls are disabled', 404)

    def _live_status(self):
        if not self.live_config or self._manifest().get('scenario') != 'live_adapty':
            raise RecoveryError('Live Adapty mode is not active', 404)
        source = internal_request(self.key, self.provider_url, 'GET', '/internal/live/status')
        fault = internal_request(self.key, self.lumen_url, 'GET', '/internal/lumen/live/status')
        readiness = {'configuration': True,
            'source_registry': source.get('account_count') == 100,
            'all_profiles_observed': source.get('observed_count') == 100,
            'identity_scope_match': source.get('identity_match_count') == 100}
        ready = all(readiness.values())
        db = _conn(self.db_path)
        try:
            incident = db.execute('SELECT incident_json FROM incidents ORDER BY created_at DESC,rowid DESC LIMIT 1').fetchone()
            latest_plan = db.execute('SELECT status FROM plans ORDER BY created_at_wall DESC,rowid DESC LIMIT 1').fetchone()
        finally:
            db.close()
        incident_status = json.loads(incident['incident_json'])['status'] if incident else None
        plan_status = latest_plan['status'] if latest_plan else None
        return {'mode': 'LIVE_ADAPTY_SEEDED', 'scenario': 'live_adapty', 'ready': ready,
            'readiness': readiness, 'app_id': self._manifest()['app'],
            'app_title': self._manifest().get('app_title'),
            'environment': self._manifest()['environment'],
            'source_environment': self._manifest().get('source_environment'),
            'run_id': self._manifest()['run_id'], 'lumen_url': self.lumen_url,
            'account_count': source.get('account_count', 0),
            'active_count': source.get('active_count', 0),
            'source_observed_at': source.get('source_observed_at'),
            'provenance': source.get('provenance'),
            'payment_verification': recovery_live.PAYMENT_VERIFICATION,
            'provider_evidence_count': 0,
            'cli_catalog': source.get('cli_catalog'),
            'catalog': source.get('cli_catalog'),
            'catalog_provenance': (source.get('cli_catalog') or {}).get('provenance'),
            'catalog_product_count': (source.get('cli_catalog') or {}).get('product_count'),
            'catalog_source_hash': (source.get('cli_catalog') or {}).get('source_hash'),
            'catalog_cli_version': (source.get('cli_catalog') or {}).get('cli_version'),
            'catalog_observed_at': (source.get('cli_catalog') or {}).get('observed_at'),
            'seed_revision': self._manifest().get('seed_revision'),
            'fault_status': fault,
            'actions_allowed': {'refresh': True,
                'inject_incident': bool(ready and source.get('active_count', 0) >= 24
                                        and not fault.get('injected')),
                'create_plan': incident_status == 'scanned',
                'approve': plan_status == 'pending_approval',
                'execute': plan_status == 'approved'}}

    def _live_refresh(self, body):
        if body not in ({}, {'action': 'refresh'}):
            raise RecoveryError('Live refresh fields do not match the contract')
        registry = self._pages(self.provider_url, '/internal/provider/accounts')
        user_ids = [row['user_id'] for row in registry]
        result = internal_request(self.key, self.provider_url, 'POST',
            '/internal/live/refresh', {'user_ids': user_ids}, timeout=60)
        profiles = self._pages(self.provider_url, '/internal/adapty/profiles')
        self._notify_live_source_observations(profiles)
        status = self._live_status()
        return {'requested': result.get('requested', 0), 'observed': result.get('observed', 0),
                'active': status['active_count'], 'source_observed_at': status['source_observed_at'],
                'ready': status['ready']}

    def _live_incident(self, body):
        if body != {'action': 'inject'}:
            raise RecoveryError('Live incident fields do not match the contract')
        registry = self._pages(self.provider_url, '/internal/provider/accounts')
        user_ids = [row['user_id'] for row in registry]
        refreshed = internal_request(self.key, self.provider_url, 'POST',
            '/internal/live/refresh', {'user_ids': user_ids}, timeout=60)
        if refreshed.get('observed') != len(user_ids):
            raise RecoveryError('Live source refresh is incomplete', 503)
        refreshed_profiles = self._pages(self.provider_url, '/internal/adapty/profiles')
        self._notify_live_source_observations(refreshed_profiles)
        status = self._live_status()
        if not status['ready']:
            raise RecoveryError('Live source scope is not ready', 409)
        if status['fault_status'].get('injected'):
            raise RecoveryError('Live fault was already injected', 409)
        observations = self._observations()
        now = datetime.now(timezone.utc)
        candidates = []
        for user_id in observations['scope_ids']:
            profile = observations['profiles_by_id'].get(user_id)
            entitlement = observations['entitlement_by_id'].get(user_id)
            provider = observations['provider_by_id'].get(user_id)
            client = observations['clients_by_id'].get(user_id)
            if (self._live_entitlement_current(profile, entitlement, user_id, now)
                    and provider and provider.get('identity_status') == 'mapped'
                    and client and client.get('identity_status') == 'mapped'
                    and client.get('policy_enabled') and client.get('gate', {}).get('allowed')):
                candidates.append(user_id)
        if len(candidates) < 24:
            raise RecoveryError('Fewer than 24 currently verified healthy accounts are available', 409)
        selected = sorted(candidates)[:24]
        signature = uuid4().hex[:10]
        fault = internal_request(self.key, self.lumen_url, 'POST', '/internal/lumen/live/inject', {
            'user_ids': selected, 'handler_version': 'lumen-handler-live-v1-'+signature,
            'config_version': 'premium-export-live-v1-'+signature,
            'occurred_at': self.wall_now()})
        gate_status, gate = self._proxy_lumen_gate({'user_id': selected[0]})
        return {'fault': fault, 'gate': {'status': gate_status, **gate},
            'incident': {'id': None, 'job_id': None,
                         'pending': gate_status == 403 and bool(gate.get('event_id'))}}

    def _simulation(self, body):
        if not self.demo or not self.live_config or not self.auto_repair:
            raise RecoveryError('Simulation requires automatic live demo mode', 404)
        if body == {'action': 'stop'}:
            with self._simulation_inject_lock:
                db = _conn(self.db_path)
                try:
                    db.execute('BEGIN IMMEDIATE')
                    row = db.execute("SELECT * FROM simulations WHERE status='running' ORDER BY created_at DESC LIMIT 1").fetchone()
                    if row is None:
                        db.execute('COMMIT')
                        return {'status': 'idle', 'duplicate': False}
                    db.execute('UPDATE simulations SET stop_requested=1,updated_at=? WHERE id=?',
                               (self.wall_now(), row['id']))
                    db.execute('COMMIT')
                    return {'simulation_id': row['id'], 'job_id': row['job_id'],
                            'status': 'running', 'duplicate': False, 'stop_requested': True}
                except Exception:
                    if db.in_transaction:
                        db.execute('ROLLBACK')
                    raise
                finally:
                    db.close()
        if (not isinstance(body, dict) or body.get('action') not in ('once', 'start')
                or set(body) != {'action', 'operation_key'}
                or not isinstance(body.get('operation_key'), str)
                or not body['operation_key'].strip() or len(body['operation_key']) > 128):
            raise RecoveryError('Simulation fields do not match the contract')
        operation_key = body['operation_key'].strip()
        db = _conn(self.db_path)
        try:
            previous = db.execute('SELECT id,job_id,status FROM simulations WHERE operation_key=?',
                                  (operation_key,)).fetchone()
            if previous:
                return {'simulation_id': previous['id'], 'job_id': previous['job_id'],
                        'status': previous['status'], 'duplicate': True}
            if db.execute("SELECT 1 FROM simulations WHERE status='running' LIMIT 1").fetchone():
                raise RecoveryError('A simulation is already running', 409)
            if db.execute("SELECT 1 FROM automatic_recovery a WHERE a.status IN ('queued','plan_created','awaiting_execution','retry_scheduled','unresolved') AND a.attempt=(SELECT MAX(b.attempt) FROM automatic_recovery b WHERE b.incident_id=a.incident_id) LIMIT 1").fetchone():
                raise RecoveryError('Resolve the previous live incident before starting a simulation', 409)
        finally:
            db.close()
        kinds = [random.choice(SIMULATION_FAULTS)] if body['action'] == 'once' else random.sample(list(SIMULATION_FAULTS), len(SIMULATION_FAULTS))
        sequence = [{'fault_kind': kind, 'count': random.randint(2, 8)} for kind in kinds]
        simulation_id, job_id, now = 'simulation-'+uuid4().hex, 'job-'+uuid4().hex, self.wall_now()
        db = _conn(self.db_path)
        try:
            db.execute('BEGIN IMMEDIATE')
            previous = db.execute('SELECT id,job_id,status FROM simulations WHERE operation_key=?',
                                   (operation_key,)).fetchone()
            if previous:
                db.execute('COMMIT')
                return {'simulation_id': previous['id'], 'job_id': previous['job_id'],
                        'status': previous['status'], 'duplicate': True}
            if db.execute("SELECT 1 FROM simulations WHERE status='running' LIMIT 1").fetchone():
                raise RecoveryError('A simulation is already running', 409)
            if db.execute("SELECT 1 FROM automatic_recovery a WHERE a.status IN ('queued','plan_created','awaiting_execution','retry_scheduled','unresolved') AND a.attempt=(SELECT MAX(b.attempt) FROM automatic_recovery b WHERE b.incident_id=a.incident_id) LIMIT 1").fetchone():
                raise RecoveryError('Resolve the previous live incident before starting a simulation', 409)
            db.execute('INSERT INTO simulations VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)',
                (simulation_id, operation_key, 'running', _json(sequence), 0, len(sequence),
                 0, 0, None, None, job_id, now, now))
            db.execute('INSERT INTO jobs(id,kind,status,payload,created_at,updated_at) VALUES(?,?,?,?,?,?)',
                (job_id, 'simulation', 'queued', _json({'simulation_id': simulation_id}), now, now))
            db.execute('COMMIT')
        except Exception:
            if db.in_transaction:
                db.execute('ROLLBACK')
            raise
        finally:
            db.close()
        self._launch_job(job_id)
        return {'simulation_id': simulation_id, 'job_id': job_id,
                'status': 'running', 'duplicate': False}

    def _simulation_row(self, simulation_id):
        db = _conn(self.db_path)
        try:
            row = db.execute('SELECT * FROM simulations WHERE id=?', (simulation_id,)).fetchone()
            if row is None:
                raise RecoveryError('Unknown simulation', 404)
            return dict(row)
        finally:
            db.close()

    def _finish_simulation(self, simulation_id, status, error=None):
        db = _conn(self.db_path)
        try:
            db.execute('UPDATE simulations SET status=?,error=?,updated_at=? WHERE id=?',
                       (status, error, self.wall_now(), simulation_id))
        finally:
            db.close()

    def _run_simulation(self, simulation_id):
        simulation = self._simulation_row(simulation_id)
        sequence = json.loads(simulation['sequence_json'])
        for index, step in enumerate(sequence):
            simulation = self._simulation_row(simulation_id)
            if simulation['stop_requested']:
                self._finish_simulation(simulation_id, 'stopped')
                return {'simulation_id': simulation_id, 'status': 'stopped',
                        'completed': simulation['completed'], 'total': simulation['total']}
            event_id = self._inject_simulation_fault(step['fault_kind'], step['count'], simulation_id)
            if event_id is None:
                self._finish_simulation(simulation_id, 'stopped')
                return {'simulation_id': simulation_id, 'status': 'stopped',
                        'completed': simulation['completed'], 'total': simulation['total']}
            incident_id = self._wait_for_automatic_recovery(simulation_id, event_id)
            simulation = self._simulation_row(simulation_id)
            db = _conn(self.db_path)
            try:
                db.execute('UPDATE simulations SET current_index=?,completed=?,current_incident_id=?,updated_at=? WHERE id=?',
                    (index+1, simulation['completed']+1, incident_id, self.wall_now(), simulation_id))
            finally:
                db.close()
            if index+1 < len(sequence):
                deadline = time.monotonic()+SIMULATION_GAP_SECONDS
                while time.monotonic() < deadline:
                    if self._simulation_row(simulation_id)['stop_requested']:
                        break
                    time.sleep(0.05)
        simulation = self._simulation_row(simulation_id)
        status = 'stopped' if simulation['stop_requested'] else 'completed'
        self._finish_simulation(simulation_id, status)
        return {'simulation_id': simulation_id, 'status': status,
                'completed': simulation['completed'], 'total': simulation['total']}

    def _inject_simulation_fault(self, fault_kind, count, simulation_id):
        registry = self._pages(self.provider_url, '/internal/provider/accounts')
        user_ids = [row['user_id'] for row in registry]
        refreshed = internal_request(self.key, self.provider_url, 'POST', '/internal/live/refresh',
                                     {'user_ids': user_ids}, timeout=60)
        if refreshed.get('observed') != len(user_ids):
            raise RecoveryError('Live source refresh is incomplete', 503)
        profiles = self._pages(self.provider_url, '/internal/adapty/profiles')
        self._notify_live_source_observations(profiles)
        observations = self._observations()
        now = datetime.now(timezone.utc)
        candidates = []
        for user_id in observations['scope_ids']:
            profile = observations['profiles_by_id'].get(user_id)
            entitlement = observations['entitlement_by_id'].get(user_id)
            provider = observations['provider_by_id'].get(user_id)
            client = observations['clients_by_id'].get(user_id)
            if (self._live_entitlement_current(profile, entitlement, user_id, now)
                    and provider and provider.get('identity_status') == 'mapped'
                    and client and client.get('identity_status') == 'mapped'
                    and client.get('policy_enabled') and client.get('gate', {}).get('allowed') is True):
                candidates.append(user_id)
        if len(candidates) < count:
            raise RecoveryError('Not enough healthy source-backed accounts for the simulation', 409)
        selected = random.sample(candidates, count)
        signature = uuid4().hex[:12]
        occurred_at = self.wall_now()
        with self._simulation_inject_lock:
            if self._simulation_row(simulation_id)['stop_requested']:
                return None
            fault = internal_request(self.key, self.lumen_url, 'POST', '/internal/lumen/live/inject', {
                'user_ids': selected, 'handler_version': f'lumen-handler-{fault_kind}-{signature}',
                'config_version': f'premium-export-{fault_kind}-{signature}',
                'occurred_at': occurred_at, 'fault_kind': fault_kind})
        if fault.get('account_count') != count:
            raise RecoveryError('Simulation fault scope did not match the request', 502)
        gate_status, gate = self._proxy_lumen_gate({'user_id': selected[0]})
        if gate_status != 403 or not gate.get('event_id'):
            raise RecoveryError('Simulation could not emit a customer denial event', 503)
        return gate['event_id']

    def _wait_for_automatic_recovery(self, simulation_id, event_id):
        deadline = time.monotonic()+SIMULATION_RECOVERY_TIMEOUT
        while time.monotonic() < deadline:
            db = _conn(self.db_path)
            try:
                incident = db.execute('SELECT id FROM incidents WHERE trigger_event_id=?',
                                      (event_id,)).fetchone()
                decision = None if not incident else db.execute(
                    'SELECT status FROM automatic_recovery WHERE incident_id=? ORDER BY attempt DESC LIMIT 1',
                    (incident['id'],)).fetchone()
                scan = None if not incident else db.execute(
                    "SELECT status,error FROM jobs WHERE kind IN ('incident','scan') AND payload LIKE ? ORDER BY created_at DESC LIMIT 1",
                    ('%'+incident['id']+'%',)).fetchone()
            finally:
                db.close()
            if incident and decision and decision['status'] == 'completed':
                return incident['id']
            if incident and decision and decision['status'] == 'unresolved':
                raise RecoveryError('Automatic recovery left an incident unresolved', 409)
            if incident and scan and scan['status'] == 'failed':
                raise RecoveryError('Incident assessment failed: '+str(scan['error'] or 'unknown'), 503)
            time.sleep(0.05)
        raise RecoveryError('Timed out waiting for automatic recovery', 504)

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
            live_denial_only = manifest.get('scenario') == 'live_adapty'
            should_scan = (not live_denial_only
                or event['kind'] == 'feature_access_decided' and event['details'].get('decision') == 'deny')
            at = parse_time(event['occurred_at'])
            db = _conn(self.db_path)
            try:
                candidates = [json.loads(row[0]) for row in db.execute(
                    'SELECT incident_json FROM incidents ORDER BY created_at DESC,rowid DESC')]
                live_signature = {'handler_version': event['details'].get('projection_version'),
                                  'config_version': event['details'].get('cache_version')}
                matching = next((item for item in candidates
                    if parse_time(item['window_start']) <= at < parse_time(item['window_end'])
                    and (not live_denial_only or (
                        (item.get('cohort_signature') or {}).get('handler_version') == live_signature['handler_version']
                        and (item.get('cohort_signature') or {}).get('config_version') == live_signature['config_version']))
                    and not (live_denial_only and (closed := db.execute(
                        'SELECT status,updated_at FROM automatic_recovery WHERE incident_id=? '
                        'ORDER BY attempt DESC LIMIT 1', (item['id'],)).fetchone())
                        and closed['status'] == 'completed'
                        and at >= parse_time(closed['updated_at']))), None)
                pending = None if matching is None else db.execute(
                    "SELECT id FROM jobs WHERE kind='scan' AND status IN ('queued','running') AND payload=? LIMIT 1",
                    (_json({'incident_id': matching['id']}),)).fetchone()
            finally:
                db.close()
            if matching and should_scan:
                incident_id = matching['id']
                job_id = pending['id'] if pending else self._start_scan(incident_id)
            elif (should_scan and (event['details'].get('decision') == 'deny'
                  or event['details'].get('observation_kind') in ('access_denied', 'purchase_succeeded'))):
                cohort_signature = None
                if live_denial_only:
                    cohort_signature = {'handler_version': event['details'].get('projection_version'),
                        'config_version': event['details'].get('cache_version'),
                        'occurred_at': event['occurred_at'], 'trigger_event_id': event['event_id']}
                incident_id, job_id = self._start_incident(event['app_user_id'], event['occurred_at'],
                    trigger_event_id=event['event_id'], cohort_signature=cohort_signature)
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
            if path == '/api/recovery/monitor':
                return self.respond(recovery_monitor.build(self.service))
            if path == '/api/recovery/live/status':
                return self.respond(self.service._live_status())
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
        if path == '/api/recovery/live/refresh':
            return self.respond(self.service._live_refresh(body))
        if path == '/api/recovery/live/incident':
            result = self.service._live_incident(body)
            return self.respond(result, 202 if result['incident']['pending'] else 200)
        if path == '/api/recovery/simulation':
            return self.respond(self.service._simulation(body), 202 if body.get('action') in ('once', 'start') else 200)
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
    parser.add_argument('--live-config', type=Path)
    parser.add_argument('--auto-repair', action='store_true')
    args = parser.parse_args(argv)
    if not 0 <= args.port <= 65535:
        parser.error('--port must be between 0 and 65535')
    service = RecoveryService(args.role, args.port, args.db, args.key_file,
                              provider_url=args.provider_url, lumen_url=args.lumen_url,
                              collector_url=args.collector_url, demo=args.demo,
                              live_config=args.live_config,
                              auto_repair=args.auto_repair)
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
