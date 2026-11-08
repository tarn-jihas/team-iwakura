#!/usr/bin/env python3
"""Three-process, loopback-only activation recovery simulator."""
from __future__ import annotations

import argparse
import csv
from datetime import datetime, timedelta, timezone
import hashlib
import hmac
import io
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
AUTOMATIC_POLICY_ID = 'local-fulfillment-resync-v2'
SIMULATION_FAULTS = ('stale_cache', 'missed_projection', 'out_of_order')
SIMULATION_GAP_SECONDS = 0.25
SIMULATION_RECOVERY_TIMEOUT = 90
LIVE_SOURCE_POLL_SECONDS = 60
LIVE_LOCAL_AUDIT_SECONDS = 30
LIVE_NEW_RIGHT_GRACE_SECONDS = 30


class RecoveryError(ValueError):
    def __init__(self, message, status=400):
        super().__init__(message)
        self.status = status


class InternalHTTPError(OSError):
    def __init__(self, status, payload=None, retry_after=None):
        super().__init__('Internal simulator HTTP '+str(status))
        self.status, self.payload, self.retry_after = status, payload, retry_after


class SourceReadUnavailable(RecoveryError):
    def __init__(self):
        super().__init__('Fresh Adapty profile read failed', 503)


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
                 auto_repair=False, live_bootstrap_pending=False):
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
        self.live_bootstrap_pending = bool(live_bootstrap_pending)
        if self.live_bootstrap_pending and (not self.demo or not self.live_config):
            raise ValueError('Pending live bootstrap is demo-only')
        self.live_reader = None
        self.adapty_db = self.db_path.with_name(self.db_path.stem + '-adapty.sqlite3')
        self.outbox_db = self.db_path.with_name(self.db_path.stem + '-outbox.sqlite3')
        self._jobs_lock = threading.Lock()
        self._mutation_lock = threading.RLock()
        self._simulation_inject_lock = threading.Lock()
        self._fulfillment_wake = threading.Event()
        self._fulfillment_stop = threading.Event()
        self._fulfillment_thread = None
        self._active_jobs = set()
        self.server = None
        self.sdk = None
        self._sdk_thread_started = False
        if role == 'provider':
            if self.live_config:
                self.live_reader = recovery_live.AdaptyReader(self.live_config)
                self.live_reader.provider_path = self.db_path
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
                domain.init_live_lumen(self.db_path, live_manifest, bootstrap.get('items', []),
                                       pending=self.live_bootstrap_pending)
            else:
                domain.init_lumen(self.db_path)
            self._init_sdk()
            if self.live_config:
                self._emit_source_observations(bootstrap.get('items', []))
        else:
            self._init_engine()
            self._init_legacy()
            if self.live_config:
                try:
                    self._live_fulfillment_audit(refresh_source=False)
                except Exception:
                    self._set_fulfillment_coverage({'complete':False,
                        'waiting_reason':'startup_audit_unavailable','updated_at':self.wall_now()})
            self._resume_jobs()
            if self.live_config and self.auto_repair:
                self._start_fulfillment_watcher()

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
        emitted = {}
        for profile in profiles:
            if not profile.get('source_fingerprint') or not profile.get('observed_at'):
                continue
            entitlement = profile.get('entitlement') or {}
            reason = reason_codes.get(profile.get('reason'), 'source_unavailable')
            try:
                details = {
                        'source_hash': profile['source_fingerprint'],
                        'starts_at': entitlement.get('starts_at'),
                        'expires_at': entitlement.get('expires_at'),
                        'adapter_version': 'adapty-profile-read-v1',
                        'outcome': 'observed', 'reason_code': reason}
                for key, value in (
                        ('transaction_id', entitlement.get('transaction_id')),
                        ('original_transaction_id', entitlement.get('original_transaction_id')),
                        ('source_environment', entitlement.get('source_environment')),
                        ('store', entitlement.get('store')),
                        ('access_level', entitlement.get('access_level_id')),
                        ('customer_id', profile.get('provider_customer_id')),
                        ('source_version', entitlement.get('source_revision'))):
                    if isinstance(value, str) and value:
                        details[key] = value
                event_id = 'source:'+digest({'customer': profile['user_id'],
                    'source_hash': profile['source_fingerprint']})
                source_event = domain.lumen_source_event(self.db_path, profile['user_id'],
                    profile['source_fingerprint'], event_id, profile['observed_at'], details)
                emitted[profile['user_id']] = source_event
                self.sdk.emit('source_entitlement_observed', profile['user_id'],
                    source_event['occurred_at'], source_event['details'],
                    event_id=source_event['event_id'], correlation_id=source_event['event_id'],
                    source_event_id=source_event['event_id'])
            except Exception:
                pass
        return emitted

    def _emit_handler_completed(self, profile, processing_id, source_event, result):
        if not self.sdk or not profile.get('source_fingerprint'):
            return False
        entitlement = profile.get('entitlement') or {}
        transaction_id = entitlement.get('transaction_id')
        if not transaction_id:
            return False
        outcome = result.get('outcome', 'failed')
        outcome = 'unknown' if outcome == 'diagnostic_only' else outcome
        failed = outcome != 'completed'
        details = {'event_type': 'source_entitlement_observed',
            'handler_version': 'lumen-handler-v2',
            'received_at': result.get('received_at') or source_event['occurred_at'],
            'processed_at': result.get('processed_at') or source_event['occurred_at'],
            'outcome': outcome, 'reason_code': ('source_unavailable' if outcome == 'unknown'
                else 'handler_failure' if failed else 'handler_completed'),
            'projection_version': 'lumen-handler-v2',
            'adapter_version': 'adapty-profile-read-v1',
            'transaction_id': transaction_id, 'source_hash': profile['source_fingerprint'],
            'processing_id': processing_id,
            'trace_id': result['trace_id'], 'steps': result['steps'],
            'revisions': result['revisions']}
        try:
            queued = self.sdk.emit('handler_completed', profile['user_id'],
                details['processed_at'], details,
                event_id='handler:'+processing_id, source_event_id=source_event['event_id'],
                correlation_id=result['trace_id'], schema_version=2)
        except Exception:
            return False
        return bool(queued and (queued.get('accepted') is True or queued.get('queued') is True))

    def _handle_live_source_observation(self, profile, source_event, processing_id=None):
        """Run the application's real receive→handler→transactional projection path."""
        user_id = profile.get('user_id')
        entitlement = profile.get('entitlement') or {}
        transaction_id = entitlement.get('transaction_id')
        fingerprint = profile.get('source_fingerprint')
        if (not user_id or not transaction_id or not fingerprint or not source_event
                or profile.get('status') != 'active'
                or profile.get('identity_match') is not True
                or profile.get('provider_customer_id') != user_id):
            return {'user_id': user_id, 'outcome': 'diagnostic_only',
                    'reason': 'source_transaction_not_eligible'}
        processing_id = processing_id or 'source-handler:'+digest(
            {'user_id': user_id, 'source_fingerprint': fingerprint})
        previous = domain.lumen_handler_result(self.db_path, processing_id)
        if previous:
            if (previous.get('user_id') != user_id
                    or previous.get('transaction_id') != transaction_id
                    or previous.get('source_fingerprint') != fingerprint):
                raise RecoveryError('Processing ID is already bound to different source evidence', 409)
            self._emit_handler_completed(profile, processing_id, source_event, previous['result'])
            return previous['result']
        received_at = self.wall_now_precise()
        trace_id = 'trace:'+digest({'processing_id': processing_id})
        rows = domain.lumen_accounts(self.db_path, limit=500)['items']
        local = next((row for row in rows if row['user_id'] == user_id), None)
        if local is None:
            return {'user_id': user_id, 'outcome': 'failed', 'reason': 'identity_unknown'}
        current = domain.lumen_access(self.db_path, user_id)
        same_projection = bool(current.get('active')
            and current.get('expires_at') == entitlement.get('expires_at')
            and current.get('entitlement_hash') == entitlement.get('entitlement_hash'))
        if (same_projection and current.get('allowed') is True
                and local.get('identity_status') == 'mapped'
                and local.get('policy_enabled')):
            result = {'user_id': user_id, 'outcome': 'completed',
                'received_at': received_at, 'processed_at': received_at,
                'trace_id': trace_id, 'transaction_id': transaction_id,
                'steps': [
                    {'name':'receive','status':'completed','owner':'lumen','result':'accepted'},
                    {'name':'source_observation','status':'completed','owner':'source','result':'observed'},
                    {'name':'identity_check','status':'completed','owner':'engine','result':'verified','revision':local['identity_revision']},
                    {'name':'policy_check','status':'completed','owner':'lumen','result':'verified','revision':local['policy_revision']},
                    {'name':'projection_readback','status':'completed','owner':'lumen','result':'matched','revision':local['projection_revision']},
                    {'name':'gate_readback','status':'completed','owner':'lumen','result':'allowed','revision':local['cache_revision']}],
                'revisions': {'identity': local['identity_revision'],
                    'policy': local['policy_revision'], 'projection': local['projection_revision'],
                    'cache': local['cache_revision']}}
            result['processed_at'] = self.wall_now_precise()
            result['telemetry_gap'] = not self._emit_handler_completed(
                profile, processing_id, source_event, result)
            domain.lumen_save_handler_result(self.db_path, processing_id, user_id,
                transaction_id, fingerprint, 'completed', result, received_at)
            return result
        body = {'schema_version': 2, 'user_id': user_id,
            'expected_provider_customer_id': local['provider_customer_id'],
            'expected_identity_revision': local['identity_revision'],
            'expected_policy_revision': local['policy_revision'],
            'expected_projection_revision': local['projection_revision'],
            'entitlement': {key: entitlement[key] for key in ('product_id','expires_at',
                'entitlement_hash','transaction_id','source_fingerprint','store','source_environment')},
            'operation_key': 'source-handler:'+digest({'user_id':user_id,
                'processing_id':processing_id}), 'processing_id': processing_id,
            'trace_id': trace_id}
        if isinstance(entitlement.get('original_transaction_id'),str) and entitlement['original_transaction_id']:
            body['entitlement']['original_transaction_id'] = entitlement['original_transaction_id']
        try:
            response = self._lumen_post('/internal/lumen/resync', body)
            if isinstance(response, tuple):
                response, close = response
                if close:
                    raise TimeoutError('Lumen response closed after commit')
            result = {'user_id': user_id, 'outcome': 'completed',
                'received_at': received_at, 'processed_at': received_at,
                'trace_id': trace_id, 'transaction_id': transaction_id,
                'steps': response['steps'], 'revisions': response['revisions'],
                'operation_key': body['operation_key'],
                'projection_revision': response['projection_revision'],
                'cache_revision': response['cache_revision'],
                'cache_skipped': response['cache_skipped']}
            if response['cache_skipped']:
                result.update(outcome='failed',reason='cache_refresh_skipped')
        except Exception as exc:
            action = domain.lumen_action(self.db_path, body['operation_key'])
            committed = bool(action and action.get('operation_key') == body['operation_key']
                and action.get('processing_id') == processing_id
                and action.get('user_id') == user_id
                and action.get('transaction_id') == transaction_id)
            try:
                access = domain.lumen_access(self.db_path, user_id)
            except (KeyError, sqlite3.Error):
                access = None
            projection_matches = bool(access and access.get('active') is True
                and access.get('expires_at') == entitlement.get('expires_at')
                and access.get('entitlement_hash') == entitlement.get('entitlement_hash'))
            gate_allowed = None if access is None else access.get('allowed')
            if committed and projection_matches and gate_allowed is True:
                outcome, reason = 'completed', 'committed_readback'
            elif committed and (access is None or gate_allowed is None):
                outcome, reason = 'diagnostic_only', 'readback_unknown'
            elif committed:
                outcome, reason = 'failed', 'gate_or_projection_mismatch'
            elif isinstance(exc, SourceReadUnavailable):
                outcome, reason = 'diagnostic_only', 'source_unavailable'
            elif isinstance(exc, (RecoveryError, InternalHTTPError, ValueError, KeyError, TypeError)):
                outcome, reason = 'failed', 'handler_failure'
            else:
                outcome, reason = 'diagnostic_only', 'readback_unknown'
            if committed:
                steps = list(action.get('steps') or [])
                revisions = dict(action.get('revisions') or {})
            else:
                steps = [
                    {'name':'receive','status':'completed','owner':'lumen','result':'accepted'},
                    {'name':'source_observation','status':'completed','owner':'source','result':'observed'},
                    {'name':'handler','status':'failed' if outcome == 'failed' else 'unknown',
                     'owner':'lumen','result':'failed' if outcome == 'failed' else 'unknown',
                     'reason_code':'handler_failure' if outcome == 'failed' else 'readback_unknown'}]
                revisions = {'identity':local['identity_revision'],'policy':local['policy_revision'],
                    'projection':local['projection_revision'],'cache':local['cache_revision']}
                if isinstance(exc, SourceReadUnavailable):
                    steps.insert(2,{'name':'fresh_source_read','status':'unknown','owner':'source',
                        'result':'unavailable','reason_code':'source_unavailable'})
            if access is None:
                steps.extend([
                    {'name':'projection_readback','status':'unknown','owner':'lumen','result':'unavailable',
                     'reason_code':'readback_unknown'},
                    {'name':'gate_readback','status':'unknown','owner':'lumen','result':'unknown',
                     'reason_code':'readback_unknown'}])
            else:
                steps.extend([
                    {'name':'projection_readback','status':'completed','owner':'lumen',
                     'result':'matched' if projection_matches else 'mismatched',
                     **({} if projection_matches else {'reason_code':'projection_mismatch'})},
                    {'name':'gate_readback',
                     'status':'completed' if gate_allowed is not None else 'unknown',
                     'owner':'lumen',
                     'result':'allowed' if gate_allowed is True else
                         'denied' if gate_allowed is False else 'unknown',
                     **({'reason_code':'timeout_after_commit'} if committed
                         and isinstance(exc,TimeoutError) else
                        {'reason_code':'gate_denied'} if gate_allowed is False else
                        {'reason_code':'readback_unknown','gap':True}
                            if gate_allowed is None else {})}])
                revisions.update({'identity':access['identity_revision'],
                    'policy':access['policy_revision'],
                    'projection':access['projection_revision'],
                    'cache':access['cache_revision']})
            result = {'user_id':user_id,'outcome':outcome,
                'received_at':received_at,'processed_at':self.wall_now_precise(),
                'trace_id':trace_id,'transaction_id':transaction_id,'reason':reason,
                'steps':steps,'revisions':revisions,'operation_key':body['operation_key'],
                'error_class':('recovery_http_'+str(exc.status)
                    if isinstance(exc,RecoveryError) else
                    'internal_http_'+str(exc.status)
                    if isinstance(exc,InternalHTTPError) else type(exc).__name__)}
        result['processed_at'] = self.wall_now_precise()
        result['telemetry_gap'] = not self._emit_handler_completed(
            profile, processing_id, source_event, result)
        domain.lumen_save_handler_result(self.db_path, processing_id, user_id,
            transaction_id, fingerprint, result['outcome'], result, received_at)
        return result

    @staticmethod
    def _live_observation_items(profiles, processing_ids=None):
        items = []
        if not profiles:
            return items
        for profile in profiles:
            if not profile.get('source_fingerprint') or not profile.get('observed_at'):
                continue
            entitlement = profile.get('entitlement') or {}
            item = {'user_id': profile['user_id'],
                'source_fingerprint': profile['source_fingerprint'],
                'observed_at': profile['observed_at'],
                'starts_at': entitlement.get('starts_at'),
                'expires_at': entitlement.get('expires_at'),
                'reason': profile.get('reason'),
                'status': profile.get('status'),
                'identity_match': profile.get('identity_match'),
                'provider_customer_id': profile.get('provider_customer_id'),
                'transaction_id': entitlement.get('transaction_id'),
                'original_transaction_id': entitlement.get('original_transaction_id'),
                'store': entitlement.get('store'),
                'source_environment': entitlement.get('source_environment'),
                'access_level': entitlement.get('access_level_id'),
                'product_id': entitlement.get('product_id'),
                'entitlement_hash': entitlement.get('entitlement_hash')}
            if processing_ids and profile['user_id'] in processing_ids:
                item['processing_id'] = processing_ids[profile['user_id']]
            items.append(item)
        return items

    def _notify_live_source_observations(self, profiles, processing_ids=None):
        items = self._live_observation_items(profiles, processing_ids)
        if items:
            return internal_request(self.key, self.lumen_url, 'POST',
                '/internal/lumen/source-observed', {'items': items}, timeout=30)
        return {'accepted':0,'telemetry_emitted':0,'handled':0,'failed':0,'writes':0}

    def _deliver_live_source_handlers(self, profiles, processing_ids):
        items = self._live_observation_items(profiles, processing_ids)
        if not items or any(not item.get('processing_id') for item in items):
            raise RecoveryError('Normal handler delivery requires processing IDs')
        return internal_request(self.key, self.lumen_url, 'POST',
            '/internal/lumen/handler/deliver', {'items': items}, timeout=120)

    def _flush_sdk(self):
        while True:
            try:
                self.sdk.flush()
            except Exception:
                pass
            time.sleep(1)

    def _start_fulfillment_watcher(self):
        if self._fulfillment_thread is not None:
            return
        self._fulfillment_thread = threading.Thread(target=self._fulfillment_watch_loop,
            name='live-fulfillment-watch', daemon=True)
        self._fulfillment_thread.start()

    def _fulfillment_watch_loop(self):
        next_source, next_local = 0.0, 0.0
        while not self._fulfillment_stop.is_set():
            now = time.monotonic()
            source_due = now >= next_source
            local_due = source_due or self._fulfillment_wake.is_set() or now >= next_local
            if local_due:
                self._fulfillment_wake.clear()
                try:
                    result = self._live_fulfillment_audit(refresh_source=source_due)
                    wait_for = max(LIVE_SOURCE_POLL_SECONDS,
                                   int(result.get('retry_after_seconds') or 0))
                except Exception as exc:
                    self._set_fulfillment_coverage({'waiting_reason':
                        'audit_unavailable:'+type(exc).__name__, 'complete': False,
                        'updated_at': self.wall_now()})
                    wait_for = LIVE_SOURCE_POLL_SECONDS
                now = time.monotonic()
                next_local = now+self._live_duration(LIVE_LOCAL_AUDIT_SECONDS)
                if source_due:
                    next_source = now+wait_for
            delay = max(0.1, min(next_local, next_source)-time.monotonic())
            self._fulfillment_wake.wait(delay)

    def _set_fulfillment_coverage(self, coverage):
        db = _conn(self.db_path)
        try:
            db.execute('BEGIN IMMEDIATE')
            _set_meta(db, 'fulfillment_coverage', coverage)
            db.execute('COMMIT')
        except Exception:
            if db.in_transaction:
                db.execute('ROLLBACK')
            raise
        finally:
            db.close()

    def _live_profile_scope_matches(self, profile, user_id):
        entitlement = (profile or {}).get('entitlement') or {}
        return bool(profile and profile.get('app_id') == recovery_live.APP_ID
            and profile.get('user_id') == user_id
            and entitlement.get('app_id') == recovery_live.APP_ID
            and entitlement.get('user_id') == user_id
            and entitlement.get('provider_customer_id') == user_id
            and entitlement.get('source_environment') == self.live_config.get('source_environment')
            and entitlement.get('store') in ('app_store','play_store'))

    def _fulfillment_source_right(self, profile, user_id, now):
        entitlement = (profile or {}).get('entitlement') or {}
        try:
            fresh_age = (now-parse_time(profile['observed_at'])).total_seconds()
            current = (0 <= fresh_age <= 300 and profile.get('status') == 'active'
                and profile.get('identity_match') is True
                and self._live_profile_scope_matches(profile,user_id)
                and entitlement.get('user_id') == user_id
                and entitlement.get('provider_customer_id') == user_id
                and entitlement.get('app_id') == recovery_live.APP_ID
                and entitlement.get('is_in_grace_period') is False
                and parse_time(entitlement['starts_at']) <= now
                < parse_time(entitlement['expires_at']))
        except (KeyError, RecoveryError, TypeError):
            fresh_age, current = float('inf'), False
        return entitlement, current, fresh_age

    def _live_fulfillment_audit(self, *, refresh_source=False,
                                handler_batch_complete=False):
        with self._simulation_inject_lock:
            return self._live_fulfillment_audit_locked(
                refresh_source=refresh_source,
                handler_batch_complete=handler_batch_complete)

    def _live_fulfillment_audit_locked(self, *, refresh_source=False,
                                       handler_batch_complete=False):
        if not self.live_config or self._manifest().get('scenario') != 'live_adapty':
            return {'waiting_reason': 'live_source_not_configured'}
        source_result = None
        source_error = None
        if refresh_source:
            try:
                registry = self._pages(self.provider_url, '/internal/provider/accounts')
                source_result = internal_request(self.key, self.provider_url, 'POST',
                    '/internal/live/refresh', {'user_ids': [row['user_id'] for row in registry]},
                    timeout=60)
            except Exception as exc:
                source_error = type(exc).__name__
        try:
            observations = self._observations()
            source = observations.get('live_source') or {}
            profiles = observations['profiles_by_id']
            clients = observations['clients_by_id']
            full_count = len(observations['scope_ids'])
            last_source_pass = source.get('last_source_pass') or {}
            source_pass_fresh = False
            try:
                pass_age = (datetime.now(timezone.utc)-parse_time(
                    last_source_pass['completed_at'])).total_seconds()
                source_pass_fresh = (0 <= pass_age <= 300
                    and last_source_pass.get('requested') == full_count
                    and last_source_pass.get('observed') == full_count
                    and not last_source_pass.get('waiting_reason'))
            except (KeyError,RecoveryError,TypeError):
                pass
            cached_poll = bool(source_result and
                source_result.get('waiting_reason') == 'source_poll_interval'
                and source_pass_fresh)
            source_complete = bool(source_result is not None
                and source_result.get('observed') == source_result.get('requested') == full_count)
            source_complete = source_complete or cached_poll
            if source_result and source_complete:
                self._notify_live_source_observations(observations['adapty_profiles'])
            waiting_reason = None
            if refresh_source and not source_complete:
                waiting_reason = ((source_result or {}).get('waiting_reason')
                                  or ('source_unavailable' if source_error else 'source_incomplete'))
            elif source.get('source_cooldown_seconds', 0):
                waiting_reason = 'source_cooldown'
            elif not source.get('last_source_pass') or source['last_source_pass'].get('waiting_reason'):
                waiting_reason = (source.get('last_source_pass') or {}).get('waiting_reason') or 'source_unavailable'
            try:
                last_source_at = parse_time(source.get('source_observed_at'))
                source_age = (datetime.now(timezone.utc)-last_source_at).total_seconds()
                cached_source_fresh = 0 <= source_age <= 300
            except RecoveryError:
                cached_source_fresh = False
            source_fresh = bool(not waiting_reason and cached_source_fresh
                and (source_complete or not refresh_source)
                and source.get('observed_count') == full_count)
            now = datetime.now(timezone.utc)
            normal_processing_seconds = self._live_duration(LIVE_NEW_RIGHT_GRACE_SECONDS)
            receipt_keys = {(user_id, (profile.get('entitlement') or {}).get('transaction_id'),
                             profile.get('source_fingerprint'))
                            for user_id, profile in profiles.items()
                            if (profile.get('entitlement') or {}).get('transaction_id')
                            and profile.get('source_fingerprint')}
            receipts = self._live_processing_receipts(receipt_keys)
            pending, current = [], []
            db = _conn(self.db_path)
            try:
                db.execute('BEGIN IMMEDIATE')
                for user_id in observations['scope_ids']:
                    profile = profiles.get(user_id) or {}
                    client = clients.get(user_id) or {}
                    entitlement, source_right, source_age = self._fulfillment_source_right(
                        profile, user_id, now)
                    handler_result = observations.get('handler_results_by_key',{}).get((
                        user_id, entitlement.get('transaction_id'),
                        profile.get('source_fingerprint')))
                    handler_failed = bool(handler_result and handler_result.get('outcome') == 'failed')
                    provider = observations['provider_by_id'].get(user_id) or {}
                    identity_ok = bool(provider.get('identity_status') == 'mapped'
                        and provider.get('provider_customer_id') == user_id
                        and client.get('identity_status') == 'mapped'
                        and client.get('provider_customer_id') == user_id
                        and profile.get('identity_match') is True)
                    key = {'app': recovery_live.APP_ID,
                        'source_environment': entitlement.get('source_environment') or
                            self.live_config.get('source_environment', ''),
                        'store': entitlement.get('store') or '',
                        'transaction_id': entitlement.get('transaction_id') or '',
                        'customer_id': user_id,
                        'access_level': entitlement.get('access_level_id') or 'premium'}
                    key_json = _json(key)
                    source_version = digest({'starts_at': entitlement.get('starts_at'),
                        'expires_at': entitlement.get('expires_at'),
                        'fingerprint': profile.get('source_fingerprint'),
                        'status': profile.get('status'), 'reason': profile.get('reason')})
                    expectation_id = digest({'key': key, 'source_version': source_version})
                    row = db.execute('SELECT * FROM fulfillment_expectations WHERE expectation_id=?',
                                     (expectation_id,)).fetchone()
                    previous = dict(row) if row else None
                    version = (previous['version'] if previous else
                        1+db.execute('SELECT COALESCE(MAX(version),0) FROM fulfillment_expectations WHERE key_json=?',
                                     (key_json,)).fetchone()[0])
                    source_record = {name: entitlement.get(name) for name in (
                        'transaction_id','original_transaction_id','store','source_environment',
                        'access_level_id','product_id','starts_at','expires_at',
                        'entitlement_hash','source_fingerprint','is_in_grace_period')}
                    application = {name: client.get(name) for name in (
                        'identity_revision','policy_revision','projection_revision','cache_revision',
                        'access_active','access_expires_at','entitlement_hash')}
                    application['gate'] = client.get('gate')
                    projection_matches = bool(client and client.get('access_active')
                        and client.get('access_expires_at') == entitlement.get('expires_at')
                        and client.get('entitlement_hash') == entitlement.get('entitlement_hash'))
                    if not source_fresh:
                        status, reason = 'inconclusive', waiting_reason or 'source_observation_stale'
                    elif not self._live_profile_scope_matches(profile,user_id):
                        status, reason = 'inconclusive', 'source_scope_mismatch'
                    elif not identity_ok:
                        status, reason = 'inconclusive', 'identity_scope_mismatch'
                    elif profile.get('status') != 'active' or not source_right:
                        status, reason = 'inconclusive', profile.get('reason') or 'source_right_not_current'
                    elif not entitlement.get('transaction_id'):
                        status, reason = 'inconclusive', 'transaction_link_missing'
                    elif not client:
                        status, reason = 'inconclusive', 'application_not_observed'
                    elif not client.get('policy_enabled'):
                        status, reason = 'inconclusive', 'policy_restricted'
                    elif client.get('gate', {}).get('allowed') is None and projection_matches:
                        status, reason = 'inconclusive', 'gate_unobserved'
                    elif projection_matches and client.get('gate', {}).get('allowed') is True:
                        status, reason = 'verified_application', 'source_period_and_gate_match'
                    elif projection_matches and client.get('gate', {}).get('allowed') is False:
                        if client.get('gate', {}).get('reason') in (
                                'cache_stale','subscription_inactive','subscription_expired'):
                            status, reason = 'discrepancy', 'gate_denied_despite_matching_projection'
                        else:
                            status, reason = 'inconclusive', 'gate_denial_not_explained'
                    elif handler_failed:
                        status, reason = 'discrepancy', 'handler_processing_failed'
                    elif not previous and (now-parse_time(profile['observed_at'])).total_seconds() < normal_processing_seconds:
                        status, reason = 'awaiting_application', 'normal_processing_window'
                    elif (previous and previous['status'] != 'verified_application'
                            and not previous.get('episode_no')
                            and (now-parse_time(previous['first_observed_at'])).total_seconds()
                                < normal_processing_seconds):
                        status, reason = 'awaiting_application', 'normal_processing_window'
                    else:
                        status, reason = 'discrepancy', (
                            'projection_mismatch' if not projection_matches else
                            'gate_denied_despite_matching_projection')
                    receipt_found = (user_id, entitlement.get('transaction_id'),
                                     entitlement.get('source_fingerprint')) in receipts
                    telemetry_gap = bool(status == 'verified_application' and not receipt_found)
                    first_seen = (previous['first_observed_at'] if previous
                                  else self.wall_now_precise())
                    episode_no = previous['episode_no'] if previous else 0
                    episode_open = previous['episode_open'] if previous else 0
                    incident_id = previous['incident_id'] if previous else None
                    if status == 'discrepancy' and episode_open and incident_id:
                        prior_decision = db.execute('SELECT status FROM automatic_recovery '
                            'WHERE incident_id=? ORDER BY attempt DESC LIMIT 1',(incident_id,)).fetchone()
                        if prior_decision and prior_decision['status'] == 'completed':
                            episode_open = 0
                    if status == 'discrepancy' and not episode_open:
                        episode_no += 1
                        episode_open = 1
                        incident_id = None
                    elif status == 'verified_application':
                        episode_open = 0
                    elif status == 'inconclusive' and profile.get('status') == 'inactive':
                        episode_open = 0
                    updated = self.wall_now_precise()
                    changed = (previous is None or previous['status'] != status
                        or previous['reason'] != reason
                        or previous['episode_no'] != episode_no
                        or previous['telemetry_gap'] != int(telemetry_gap))
                    db.execute('INSERT INTO fulfillment_expectations(expectation_id,key_json,source_version,version,period_start,period_end,source_fingerprint,original_transaction_id,status,reason,first_observed_at,last_observed_at,incident_id,episode_no,episode_open,telemetry_gap,source_json,application_json,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(expectation_id) DO UPDATE SET status=excluded.status,reason=excluded.reason,last_observed_at=excluded.last_observed_at,incident_id=CASE WHEN excluded.episode_no>fulfillment_expectations.episode_no THEN excluded.incident_id ELSE COALESCE(fulfillment_expectations.incident_id,excluded.incident_id) END,episode_no=excluded.episode_no,episode_open=excluded.episode_open,telemetry_gap=excluded.telemetry_gap,application_json=excluded.application_json,updated_at=excluded.updated_at',
                        (expectation_id,key_json,source_version,version,
                         entitlement.get('starts_at'),entitlement.get('expires_at'),
                         profile.get('source_fingerprint'),entitlement.get('original_transaction_id'),
                         status,reason,first_seen,updated,incident_id,episode_no,int(episode_open),
                         int(telemetry_gap),_json(source_record),_json(application),updated))
                    if changed:
                        activity_id = 'fulfillment:'+digest({'expectation': expectation_id,
                            'status': status, 'reason': reason, 'episode': episode_no,
                            'updated_at': updated})
                        details = {'status': status, 'reason': reason,
                            'version': version,
                            'transaction_id': entitlement.get('transaction_id'),
                            'period_start': entitlement.get('starts_at'),
                            'period_end': entitlement.get('expires_at'),
                            'telemetry_gap': telemetry_gap}
                        db.execute('INSERT OR IGNORE INTO fulfillment_activity VALUES(?,?,?,?,?,?)',
                            (activity_id,expectation_id,incident_id,updated,status,_json(details)))
                        trace_id = 'trace:'+digest({'expectation': expectation_id,
                            'status': status, 'reason': reason, 'episode': episode_no,
                            'updated_at': updated})
                        steps = [
                            {'name': 'fresh_source_read', 'status': 'completed' if source_fresh else 'unknown',
                             'owner': 'source', 'result': 'verified' if source_fresh else 'unavailable'},
                            {'name': 'identity_check',
                             'status': 'completed' if identity_ok else 'failed' if provider and client and profile else 'unknown',
                             'owner': 'engine', 'result': 'verified' if identity_ok else 'failed' if provider and client and profile else 'unknown'},
                            {'name': 'policy_check',
                             'status': 'completed' if client and client.get('policy_enabled') else 'failed' if client else 'unknown',
                             'owner': 'lumen', 'result': 'verified' if client and client.get('policy_enabled') else 'failed' if client else 'unknown'},
                            {'name': 'projection_readback',
                             'status': 'completed' if client and projection_matches else 'failed' if client else 'unknown',
                             'owner': 'lumen', 'result': 'matched' if client and projection_matches else 'mismatched' if client else 'unknown',
                             'revision': (client or {}).get('projection_revision') or 0},
                            {'name': 'gate_readback',
                             'status': 'completed' if client and client.get('gate',{}).get('allowed') is True else 'failed' if client and client.get('gate',{}).get('allowed') is False else 'unknown',
                             'owner': 'lumen', 'result': 'allowed' if client and client.get('gate',{}).get('allowed') is True else 'denied' if client and client.get('gate',{}).get('allowed') is False else 'unknown',
                             'revision': (client or {}).get('cache_revision') or 0},
                        ]
                        if handler_failed:
                            steps.insert(2, {'name':'handler','status':'failed',
                                'owner':'lumen','result':'failed',
                                'reason_code':'handler_failure'})
                        if telemetry_gap:
                            steps.append({'name': 'telemetry_enqueue', 'status': 'unknown',
                                'owner': 'collector', 'result': 'unavailable', 'gap': True,
                                'reason_code': 'telemetry_gap'})
                        trace = {'trace_id': trace_id, 'expectation_id': expectation_id,
                            'incident_id': incident_id, 'user_id': user_id,
                            'key': key, 'version': version, 'episode_no': episode_no,
                            'transaction_id': entitlement.get('transaction_id'),
                            'source_fingerprint': profile.get('source_fingerprint'),
                            **({'processing_id':handler_result.get('processing_id'),
                                'processing_trace_id':(handler_result.get('result') or {}).get('trace_id'),
                                'processing_outcome':handler_result.get('outcome')}
                               if handler_result else {}),
                            'status': status, 'reason': reason, 'telemetry_gap': telemetry_gap,
                            'revisions': {name:(client or {}).get(name+'_revision')
                                for name in ('identity','policy','projection','cache')},
                            'source_period': {'starts_at': entitlement.get('starts_at'),
                                'expires_at': entitlement.get('expires_at')},
                            'next_step': ('Review source identity/period' if not identity_ok else
                                'Wait for source-backed entitlement before resync' if not source_fresh else
                                'No write; source period and Lumen gate already match' if status == 'verified_application' else
                                'Read back the local projection and gate before any repair' if not entitlement.get('transaction_id') else
                                'Reconcile the existing source transaction to the Lumen projection'),
                            'steps': steps, 'created_at': updated}
                        db.execute('INSERT OR IGNORE INTO fulfillment_traces VALUES(?,?,?,?,?,?)',
                            (trace_id,expectation_id,incident_id,user_id,_json(trace),updated))
                    current.append({'expectation_id': expectation_id, 'user_id': user_id,
                        'version': version, 'status': status, 'reason': reason, 'episode_no': episode_no,
                        'episode_open': bool(episode_open), 'incident_id': incident_id,
                        'eligible': status == 'discrepancy' and bool(entitlement.get('transaction_id')),
                        'trace_id': None})
                    if episode_open and not incident_id and status == 'discrepancy':
                        pending.append({'expectation_id': expectation_id, 'user_id': user_id,
                                        'episode_no': episode_no})
                db.execute('COMMIT')
            except Exception:
                if db.in_transaction:
                    db.execute('ROLLBACK')
                raise
            finally:
                db.close()
            incident_id = None
            if (pending and source_fresh and self.auto_repair
                    and (handler_batch_complete or self._live_initial_bootstrap_complete())):
                pending_ids = sorted(item['expectation_id']+':'+str(item['episode_no'])
                                     for item in pending)
                trigger_id = 'fulfillment:'+digest(pending_ids)
                at = datetime.now(timezone.utc)
                signature = self._live_denial_cohort_signature(pending)
                claims = pending + [{'expectation_id':item['expectation_id'],
                    'episode_no':item['episode_no']} for item in current
                    if item['status']=='discrepancy' and item['episode_open'] and item['incident_id']]
                incident_id, _ = self._start_incident(pending[0]['user_id'], iso(at),
                    iso(at-timedelta(minutes=5)), iso(at+timedelta(minutes=5)),
                    trigger_event_id=trigger_id, cohort_signature=signature,
                    fulfillment_claims=claims)
                db = _conn(self.db_path)
                try:
                    db.execute('BEGIN IMMEDIATE')
                    db.executemany('UPDATE fulfillment_expectations SET incident_id=? WHERE expectation_id=? AND episode_no=? AND episode_open=1 AND incident_id IS NULL',
                        [(incident_id,item['expectation_id'],item['episode_no']) for item in pending])
                    db.execute('UPDATE fulfillment_activity SET incident_id=? WHERE expectation_id IN ('+
                        ','.join('?' for _ in pending)+') AND incident_id IS NULL',
                        [incident_id]+[item['expectation_id'] for item in pending])
                    db.execute('UPDATE fulfillment_traces SET incident_id=? WHERE expectation_id IN ('+
                        ','.join('?' for _ in pending)+') AND incident_id IS NULL',
                        [incident_id]+[item['expectation_id'] for item in pending])
                    db.execute('COMMIT')
                except Exception:
                    if db.in_transaction:
                        db.execute('ROLLBACK')
                    raise
                finally:
                    db.close()
                self._bind_handler_receipts_to_incident(incident_id,pending)
            coverage = {'complete': source_fresh and observations['complete'],
                'waiting_reason': waiting_reason, 'source_fresh': source_fresh,
                'handler_results_available':observations.get('handler_results_available',True),
                'source_requests_total': source.get('source_requests_total', 0),
                'last_source_request_at': source.get('last_source_request_at'),
                'last_source_pass': source.get('last_source_pass'),
                'source_calls_last_pass': ((last_source_pass.get('source_calls',0)
                    if cached_poll else (source_result or {}).get('source_calls',
                    last_source_pass.get('source_calls',0)))),
                'observed_accounts': sum(bool(item.get('observed_at')) for item in observations['adapty_profiles']),
                'total_accounts': full_count, 'updated_at': self.wall_now()}
            summary = {}
            for item in current:
                summary[item['status']] = summary.get(item['status'], 0)+1
            coverage['fulfillments'] = summary
            if pending and not self.auto_repair:
                coverage['waiting_reason'] = 'automatic_repair_disabled'
            self._set_fulfillment_coverage(coverage)
            return {'waiting_reason': coverage['waiting_reason'],
                'incident_id': incident_id,
                'retry_after_seconds': (source_result or {}).get('not_before') and max(0,
                    int((parse_time(source_result['not_before'])-datetime.now(timezone.utc)).total_seconds()))}
        except Exception:
            raise

    def _live_processing_receipts(self, receipt_keys):
        db = _conn(self.db_path)
        try:
            result = set()
            for user_id, transaction_id, source_fingerprint in receipt_keys:
                row = db.execute('SELECT 1 FROM fulfillment_receipts WHERE user_id=? AND transaction_id=? AND source_fingerprint=?',
                                 (user_id, transaction_id, source_fingerprint)).fetchone()
                if row:
                    result.add((user_id, transaction_id, source_fingerprint))
            return result
        finally:
            db.close()

    def _fulfillments(self, cursor=None, limit=50, status=None):
        if not self.live_config:
            raise RecoveryError('Fulfillment monitoring is available only in live Adapty mode', 404)
        try:
            offset = int(cursor or 0)
        except (TypeError, ValueError) as exc:
            raise RecoveryError('Invalid fulfillment cursor') from exc
        if isinstance(limit, bool) or not isinstance(limit, int) or not 1 <= limit <= 200 or offset < 0:
            raise RecoveryError('Invalid fulfillment page')
        allowed = {'awaiting_application','verified_application','discrepancy','inconclusive'}
        if status is not None and status not in allowed:
            raise RecoveryError('Unsupported fulfillment status')
        db = _conn(self.db_path)
        try:
            where, params = (' WHERE status=?', [status]) if status else ('', [])
            total = db.execute('SELECT COUNT(*) FROM fulfillment_expectations'+where, params).fetchone()[0]
            rows = db.execute('SELECT * FROM fulfillment_expectations'+where+
                ' ORDER BY updated_at DESC,expectation_id LIMIT ? OFFSET ?',
                (*params, limit, offset)).fetchall()
            coverage = _meta(db, 'fulfillment_coverage', {})
            items = []
            for row in rows:
                source, application = json.loads(row['source_json']), json.loads(row['application_json'])
                gate = application.get('gate') or {}
                projection_matches = bool(application.get('access_active')
                    and application.get('access_expires_at') == source.get('expires_at')
                    and application.get('entitlement_hash') == source.get('entitlement_hash'))
                trace = db.execute('SELECT trace_id,trace_json FROM fulfillment_traces '
                    'WHERE expectation_id=? ORDER BY updated_at DESC LIMIT 1',
                    (row['expectation_id'],)).fetchone()
                trace_data = {} if trace is None else json.loads(trace['trace_json'])
                items.append({'expectation_id': row['expectation_id'],
                    'key': json.loads(row['key_json']), 'version': row['version'],
                    'source_version': row['source_version'], 'status': row['status'],
                    'reason': row['reason'], 'source_period': {
                        'starts_at': row['period_start'], 'expires_at': row['period_end']},
                    'source_fingerprint': row['source_fingerprint'],
                    'original_transaction_id': row['original_transaction_id'],
                    'first_observed_at': row['first_observed_at'],
                    'last_observed_at': row['last_observed_at'],
                    'episode_no': row['episode_no'], 'episode_open': bool(row['episode_open']),
                    'incident_id': row['incident_id'],
                    'stages': {'source_recorded': bool(row['source_fingerprint']),
                        'application_applied': projection_matches,
                        'access_verified': projection_matches and gate.get('allowed') is True},
                    'application': application,
                    'telemetry_gap': bool(row['telemetry_gap']),
                    'trace_ref': None if trace is None or not row['incident_id'] else
                        '/api/recovery/incidents/'+row['incident_id']+'/trace',
                    'trace_id': None if trace is None else trace['trace_id'],
                    'next_step': trace_data.get('next_step')})
            next_cursor = str(offset+len(items)) if offset+len(items) < total else None
            return {'items': items, 'pagination': {'cursor': str(offset),
                'limit': limit, 'next_cursor': next_cursor, 'total': total,
                'status': status}, 'coverage': coverage}
        finally:
            db.close()

    def _fulfillment_trace(self, incident_id):
        if not self.live_config:
            raise RecoveryError('Fulfillment traces are available only in live Adapty mode', 404)
        db = _conn(self.db_path)
        try:
            db.execute('BEGIN')
            incident = db.execute('SELECT incident_json FROM incidents WHERE id=?',
                                  (incident_id,)).fetchone()
            if incident is None:
                raise RecoveryError('Unknown incident', 404)
            traces = [json.loads(row['trace_json']) for row in db.execute(
                'SELECT trace_json FROM fulfillment_traces WHERE incident_id=? ORDER BY updated_at,trace_id',
                (incident_id,))]
            expectation_ids = sorted({item['expectation_id'] for item in traces})
            historical = {}
            for trace in traces:
                expectation_id = trace['expectation_id']
                historical[expectation_id] = {'expectation_id': expectation_id,
                    'key': trace.get('key'), 'version': trace.get('version'),
                    'status': trace.get('status'), 'reason': trace.get('reason'),
                    'source_period': trace.get('source_period'),
                    'source_fingerprint': trace.get('source_fingerprint'),
                    'episode_no': trace.get('episode_no'),
                    'incident_id': trace.get('incident_id'),
                    'trace_id': trace.get('trace_id')}
            current_fulfillments = []
            for expectation_id in expectation_ids:
                row = db.execute('SELECT * FROM fulfillment_expectations WHERE expectation_id=?',
                                 (expectation_id,)).fetchone()
                if row is not None:
                    current_fulfillments.append({'expectation_id': expectation_id,
                        'key': json.loads(row['key_json']), 'version': row['version'],
                        'status': row['status'], 'reason': row['reason'],
                        'source_period': {'starts_at': row['period_start'],
                            'expires_at': row['period_end'], 'fingerprint': row['source_fingerprint']},
                        'episode_no': row['episode_no'], 'episode_open': bool(row['episode_open']),
                        'incident_id': row['incident_id'], 'updated_at': row['updated_at']})
            expectations = list(historical.values())
            receipts = [{'event_id':row['event_id'],'trace_id':row['trace_id'],
                'user_id':row['user_id'],'transaction_id':row['transaction_id'],
                'steps':json.loads(row['steps_json']),'recorded_at':row['recorded_at']}
                for row in db.execute('SELECT * FROM fulfillment_receipts WHERE incident_id=? '
                    'ORDER BY recorded_at,event_id',(incident_id,))]
            activity = [{'occurred_at': row['occurred_at'], 'kind': row['kind'],
                         'details': json.loads(row['details_json'])}
                for row in db.execute('SELECT occurred_at,kind,details_json FROM fulfillment_activity '
                    'WHERE incident_id=? ORDER BY occurred_at,activity_id', (incident_id,))]
            coverage = _meta(db, 'fulfillment_coverage', {})
            manifest = {key: _meta(db,key) for key in ('app','environment','run_id','provenance',
                'payment_verification','seed_revision')}
            db.execute('COMMIT')
            return {'incident_id': incident_id, 'incident': json.loads(incident['incident_json']),
                'expectations': expectations, 'traces': traces, 'processing_receipts': receipts,
                'current_fulfillments': current_fulfillments,
                'activity': activity, 'coverage': coverage,
                'provenance': {key: value for key,value in manifest.items() if value is not None}}
        except Exception:
            if db.in_transaction:
                db.execute('ROLLBACK')
            raise
        finally:
            db.close()

    def _export_recovery(self, from_value=None, to_value=None, format='json'):
        if not self.live_config:
            raise RecoveryError('Recovery export is available only in live Adapty mode', 404)
        if format not in ('csv','json'):
            raise RecoveryError('Export format must be csv or json')
        export_now = datetime.now(timezone.utc)
        end = export_now if to_value is None else parse_time(to_value, 'export to')
        start = end-timedelta(hours=24) if from_value is None else parse_time(from_value, 'export from')
        if start >= end:
            raise RecoveryError('Export period must be a non-empty UTC interval')
        start_text, end_text = iso_precise(start), iso_precise(end)

        def in_period(value):
            if not value:
                return False
            try:
                parsed = parse_time(value)
            except RecoveryError:
                return False
            return start <= parsed < end

        db = _conn(self.db_path)
        try:
            db.execute('BEGIN')
            export_time = self.wall_now_precise()
            incident_rows = [dict(row) for row in db.execute(
                'SELECT id,incident_json,created_at FROM incidents ORDER BY created_at,rowid')]
            incident_by_id = {row['id']: row for row in incident_rows}
            plan_rows = [dict(row) for row in db.execute(
                'SELECT id,incident_id,plan_json,status,created_at_wall,expires_at_wall FROM plans ORDER BY created_at_wall,rowid')]
            plan_incident = {row['id']: row['incident_id'] for row in plan_rows}
            action_rows = [dict(row) for row in db.execute('SELECT * FROM actions')]
            decision_rows = [dict(row) for row in db.execute('SELECT * FROM automatic_recovery')]
            activity_rows = [dict(row) for row in db.execute('SELECT * FROM fulfillment_activity')]
            selected = {row['id'] for row in incident_rows if in_period(row['created_at'])}
            selected.update(plan_incident[row['plan_id']] for row in action_rows
                if row['plan_id'] in plan_incident and
                (in_period(row.get('started_at')) or in_period(row.get('finished_at'))))
            selected.update(row['incident_id'] for row in activity_rows
                if row.get('incident_id') and in_period(row['occurred_at']))
            selected.update(row['incident_id'] for row in decision_rows
                if in_period(row.get('updated_at')))
            selected = sorted(selected & incident_by_id.keys())
            db.execute('CREATE TEMP TABLE export_selected_incidents(id TEXT PRIMARY KEY)')
            db.executemany('INSERT INTO export_selected_incidents VALUES(?)',
                           ((item,) for item in selected))
            snapshots = [dict(row) for row in db.execute(
                'SELECT s.* FROM snapshots s JOIN export_selected_incidents e ON e.id=s.incident_id '
                'ORDER BY s.created_at,s.id')]
            selected_plans = [row for row in plan_rows if row['incident_id'] in set(selected)]
            selected_plan_ids = {row['id'] for row in selected_plans}
            selected_actions = [row for row in action_rows if row['plan_id'] in selected_plan_ids]
            selected_decisions = [row for row in decision_rows if row['incident_id'] in set(selected)]
            selected_activity = [row for row in activity_rows if row.get('incident_id') in set(selected)]
            selected_traces = [dict(row) for row in db.execute(
                'SELECT t.* FROM fulfillment_traces t JOIN export_selected_incidents e '
                'ON e.id=t.incident_id ORDER BY t.updated_at,t.trace_id')]
            expectations = [dict(row) for row in db.execute(
                'SELECT f.* FROM fulfillment_expectations f JOIN export_selected_incidents e '
                'ON e.id=f.incident_id ORDER BY f.updated_at,f.expectation_id')]
            selected_jobs = []
            all_jobs = [dict(row) for row in db.execute('SELECT * FROM jobs ORDER BY created_at,rowid')]
            related_job_ids = {row['auto_job_id'] for row in selected_decisions if row.get('auto_job_id')}
            related_job_ids.update(row['execution_job_id'] for row in selected_decisions
                                   if row.get('execution_job_id'))
            for job in all_jobs:
                try:
                    payload = json.loads(job['payload'])
                except (TypeError, json.JSONDecodeError):
                    payload = {}
                if job['id'] in related_job_ids or payload.get('incident_id') in set(selected) or (
                        payload.get('plan_id') in selected_plan_ids):
                    selected_jobs.append(job)
            selected_expectation_ids = {row['expectation_id'] for row in expectations}
            selected_receipts = []
            user_ids = set()
            for row in expectations:
                key = json.loads(row['key_json'])
                user_id, txn = key.get('customer_id'), key.get('transaction_id')
                if user_id:
                    user_ids.add(user_id)
                if user_id and txn and row.get('source_fingerprint'):
                    receipt_rows = db.execute('SELECT * FROM fulfillment_receipts WHERE user_id=? '
                        'AND transaction_id=? AND source_fingerprint=? ORDER BY recorded_at,event_id',
                        (user_id,txn,row['source_fingerprint'])).fetchall()
                    selected_receipts.extend(dict(receipt) for receipt in receipt_rows)
            for trace in selected_traces:
                user_ids.add(trace['user_id'])
                data = json.loads(trace['trace_json'])
                selected_expectation_ids.add(data['expectation_id'])
            present_expectations = {row['expectation_id'] for row in expectations}
            for expectation_id in selected_expectation_ids-present_expectations:
                row = db.execute('SELECT * FROM fulfillment_expectations WHERE expectation_id=?',
                                 (expectation_id,)).fetchone()
                if row:
                    expectations.append(dict(row))
            event_rows = []
            if user_ids:
                for row in db.execute('SELECT event_json,recorded_at FROM collector_events ORDER BY recorded_at,event_id'):
                    try:
                        event = json.loads(row['event_json'])
                    except (TypeError, json.JSONDecodeError):
                        continue
                    if event.get('app_user_id') in user_ids:
                        event_rows.append({'recorded_at': row['recorded_at'], 'event': event})
            selected_expectations = []
            if selected_expectation_ids:
                for row in expectations:
                    if row['expectation_id'] in selected_expectation_ids:
                        selected_expectations.append(row)
            else:
                selected_expectations = expectations
            manifest = {key: _meta(db,key) for key in ('app','environment','run_id','provenance',
                'payment_verification','seed_revision','source_environment')}
            coverage = _meta(db, 'fulfillment_coverage', {})
            records = []
            for incident_id in selected:
                incident_row = incident_by_id[incident_id]
                incident_data = json.loads(incident_row['incident_json'])
                incident_plans = [row for row in selected_plans if row['incident_id'] == incident_id]
                incident_plan_ids = {row['id'] for row in incident_plans}
                incident_actions = [row for row in selected_actions if row['plan_id'] in incident_plan_ids]
                incident_snapshots = [json.loads(row['snapshot_json']) for row in snapshots
                                      if row['incident_id'] == incident_id]
                affected_ids = set(incident_data.get('confirmed_ids', []))
                if not affected_ids:
                    affected_ids.update(account['id'] for snapshot in incident_snapshots
                        for account in snapshot.get('accounts', []) if account.get('status') == 'confirmed')
                verified_ids = set()
                actions_by_id = {row['id']: row for row in incident_actions}
                for plan in incident_plans:
                    for entry in json.loads(plan['plan_json']).get('entries', []):
                        account_id = entry.get('account_id')
                        if not account_id:
                            continue
                        affected_ids.add(account_id)
                        action = actions_by_id.get(entry['id'])
                        if entry.get('type') != 'verify_gate' or not action or not action.get('started_at'):
                            continue
                        result = json.loads(action['result']) if action.get('result') else {}
                        if action['status'] == 'verified' and result.get('allowed') is True:
                            verified_ids.add(account_id)
                        else:
                            verified_ids.discard(account_id)
                incident_decisions = [row for row in selected_decisions if row['incident_id'] == incident_id]
                incident_activity = [row for row in selected_activity if row.get('incident_id') == incident_id]
                incident_traces = [row for row in selected_traces if row['incident_id'] == incident_id]
                incident_expectations = []
                trace_expectation_ids = {json.loads(row['trace_json'])['expectation_id']
                                         for row in incident_traces}
                for row in selected_expectations:
                    if row['expectation_id'] in trace_expectation_ids:
                        incident_expectations.append({'expectation_id': row['expectation_id'],
                            'key': json.loads(row['key_json']), 'version': row['version'],
                            'source_version': row['source_version'], 'status': row['status'],
                            'reason': row['reason'], 'period_start': row['period_start'],
                            'period_end': row['period_end'], 'source_fingerprint': row['source_fingerprint'],
                            'original_transaction_id': row['original_transaction_id'],
                            'source': json.loads(row['source_json']),
                            'application': json.loads(row['application_json']),
                            'telemetry_gap': bool(row['telemetry_gap']), 'episode_no': row['episode_no']})
                current_fulfillments = incident_expectations
                incident_expectations = []
                for current in current_fulfillments:
                    assessments = [json.loads(row['trace_json']) for row in incident_traces
                        if row['expectation_id'] == current['expectation_id']]
                    if assessments:
                        historical = assessments[-1]
                        incident_expectations.append({**current,
                            'status': historical['status'], 'reason': historical['reason'],
                            'telemetry_gap': historical.get('telemetry_gap'),
                            'episode_no': historical.get('episode_no'), 'application': None,
                            'assessment_at': historical['created_at']})
                incident_job_ids = set()
                for job in selected_jobs:
                    try:
                        payload = json.loads(job['payload'])
                    except (TypeError, json.JSONDecodeError):
                        continue
                    if payload.get('incident_id') == incident_id or payload.get('plan_id') in incident_plan_ids:
                        incident_job_ids.add(job['id'])
                incident_job_ids.update(value for row in incident_decisions for value in
                    (row.get('auto_job_id'),row.get('execution_job_id')) if value)
                incident_expectation_keys = {(row['key']['customer_id'],
                    row['key']['transaction_id'],row.get('source_fingerprint'))
                    for row in incident_expectations if row['key'].get('customer_id')
                    and row['key'].get('transaction_id')}
                incident_user_ids = {key[0] for key in incident_expectation_keys}
                incident_data_records = {'id': incident_id, 'detected_at': incident_row['created_at'],
                    'summary': {'affected_accounts': len(affected_ids),
                        'repaired_accounts': len(verified_ids),
                        'unresolved_accounts': len(affected_ids-verified_ids)},
                    'incident': incident_data,
                    'snapshots': incident_snapshots,
                    'plans': [json.loads(row['plan_json']) for row in incident_plans],
                    'actions': [{**{key: row[key] for key in ('id','plan_id','account_id','owner',
                        'target','preconditions','status','started_at','finished_at','evidence_ref')},
                        'result': None if not row['result'] else json.loads(row['result'])}
                        for row in incident_actions],
                    'automatic_recovery': [{**{key: row[key] for key in row.keys()
                        if key != 'outcome_json'}, 'outcome': None if not row['outcome_json']
                        else json.loads(row['outcome_json'])} for row in incident_decisions],
                    'jobs': [{**{key: row[key] for key in row.keys() if key not in ('payload','result')},
                        'payload': json.loads(row['payload']),
                        'result': None if not row['result'] else json.loads(row['result'])}
                        for row in selected_jobs if row['id'] in incident_job_ids or
                            any(row['id'] in (decision.get('auto_job_id'),decision.get('execution_job_id'))
                                for decision in incident_decisions)],
                    'fulfillments': incident_expectations,
                    'current_fulfillments': current_fulfillments,
                    'activity': [{'occurred_at': row['occurred_at'], 'kind': row['kind'],
                        'details': json.loads(row['details_json'])} for row in incident_activity],
                    'traces': [json.loads(row['trace_json']) for row in incident_traces],
                    'processing_receipts': [dict(row) | {'steps': json.loads(row['steps_json']),
                        'scope': 'incident'}
                        for row in selected_receipts if row.get('incident_id') == incident_id and (row['user_id'],row['transaction_id'],
                            row['source_fingerprint']) in incident_expectation_keys],
                    'telemetry': [row for row in event_rows if
                        row['event'].get('app_user_id') in incident_user_ids]}
                records.append(incident_data_records)
            db.execute('COMMIT')
        except Exception:
            if db.in_transaction:
                db.execute('ROLLBACK')
            raise
        finally:
            db.close()
        provenance = {key: manifest[key] for key in ('app','environment','provenance',
            'payment_verification','source_environment','seed_revision') if manifest.get(key) is not None}
        metadata = {'period': {'from': start_text, 'to': end_text,
            'interval': '[from,to)'}, 'export_time': export_time,
            'coverage': coverage, 'provenance': provenance}
        if format == 'json':
            # Source snapshots retain private evidence; exports use normalized fields.
            def public(value):
                private = {'raw_source_profile', 'custom_attributes', 'installation_meta',
                    'authorization', 'api_key', 'secret', 'password', 'purchase_token',
                    'receipt', 'raw_receipt', 'headers', 'request_body'}
                if isinstance(value, dict):
                    return {key: public(item) for key, item in value.items()
                            if key.lower() not in private}
                if isinstance(value, list):
                    return [public(item) for item in value]
                return value
            return public({**metadata, 'incident_count': len(records), 'incidents': records})
        output = io.StringIO(newline='')
        writer = csv.writer(output, lineterminator='\n')
        columns = ['record_type','incident_id','detected_at','first_attempt_at','last_activity_at',
            'status','affected_accounts','repaired_accounts','unresolved_accounts',
            'owner','error','next_step','trace_ref','period_from','period_to',
            'export_time','coverage_json','provenance_json']
        writer.writerow(columns)
        if not records:
            metadata_row = {'record_type':'export_metadata','status':'metadata',
                'period_from':start_text,'period_to':end_text,'export_time':export_time,
                'coverage_json':_json(coverage),'provenance_json':_json(provenance)}
            writer.writerow([self._csv_safe(metadata_row.get(column,'')) for column in columns])
        for item in records:
            actions = item['actions']
            started = sorted((row['started_at'] for row in actions if row.get('started_at')), key=parse_time)
            activity_times = [row['occurred_at'] for row in item['activity']]
            activity_times.extend(value for row in actions for value in
                (row.get('started_at'),row.get('finished_at')) if value)
            activity_times.extend(row.get('updated_at') for row in item['automatic_recovery']
                                  if row.get('updated_at'))
            decisions = item['automatic_recovery']
            latest_decision = max(decisions,key=lambda row:(parse_time(row['updated_at']),row.get('attempt',0))) if decisions else None
            if latest_decision and latest_decision['status'] == 'completed':
                status_value = 'repaired'
            elif latest_decision and latest_decision['status'] == 'unresolved':
                status_value = 'unresolved'
            else:
                status_value = item['incident'].get('status','detecting')
            if item['summary']['affected_accounts'] and not item['summary']['unresolved_accounts']:
                status_value = 'repaired'
            elif status_value == 'repaired':
                status_value = 'unresolved'
            latest_action = max(actions,key=lambda row:parse_time(row.get('finished_at') or row.get('started_at')) if row.get('finished_at') or row.get('started_at') else datetime.min.replace(tzinfo=timezone.utc)) if actions else None
            reason = None
            if latest_action and latest_action.get('result'):
                reason = latest_action['result'].get('reason')
            latest_trace = item['traces'][-1] if item['traces'] else None
            next_step = latest_trace.get('next_step') if latest_trace else None
            values = ['incident',item['id'],item['detected_at'],started[0] if started else '',
                max(activity_times,key=parse_time) if activity_times else '',status_value,
                item['summary']['affected_accounts'],item['summary']['repaired_accounts'],
                item['summary']['unresolved_accounts'],
                ','.join(sorted({row['owner'] for row in actions if row.get('owner')})),
                reason or '',next_step or 'Review the incident trace',
                '/api/recovery/incidents/'+item['id']+'/trace',start_text,end_text,export_time,
                _json(coverage),_json(provenance)]
            writer.writerow([self._csv_safe(value) for value in values])
        return output.getvalue().encode('utf-8')

    @staticmethod
    def _csv_safe(value):
        text = '' if value is None else str(value)
        return "'"+text if text.lstrip().startswith(('=','+','-','@')) or text.startswith(('\t','\r','\n')) else text

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
                'CREATE TABLE IF NOT EXISTS simulation_intents(operation_key TEXT PRIMARY KEY,simulation_id TEXT NOT NULL,cycle_no INTEGER NOT NULL,user_id TEXT NOT NULL,fault_mode TEXT NOT NULL,processing_id TEXT NOT NULL,status TEXT NOT NULL,incident_id TEXT,result_json TEXT,created_at TEXT NOT NULL,updated_at TEXT NOT NULL)',
                'CREATE TABLE IF NOT EXISTS collector_events(event_id TEXT PRIMARY KEY,payload_hash TEXT NOT NULL,event_json TEXT NOT NULL,recorded_at TEXT NOT NULL,provenance TEXT NOT NULL)',
                'CREATE TABLE IF NOT EXISTS collector_assessments(event_id TEXT PRIMARY KEY,result TEXT NOT NULL)',
                'CREATE TABLE IF NOT EXISTS fulfillment_receipts(event_id TEXT PRIMARY KEY,user_id TEXT NOT NULL,transaction_id TEXT NOT NULL,source_fingerprint TEXT NOT NULL,trace_id TEXT NOT NULL,action_id TEXT,incident_id TEXT,steps_json TEXT NOT NULL,recorded_at TEXT NOT NULL)',
                'CREATE INDEX IF NOT EXISTS fulfillment_receipts_source ON fulfillment_receipts(user_id,transaction_id,source_fingerprint,recorded_at,event_id)',
                'CREATE INDEX IF NOT EXISTS fulfillment_receipts_incident ON fulfillment_receipts(incident_id,recorded_at,event_id)',
                'CREATE TABLE IF NOT EXISTS fulfillment_expectations(expectation_id TEXT PRIMARY KEY,key_json TEXT NOT NULL,source_version TEXT NOT NULL,version INTEGER NOT NULL,period_start TEXT,period_end TEXT,source_fingerprint TEXT,original_transaction_id TEXT,status TEXT NOT NULL,reason TEXT NOT NULL,first_observed_at TEXT NOT NULL,last_observed_at TEXT NOT NULL,incident_id TEXT,episode_no INTEGER NOT NULL DEFAULT 0,episode_open INTEGER NOT NULL DEFAULT 0,telemetry_gap INTEGER NOT NULL DEFAULT 0,source_json TEXT NOT NULL,application_json TEXT NOT NULL,updated_at TEXT NOT NULL,UNIQUE(key_json,source_version))',
                'CREATE INDEX IF NOT EXISTS fulfillment_expectations_updated ON fulfillment_expectations(updated_at DESC,expectation_id)',
                'CREATE INDEX IF NOT EXISTS fulfillment_expectations_source ON fulfillment_expectations(source_fingerprint)',
                'CREATE TABLE IF NOT EXISTS fulfillment_activity(activity_id TEXT PRIMARY KEY,expectation_id TEXT NOT NULL,incident_id TEXT,occurred_at TEXT NOT NULL,kind TEXT NOT NULL,details_json TEXT NOT NULL)',
                'CREATE INDEX IF NOT EXISTS fulfillment_activity_time ON fulfillment_activity(occurred_at,activity_id)',
                'CREATE TABLE IF NOT EXISTS fulfillment_traces(trace_id TEXT PRIMARY KEY,expectation_id TEXT NOT NULL,incident_id TEXT,user_id TEXT NOT NULL,trace_json TEXT NOT NULL,updated_at TEXT NOT NULL)',
                'CREATE INDEX IF NOT EXISTS fulfillment_traces_incident ON fulfillment_traces(incident_id,updated_at)',
                'CREATE INDEX IF NOT EXISTS fulfillment_traces_user ON fulfillment_traces(user_id,updated_at,trace_id)',
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

    def _live_duration(self, seconds):
        if not (self.demo and self.live_bootstrap_pending):
            return seconds
        db = _conn(self.db_path)
        try:
            scale = _meta(db, 'demo_simulation_clock_scale', 1)
        finally:
            db.close()
        if type(scale) is not int or scale < 1:
            scale = 1
        return max(0.01, seconds/scale)

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
            row = db.execute('SELECT id,job_id,status,completed,total,error,sequence_json FROM simulations '
                             'ORDER BY created_at DESC,rowid DESC LIMIT 1').fetchone()
            if row is None:
                status = {'status': 'idle', 'completed': 0, 'total': 0, 'error': None}
            else:
                sequence = json.loads(row['sequence_json'])
                status = {'status': 'running' if row['status'] == 'queued' else row['status'],
                    'simulation_id': row['id'],
                    'completed': row['completed'], 'total': row['total'],
                    'error': row['error'],
                    'continuous': bool(sequence and sequence[0].get('mode') == 'continuous'),
                    'seed': sequence[0].get('seed') if sequence else None}
                job = db.execute('SELECT result FROM jobs WHERE id=?',(row['job_id'],)).fetchone()
                if job and job['result']:
                    status['result'] = json.loads(job['result'])
                cycle = db.execute('SELECT result_json FROM simulation_intents WHERE simulation_id=? '
                    "AND cycle_no>0 AND status='completed' AND result_json IS NOT NULL ORDER BY cycle_no DESC LIMIT 1",
                    (row['id'],)).fetchone()
                if cycle:
                    status['last_cycle'] = json.loads(cycle['result_json'])
            if self.live_bootstrap_pending:
                bootstrap = None
                for candidate in db.execute('SELECT id,status,sequence_json FROM simulations '
                        'ORDER BY created_at DESC,rowid DESC'):
                    sequence = json.loads(candidate['sequence_json'])
                    if sequence and sequence[0].get('mode') == 'bootstrap':
                        bootstrap = candidate
                        break
                bootstrap_status = 'not_started' if bootstrap is None else bootstrap['status']
                status['bootstrap_required'] = bootstrap_status != 'completed'
                status['bootstrap_status'] = bootstrap_status
                if bootstrap is not None:
                    status['bootstrap_simulation_id'] = bootstrap['id']
            else:
                status['bootstrap_required'] = False
                status['bootstrap_status'] = 'not_required'
            status['waiting_reason'] = _meta(db, 'simulation_waiting_reason')
        finally:
            db.close()
        if self.live_config:
            try:
                source=internal_request(self.key,self.provider_url,'GET','/internal/live/status')
                status['source_requests_total']=source.get('source_requests_total',0)
                status['source_cooldown_seconds']=source.get('source_cooldown_seconds',0)
                status['last_source_pass']=source.get('last_source_pass')
            except Exception:
                status['source_status_available']=False
        return status

    def _live_initial_bootstrap_complete(self):
        if not self.live_bootstrap_pending:
            return True
        db = _conn(self.db_path)
        try:
            for row in db.execute('SELECT status,sequence_json FROM simulations '
                    'ORDER BY created_at DESC,rowid DESC'):
                sequence = json.loads(row['sequence_json'])
                if sequence and sequence[0].get('mode') == 'bootstrap':
                    return row['status'] == 'completed'
            return False
        finally:
            db.close()

    def _set_simulation_waiting(self, reason):
        db = _conn(self.db_path)
        try:
            db.execute('BEGIN IMMEDIATE')
            _set_meta(db, 'simulation_waiting_reason', reason)
            db.execute('COMMIT')
        except Exception:
            if db.in_transaction:
                db.execute('ROLLBACK')
            raise
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
        source_refresh_reused = False
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
                    source_refresh_reused = bool(refresh.get('waiting_reason') == 'source_poll_interval'
                        and self._has_fresh_complete_source_pass())
                    if not source_refresh_reused:
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
        handler_results_available = True
        handler_results = []
        if manifest.get('scenario') == 'live_adapty':
            try:
                handler_results = self._pages(self.lumen_url,
                    '/internal/lumen/handler/results')
            except Exception:
                handler_results_available = False
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
        handler_results_by_key = {}
        for row in handler_results:
            key = (row.get('user_id'),row.get('transaction_id'),row.get('source_fingerprint'))
            if all(isinstance(value,str) and value for value in key):
                handler_results_by_key[key] = row
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
            if live_source.get('source_cooldown_seconds',0):
                gaps.append('adapty_source_cooldown')
            complete = not gaps
        else:
            live_source = None
            complete = not gaps
        return {'provider_accounts': providers, 'provider_evidence': evidence,
                'adapty_profiles': profiles, 'catalog': catalog,
                'lumen_accounts': clients, 'provider_by_id': provider_by_id,
                'lumen_handler_results': handler_results,
                'handler_results_available': handler_results_available,
                'handler_results_by_key': handler_results_by_key,
                'evidence_by_id': evidence_by_id, 'profiles_by_id': profiles_by_id,
                'entitlement_evidence': [item for item in entitlements_by_id.values()],
                'entitlement_by_id': entitlements_by_id, 'live_source': live_source,
                'clients_by_id': clients_by_id, 'scope_ids': scope_ids,
                'source_refresh_reused': source_refresh_reused,
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
        normal_processing_seconds = self._live_duration(LIVE_NEW_RIGHT_GRACE_SECONDS)
        open_incident_users = self._live_open_incident_accounts(incident.get('id'))
        trigger_failure = None
        if incident.get('trigger_event_id'):
            db = _conn(self.db_path)
            try:
                row = db.execute('SELECT event_json FROM collector_events WHERE event_id=?',
                                 (incident['trigger_event_id'],)).fetchone()
                event = None if row is None else json.loads(row['event_json'])
                if (event and event.get('schema_version') == 2
                        and event.get('kind') == 'handler_completed'
                        and event.get('details',{}).get('outcome') == 'failed'):
                    trigger_failure = {'user_id': event.get('app_user_id'),
                        'transaction_id': event.get('details',{}).get('transaction_id'),
                        'source_fingerprint': event.get('details',{}).get('source_hash')}
            finally:
                db.close()
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
            source_scope_ok = self._live_profile_scope_matches(profile,user_id)
            handler_result = observations.get('handler_results_by_key',{}).get((
                user_id,(entitlement or {}).get('transaction_id'),
                (profile or {}).get('source_fingerprint')))
            status, reason, eligible = 'inconclusive', 'source_unavailable', False
            active = source_fresh = projection_matches = False
            incident_window = False
            if profile and profile.get('observed_at'):
                try:
                    observed_at = parse_time(profile['observed_at'])
                    age = (now-observed_at).total_seconds()
                    source_fresh = 0 <= age <= min(domain.FRESHNESS_TTL, 300)
                    incident_window = (parse_time(incident['window_start']) <= observed_at
                                       < parse_time(incident['window_end']))
                except RecoveryError:
                    pass
            if not observations['complete']:
                reason = 'coverage_incomplete'
            elif not identity_ok:
                reason = 'identity_unknown'
            elif not source_scope_ok:
                reason = 'source_scope_mismatch'
            elif not source_fresh:
                reason = 'adapty_profile_stale'
            elif profile.get('status') != 'active' or not entitlement:
                source_reason = profile.get('reason', 'premium_entitlement_inactive')
                if profile.get('status') == 'inactive' and source_reason in (
                        'premium_entitlement_absent','subscription_not_started',
                        'subscription_expired'):
                    status, reason = 'legitimate_denial', source_reason
                else:
                    reason = source_reason
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
                elif not entitlement.get('transaction_id'):
                    reason = 'transaction_link_missing'
                elif client is None:
                    reason = 'client_access_not_observed'
                elif not client.get('policy_enabled') or gate.get('reason') == 'policy_restricted':
                    status, reason = 'policy_denial', 'policy_restricted'
                elif user_id in open_incident_users:
                    status, reason = 'potential', 'owned_by_open_incident'
                else:
                    projection_matches = bool(client.get('access_active')
                        and client.get('access_expires_at') == entitlement.get('expires_at')
                        and client.get('entitlement_hash') == entitlement.get('entitlement_hash'))
                    normal_processing = self._live_within_processing_allowance(
                        user_id, profile, entitlement, now, normal_processing_seconds)
                    explicit_failure = bool(trigger_failure
                        and trigger_failure['user_id'] == user_id
                        and trigger_failure['transaction_id'] == entitlement.get('transaction_id')
                        and trigger_failure['source_fingerprint'] == profile.get('source_fingerprint'))
                    explicit_failure = explicit_failure or bool(handler_result
                        and handler_result.get('outcome') == 'failed')
                    if not projection_matches:
                        if normal_processing and not explicit_failure:
                            status, reason = 'potential', 'normal_processing_window'
                        else:
                            status, reason, eligible = 'confirmed', 'projection_mismatch', True
                    elif gate.get('allowed') is None:
                        reason = 'gate_unobserved'
                    elif gate.get('allowed') is True:
                        status, reason = 'healthy', 'source_period_and_gate_match'
                    elif (gate.get('reason') in
                            ('cache_stale', 'subscription_inactive', 'subscription_expired')):
                        if normal_processing and not explicit_failure:
                            status, reason = 'potential', 'normal_processing_window'
                        else:
                            status, reason, eligible = 'confirmed', 'gate_denied_despite_matching_projection', True
                    else:
                        status, reason = 'potential', 'gate_denial_not_explained_by_projection'
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
                'provider_customer_id': (client or {}).get('provider_customer_id'),
                'policy_revision': (client or {}).get('policy_revision'),
                'projection_revision': (client or {}).get('projection_revision'),
                'cache_revision': (client or {}).get('cache_revision'),
                'adapty_revision': (profile or {}).get('source_revision'),
                'catalog_mapped': None,
                'source_transaction_id': (entitlement or {}).get('transaction_id'),
                'processing_outcome': None if handler_result is None else handler_result.get('outcome'),
                'processing_id': None if handler_result is None else handler_result.get('processing_id'),
                'original_transaction_id': (entitlement or {}).get('original_transaction_id'),
                'store': (entitlement or {}).get('store'),
                'source_environment': (entitlement or {}).get('source_environment'),
                'access_level': (entitlement or {}).get('access_level_id'),
                'projection_matches_source_period': projection_matches,
                'incident_window_match': incident_window,
                'causal_hypothesis': ({'component': reason, 'certainty': 'observed_mismatch'}
                    if status == 'confirmed' else None),
                'entitlement_evidence': entitlement})
        return rows

    def _live_within_processing_allowance(self, user_id, profile, entitlement, now, allowance):
        key = {'app': recovery_live.APP_ID,
            'source_environment': entitlement.get('source_environment') or
                self.live_config.get('source_environment', ''),
            'store': entitlement.get('store') or '',
            'transaction_id': entitlement.get('transaction_id') or '',
            'customer_id': user_id,
            'access_level': entitlement.get('access_level_id') or 'premium'}
        source_version = digest({'starts_at':entitlement.get('starts_at'),
            'expires_at':entitlement.get('expires_at'),
            'fingerprint':profile.get('source_fingerprint'),
            'status':profile.get('status'),'reason':profile.get('reason')})
        expectation_id = digest({'key':key,'source_version':source_version})
        db = _conn(self.db_path)
        try:
            row = db.execute('SELECT first_observed_at,status FROM fulfillment_expectations '
                'WHERE expectation_id=?', (expectation_id,)).fetchone()
            if row and row['status'] == 'verified_application':
                return False
            if row and db.execute('SELECT 1 FROM fulfillment_activity WHERE kind=? '
                    'AND expectation_id=? LIMIT 1',
                    ('verified_application',expectation_id)).fetchone():
                return False
            receipt = db.execute('SELECT e.event_json FROM fulfillment_receipts r '
                'JOIN collector_events e ON e.event_id=r.event_id WHERE r.user_id=? '
                'AND r.transaction_id=? AND r.source_fingerprint=?',
                (user_id,entitlement.get('transaction_id'),profile.get('source_fingerprint'))).fetchall()
            for receipt_row in receipt:
                event = json.loads(receipt_row['event_json'])
                if (event.get('kind') == 'handler_completed'
                        and event.get('details',{}).get('outcome') == 'completed'):
                    return False
            first_seen = parse_time(row['first_observed_at']) if row else None
        finally:
            db.close()
        if first_seen is None:
            try:
                first_seen = parse_time(profile['observed_at'])
            except (KeyError, RecoveryError, TypeError):
                return False
        age = (now-first_seen).total_seconds()
        return 0 <= age < allowance

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
            db = _conn(self.db_path)
            try:
                trigger = db.execute('SELECT event_json FROM collector_events WHERE event_id=?',
                                     (incident.get('trigger_event_id'),)).fetchone()
                event = None if trigger is None else json.loads(trigger['event_json'])
            finally:
                db.close()
            if (event and event.get('schema_version') == 2
                    and event.get('kind') == 'handler_completed'
                    and event.get('details',{}).get('outcome') == 'failed'):
                fresh_live_ids = [incident['trigger_user_id']]
            elif (not event and str(incident.get('trigger_event_id') or '').startswith('fulfillment:')
                    and self._has_fresh_complete_source_pass()):
                fresh_live_ids = None
            else:
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
        if not history and not observations.get('lumen_handler_results'):
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
                                 'handler_results_readback':len(observations.get('lumen_handler_results',[])),
                                 'handler_results_available':observations.get('handler_results_available',True),
                                 'source_profile_cache_reused':observations.get('source_refresh_reused',False),
                                 'scope_accounts': len(observations['scope_ids']),
                                 'orphan_provider_records': observations['orphan_provider_records'],
                                 'source_history': observations.get('source_history_summary'),
                                 'customer_event_users_observed': len(event_users),
                                 'customer_event_users_missing': len(missing_event_users),
                                 'future_window_remaining_seconds': future_seconds,
                                 'inconclusive_accounts': inconclusive_accounts}}
        db = _conn(self.db_path)
        automatic_job = None
        try:
            db.execute('BEGIN IMMEDIATE')
            if snapshot['manifest'].get('scenario') == 'live_adapty':
                claims = []
                for account in accounts:
                    if account.get('status') != 'confirmed':
                        continue
                    row = db.execute('SELECT * FROM fulfillment_expectations WHERE source_fingerprint=? '
                        "AND json_extract(key_json,'$.customer_id')=? "
                        "AND json_extract(key_json,'$.transaction_id')=?",
                        (account.get('evidence_hash'),account['id'],account.get('source_transaction_id'))).fetchone()
                    if row:
                        decision = (None if not row['incident_id'] else db.execute(
                            'SELECT status FROM automatic_recovery WHERE incident_id=? '
                            'ORDER BY attempt DESC LIMIT 1',(row['incident_id'],)).fetchone())
                        opened = row['episode_open'] and not (decision and decision['status']=='completed')
                        if opened and row['incident_id'] and row['incident_id'] != incident_id:
                            account.update(status='potential',reason='owned_by_open_incident',eligible=False)
                            continue
                        claims.append((row,row['episode_no'] if opened else row['episode_no']+1))
                self._bind_fulfillment_claims(db,incident_id,claims)
            snapshot['snapshot_hash'] = digest(snapshot)
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
            if snapshot['manifest'].get('scenario') == 'live_adapty':
                self._record_fulfillment_snapshot_traces(db,incident_id,snapshot,observations)
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

    def _record_fulfillment_snapshot_traces(self, db, incident_id, snapshot, observations):
        event_row = db.execute('SELECT e.event_json FROM collector_events e JOIN incidents i '
            'ON i.trigger_event_id=e.event_id WHERE i.id=?',(incident_id,)).fetchone()
        trigger = None if event_row is None else json.loads(event_row['event_json'])
        for account in snapshot['accounts']:
            if account['status'] not in ('confirmed','healthy'):
                continue
            user_id = account['id']
            row = db.execute('SELECT * FROM fulfillment_expectations WHERE incident_id=? '
                "AND source_fingerprint=? AND json_extract(key_json,'$.customer_id')=? "
                "AND json_extract(key_json,'$.transaction_id')=?",
                (incident_id,account.get('evidence_hash'),user_id,
                 account.get('source_transaction_id'))).fetchone()
            if row is None:
                continue
            processing = observations.get('handler_results_by_key',{}).get((
                user_id,account.get('source_transaction_id'),account.get('evidence_hash'))) or {}
            processing_id = processing.get('processing_id')
            processing_trace_id = (processing.get('result') or {}).get('trace_id')
            processing_outcome = processing.get('outcome')
            details = (trigger or {}).get('details') or {}
            if (trigger and trigger.get('kind') == 'handler_completed'
                    and trigger.get('app_user_id') == user_id
                    and details.get('transaction_id') == account.get('source_transaction_id')
                    and details.get('source_hash') == account.get('evidence_hash')):
                processing_id,processing_trace_id,processing_outcome = (
                    details.get('processing_id'),details.get('trace_id'),details.get('outcome'))
            projection_matches = account.get('projection_matches_source_period') is True
            allowed = (account.get('gate') or {}).get('allowed')
            trace_id = 'snapshot-trace:'+digest({'snapshot':snapshot['id'],'user':user_id})
            status = 'discrepancy' if account['status']=='confirmed' else 'verified_application'
            at = self.wall_now_precise()
            trace = {'trace_id':trace_id,'snapshot_id':snapshot['id'],
                'expectation_id':row['expectation_id'],'incident_id':incident_id,
                'user_id':user_id,'key':json.loads(row['key_json']),'version':row['version'],
                'episode_no':row['episode_no'],'transaction_id':account.get('source_transaction_id'),
                'source_fingerprint':account.get('evidence_hash'),'status':status,
                'revisions': {name:account.get(name+'_revision')
                    for name in ('identity','policy','projection','cache')},
                'reason':account['reason'],'telemetry_gap':bool(row['telemetry_gap']),
                'source_period':{'starts_at':row['period_start'],'expires_at':row['period_end']},
                'next_step':('No write; source period and Lumen gate already match'
                    if status=='verified_application' else
                    'Reconcile the existing source transaction to the Lumen projection'),
                'created_at':at,'steps':[
                    {'name':'fresh_source_read','status':'completed','owner':'source','result':'verified'},
                    {'name':'identity_check','status':'completed','owner':'engine','result':'verified'},
                    {'name':'policy_check','status':'completed','owner':'lumen','result':'verified'},
                    {'name':'projection_readback','status':'completed' if projection_matches else 'failed',
                     'owner':'lumen','result':'matched' if projection_matches else 'mismatched'},
                    {'name':'gate_readback','status':'completed' if allowed is True else 'failed' if allowed is False else 'unknown',
                     'owner':'lumen','result':'allowed' if allowed is True else 'denied' if allowed is False else 'unknown'}]}
            if processing_id:
                trace.update(processing_id=processing_id,processing_trace_id=processing_trace_id,
                    processing_outcome=processing_outcome)
            db.execute('INSERT OR IGNORE INTO fulfillment_traces VALUES(?,?,?,?,?,?)',
                (trace_id,row['expectation_id'],incident_id,user_id,_json(trace),at))

    def _has_fresh_complete_source_pass(self):
        try:
            source=internal_request(self.key,self.provider_url,'GET','/internal/live/status')
            last=source.get('last_source_pass') or {}
            age=(datetime.now(timezone.utc)-parse_time(last['completed_at'])).total_seconds()
            return bool(source.get('source_cooldown_seconds',0) == 0
                and last.get('requested') == source.get('account_count')
                and last.get('observed') == source.get('account_count')
                and not last.get('waiting_reason') and 0 <= age <= 300
                and source.get('observed_count') == source.get('account_count'))
        except (InternalHTTPError,KeyError,RecoveryError,TypeError):
            return False

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
        except Exception as exc:
            failure_code = ('simulation_failed:'+type(exc).__name__
                if kind == 'simulation' else 'job_failed')
            self._set_job(job_id, 'failed', error=failure_code)
            if kind == 'automatic_recovery':
                self._finish_automatic_decision(payload['decision_id'], 'unresolved',
                                                {'reason': 'job_failed'})
            elif kind == 'simulation':
                self._finish_simulation(payload['simulation_id'], 'failed', failure_code)
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

    @staticmethod
    def _bind_fulfillment_claims(db, owner, claims):
        for row,episode in claims:
            if (row['episode_open'] and row['episode_no'] == episode
                    and row['incident_id'] and row['incident_id'] != owner):
                continue
            db.execute('UPDATE fulfillment_expectations SET incident_id=?,episode_no=?,episode_open=1 '
                'WHERE expectation_id=?',(owner,episode,row['expectation_id']))
            db.execute('UPDATE fulfillment_activity SET incident_id=? WHERE expectation_id=? '
                'AND incident_id IS NULL',(owner,row['expectation_id']))
            db.execute('UPDATE fulfillment_traces SET incident_id=? WHERE expectation_id=? '
                'AND incident_id IS NULL',(owner,row['expectation_id']))

    def _start_incident(self, user_id, occurred_at=None, window_start=None, window_end=None,
                        trigger_event_id=None, cohort_signature=None, fulfillment_claims=None):
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
            claims = []
            if manifest.get('scenario') == 'live_adapty':
                if fulfillment_claims is not None:
                    claimed_owners = []
                    for claim in fulfillment_claims:
                        row = db.execute('SELECT * FROM fulfillment_expectations WHERE expectation_id=?',
                            (claim['expectation_id'],)).fetchone()
                        if row and row['episode_open'] and row['episode_no'] == claim['episode_no']:
                            if row['incident_id']:
                                owner = db.execute('SELECT incident_json FROM incidents WHERE id=?',
                                    (row['incident_id'],)).fetchone()
                                if owner:
                                    claimed_owners.append(row['incident_id'])
                                pending_scan = db.execute("SELECT 1 FROM jobs WHERE kind IN ('incident','scan') "
                                    "AND status IN ('queued','running') AND payload=? LIMIT 1",
                                    (_json({'incident_id':row['incident_id']}),)).fetchone()
                                if (not owner or json.loads(owner['incident_json']).get('first_snapshot_id')
                                        or not pending_scan):
                                    continue
                            claims.append((row,row['episode_no']))
                    if not claims:
                        db.execute('COMMIT')
                        return (claimed_owners[0] if claimed_owners else None), None
                elif trigger_event_id:
                    event_row = db.execute('SELECT event_json FROM collector_events WHERE event_id=?',
                        (trigger_event_id,)).fetchone()
                    event = None if event_row is None else json.loads(event_row['event_json'])
                    if event:
                        details = event.get('details') or {}
                        rows = db.execute('SELECT * FROM fulfillment_expectations '
                            "WHERE json_extract(key_json,'$.customer_id')=? "
                            'ORDER BY first_observed_at DESC,version DESC', (user_id,)).fetchall()
                        for row in rows:
                            key = json.loads(row['key_json'])
                            if event.get('kind') == 'handler_completed' and (
                                    key.get('transaction_id') != details.get('transaction_id')
                                    or row['source_fingerprint'] != details.get('source_hash')):
                                continue
                            decision = (None if not row['incident_id'] else db.execute(
                                'SELECT status FROM automatic_recovery WHERE incident_id=? '
                                'ORDER BY attempt DESC LIMIT 1',(row['incident_id'],)).fetchone())
                            opened = row['episode_open'] and not (decision and decision['status']=='completed')
                            claims.append((row,row['episode_no'] if opened else row['episode_no']+1))
                            break
                for row,episode in claims:
                    if row['episode_open'] and row['episode_no'] == episode and row['incident_id']:
                        owned = db.execute('SELECT id,incident_json FROM incidents WHERE id=?',
                            (row['incident_id'],)).fetchone()
                        if owned:
                            existing = owned
                            break

            if existing is None and (not trigger_event_id or cohort_signature):
                for candidate in db.execute('SELECT id,incident_json FROM incidents ORDER BY rowid DESC'):
                    saved = json.loads(candidate['incident_json'])
                    saved_signature = saved.get('cohort_signature') or {}
                    signature_matches = (not cohort_signature and not saved_signature) or bool(
                        cohort_signature and saved_signature
                        and saved_signature.get('handler_version') == cohort_signature.get('handler_version')
                        and saved_signature.get('config_version') == cohort_signature.get('config_version'))
                    same_exact_incident = (not trigger_event_id
                        and saved['trigger_user_id'] == user_id
                        and saved['window_start'] == iso(start)
                        and saved['window_end'] == iso(end))
                    same_live_cohort = bool(cohort_signature and signature_matches
                        and saved['run_id'] == manifest['run_id']
                        and parse_time(saved['window_start']) <= at
                        < parse_time(saved['window_end']))
                    if not (same_exact_incident or same_live_cohort):
                        continue
                    if same_live_cohort:
                        closed = db.execute('SELECT status,updated_at,execution_job_id FROM automatic_recovery '
                            'WHERE incident_id=? ORDER BY attempt DESC LIMIT 1',
                            (candidate['id'],)).fetchone()
                        if closed and closed['status'] in ('completed','unresolved'):
                            continue
                        incident_job = db.execute('SELECT 1 FROM jobs WHERE kind IN '
                            "('incident','scan','automatic_recovery') AND payload LIKE ? "
                            "AND status IN ('queued','running') LIMIT 1",
                            ('%'+candidate['id']+'%',)).fetchone()
                        execution_job = (None if not closed or not closed['execution_job_id'] else
                            db.execute("SELECT 1 FROM jobs WHERE id=? AND status IN ('queued','running')",
                                (closed['execution_job_id'],)).fetchone())
                        decision_active = bool(closed and closed['status'] in (
                            'queued','awaiting_execution','retry_scheduled'))
                        if not incident_job and not execution_job and not decision_active:
                            continue
                    if saved['run_id'] == manifest['run_id']:
                        existing = candidate
                        break
            if trigger_event_id:
                existing = db.execute('SELECT id,incident_json FROM incidents WHERE trigger_event_id=?', (trigger_event_id,)).fetchone() or existing
            if existing:
                incident = json.loads(existing['incident_json'])
                self._bind_fulfillment_claims(db,incident['id'],claims)
                job = db.execute('SELECT id FROM jobs WHERE payload LIKE ? ORDER BY created_at DESC LIMIT 1',
                                 ('%'+incident['id']+'%',)).fetchone()
                db.execute('COMMIT')
                return incident['id'], job['id'] if job else None
            job_id, now = 'job-'+uuid4().hex, self.wall_now()
            db.execute('INSERT INTO incidents VALUES(?,?,?,?)',
                       (incident_id, trigger_event_id, _json(incident), now))
            db.execute('INSERT INTO jobs(id,kind,status,payload,created_at,updated_at) VALUES(?,?,?,?,?,?)',
                       (job_id, 'incident', 'queued', _json({'incident_id': incident_id}), now, now))
            self._bind_fulfillment_claims(db,incident_id,claims)
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
                'provider_customer_id': account['provider_customer_id'],
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
            # Plans persisted before the V2 identity/policy CAS cannot safely
            # issue a new request. A started operation may only be read back
            # using its immutable operation key; a fresh plan is required for
            # any request whose original intent was never durably recorded.
            legacy_entries = [entry for entry in plan.get('entries', [])
                if entry.get('type') == 'resync_access'
                and 'provider_customer_id' not in entry.get('preconditions', {})]
            if legacy_entries:
                existing = self._action_rows(plan['id'])
                if any(not existing.get(entry['id']) or not existing[entry['id']].get('started_at')
                       for entry in legacy_entries):
                    raise RecoveryError('Legacy live plan requires a new preview before resync', 409)
                return {'legacy_readback_only': True}
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
            result = internal_request(self.key, base, 'POST', endpoint, body,
                timeout=65 if self.live_config and owner == 'lumen' else 5)
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
                                  '/internal/adapty/profile?'+urlencode({'user': user_id}),
                                  timeout=60 if self.live_config else 5)
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
                if 'provider_customer_id' not in entry.get('preconditions', {}):
                    result, status = self._operation_result(entry, plan_id, 'lumen',
                        '/internal/lumen/resync', {}, allow_new=False)
                    self._save_action(entry, plan_id, status, result=result,
                        evidence_ref='adapty://entitlement/'+entry['account_id'])
                    outcomes[entry['id']] = status
                    continue
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
                    'schema_version': 2,
                    'expected_provider_customer_id': preconditions['provider_customer_id'],
                    'expected_identity_revision': preconditions['identity_revision'],
                    'expected_policy_revision': preconditions['policy_revision'],
                    'expected_projection_revision': preconditions['projection_revision'],
                    'processing_id': 'processing-'+entry['id'],
                    'trace_id': 'trace-'+entry['id'],
                    'entitlement': {'product_id': entitlement['product_id'],
                        'expires_at': entitlement['expires_at'],
                        'entitlement_hash': entitlement['entitlement_hash'],
                        'transaction_id': entitlement['transaction_id'],
                        'source_fingerprint': entitlement['source_fingerprint'],
                        **{key: entitlement[key] for key in
                            ('original_transaction_id', 'store', 'source_environment')
                            if entitlement.get(key)}},
                    'operation_key': entry['id']}
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
        provenance = manifest.get('provenance',recovery_live.PROVENANCE)
        payment_verification = manifest.get('payment_verification',
            recovery_live.PAYMENT_VERIFICATION)
        mode = ('LOCAL_ADAPTY_FIXTURE' if provenance == 'synthetic_test_fixture'
                else 'LIVE_ADAPTY_SEEDED')
        return {'mode': mode,
            'manifest': {**manifest, 'logical_now': self.wall_now(), 'wall_now': self.wall_now(),
                         'time_basis': 'wall_clock_for_adapty_entitlements_and_lumen_access'},
            'payment_verification': payment_verification,
            'provenance': provenance,
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
                'root_cause_status': 'fulfillment_mismatch_observed' if confirmed else 'not_assessed',
                'root_cause_certainty': 'shared_cause_not_established' if confirmed else 'not_assessed',
                'latest_plan_id': plans[-1]['id'] if plans else None},
            'accounts': accounts, 'coverage': coverage, 'actions': actions,
            'fault_status': fault,
            'plans': [{'id': plan['id'], 'plan_hash': plan['plan_hash'],
                'incident_id': plan['incident_id'], 'snapshot_id': plan['snapshot_id'],
                'status': plan['status'], 'target_count': plan['target_count'],
                'created_at': plan['created_at'], 'expires_at': plan['expires_at']}
                for plan in plans], 'jobs': jobs}

    def _live_entitlement_current(self, profile, entitlement, user_id, now):
        if not profile or not entitlement or profile.get('status') != 'active' or not profile.get('identity_match'):
            return False
        try:
            age = (now-parse_time(profile['observed_at'])).total_seconds()
            return bool(0 <= age <= domain.FRESHNESS_TTL
                and entitlement.get('user_id') == user_id
                and entitlement.get('provider_customer_id') == user_id
                and entitlement.get('app_id') == recovery_live.APP_ID
                and self._live_profile_scope_matches(profile,user_id)
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
                refreshed = recovery_live.refresh_profiles(self.db_path, self.live_config,
                    self.live_reader, [user_id], include_profiles=True)
                if refreshed.get('observed') != 1:
                    raise RecoveryError('Fresh Adapty profile read is in source cooldown', 503)
                return refreshed['items'][0]
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
        if self.live_config and path == '/internal/lumen/handler/result':
            processing_id = _one(query, 'processing_id')
            if not processing_id:
                raise RecoveryError('processing_id query is required')
            result = domain.lumen_handler_result(self.db_path, processing_id)
            if result is not None:
                return result
            result = domain.lumen_find_processing_result(self.db_path, processing_id)
            return {'processing_id': processing_id, 'outcome': 'committed_readback',
                    'result': result} if result is not None else {'processing_id':processing_id,'outcome':'unknown'}
        if self.live_config and path == '/internal/lumen/handler/results':
            try:
                return domain.lumen_handler_results(self.db_path,
                    _one(query,'cursor'),self._limit(query))
            except ValueError as exc:
                raise RecoveryError(str(exc)) from exc
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
            legacy_fields = {'user_id','expected_revision','entitlement','operation_key'}
            v2_fields = {'schema_version','user_id','expected_provider_customer_id',
                'expected_identity_revision','expected_policy_revision',
                'expected_projection_revision','entitlement','operation_key',
                'processing_id','trace_id'}
            version = body.get('schema_version', 1) if isinstance(body, dict) else None
            if (version == 1 and set(body) != legacy_fields
                    or version == 2 and (type(version) is not int or set(body) != v2_fields)
                    or version not in (1, 2)):
                raise RecoveryError('Resync fields do not match the contract')
            if self.live_config and version != 2:
                raise RecoveryError('Live resync requires contract version 2', 409)
            prior = domain.lumen_action(self.db_path, body['operation_key'])
            if prior and not self.live_config:
                return domain.lumen_resync(self.db_path, body)
            fault_mode = None
            if self.live_config and self.live_bootstrap_pending and not prior:
                fault_mode = domain.lumen_simulation_take_fault(self.db_path, body['user_id'])
                if fault_mode in ('handler_precommit','db_precommit','permanent_handler'):
                    raise RecoveryError('Lumen handler could not commit the projection', 503)
                if fault_mode == 'cache_refresh_skipped':
                    db = _conn(self.db_path)
                    try:
                        db.execute('UPDATE access SET stale_once=1 WHERE user_id=?', (body['user_id'],))
                    finally:
                        db.close()
            try:
                profile = self._profile(body['user_id'])
            except Exception as exc:
                raise SourceReadUnavailable() from exc
            if self.live_config:
                self._emit_source_observations([profile])
            expected = body['entitlement']
            source = (profile or {}).get('entitlement') or {}
            if self.live_config:
                supported_stores = ('app_store','play_store')
                expected_environment = self.live_config.get('source_environment')
                if (not profile or profile.get('app_id') != recovery_live.APP_ID
                        or profile.get('user_id') != body['user_id']
                        or source.get('app_id') != recovery_live.APP_ID
                        or source.get('user_id') != body['user_id']
                        or source.get('provider_customer_id') != body.get('expected_provider_customer_id')
                        or source.get('source_environment') != expected_environment
                        or source.get('store') not in supported_stores):
                    raise RecoveryError('Fresh Adapty source scope mismatch',409)
                if (expected.get('source_environment') != expected_environment
                        or expected.get('store') not in supported_stores):
                    raise RecoveryError('Requested entitlement outside source scope',409)
            if (not profile or profile.get('status') != 'active'
                    or (source if self.live_config else profile).get('product_id') != expected.get('product_id')
                    or (source if self.live_config else profile).get('expires_at') != expected.get('expires_at')
                    or (source if self.live_config else profile).get('transaction_id') != expected.get('transaction_id')
                    or (source if self.live_config else profile).get('entitlement_hash') != expected.get('entitlement_hash')
                    or self.live_config and (not profile.get('identity_match')
                        or profile.get('provider_customer_id') != body.get('expected_provider_customer_id')
                        or source.get('original_transaction_id') != expected.get('original_transaction_id')
                        or source.get('store') != expected.get('store')
                        or source.get('source_environment') != expected.get('source_environment')
                        or profile.get('source_fingerprint') != expected.get('source_fingerprint'))):
                raise RecoveryError('Fresh Adapty profile does not match requested entitlement', 409)
            if fault_mode == 'delayed_older_update':
                time.sleep(0.1)
                try:
                    latest = self._profile(body['user_id'])
                except Exception as exc:
                    raise SourceReadUnavailable() from exc
                if latest.get('source_fingerprint') != profile.get('source_fingerprint'):
                    raise RecoveryError('Delayed source update is no longer current', 409)
            result = domain.lumen_resync(self.db_path, body)
            if self.live_config:
                self._emit_projection_change(body['user_id'], result, body['operation_key'],
                    occurred_at=result.get('processed_at'))
                if fault_mode == 'timeout_after_commit':
                    return result, True
            return result
        if self.live_config and path in ('/internal/lumen/source-observed',
                '/internal/lumen/handler/deliver'):
            handler_delivery = path.endswith('/handler/deliver')
            if handler_delivery and (not self.demo or not self.live_bootstrap_pending):
                raise RecoveryError('Normal handler simulation is unavailable', 404)
            if not isinstance(body, dict) or set(body) != {'items'} or not isinstance(body['items'], list):
                raise RecoveryError('Source observation fields do not match the contract')
            profiles = []
            for item in body['items']:
                optional = {'transaction_id','original_transaction_id','store',
                    'source_environment','access_level','product_id','entitlement_hash',
                    'processing_id'}
                required = {'user_id','source_fingerprint','observed_at','starts_at','expires_at',
                    'reason','status','identity_match','provider_customer_id'}
                if (not isinstance(item, dict) or not required <= set(item)
                        or set(item)-required-optional
                        or item['user_id'] not in self.live_config['customer_user_ids']
                        or item['status'] not in ('active','inactive','unknown')
                        or type(item['identity_match']) is not bool
                        or not isinstance(item['provider_customer_id'],str)
                        or handler_delivery and (not isinstance(item.get('processing_id'),str)
                            or not item['processing_id'])):
                    raise RecoveryError('Source observation fields do not match the contract')
                entitlement = {'starts_at': item['starts_at'], 'expires_at': item['expires_at'],
                    'source_fingerprint': item['source_fingerprint']}
                for key in ('transaction_id','original_transaction_id','store',
                            'source_environment','product_id','entitlement_hash'):
                    if key in item:
                        entitlement[key] = item[key]
                if 'access_level' in item:
                    entitlement['access_level_id'] = item['access_level']
                profiles.append({'user_id': item['user_id'],
                    'source_fingerprint': item['source_fingerprint'],
                    'observed_at': item['observed_at'], 'reason': item['reason'],
                    'provider_customer_id': item['provider_customer_id'],
                    'status': item['status'], 'identity_match': item['identity_match'],
                    'entitlement': entitlement,
                    **({'processing_id':item['processing_id']} if 'processing_id' in item else {})})
            source_events = self._emit_source_observations(profiles)
            if not handler_delivery:
                return {'accepted':len(profiles),'telemetry_emitted':len(source_events),
                    'handled':0,'failed':0,'writes':0}
            db = _conn(self.db_path)
            try:
                paused = bool(_meta(db, 'live_handler_paused', False))
            finally:
                db.close()
            handled = failed = diagnostics = 0
            failure_classes = {}
            if not paused:
                for profile in profiles:
                    source_event = source_events.get(profile['user_id'])
                    result = self._handle_live_source_observation(profile, source_event,
                        profile.get('processing_id'))
                    if result.get('outcome') == 'completed':
                        handled += 1
                    elif result.get('outcome') == 'failed':
                        failed += 1
                        category = result.get('error_class') or result.get('reason') or 'other'
                        if category not in ('recovery_http_400','recovery_http_404',
                                'recovery_http_409','recovery_http_429','recovery_http_503',
                                'recovery_http_504','internal_http_400','internal_http_404',
                                'internal_http_409','internal_http_429','internal_http_503',
                                'internal_http_504','ValueError','TypeError','KeyError',
                                'TimeoutError','OperationalError',
                                'handler_failure','cache_refresh_skipped','identity_unknown'):
                            category = 'other'
                        failure_classes[category] = failure_classes.get(category,0)+1
                    else:
                        diagnostics += 1
            return {'accepted': len(profiles), 'handled': handled,
                    'failed': failed, 'diagnostic_only': diagnostics,
                    'failure_classes': failure_classes, 'paused': paused}
        if self.live_config and path == '/internal/lumen/simulation/configure':
            if not self.demo or not self.live_bootstrap_pending:
                raise RecoveryError('Live simulation configuration is unavailable', 404)
            if (not isinstance(body,dict) or set(body) not in (
                    {'faults','paused'}, {'faults','paused','prepare_projection_loss'})
                    or type(body['paused']) is not bool):
                raise RecoveryError('Live simulation configuration fields do not match')
            try:
                return domain.lumen_simulation_configure(self.db_path, body['faults'],
                    paused=body['paused'],
                    prepare_projection_loss=body.get('prepare_projection_loss'))
            except ValueError as exc:
                raise RecoveryError(str(exc)) from exc
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
                'revisions': {name:result[name+'_revision']
                    for name in ('identity','policy','projection','cache')},
            })
        except Exception:
            # Telemetry is best effort; gate decisions must remain available.
            return None

    def _emit_projection_change(self, user_id, result, action_id, *, occurred_at=None,
                                handler_version=None, config_version=None):
        if not self.sdk or not result or not result.get('before') or not result.get('after'):
            return None
        try:
            before = {key:value for key,value in result['before'].items()
                      if key != 'source_hash' or value is not None}
            details = {
                    'action_id': action_id, 'source_hash': result.get('source_hash') or 'unknown',
                    'expected_revision': result['before']['projection_revision'],
                    'policy_version': result.get('policy_version', 'premium-policy-v1'),
                    'adapter_version': result.get('adapter_version', 'adapty-profile-read-v1'),
                    'projection_version': handler_version or result.get('projection_version', 'lumen-projection-v2'),
                    'cache_version': config_version or result.get('config_version', 'lumen-cache-v2'),
                    'outcome': 'projection_updated', 'before': before,
                    'after': result['after'], 'cache_invalidated': bool(result['after'].get('invalidated'))}
            if result.get('schema_version') == 2:
                details.update(processing_id=result['processing_id'], trace_id=result['trace_id'],
                    transaction_id=result['transaction_id'], steps=result['steps'],
                    revisions=result['revisions'])
                return self.sdk.emit('access_projection_changed', user_id,
                    occurred_at or self.wall_now(), details, schema_version=2,
                    event_id='processing:'+result['processing_id'],
                    correlation_id=result['trace_id'], source_event_id=action_id)
            return self.sdk.emit('access_projection_changed', user_id,
                occurred_at or self.wall_now(), details)
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
        provenance=source.get('provenance') or self._manifest().get('provenance')
        payment_verification=self._manifest().get('payment_verification',
            recovery_live.PAYMENT_VERIFICATION)
        mode=('LOCAL_ADAPTY_FIXTURE' if provenance == 'synthetic_test_fixture'
            else 'LIVE_ADAPTY_SEEDED')
        return {'mode': mode, 'scenario': 'live_adapty', 'ready': ready,
            'readiness': readiness, 'app_id': self._manifest()['app'],
            'app_title': self._manifest().get('app_title'),
            'environment': self._manifest()['environment'],
            'source_environment': self._manifest().get('source_environment'),
            'run_id': self._manifest()['run_id'], 'lumen_url': self.lumen_url,
            'account_count': source.get('account_count', 0),
            'active_count': source.get('active_count', 0),
            'source_observed_at': source.get('source_observed_at'),
            'source_requests_total': source.get('source_requests_total', 0),
            'last_source_request_at': source.get('last_source_request_at'),
            'source_cooldown_seconds': source.get('source_cooldown_seconds', 0),
            'last_source_pass': source.get('last_source_pass'),
            'provenance': source.get('provenance'),
            'payment_verification': payment_verification,
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
        fulfillment = self._live_fulfillment_audit(refresh_source=False)
        status = self._live_status()
        return {'requested': result.get('requested', 0), 'observed': result.get('observed', 0),
                'active': status['active_count'], 'source_observed_at': status['source_observed_at'],
                'source_calls': result.get('source_calls', 0),
                'source_pass_id': result.get('source_pass_id'),
                'waiting_reason': result.get('waiting_reason') or fulfillment.get('waiting_reason'),
                'ready': status['ready']}

    def _live_incident(self, body):
        if body != {'action': 'inject'}:
            raise RecoveryError('Live incident fields do not match the contract')
        registry = self._pages(self.provider_url, '/internal/provider/accounts')
        user_ids = [row['user_id'] for row in registry]
        refreshed = internal_request(self.key, self.provider_url, 'POST',
            '/internal/live/refresh', {'user_ids': user_ids}, timeout=60)
        source_complete = refreshed.get('observed') == len(user_ids)
        if (not source_complete and refreshed.get('waiting_reason') == 'source_poll_interval'
                and self._has_fresh_complete_source_pass()):
            source_complete = True
        if not source_complete:
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

    def _live_simulation_control(self, body):
        if isinstance(body,dict) and body.get('action') == 'configure':
            if (set(body) != {'action','clock_scale'} or type(body['clock_scale']) is not int
                    or not 1 <= body['clock_scale'] <= 1000):
                raise RecoveryError('Simulation clock scale must be an integer from 1 to 1000')
            db = _conn(self.db_path)
            try:
                db.execute('BEGIN IMMEDIATE')
                if db.execute("SELECT 1 FROM simulations WHERE status='running' LIMIT 1").fetchone():
                    raise RecoveryError('Stop simulation generation before changing its clock', 409)
                _set_meta(db, 'demo_simulation_clock_scale', body['clock_scale'])
                _set_meta(db, 'simulation_waiting_reason', None)
                db.execute('COMMIT')
            except Exception:
                if db.in_transaction:
                    db.execute('ROLLBACK')
                raise
            finally:
                db.close()
            self._fulfillment_wake.set()
            return {'clock_scale': body['clock_scale'], 'demo_only': True}
        if body == {'action':'stop'}:
            with self._simulation_inject_lock:
                db = _conn(self.db_path)
                try:
                    db.execute('BEGIN IMMEDIATE')
                    row = db.execute("SELECT * FROM simulations WHERE status='running' "
                        'ORDER BY created_at DESC,rowid DESC LIMIT 1').fetchone()
                    if row is None:
                        db.execute('COMMIT')
                        return {'status':'idle','duplicate':False}
                    db.execute('UPDATE simulations SET stop_requested=1,updated_at=? WHERE id=?',
                               (self.wall_now(),row['id']))
                    db.execute('COMMIT')
                    return {'simulation_id':row['id'],'job_id':row['job_id'],
                        'status':'running','duplicate':False,'stop_requested':True}
                except Exception:
                    if db.in_transaction:
                        db.execute('ROLLBACK')
                    raise
                finally:
                    db.close()
        if isinstance(body,dict) and body.get('action') == 'resume':
            if set(body) != {'action','simulation_id'} or not isinstance(body['simulation_id'],str):
                raise RecoveryError('Simulation resume fields do not match')
            simulation = self._simulation_row(body['simulation_id'])
            sequence = json.loads(simulation['sequence_json'])
            if (simulation['status'] not in ('stopped','failed') or not sequence
                    or sequence[0].get('mode') not in ('bootstrap','continuous','cycle','batch')):
                raise RecoveryError('Simulation is not resumable', 409)
            job_id, now = 'job-'+uuid4().hex, self.wall_now()
            db = _conn(self.db_path)
            try:
                db.execute('BEGIN IMMEDIATE')
                if db.execute("SELECT 1 FROM simulations WHERE status='running' LIMIT 1").fetchone():
                    raise RecoveryError('A simulation is already running', 409)
                db.execute('UPDATE simulations SET status=\'running\',stop_requested=0,error=NULL,'
                    'job_id=?,updated_at=? WHERE id=?',(job_id,now,simulation['id']))
                db.execute('INSERT INTO jobs(id,kind,status,payload,created_at,updated_at) VALUES(?,?,?,?,?,?)',
                    (job_id,'simulation','queued',_json({'simulation_id':simulation['id']}),now,now))
                db.execute('COMMIT')
            except Exception:
                if db.in_transaction:
                    db.execute('ROLLBACK')
                raise
            finally:
                db.close()
            self._set_simulation_waiting(None)
            self._launch_job(job_id)
            return {'simulation_id':simulation['id'],'job_id':job_id,
                'status':'running','duplicate':False,'resumed':True}
        if (not isinstance(body,dict) or body.get('action') not in ('bootstrap','once','start','continuous')
                or set(body)-{'action','operation_key','fault_mode'}
                or not isinstance(body.get('operation_key'),str)
                or not body['operation_key'].strip() or len(body['operation_key'])>128):
            raise RecoveryError('Simulation fields do not match the contract')
        action = body['action']
        fault_mode = body.get('fault_mode','random')
        if action in ('once','start','continuous') and fault_mode not in (
                'random','handler_precommit','db_precommit','cache_refresh_skipped','delayed_older_update',
                'timeout_after_commit'):
            raise RecoveryError('Unsupported simulation handler fault')
        if action == 'bootstrap' and set(body) != {'action','operation_key'}:
            raise RecoveryError('Bootstrap accepts only an operation key')
        if action == 'once' and set(body)-{'action','operation_key','fault_mode'}:
            raise RecoveryError('Simulation fields do not match the contract')
        if action in ('start','continuous') and set(body)-{'action','operation_key','fault_mode'}:
            raise RecoveryError('Simulation fields do not match the contract')
        operation_key = body['operation_key'].strip()
        mode = ('bootstrap' if action == 'bootstrap' else 'cycle' if action == 'once'
                else 'batch' if action == 'start' else 'continuous')
        step = {'mode':mode}
        if mode != 'bootstrap':
            step['fault_mode'] = fault_mode
            step['seed'] = digest({'operation_key':operation_key})
        sequence = [step]
        total = 1 if action in ('bootstrap','once') else 3 if action == 'start' else 0
        db = _conn(self.db_path)
        try:
            previous = db.execute('SELECT id,job_id,status FROM simulations WHERE operation_key=?',
                                  (operation_key,)).fetchone()
            if previous:
                return {'simulation_id':previous['id'],'job_id':previous['job_id'],
                    'status':previous['status'],'duplicate':True}
            if db.execute("SELECT 1 FROM simulations WHERE status='running' LIMIT 1").fetchone():
                raise RecoveryError('A simulation is already running',409)
        finally:
            db.close()
        simulation_id, job_id, now = 'simulation-'+uuid4().hex, 'job-'+uuid4().hex, self.wall_now()
        db = _conn(self.db_path)
        try:
            db.execute('BEGIN IMMEDIATE')
            previous = db.execute('SELECT id,job_id,status FROM simulations WHERE operation_key=?',
                                  (operation_key,)).fetchone()
            if previous:
                db.execute('COMMIT')
                return {'simulation_id':previous['id'],'job_id':previous['job_id'],
                    'status':previous['status'],'duplicate':True}
            if db.execute("SELECT 1 FROM simulations WHERE status='running' LIMIT 1").fetchone():
                raise RecoveryError('A simulation is already running',409)
            db.execute('INSERT INTO simulations VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)',
                (simulation_id,operation_key,'running',_json(sequence),0,total,0,0,None,None,
                 job_id,now,now))
            db.execute('INSERT INTO jobs(id,kind,status,payload,created_at,updated_at) VALUES(?,?,?,?,?,?)',
                (job_id,'simulation','queued',_json({'simulation_id':simulation_id}),now,now))
            db.execute('COMMIT')
        except Exception:
            if db.in_transaction:
                db.execute('ROLLBACK')
            raise
        finally:
            db.close()
        self._set_simulation_waiting(None)
        self._launch_job(job_id)
        return {'simulation_id':simulation_id,'job_id':job_id,'status':'running',
            'duplicate':False,'mode':mode}

    def _live_open_incident_accounts(self, exclude_incident_id=None, *, include_verified=False):
        db = _conn(self.db_path)
        try:
            open_ids = set()
            for row in db.execute('SELECT incident_json FROM incidents ORDER BY created_at'):
                incident = json.loads(row['incident_json'])
                if incident['id'] == exclude_incident_id:
                    continue
                latest = db.execute('SELECT status,selected_ids,assessment_snapshot_id '
                    'FROM automatic_recovery WHERE incident_id=? ORDER BY attempt DESC LIMIT 1',
                    (incident['id'],)).fetchone()
                candidates = set()
                if incident.get('trigger_user_id'):
                    candidates.add(incident['trigger_user_id'])
                candidates.update(incident.get('confirmed_ids',[]))
                snapshots = {incident.get('snapshot_id'),incident.get('first_snapshot_id')}
                for decision in db.execute('SELECT selected_ids,assessment_snapshot_id '
                        'FROM automatic_recovery WHERE incident_id=? ORDER BY attempt',
                        (incident['id'],)):
                    candidates.update(json.loads(decision['selected_ids']))
                    snapshots.add(decision['assessment_snapshot_id'])
                for snapshot_id in snapshots-{None}:
                    snapshot = db.execute('SELECT snapshot_json FROM snapshots WHERE id=?',
                        (snapshot_id,)).fetchone()
                    if snapshot:
                        data = json.loads(snapshot['snapshot_json'])
                        candidates.update(item['id'] for item in data.get('accounts', [])
                                          if item.get('status') == 'confirmed')
                verification_status = {}
                for plan_row in db.execute('SELECT plan_json FROM plans WHERE incident_id=? '
                                           'ORDER BY created_at_wall,rowid', (incident['id'],)):
                    plan = json.loads(plan_row['plan_json'])
                    for entry in plan.get('entries', []):
                        if entry.get('type') != 'verify_gate' or not entry.get('account_id'):
                            continue
                        verification_status[entry['account_id']] = False
                        action = db.execute('SELECT status,result FROM actions WHERE id=?',
                                            (entry['id'],)).fetchone()
                        result = {} if action is None or not action['result'] else json.loads(action['result'])
                        if (action and action['status'] == 'verified'
                                and result.get('allowed') is True):
                            verification_status[entry['account_id']] = True
                verified = {user_id for user_id,allowed in verification_status.items() if allowed}
                unresolved = candidates-verified
                if not unresolved:
                    continue
                open_ids.update(candidates if include_verified else unresolved)
            return open_ids
        finally:
            db.close()

    def _live_simulation_wait_reason(self):
        try:
            source = internal_request(self.key,self.provider_url,'GET','/internal/live/status')
        except Exception:
            return 'source_status_unavailable'
        if source.get('source_cooldown_seconds',0):
            return 'source_cooldown'
        try:
            coverage = internal_request(self.key,self.lumen_url,'GET',
                '/internal/lumen/collector-coverage')
        except Exception:
            return 'collector_status_unavailable'
        if coverage.get('queued',0) >= 800:
            return 'outbox_backpressure'
        total = 0
        for path in (self.db_path,Path(str(self.db_path)+'-wal')):
            try:
                total += path.stat().st_size
            except OSError:
                continue
        if total >= 512*1024*1024:
            return 'engine_storage_limit'
        return None

    def _live_source_request_total(self):
        try:
            status=internal_request(self.key,self.provider_url,'GET','/internal/live/status')
            return int(status.get('source_requests_total',0))
        except Exception:
            return None

    def _live_simulation_candidates(self, excluded):
        observations = self._observations()
        now = datetime.now(timezone.utc)
        candidates = []
        for user_id in observations['scope_ids']:
            if user_id in excluded:
                continue
            profile = observations['profiles_by_id'].get(user_id)
            entitlement = observations['entitlement_by_id'].get(user_id)
            provider = observations['provider_by_id'].get(user_id)
            client = observations['clients_by_id'].get(user_id)
            if (self._live_entitlement_current(profile,entitlement,user_id,now)
                    and provider and provider.get('identity_status') == 'mapped'
                    and provider.get('provider_customer_id') == user_id
                    and client and client.get('identity_status') == 'mapped'
                    and client.get('provider_customer_id') == user_id
                    and client.get('policy_enabled') and client.get('gate',{}).get('allowed') is True):
                candidates.append(user_id)
        return sorted(candidates)

    def _save_simulation_intent(self, operation_key, simulation_id, cycle_no,
                                user_id, fault_mode, processing_id, status='intent',
                                result=None, incident_id=None):
        now = self.wall_now()
        db = _conn(self.db_path)
        try:
            db.execute('INSERT INTO simulation_intents(operation_key,simulation_id,cycle_no,user_id,'
                'fault_mode,processing_id,status,incident_id,result_json,created_at,updated_at) '
                'VALUES(?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(operation_key) DO UPDATE SET '
                'status=excluded.status,incident_id=COALESCE(excluded.incident_id,simulation_intents.incident_id),'
                'result_json=COALESCE(excluded.result_json,simulation_intents.result_json),updated_at=excluded.updated_at',
                (operation_key,simulation_id,cycle_no,user_id,fault_mode,processing_id,status,
                 incident_id,None if result is None else _json(result),now,now))
        finally:
            db.close()

    def _update_simulation_intent(self, operation_key, status, result=None, incident_id=None):
        db = _conn(self.db_path)
        try:
            db.execute('UPDATE simulation_intents SET status=?,incident_id=COALESCE(?,incident_id),'
                'result_json=COALESCE(?,result_json),updated_at=? WHERE operation_key=?',
                (status,incident_id,None if result is None else _json(result),self.wall_now(),operation_key))
        finally:
            db.close()

    def _live_handler_readback(self, processing_id):
        return internal_request(self.key,self.lumen_url,'GET',
            '/internal/lumen/handler/result?'+urlencode({'processing_id':processing_id}))

    def _live_handler_result(self, simulation_id, operation_key, processing_id,
                             user_id, fault_mode):
        try:
            readback = self._live_handler_readback(processing_id)
        except Exception:
            readback = {'outcome':'unknown'}
        if readback.get('outcome') == 'unknown':
            try:
                profile = self._profile(user_id)
            except Exception:
                self._set_simulation_waiting('source_unavailable')
                return None
            if profile.get('status') != 'active' or not profile.get('entitlement',{}).get('transaction_id'):
                self._update_simulation_intent(operation_key,'source_rejected',
                    {'reason':'source_right_not_eligible'})
                return {'outcome':'diagnostic_only','reason':'source_right_not_eligible'}
            intent = self._simulation_intent(operation_key)
            if intent and intent['status'] == 'intent':
                fault = [] if fault_mode == 'normal' else [{'user_id':user_id,
                    'fault_mode':fault_mode,'remaining_attempts':1,'permanent':False}]
                internal_request(self.key,self.lumen_url,'POST','/internal/lumen/simulation/configure',
                    {'faults':fault,'paused':False,
                     'prepare_projection_loss':[] if fault_mode == 'normal' else [user_id]})
                self._update_simulation_intent(operation_key,'fault_configured')
            self._update_simulation_intent(operation_key,'request_sent')
            handler_profile=profile
            if fault_mode == 'delayed_older_update':
                current=profile.get('entitlement') or {}
                old_expiry=iso(parse_time(current['expires_at'])-timedelta(seconds=60))
                old_fingerprint=digest({'previous':profile['source_fingerprint'],
                    'expires_at':old_expiry,'simulation':'delayed_older_update'})
                old_entitlement={**current,'expires_at':old_expiry,
                    'entitlement_hash':digest({'user_id':user_id,
                        'product_id':current['product_id'],'expires_at':old_expiry}),
                    'source_fingerprint':old_fingerprint}
                handler_profile={**profile,'source_fingerprint':old_fingerprint,
                    'entitlement':old_entitlement}
            try:
                self._deliver_live_source_handlers([handler_profile],{user_id:processing_id})
            except Exception:
                pass
            try:
                readback = self._live_handler_readback(processing_id)
            except Exception:
                readback = {'outcome':'unknown'}
        if readback.get('outcome') == 'committed_readback':
            result = readback.get('result') or {}
            result = {'user_id':user_id,'outcome':'completed','reason':'committed_readback',
                'processing_id':processing_id,'trace_id':result.get('trace_id'),
                'steps':result.get('steps',[]),'revisions':result.get('revisions',{})}
        elif readback.get('outcome') in ('completed','failed','diagnostic_only'):
            result = readback.get('result') or readback
        else:
            self._update_simulation_intent(operation_key,'unknown')
            return None
        state = 'handler_'+result.get('outcome','unknown')
        self._update_simulation_intent(operation_key,state,result)
        self._set_simulation_waiting(None)
        return result

    def _simulation_intent(self, operation_key):
        db = _conn(self.db_path)
        try:
            row = db.execute('SELECT * FROM simulation_intents WHERE operation_key=?',
                             (operation_key,)).fetchone()
            return None if row is None else dict(row)
        finally:
            db.close()

    def _wait_for_live_handler_incident(self, simulation_id, processing_id):
        event_id = 'handler:'+processing_id
        deadline = time.monotonic()+SIMULATION_RECOVERY_TIMEOUT
        while time.monotonic() < deadline:
            if self._simulation_row(simulation_id)['stop_requested']:
                # Stop prevents another injected episode; current recovery is still monitored.
                pass
            db = _conn(self.db_path)
            try:
                assessment = db.execute('SELECT result FROM collector_assessments WHERE event_id=?',
                                        (event_id,)).fetchone()
                incident_id = None if assessment is None else json.loads(assessment['result']).get('incident_id')
                decision = None if not incident_id else db.execute(
                    'SELECT status FROM automatic_recovery WHERE incident_id=? ORDER BY attempt DESC LIMIT 1',
                    (incident_id,)).fetchone()
            finally:
                db.close()
            if incident_id and decision and decision['status'] in ('completed','unresolved'):
                return incident_id,decision['status']
            time.sleep(0.05)
        raise RecoveryError('Timed out waiting for source-handler recovery',504)

    def _wait_for_live_fulfillment_incident(self, simulation_id, incident_id):
        deadline = time.monotonic()+SIMULATION_RECOVERY_TIMEOUT
        while time.monotonic() < deadline:
            db = _conn(self.db_path)
            try:
                decision = db.execute('SELECT status FROM automatic_recovery WHERE incident_id=? '
                    'ORDER BY attempt DESC LIMIT 1',(incident_id,)).fetchone()
                if decision and decision['status'] in ('completed','unresolved'):
                    return decision['status']
                jobs = [dict(row) for row in db.execute(
                    "SELECT status,error,payload FROM jobs WHERE kind IN ('incident','scan','automatic_recovery') "
                    "AND status='failed' ORDER BY created_at DESC LIMIT 20")]
            finally:
                db.close()
            if any(json.loads(job['payload']).get('incident_id') == incident_id for job in jobs):
                raise RecoveryError('Bootstrap fulfillment incident assessment failed',409)
            time.sleep(0.05)
        raise RecoveryError('Timed out waiting for bootstrap fulfillment recovery',504)

    def _run_live_simulation(self, simulation_id, step):
        if step['mode'] == 'bootstrap':
            return self._run_live_bootstrap(simulation_id)
        if step['mode'] == 'cycle':
            outcome = self._run_live_simulation_cycle(simulation_id,step['fault_mode'])
            if outcome is None:
                self._finish_simulation(simulation_id,'stopped')
                return {'simulation_id':simulation_id,'status':'stopped',
                    'completed':self._simulation_row(simulation_id)['completed'],
                    'total':self._simulation_row(simulation_id)['total']}
            self._advance_simulation_cycle(simulation_id,outcome)
            self._finish_simulation(simulation_id,'completed')
            return {'simulation_id':simulation_id,'status':'completed',
                'completed':self._simulation_row(simulation_id)['completed'],
                'total':self._simulation_row(simulation_id)['total'],**outcome}
        if step['mode'] == 'batch':
            current = self._simulation_row(simulation_id)
            for _ in range(max(0,current['total']-current['completed'])):
                if self._simulation_row(simulation_id)['stop_requested']:
                    break
                outcome=self._run_live_simulation_cycle(simulation_id,step['fault_mode'])
                if outcome is None:
                    break
                self._advance_simulation_cycle(simulation_id,outcome)
                deadline=time.monotonic()+self._live_duration(10)
                while time.monotonic()<deadline and not self._simulation_row(simulation_id)['stop_requested']:
                    time.sleep(min(0.1,max(0,deadline-time.monotonic())))
            current=self._simulation_row(simulation_id)
            status='stopped' if current['stop_requested'] else 'completed'
            self._finish_simulation(simulation_id,status)
            return {'simulation_id':simulation_id,'status':status,
                'completed':self._simulation_row(simulation_id)['completed'],
                'total':self._simulation_row(simulation_id)['total']}
        completed = 0
        while not self._simulation_row(simulation_id)['stop_requested']:
            reason = self._live_simulation_wait_reason()
            if reason == 'engine_storage_limit':
                self._set_simulation_waiting(reason)
                self._finish_simulation(simulation_id,'stopped',reason)
                return {'simulation_id':simulation_id,'status':'stopped','waiting_reason':reason,
                    'completed':completed,'total':0}
            if reason:
                self._set_simulation_waiting(reason)
                time.sleep(min(1,self._live_duration(1)))
                continue
            outcome = self._run_live_simulation_cycle(simulation_id,step['fault_mode'])
            if outcome is None:
                self._set_simulation_waiting('no_candidates')
                time.sleep(min(1,self._live_duration(1)))
                continue
            self._advance_simulation_cycle(simulation_id,outcome)
            completed += 1
            self._set_simulation_waiting(None)
            deadline = time.monotonic()+self._live_duration(10)
            while time.monotonic()<deadline and not self._simulation_row(simulation_id)['stop_requested']:
                time.sleep(min(0.1,max(0,deadline-time.monotonic())))
        self._finish_simulation(simulation_id,'stopped')
        return {'simulation_id':simulation_id,'status':'stopped','completed':
            self._simulation_row(simulation_id)['completed'],'total':0}

    def _advance_simulation_cycle(self,simulation_id,outcome):
        db = _conn(self.db_path)
        try:
            db.execute('BEGIN IMMEDIATE')
            intent = db.execute('SELECT operation_key,result_json FROM simulation_intents '
                'WHERE simulation_id=? AND cycle_no=? ORDER BY created_at DESC LIMIT 1',
                (simulation_id,outcome.get('cycle_no'))).fetchone()
            if intent and intent['result_json']:
                handler_result = json.loads(intent['result_json'])
                cycle_result = {**handler_result, **outcome,
                    'handler_outcome':outcome.get('handler_outcome',handler_result.get('outcome')),
                    'handler_result':handler_result}
                db.execute("UPDATE simulation_intents SET status='completed',result_json=?,updated_at=? "
                    'WHERE operation_key=?',(_json(cycle_result),self.wall_now(),
                        intent['operation_key']))
            db.execute('UPDATE simulations SET current_index=current_index+1,completed=completed+1,'
                'current_incident_id=?,updated_at=? WHERE id=?',
                (outcome.get('incident_id'),self.wall_now(),simulation_id))
            db.execute('COMMIT')
        except Exception:
            if db.in_transaction:
                db.execute('ROLLBACK')
            raise
        finally:
            db.close()

    def _run_live_bootstrap(self,simulation_id):
        source_calls_before=self._live_source_request_total()

        def source_calls_since_start():
            source_calls_after=self._live_source_request_total()
            if source_calls_before is None or source_calls_after is None:
                return None
            return source_calls_after-source_calls_before

        simulation = self._simulation_row(simulation_id)
        if simulation['stop_requested']:
            self._finish_simulation(simulation_id,'stopped')
            return {'simulation_id':simulation_id,'status':'stopped','completed':0,'total':1,
                'source_calls':source_calls_since_start()}
        operation_key = simulation['operation_key']
        registry = self._pages(self.provider_url,'/internal/provider/accounts')
        user_ids = [item['user_id'] for item in registry]
        if len(user_ids) != 100:
            raise RecoveryError('Initial replay requires the configured 100-account source scope',409)
        while True:
            source = internal_request(self.key,self.provider_url,'GET','/internal/live/status')
            if source.get('source_cooldown_seconds',0):
                self._set_simulation_waiting('source_cooldown')
                if self._simulation_row(simulation_id)['stop_requested']:
                    self._finish_simulation(simulation_id,'stopped')
                    return {'simulation_id':simulation_id,'status':'stopped','completed':0,'total':1,
                        'source_calls':source_calls_since_start()}
                time.sleep(min(1,max(0.1,source['source_cooldown_seconds'])))
                continue
            last_pass = source.get('last_source_pass') or {}
            try:
                pass_age = (datetime.now(timezone.utc)-parse_time(last_pass['completed_at'])).total_seconds()
            except (KeyError,RecoveryError,TypeError):
                pass_age = float('inf')
            if (last_pass.get('requested') == 100 and last_pass.get('observed') == 100
                    and not last_pass.get('waiting_reason') and 0 <= pass_age <= 300
                    and source.get('observed_count') == 100):
                break
            result = internal_request(self.key,self.provider_url,'POST','/internal/live/refresh',
                {'user_ids':user_ids},timeout=60)
            if result.get('waiting_reason') in ('source_cooldown','source_poll_interval'):
                self._set_simulation_waiting(result['waiting_reason'])
                if result.get('not_before'):
                    time.sleep(min(1,max(0.1,(parse_time(result['not_before'])-
                        datetime.now(timezone.utc)).total_seconds())))
                continue
            if result.get('observed') != 100:
                raise RecoveryError('Initial replay source pass is incomplete',503)
            break
        profiles = self._pages(self.provider_url,'/internal/adapty/profiles')
        now = datetime.now(timezone.utc)
        if len(profiles) != 100 or any(not self._fulfillment_source_right(
                profile,profile.get('user_id'),now)[1]
                or not (profile.get('entitlement') or {}).get('transaction_id')
                for profile in profiles):
            raise RecoveryError('Initial replay requires 100 current transaction-linked rights',409)
        ordered = sorted(profiles,key=lambda item:item['user_id'])
        transient = ordered[:23]
        permanent = ordered[23]
        processing_ids = {}
        modes = {}
        for profile in ordered:
            user_id = profile['user_id']
            processing_id = 'bootstrap:'+digest({'operation_key':operation_key,'user_id':user_id})
            processing_ids[user_id] = processing_id
            fault_mode = ('handler_precommit' if user_id in {item['user_id'] for item in transient}
                          else 'permanent_handler' if user_id == permanent['user_id'] else 'normal')
            modes[user_id] = fault_mode
            intent_key = 'bootstrap:'+digest({'operation_key':operation_key,'user_id':user_id})
            self._save_simulation_intent(intent_key,simulation_id,0,user_id,fault_mode,
                                         processing_id,'request_sent')
        faults = []
        for profile in ordered:
            user_id=profile['user_id']
            if modes[user_id] == 'normal':
                continue
            processing_id=processing_ids[user_id]
            try:
                receipt=self._live_handler_readback(processing_id)
            except Exception:
                receipt={'outcome':'unknown'}
            intent_key='bootstrap:'+digest({'operation_key':operation_key,'user_id':user_id})
            operation_key_live='source-handler:'+digest({'user_id':user_id,
                'processing_id':processing_id})
            try:
                action=internal_request(self.key,self.lumen_url,'GET',
                    '/internal/lumen/action?'+urlencode({'operation_key':operation_key_live}))
            except Exception:
                action=None
            if receipt.get('outcome') == 'unknown' and action is None:
                faults.append({'user_id':user_id,'fault_mode':modes[user_id],
                    'remaining_attempts':1,'permanent':modes[user_id] == 'permanent_handler'})
            elif receipt.get('outcome') == 'unknown':
                self._update_simulation_intent(intent_key,'action_committed')
        internal_request(self.key,self.lumen_url,'POST','/internal/lumen/simulation/configure',
            {'faults':faults,'paused':False})
        self._set_scenario_meta('bootstrap_handler_batch_active',True)
        if self._simulation_row(simulation_id)['stop_requested']:
            self._finish_simulation(simulation_id,'stopped')
            return {'simulation_id':simulation_id,'status':'stopped','completed':0,'total':1}
        try:
            replay = self._deliver_live_source_handlers(ordered,processing_ids)
        except Exception:
            replay = None
        if replay and (replay.get('handled') != 76 or replay.get('failed') != 24):
            raise RecoveryError('Initial source-handler replay count mismatch: accepted={} handled={} failed={} diagnostic_only={} failure_classes={}'.format(
                replay.get('accepted',-1),replay.get('handled',-1),
                replay.get('failed',-1),replay.get('diagnostic_only',-1),
                json.dumps(replay.get('failure_classes',{}),sort_keys=True)),409)
        processing_for_user = {}
        handler_outcomes = {}
        for profile in ordered:
            user_id=profile['user_id']
            processing_id=processing_ids[user_id]
            intent_key='bootstrap:'+digest({'operation_key':operation_key,'user_id':user_id})
            readback=self._live_handler_readback(processing_id)
            if readback.get('outcome') == 'unknown':
                # A crash between Lumen commit and its handler row is recovered from
                # the durable action receipt or by idempotently replaying this event.
                self._save_simulation_intent(intent_key,simulation_id,0,user_id,
                    'normal',processing_id,'unknown')
                self._deliver_live_source_handlers([profile],{user_id:processing_id})
                readback=self._live_handler_readback(processing_id)
            outcome=readback.get('result') or readback
            processing_for_user[user_id]=processing_id
            handler_outcomes[user_id]=outcome
            self._update_simulation_intent(intent_key,'handler_'+str(outcome.get('outcome','unknown')),outcome)
        self._set_simulation_waiting(None)
        failed_users={user_id for user_id,result in handler_outcomes.items()
            if result.get('outcome') == 'failed'}
        if len(failed_users) != 24:
            raise RecoveryError('Initial source-handler batch readback did not contain 24 failed results',409)
        audit=self._live_fulfillment_audit(refresh_source=False,handler_batch_complete=True)
        incident_id=audit.get('incident_id')
        if not incident_id:
            db=_conn(self.db_path)
            try:
                row=db.execute('SELECT incident_id FROM fulfillment_expectations '
                    "WHERE status='discrepancy' AND episode_open=1 AND incident_id IS NOT NULL "
                    'ORDER BY updated_at DESC LIMIT 1').fetchone()
                incident_id=None if row is None else row['incident_id']
            finally:
                db.close()
        self._set_scenario_meta('bootstrap_handler_batch_active',False)
        if not incident_id:
            raise RecoveryError('Initial source-handler batch did not produce a shared discrepancy incident',409)
        automatic_status=self._wait_for_live_fulfillment_incident(simulation_id,incident_id)
        self._live_fulfillment_audit(refresh_source=False)
        state_by_key={}
        db=_conn(self.db_path)
        try:
            for row in db.execute('SELECT key_json,source_fingerprint,status FROM fulfillment_expectations '
                                  'ORDER BY updated_at DESC,expectation_id'):
                key=json.loads(row['key_json'])
                state_by_key.setdefault((key.get('customer_id'),key.get('transaction_id'),
                    row['source_fingerprint']),row['status'])
        finally:
            db.close()
        repaired=unresolved=0
        for profile in ordered:
            user_id=profile['user_id']
            outcome=handler_outcomes[user_id]
            intent_key='bootstrap:'+digest({'operation_key':operation_key,'user_id':user_id})
            intent=self._simulation_intent(intent_key)
            if user_id in failed_users:
                entitlement=profile.get('entitlement') or {}
                state=state_by_key.get((user_id,entitlement.get('transaction_id'),
                    profile.get('source_fingerprint')))
                if state == 'verified_application':
                    repaired += 1
                    status='handler_repaired'
                else:
                    unresolved += 1
                    status='handler_unresolved'
                self._update_simulation_intent(intent_key,status,outcome,incident_id)
            elif intent:
                self._update_simulation_intent(intent_key,intent['status'],
                    None if not intent['result_json'] else json.loads(intent['result_json']))
        if (replay is None or replay.get('accepted') != 100
                or replay.get('handled') != 76 or replay.get('failed') != 24
                or repaired != 23 or unresolved != 1
                or automatic_status not in ('completed','unresolved')):
            raise RecoveryError('Initial replay did not settle at 76 healthy, 23 repaired, 1 unresolved',409)
        db=_conn(self.db_path)
        try:
            db.execute('UPDATE simulations SET current_index=1,completed=1,updated_at=? WHERE id=?',
                (self.wall_now(),simulation_id))
        finally:
            db.close()
        result={'simulation_id':simulation_id,'status':'completed','source_observed':100,
            'handler_completed':76,'handler_failed':24,'repaired':23,'unresolved':1,
            'customer_denials':0,'manual_incidents':0,
            'source_calls':source_calls_since_start()}
        self._finish_simulation(simulation_id,'completed')
        return result

    def _run_live_simulation_cycle(self,simulation_id,fault_mode):
        if self._simulation_row(simulation_id)['stop_requested']:
            return None
        reason=self._live_simulation_wait_reason()
        if reason:
            self._set_simulation_waiting(reason)
            return None
        source_calls_before=self._live_source_request_total()
        simulation=self._simulation_row(simulation_id)
        cycle_no=simulation['completed']+1
        operation_key='simcycle:'+digest({'simulation_id':simulation_id,'cycle_no':cycle_no})
        intent=self._simulation_intent(operation_key)
        if intent is None:
            excluded=self._live_open_incident_accounts(include_verified=True)
            candidates=self._live_simulation_candidates(excluded)
            if not candidates:
                self._set_simulation_waiting('no_candidates')
                return None
            if fault_mode == 'random':
                step = json.loads(simulation['sequence_json'])[0]
                generator = random.Random(str(step.get('seed') or simulation['operation_key'])+':'+str(cycle_no))
                fault_mode = generator.choice(('handler_precommit','cache_refresh_skipped',
                    'delayed_older_update','timeout_after_commit'))
                user_id = generator.choice(candidates)
            else:
                user_id=candidates[(cycle_no-1)%len(candidates)]
            processing_id='cycle:'+digest({'operation_key':operation_key,'user_id':user_id})
            self._save_simulation_intent(operation_key,simulation_id,cycle_no,user_id,
                fault_mode,processing_id,'intent')
        else:
            user_id,processing_id=intent['user_id'],intent['processing_id']
            fault_mode=intent['fault_mode']
            if intent['status'].startswith('handler_'):
                outcome=json.loads(intent['result_json'] or '{}')
            else:
                with self._simulation_inject_lock:
                    if self._simulation_row(simulation_id)['stop_requested']:
                        return None
                    outcome=self._live_handler_result(simulation_id,operation_key,processing_id,
                        user_id,intent['fault_mode'])
        if intent is None:
            with self._simulation_inject_lock:
                if self._simulation_row(simulation_id)['stop_requested']:
                    return None
                outcome=self._live_handler_result(simulation_id,operation_key,processing_id,
                    user_id,fault_mode)
        if outcome is None:
            return None
        incident_id,status=None,'no_recovery_needed'
        if outcome.get('outcome') == 'failed':
            incident_id,status=self._wait_for_live_handler_incident(simulation_id,processing_id)
            self._update_simulation_intent(operation_key,'handler_'+status,outcome,incident_id)
        self._set_simulation_waiting(None)
        source_calls_after=self._live_source_request_total()
        return {'cycle_no':cycle_no,'user_id':user_id,'fault_mode':fault_mode,
            'handler_outcome':outcome.get('outcome'),'incident_id':incident_id,
            'recovery_status':status,
            'source_calls':None if source_calls_before is None or source_calls_after is None
                else source_calls_after-source_calls_before}

    def _simulation(self, body):
        if not self.demo or not self.live_config or not self.auto_repair:
            raise RecoveryError('Simulation requires automatic live demo mode', 404)
        if self.live_bootstrap_pending:
            return self._live_simulation_control(body)
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
        if self.live_bootstrap_pending and sequence and sequence[0].get('mode') in (
                'bootstrap','continuous','cycle','batch'):
            return self._run_live_simulation(simulation_id, sequence[0])
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
        if self._simulation_row(simulation_id)['stop_requested']:
            return None
        source_complete = refreshed.get('observed') == len(user_ids)
        if (not source_complete and refreshed.get('waiting_reason') == 'source_poll_interval'
                and self._has_fresh_complete_source_pass()):
            source_complete = True
        if not source_complete:
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
            event_id = gate['event_id']
            deadline = time.monotonic()+5
            while time.monotonic() < deadline:
                db = _conn(self.db_path)
                try:
                    received = db.execute('SELECT 1 FROM collector_events WHERE event_id=?',
                                          (event_id,)).fetchone()
                finally:
                    db.close()
                if received:
                    break
                time.sleep(0.01)
            return event_id

    def _wait_for_automatic_recovery(self, simulation_id, event_id):
        deadline = time.monotonic()+SIMULATION_RECOVERY_TIMEOUT
        while time.monotonic() < deadline:
            db = _conn(self.db_path)
            try:
                assessment = db.execute('SELECT result FROM collector_assessments WHERE event_id=?',
                                        (event_id,)).fetchone()
                owner = None if assessment is None else json.loads(assessment['result']).get('incident_id')
                incident = (db.execute('SELECT id FROM incidents WHERE id=?',(owner,)).fetchone()
                    if owner else db.execute('SELECT id FROM incidents WHERE trigger_event_id=?',
                        (event_id,)).fetchone())
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

    def _bootstrap_handler_batch_open(self, processing_id):
        if not self.live_bootstrap_pending or not isinstance(processing_id,str):
            return False
        db = _conn(self.db_path)
        try:
            row = db.execute('SELECT s.status,s.sequence_json,i.cycle_no FROM simulation_intents i '
                'JOIN simulations s ON s.id=i.simulation_id WHERE i.processing_id=?',
                (processing_id,)).fetchone()
            if row is None or row['cycle_no'] != 0 or row['status'] not in ('queued','running'):
                return False
            sequence = json.loads(row['sequence_json'])
            return bool(sequence and sequence[0].get('mode') == 'bootstrap'
                and _meta(db,'bootstrap_handler_batch_active',False))
        finally:
            db.close()

    def _open_fulfillment_incident_for_handler(self, event):
        details = event.get('details') or {}
        user_id = event.get('app_user_id')
        transaction_id = details.get('transaction_id')
        source_fingerprint = details.get('source_hash')
        if not isinstance(user_id,str) or not user_id:
            return None
        db = _conn(self.db_path)
        try:
            if (event.get('kind') == 'feature_access_decided'
                    and details.get('decision') == 'deny'):
                revisions = details.get('revisions')
                if (isinstance(revisions,dict) and set(revisions)=={'identity','policy','projection','cache'}
                        and all(type(value) is int and value>=0 for value in revisions.values())):
                    for trace_row in db.execute('SELECT incident_id,trace_json FROM fulfillment_traces '
                            'WHERE user_id=? AND incident_id IS NOT NULL ORDER BY updated_at DESC,trace_id',
                            (user_id,)):
                        trace = json.loads(trace_row['trace_json'])
                        if (trace.get('revisions')==revisions and any(
                                step.get('name')=='gate_readback' and step.get('result')=='denied'
                                for step in trace.get('steps',[]))):
                            return trace_row['incident_id']
                row = db.execute('SELECT incident_id,episode_open FROM fulfillment_expectations '
                    "WHERE json_extract(key_json,'$.customer_id')=? "
                    'ORDER BY first_observed_at DESC,version DESC LIMIT 1', (user_id,)).fetchone()
                if row and row['episode_open'] and row['incident_id']:
                    decision = db.execute('SELECT status FROM automatic_recovery '
                        'WHERE incident_id=? ORDER BY attempt DESC LIMIT 1',
                        (row['incident_id'],)).fetchone()
                    if not decision or decision['status'] != 'completed':
                        return row['incident_id']
                return None
            if not all(isinstance(value,str) and value for value in
                       (transaction_id,source_fingerprint)):
                return None
            # Processing identity, rather than collection time, binds a late receipt.
            processing_id = details.get('processing_id')
            if isinstance(processing_id,str) and processing_id:
                for row in db.execute('SELECT incident_id,trace_json FROM fulfillment_traces '
                        'WHERE user_id=? AND incident_id IS NOT NULL ORDER BY updated_at,trace_id',
                        (user_id,)):
                    trace = json.loads(row['trace_json'])
                    if (trace.get('source_fingerprint') == source_fingerprint
                            and trace.get('transaction_id') == transaction_id
                            and trace.get('processing_id') == processing_id):
                        return row['incident_id']
            rows = db.execute('SELECT key_json,incident_id,episode_open FROM fulfillment_expectations '
                'WHERE source_fingerprint=? AND incident_id IS NOT NULL ORDER BY episode_no DESC',
                (source_fingerprint,)).fetchall()
            for row in rows:
                key = json.loads(row['key_json'])
                if key.get('customer_id') != user_id or key.get('transaction_id') != transaction_id:
                    continue
                if row['episode_open']:
                    decision = db.execute('SELECT status FROM automatic_recovery '
                        'WHERE incident_id=? ORDER BY attempt DESC LIMIT 1',
                        (row['incident_id'],)).fetchone()
                    if decision and decision['status'] == 'completed':
                        continue
                    return row['incident_id']
            return None
        finally:
            db.close()

    def _bind_handler_receipts_to_incident(self, incident_id, expectations):
        db = _conn(self.db_path)
        try:
            db.execute('BEGIN IMMEDIATE')
            for item in expectations:
                row = db.execute('SELECT key_json,source_fingerprint,incident_id FROM fulfillment_expectations '
                    'WHERE expectation_id=? AND episode_no=?',
                    (item['expectation_id'],item['episode_no'])).fetchone()
                if row is None or row['incident_id'] != incident_id:
                    continue
                key = json.loads(row['key_json'])
                if not key.get('transaction_id') or not row['source_fingerprint']:
                    continue
                events = db.execute('SELECT event_id FROM fulfillment_receipts WHERE user_id=? '
                    'AND transaction_id=? AND source_fingerprint=?',
                    (key.get('customer_id'),key['transaction_id'],row['source_fingerprint'])).fetchall()
                db.execute('UPDATE fulfillment_receipts SET incident_id=? WHERE user_id=? '
                    'AND transaction_id=? AND source_fingerprint=? AND incident_id IS NULL',
                    (incident_id,key.get('customer_id'),key['transaction_id'],row['source_fingerprint']))
                for event in events:
                    assessment = db.execute('SELECT result FROM collector_assessments WHERE event_id=?',
                        (event['event_id'],)).fetchone()
                    if assessment:
                        result = json.loads(assessment['result'])
                        if not result.get('incident_id'):
                            result.update(incident_id=incident_id,job_id=None)
                            db.execute('UPDATE collector_assessments SET result=? WHERE event_id=?',
                                (_json(result),event['event_id']))
            db.execute('COMMIT')
        except Exception:
            if db.in_transaction:
                db.execute('ROLLBACK')
            raise
        finally:
            db.close()

    def _live_denial_cohort_signature(self, pending):
        users = {item.get('user_id') for item in pending if item.get('user_id')}
        if not users:
            return None
        db = _conn(self.db_path)
        try:
            rows = db.execute('SELECT event_json FROM collector_events '
                'ORDER BY recorded_at DESC,rowid DESC LIMIT 500').fetchall()
        finally:
            db.close()
        now = datetime.now(timezone.utc)
        for row in rows:
            event = json.loads(row['event_json'])
            if (event.get('app_user_id') not in users
                    or event.get('kind') != 'feature_access_decided'):
                continue
            details = event.get('details') or {}
            if (details.get('decision') != 'deny'
                    or not isinstance(details.get('projection_version'),str)
                    or not isinstance(details.get('cache_version'),str)):
                continue
            try:
                if (now-parse_time(event['occurred_at'])).total_seconds() > 300:
                    continue
            except (KeyError,RecoveryError,TypeError):
                continue
            db = _conn(self.db_path)
            try:
                assessment = db.execute('SELECT result FROM collector_assessments '
                    'WHERE event_id=?',(event['event_id'],)).fetchone()
                incident_id = (None if assessment is None else
                    json.loads(assessment['result']).get('incident_id'))
                decision = None if not incident_id else db.execute(
                    'SELECT status FROM automatic_recovery WHERE incident_id=? '
                    'ORDER BY attempt DESC LIMIT 1',(incident_id,)).fetchone()
            finally:
                db.close()
            if decision and decision['status'] == 'completed':
                continue
            return {'handler_version':details['projection_version'],
                'config_version':details['cache_version'],
                'occurred_at':event['occurred_at'],
                'trigger_event_id':event['event_id']}
        return None

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
        if (type(envelope['schema_version']) is not int or envelope['schema_version'] not in (1, 2)
                or not isinstance(envelope['event'], dict)
                or type(envelope['event'].get('schema_version')) is not int
                or envelope['schema_version'] != envelope['event']['schema_version']):
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
                duplicate = True
            else:
                db.execute('INSERT INTO collector_events VALUES(?,?,?,?,?)',
                           (event['event_id'], event_hash, _json(event), self.wall_now(), 'client_simulator'))
                duplicate = False
            if (event['schema_version'] == 2 and event['kind'] == 'access_projection_changed'
                    and event['details'].get('transaction_id')
                    and event['details'].get('source_hash')
                    and event['details'].get('trace_id')
                    and isinstance(event['details'].get('steps'), list)):
                details = event['details']
                action_id = details.get('action_id')
                action = (None if not action_id else db.execute(
                    'SELECT p.incident_id FROM actions a JOIN plans p ON p.id=a.plan_id WHERE a.id=?',
                    (action_id,)).fetchone())
                db.execute('INSERT OR IGNORE INTO fulfillment_receipts VALUES(?,?,?,?,?,?,?,?,?)',
                    (event['event_id'], event['app_user_id'], details['transaction_id'],
                     details['source_hash'], details['trace_id'], action_id,
                     None if action is None else action['incident_id'],
                     _json(details['steps']), self.wall_now()))
            elif (event['schema_version'] == 2 and event['kind'] == 'handler_completed'
                    and event['details'].get('transaction_id')
                    and event['details'].get('processing_id')
                    and isinstance(event['details'].get('steps'), list)):
                details = event['details']
                db.execute('INSERT OR IGNORE INTO fulfillment_receipts VALUES(?,?,?,?,?,?,?,?,?)',
                    (event['event_id'],event['app_user_id'],details['transaction_id'],
                     details['source_hash'],details['trace_id'],None,None,
                     _json(details['steps']),self.wall_now()))
            db.execute('COMMIT')
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
        live_handler_failure = bool(manifest.get('scenario') == 'live_adapty'
            and event['schema_version'] == 2 and event['kind'] == 'handler_completed'
            and event['details'].get('outcome') == 'failed')
        live_handler_receipt = bool(manifest.get('scenario') == 'live_adapty'
            and event['schema_version'] == 2 and event['kind'] == 'handler_completed'
            and event['details'].get('processing_id')
            and event['details'].get('transaction_id')
            and event['details'].get('source_hash'))
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
                owned_id = (self._open_fulfillment_incident_for_handler(event)
                            if live_denial_only and should_scan else None)
                matching = next((item for item in candidates if item['id'] == owned_id), None)
                matching = matching or next((item for item in candidates
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
                job_id = (pending['id'] if pending else None) if owned_id else (
                    pending['id'] if pending else self._start_scan(incident_id))
            elif (should_scan and (event['details'].get('decision') == 'deny'
                  or event['details'].get('observation_kind') in ('access_denied', 'purchase_succeeded'))):
                cohort_signature = None
                if live_denial_only:
                    cohort_signature = {'handler_version': event['details'].get('projection_version'),
                        'config_version': event['details'].get('cache_version'),
                        'occurred_at': event['occurred_at'], 'trigger_event_id': event['event_id']}
                incident_id, job_id = self._start_incident(event['app_user_id'], event['occurred_at'],
                    trigger_event_id=event['event_id'], cohort_signature=cohort_signature)
        elif not assessed and live_handler_failure:
            if self._bootstrap_handler_batch_open(event['details'].get('processing_id')):
                incident_id, job_id = None, None
            else:
                incident_id = self._open_fulfillment_incident_for_handler(event)
                if incident_id is None:
                    incident_id, job_id = self._start_incident(event['app_user_id'],
                        event['occurred_at'], trigger_event_id=event['event_id'])
        if (live_handler_receipt and not assessed and not incident_id and not self._bootstrap_handler_batch_open(
                event['details'].get('processing_id'))):
            incident_id = self._open_fulfillment_incident_for_handler(event)
        if assessed:
            decision = json.loads(assessed['result'])
            incident_id = decision.get('incident_id') or incident_id
            job_id = job_id or decision.get('job_id')
        else:
            db = _conn(self.db_path)
            try:
                if incident_id and live_handler_failure:
                    db.execute('UPDATE fulfillment_receipts SET incident_id=? WHERE event_id=? AND incident_id IS NULL',
                               (incident_id,event['event_id']))
                db.execute('INSERT OR IGNORE INTO collector_assessments VALUES(?,?)',
                           (event['event_id'], _json({'incident_id': incident_id, 'job_id': job_id})))
            finally:
                db.close()
        if live_handler_receipt and incident_id:
            db = _conn(self.db_path)
            try:
                db.execute('UPDATE fulfillment_receipts SET incident_id=? WHERE event_id=? AND incident_id IS NULL',
                    (incident_id,event['event_id']))
                assessment = db.execute('SELECT result FROM collector_assessments WHERE event_id=?',
                    (event['event_id'],)).fetchone()
                if assessment:
                    result = json.loads(assessment['result'])
                    if not result.get('incident_id'):
                        result.update(incident_id=incident_id,job_id=job_id)
                        db.execute('UPDATE collector_assessments SET result=? WHERE event_id=?',
                            (_json(result),event['event_id']))
            finally:
                db.close()
        if (manifest.get('scenario') == 'live_adapty' and event['kind'] in
                ('source_entitlement_observed', 'handler_completed',
                 'access_projection_changed', 'mobile_observation')):
            self._fulfillment_wake.set()
        if job_id:
            self._launch_job(job_id)
        return {'accepted': True, 'duplicate': duplicate,
                'event_id': event['event_id'], 'event_hash': event_hash,
                **({'incident_id': incident_id, 'job_id': job_id} if incident_id else {})}

    def _mobile_observation(self, body):
        from recovery_sdk import validate_event
        required = {'event_id', 'user_id', 'kind', 'occurred_at', 'details'}
        version = body.get('schema_version', 1) if isinstance(body, dict) else None
        if (not isinstance(body, dict)
                or (version == 1 and set(body) != required)
                or (version == 2 and (type(version) is not int or set(body) != required | {'schema_version'}))
                or version not in (1, 2) or not isinstance(body['details'], dict)):
            raise RecoveryError('Mobile event fields do not match the contract')
        detail_keys = {'transaction_id', 'original_transaction_id', 'product_id', 'price_id',
            'feature', 'reason_code', 'processing_id', 'trace_id', 'steps', 'revisions', 'stack'}
        if set(body['details']) - detail_keys:
            raise RecoveryError('Only allowlisted mobile metadata is accepted')
        details = {'observation_kind': body['kind'], **{key: body['details'].get(key)
            for key in ('transaction_id', 'product_id', 'price_id', 'feature', 'reason_code')}}
        for key in ('original_transaction_id', 'processing_id', 'trace_id', 'steps', 'revisions', 'stack'):
            if key in body['details']:
                details[key] = body['details'][key]
        manifest = self._manifest()
        event_id = 'mobile:'+str(body['event_id'])
        event = {'schema_version': version, 'event_id': event_id, 'run_id': manifest['run_id'],
                 'app': manifest['app'], 'environment': manifest['environment'],
                 'app_user_id': body['user_id'], 'kind': 'mobile_observation',
                 'occurred_at': body['occurred_at'], 'correlation_id': event_id,
                 'source_event_id': body['event_id'], 'details': details}
        validate_event(event)
        result = domain.mobile_event(self.db_path, body)
        # Stable event identity makes replay safe after a crash between these two stores.
        receipt = self.sdk.emit('mobile_observation', body['user_id'], body['occurred_at'], details,
                                event_id=event_id, correlation_id=event_id, source_event_id=body['event_id'],
                                schema_version=version)
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
                if set(query)-{'cursor','limit','status'}:
                    raise RecoveryError('Unknown monitor query field')
                limit = _one(query, 'limit')
                try:
                    limit = None if limit is None else int(limit)
                except ValueError as exc:
                    raise RecoveryError('Invalid monitor limit') from exc
                return self.respond(recovery_monitor.build(self.service,
                    cursor=_one(query,'cursor'), limit=limit, status=_one(query,'status')))
            if path == '/api/recovery/fulfillments':
                if set(query)-{'cursor','limit','status'}:
                    raise RecoveryError('Unknown fulfillment query field')
                limit = _one(query,'limit','50')
                try:
                    limit = int(limit)
                except ValueError as exc:
                    raise RecoveryError('Invalid fulfillment limit') from exc
                return self.respond(self.service._fulfillments(
                    _one(query,'cursor'), limit, _one(query,'status')))
            if path.startswith('/api/recovery/incidents/') and path.endswith('/trace'):
                incident_id = unquote(path[len('/api/recovery/incidents/'):-len('/trace')].rstrip('/'))
                if not incident_id or query:
                    raise RecoveryError('Trace path or query is invalid')
                return self.respond(self.service._fulfillment_trace(incident_id))
            if path == '/api/recovery/export':
                if set(query)-{'from','to','format'}:
                    raise RecoveryError('Unknown export query field')
                export_format = _one(query,'format','json')
                exported = self.service._export_recovery(_one(query,'from'),
                    _one(query,'to'), export_format)
                if export_format == 'csv':
                    return self.respond(exported, ctype='text/csv; charset=utf-8',
                        extra_headers={'Content-Disposition':'attachment; filename="recovery-export.csv"'})
                return self.respond(exported)
            if path == '/api/recovery/live/status':
                return self.respond(self.service._live_status())
            if path == '/api/recovery/simulation':
                if query:
                    raise RecoveryError('Simulation status does not accept query fields')
                return self.respond(self.service._simulation_summary())
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
            return self.respond(self.service._simulation(body), 202 if body.get('action') in
                ('once','start','continuous','bootstrap','resume') else 200)
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
    parser.add_argument('--live-bootstrap-pending', action='store_true')
    args = parser.parse_args(argv)
    if not 0 <= args.port <= 65535:
        parser.error('--port must be between 0 and 65535')
    service = RecoveryService(args.role, args.port, args.db, args.key_file,
                              provider_url=args.provider_url, lumen_url=args.lumen_url,
                              collector_url=args.collector_url, demo=args.demo,
                              live_config=args.live_config,
                              auto_repair=args.auto_repair,
                              live_bootstrap_pending=args.live_bootstrap_pending)
    server = RecoveryHTTPServer(service)
    service.server = server
    print(json.dumps({'port': server.server_port, 'role': args.role}, separators=(',', ':')),
          flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        service._fulfillment_stop.set()
        service._fulfillment_wake.set()
        server.shutdown()
        server.server_close()


if __name__ == '__main__':
    main()
