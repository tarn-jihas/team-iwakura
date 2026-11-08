"""Independent local source fixture and subprocess launcher for fulfillment UAT."""
from __future__ import annotations

from datetime import datetime, timedelta, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import argparse
import ctypes
import ctypes.util
import hashlib
import hmac
import json
import os
from pathlib import Path
import selectors
import secrets
import socket
import subprocess
import sys
import threading
import time
from urllib.parse import parse_qs, urlsplit
from urllib.request import urlopen


ROOT = Path(__file__).resolve().parents[2]
SERVICE = ROOT / 'recovery_service.py'
APP_ID = '46a573aa-8c90-4b4b-ba72-2349ae9fb030'
APP_TITLE = 'Lumen - AI Photo Editor (Hackathon)'
APP_ENVIRONMENT = 'hackathon_seed'
SOURCE_ENVIRONMENT = 'Production'
PROVENANCE = 'synthetic_test_fixture'
PAYMENT_VERIFICATION = 'not_independently_verified'


def utc_now():
    return datetime.now(timezone.utc).isoformat(timespec='seconds').replace('+00:00', 'Z')


def canonical(value):
    return json.dumps(value, sort_keys=True, separators=(',', ':'),
                      ensure_ascii=False, allow_nan=False).encode('utf-8')


def digest(value):
    return hashlib.sha256(canonical(value)).hexdigest()


def internal_signature(key, method, path, timestamp, body):
    material = (b'recovery-internal-v1\n' + method.upper().encode('ascii') + b'\n'
                + path.encode('utf-8') + b'\n' + str(timestamp).encode('ascii') + b'\n'
                + hashlib.sha256(body).hexdigest().encode('ascii'))
    return hmac.new(key, material, hashlib.sha256).hexdigest()


class SourceState:
    """Synthetic source evidence served independently of the recovery engine."""

    def __init__(self, key, run_id, run_prefix):
        self.key = key
        self.run_id = run_id
        self.run_prefix = run_prefix
        self.user_ids = [f'{run_prefix}-{index:03d}' for index in range(100)]
        self.observed_at = utc_now()
        self.starts_at = (datetime.now(timezone.utc)-timedelta(days=30)).isoformat(
            timespec='seconds').replace('+00:00', 'Z')
        self.expires_at = (datetime.now(timezone.utc)+timedelta(days=335)).isoformat(
            timespec='seconds').replace('+00:00', 'Z')
        self.profile_overrides = {}
        self.lock = threading.RLock()
        self.profiles = {user_id: self._profile(user_id) for user_id in self.user_ids}
        self.source_requests_total = 0
        self.fixture_profile_requests_total = 0
        self.fixture_refresh_requests_total = 0
        self.last_source_request_at = None
        self.last_source_pass = None
        self.control_key = secrets.token_urlsafe(32)
        self.cooldown_until = 0.0
        self.profile_pause_after = None
        self.profile_pause_reached = threading.Event()
        self.profile_release = threading.Event()
        self.profile_release.set()
        self.manifest = self._manifest()
        self.catalog = {
            'app_id': APP_ID, 'command': 'synthetic fixture catalog',
            'cli_version': 'fixture-v1', 'product_count': 1,
            'observed_at': self.observed_at, 'source_hash': 'f'*64,
            'products': [{'id': 'lumen.annual', 'title': 'Synthetic annual access'}],
            'provenance': PROVENANCE, 'payment_verification': PAYMENT_VERIFICATION,
            'items': [{'provider': 'live_adapty', 'product_id': 'lumen.annual',
                       'price_id': 'lumen.annual', 'status': 'mapped', 'revision': 1}],
            'revision': 1,
        }

    def _manifest(self):
        return {
            'app_id': APP_ID, 'app_title': APP_TITLE,
            'environment': APP_ENVIRONMENT, 'source_environment': SOURCE_ENVIRONMENT,
            'seed_revision': 'synthetic-fixture-v1', 'seed_run_prefix': self.run_prefix,
            'provenance': PROVENANCE, 'payment_verification': PAYMENT_VERIFICATION,
            'app': APP_ID, 'scenario': 'live_adapty', 'scenario_now': utc_now(),
            'run_id': self.run_id, 'customer_registry_hash': digest(sorted(self.user_ids)),
            'customer_count': len(self.user_ids),
            'catalog_provenance': PROVENANCE, 'catalog_product_count': 1,
            'catalog_source_hash': 'f'*64, 'catalog_cli_version': 'fixture-v1',
            'catalog_observed_at': self.observed_at,
        }

    def _profile(self, user_id):
        override = self.profile_overrides.get(user_id, {})
        app_id = override.get('app_id', APP_ID)
        profile_id = override.get('profile_id', f'profile-{user_id}')
        transaction_id = override.get('transaction_id', f'txn-{user_id}')
        original_transaction_id = override.get('original_transaction_id', f'original-{user_id}')
        product_id = override.get('product_id', 'lumen.annual')
        starts_at = override.get('starts_at', self.starts_at)
        expires_at = override.get('expires_at', self.expires_at)
        status = override.get('status', 'active')
        customer_user_id = override.get('customer_user_id', user_id)
        source_environment = override.get('source_environment', SOURCE_ENVIRONMENT)
        identity_match = (app_id == APP_ID and customer_user_id == user_id
                          and profile_id == f'profile-{user_id}')
        source = {'app_id': app_id, 'profile_id': profile_id,
            'customer_user_id': customer_user_id, 'access_level_id': 'premium',
            'transaction_id': transaction_id, 'original_transaction_id': original_transaction_id,
            'product_id': product_id, 'store': override.get('store', 'app_store'),
            'source_environment': source_environment,
            'starts_at': starts_at, 'expires_at': expires_at, 'is_in_grace_period': False,
            'status': status, 'payment_verification': PAYMENT_VERIFICATION,
            'provenance': PROVENANCE}
        source_fingerprint = digest(source)
        if not identity_match:
            observed_at = self.observed_at
            raw = {'fixture_record': source, 'timestamp': observed_at}
            return {'user_id': user_id, 'provider_customer_id': user_id,
                'app_id': app_id, 'profile_id': profile_id,
                'source_fingerprint': source_fingerprint,
                'source_revision': source_fingerprint, 'observed_at': observed_at,
                'raw_source_profile': raw, 'identity_match': False,
                'status': 'unknown', 'reason': 'identity_scope_mismatch',
                'entitlement': None, 'provenance': PROVENANCE,
                'payment_verification': PAYMENT_VERIFICATION}
        entitlement_hash = digest({'user_id': user_id, 'product_id': product_id,
                                  'expires_at': expires_at})
        entitlement = {
            'user_id': user_id, 'provider_customer_id': user_id,
            'app_id': app_id, 'profile_id': profile_id,
            'access_level_id': 'premium', 'product_id': product_id,
            'transaction_id': transaction_id,
            'original_transaction_id': original_transaction_id,
            'store': override.get('store', 'app_store'), 'source_environment': source_environment,
            'starts_at': starts_at, 'purchased_at': starts_at,
            'expires_at': expires_at, 'is_in_grace_period': False,
            'subscription_environment': source_environment,
            'source_fingerprint': source_fingerprint,
            'source_revision': source_fingerprint, 'observed_at': self.observed_at,
            'provenance': PROVENANCE, 'payment_verification': PAYMENT_VERIFICATION,
            'entitlement_hash': entitlement_hash,
            'raw_source_profile': {'fixture_record': source, 'timestamp': self.observed_at},
        }
        reason = override.get('reason', 'active' if status == 'active' else 'subscription_expired')
        return {'user_id': user_id, 'provider_customer_id': user_id,
            'app_id': app_id, 'profile_id': profile_id,
            'source_fingerprint': source_fingerprint, 'source_revision': source_fingerprint,
            'observed_at': self.observed_at, 'raw_source_profile': {
                'fixture_record': source, 'timestamp': self.observed_at},
            'identity_match': True, 'status': status, 'reason': reason,
            'entitlement': entitlement, 'provenance': PROVENANCE,
            'payment_verification': PAYMENT_VERIFICATION}

    def accounts_page(self, query):
        return self._page([{'user_id': user_id, 'provider_customer_id': user_id,
            'identity_status': 'mapped', 'provenance': PROVENANCE}
            for user_id in self.user_ids], query)

    @staticmethod
    def _page(items, query):
        values = parse_qs(query, keep_blank_values=True)
        try:
            cursor = int(values.get('cursor', ['0'])[0] or 0)
            limit = int(values.get('limit', ['500'])[0] or 500)
        except ValueError as exc:
            raise ValueError('Invalid pagination') from exc
        if cursor < 0 or not 1 <= limit <= 1000:
            raise ValueError('Invalid pagination')
        page = items[cursor:cursor+limit]
        next_cursor = str(cursor+len(page)) if cursor+len(page) < len(items) else None
        return {'items': page, 'next_cursor': next_cursor, 'total': len(items)}

    def profile(self, user_id):
        with self.lock:
            self.fixture_profile_requests_total += 1
            pause = self.profile_pause_after == self.fixture_profile_requests_total
            if pause:
                self.profile_pause_reached.set()
        if pause:
            self.profile_release.wait(timeout=60)
        with self.lock:
            if user_id not in self.profiles:
                return None, 0
            retry_after = max(0, int(self.cooldown_until-time.monotonic()+0.999))
            if retry_after:
                return None, retry_after
            self.source_requests_total += 1
            self.last_source_request_at = utc_now()
            profile = self.profiles[user_id]
            return self._observed(profile), 0

    def update_profile(self, body):
        allowed = {'user_id', 'transaction_id', 'original_transaction_id',
            'product_id', 'starts_at', 'expires_at', 'status', 'customer_user_id',
            'store', 'source_environment', 'reason', 'app_id', 'profile_id'}
        if (not isinstance(body, dict) or not {'user_id'} <= set(body)
                or set(body)-allowed or body['user_id'] not in self.profiles):
            raise ValueError('Source profile update fields are invalid')
        if body.get('status', 'active') not in ('active', 'inactive', 'unknown'):
            raise ValueError('Source profile status is invalid')
        with self.lock:
            self.profile_overrides[body['user_id']] = {
                key: value for key, value in body.items() if key != 'user_id'}
            self.profiles[body['user_id']] = self._profile(body['user_id'])
            return self._observed(self.profiles[body['user_id']])

    def refresh(self, body):
        if not isinstance(body, dict) or set(body) != {'user_ids'}:
            raise ValueError('Refresh fields do not match the fixture contract')
        user_ids = body['user_ids']
        if (not isinstance(user_ids, list) or not user_ids or len(user_ids) > 100
                or len(set(user_ids)) != len(user_ids)
                or any(user_id not in self.profiles for user_id in user_ids)):
            raise ValueError('Refresh scope does not match the fixture registry')
        now = time.monotonic()
        with self.lock:
            self.fixture_refresh_requests_total += 1
            pass_id = secrets.token_hex(12)
            started_at = utc_now()
            if now < self.cooldown_until:
                result = {'requested': len(user_ids), 'observed': 0, 'active': 0,
                    'source_calls': 0, 'source_pass_id': pass_id,
                    'source_observed_at': None, 'waiting_reason': 'source_cooldown',
                    'retry_after_seconds': max(1, int(self.cooldown_until-now))}
                self.last_source_pass = {'requested': len(user_ids), 'observed': 0,
                    'source_calls': 0, 'started_at': started_at, 'completed_at': utc_now(),
                    'waiting_reason': 'source_cooldown', 'pass_id': pass_id}
                return result
            self.source_requests_total += len(user_ids)
            self.last_source_request_at = utc_now()
            self.observed_at = utc_now()
            active = 0
            for user_id in user_ids:
                profile = self.profiles[user_id]
                fresh = self._observed(profile)
                self.profiles[user_id] = fresh
                active += fresh.get('status') == 'active'
            completed_at = utc_now()
            self.last_source_pass = {'requested': len(user_ids), 'observed': len(user_ids),
                'source_calls': len(user_ids), 'started_at': started_at,
                'completed_at': completed_at, 'waiting_reason': None, 'pass_id': pass_id}
            return {'requested': len(user_ids), 'observed': len(user_ids), 'active': active,
                'source_observed_at': completed_at, 'source_calls': len(user_ids),
                'source_pass_id': pass_id}

    def _observed(self, profile):
        observed_at = utc_now()
        result = json.loads(json.dumps(profile))
        result['observed_at'] = observed_at
        if result.get('entitlement'):
            result['entitlement']['observed_at'] = observed_at
        return result

    def status(self):
        with self.lock:
            active = sum(profile['status'] == 'active' for profile in self.profiles.values())
            return {'account_count': len(self.profiles), 'active_count': active,
                'observed_count': sum(bool(item.get('observed_at')) for item in self.profiles.values()),
                'identity_match_count': sum(item.get('identity_match') is True
                                            for item in self.profiles.values()),
                'source_observed_at': max(item['observed_at'] for item in self.profiles.values()),
                'source_requests_total': self.source_requests_total,
                'fixture_profile_requests_total': self.fixture_profile_requests_total,
                'fixture_refresh_requests_total': self.fixture_refresh_requests_total,
                'profile_read_paused': self.profile_pause_reached.is_set()
                    and not self.profile_release.is_set(),
                'last_source_request_at': self.last_source_request_at,
                'source_cooldown_seconds': max(0, int(self.cooldown_until-time.monotonic())),
                'last_source_pass': self.last_source_pass,
                'provider_evidence_count': 0,
                'provenance': PROVENANCE,
                'payment_verification': PAYMENT_VERIFICATION,
                'cli_catalog': self.catalog}

    def set_cooldown(self, seconds):
        if type(seconds) is not int or not 1 <= seconds <= 3600:
            raise ValueError('Cooldown must be between 1 and 3600 seconds')
        with self.lock:
            self.cooldown_until = time.monotonic()+seconds

    def pause_profile_reads(self, after):
        if type(after) is not int or not 1 <= after <= 100:
            raise ValueError('Profile read pause must be after 1 to 100 reads')
        with self.lock:
            self.profile_pause_after = self.fixture_profile_requests_total+after
            self.profile_pause_reached.clear()
            self.profile_release.clear()

    def release_profile_reads(self):
        self.profile_release.set()
        return {'released': True}


class FixtureHandler(BaseHTTPRequestHandler):
    def log_message(self, *_):
        pass

    def _send(self, status, value, *, headers=None):
        raw = json.dumps(value, ensure_ascii=False, separators=(',', ':'),
                         allow_nan=False).encode('utf-8')
        self.send_response(status)
        self.send_header('Content-Type', 'application/json; charset=utf-8')
        self.send_header('Content-Length', str(len(raw)))
        for name, value in (headers or {}).items():
            self.send_header(name, value)
        self.end_headers()
        self.wfile.write(raw)

    def _auth(self, raw):
        try:
            timestamp = int(self.headers.get('X-Recovery-Timestamp', ''))
        except ValueError:
            return False
        if abs(time.time()-timestamp) > 300:
            return False
        expected = internal_signature(self.server.state.key, self.command,
            self.path, timestamp, raw)
        return hmac.compare_digest(expected, self.headers.get('X-Recovery-Signature', ''))

    def do_GET(self):
        if self.path == '/health':
            return self._send(200, {'role': 'fixture-provider', 'ready': True})
        if self.path.startswith('/fixture/'):
            if not hmac.compare_digest(self.headers.get('X-Fixture-Control', ''),
                                       self.server.state.control_key):
                return self._send(403, {'error': 'Fixture control denied'})
            if self.path == '/fixture/status':
                return self._send(200, self.server.state.status())
        if not self._auth(b''):
            return self._send(401, {'error': 'Fixture source authentication failed'})
        split = urlsplit(self.path)
        path = split.path
        state = self.server.state
        if path == '/internal/manifest':
            return self._send(200, state.manifest)
        if path == '/internal/provider/accounts':
            return self._send(200, state.accounts_page(split.query))
        if path == '/internal/provider/evidence':
            return self._send(200, {'items': [], 'next_cursor': None, 'total': 0})
        if path == '/internal/adapty/profiles':
            return self._send(200, state._page(
                [state.profiles[key] for key in sorted(state.profiles)], split.query))
        if path == '/internal/adapty/profile':
            user_id = parse_qs(split.query).get('user', [''])[0]
            profile, retry_after = state.profile(user_id)
            if retry_after:
                return self._send(429, {'error': 'Synthetic source cooldown'},
                                  headers={'Retry-After': str(retry_after)})
            if profile is None:
                return self._send(404, {'error': 'Unknown fixture account'})
            return self._send(200, profile)
        if path == '/internal/adapty/catalog':
            return self._send(200, state.catalog)
        if path == '/internal/live/status':
            return self._send(200, state.status())
        return self._send(404, {'error': 'Unknown fixture source route'})

    def do_POST(self):
        try:
            length = int(self.headers.get('Content-Length', '0'))
            if length < 0 or length > 1024*1024:
                return self._send(413, {'error': 'Fixture request size rejected'})
            raw = self.rfile.read(length)
            body = json.loads(raw or b'{}')
        except (ValueError, json.JSONDecodeError):
            return self._send(400, {'error': 'Fixture request is invalid'})
        state = self.server.state
        if self.path.startswith('/fixture/'):
            if not hmac.compare_digest(self.headers.get('X-Fixture-Control', ''),
                                       state.control_key):
                return self._send(403, {'error': 'Fixture control denied'})
            if self.path == '/fixture/cooldown':
                try:
                    state.set_cooldown(body.get('seconds') if isinstance(body, dict) else None)
                except ValueError as exc:
                    return self._send(400, {'error': str(exc)})
                return self._send(200, {'accepted': True})
            if self.path == '/fixture/profile':
                try:
                    profile = state.update_profile(body)
                except ValueError as exc:
                    return self._send(400, {'error': str(exc)})
                return self._send(200, profile)
            if self.path == '/fixture/profile-pause':
                try:
                    state.pause_profile_reads(body.get('after') if isinstance(body, dict) else None)
                except ValueError as exc:
                    return self._send(400, {'error': str(exc)})
                return self._send(200, {'paused_after': body['after']})
            if self.path == '/fixture/profile-release':
                return self._send(200, state.release_profile_reads())
            return self._send(404, {'error': 'Unknown fixture control'})
        if not self._auth(raw):
            return self._send(401, {'error': 'Fixture source authentication failed'})
        if self.path == '/internal/live/refresh':
            try:
                return self._send(200, state.refresh(body))
            except ValueError as exc:
                return self._send(400, {'error': str(exc)})
        return self._send(404, {'error': 'Unknown fixture source route'})


class FixtureHTTPServer(ThreadingHTTPServer):
    allow_reuse_address = True
    daemon_threads = True

    def __init__(self, address, state):
        self.state = state
        super().__init__(address, FixtureHandler)


def serve_provider(port, key_file, run_id, run_prefix):
    raw_key = Path(key_file).read_bytes().strip()
    key = bytes.fromhex(raw_key.decode('ascii'))
    state = SourceState(key, run_id, run_prefix)
    server = FixtureHTTPServer(('127.0.0.1', port), state)
    print(json.dumps({'port': server.server_port, 'role': 'fixture-provider',
                      'control_key': state.control_key}, separators=(',', ':')), flush=True)
    server.serve_forever()


def free_port():
    with socket.socket() as listener:
        listener.bind(('127.0.0.1', 0))
        return listener.getsockname()[1]


def _write_private(path, content):
    descriptor = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    try:
        os.write(descriptor, content)
        os.fsync(descriptor)
    finally:
        os.close(descriptor)


def _process_rss_kb(pid):
    """Read RSS from the native process resource API without spawning `ps`."""
    try:
        if sys.platform == 'darwin':
            library = ctypes.util.find_library('proc') or '/usr/lib/libproc.dylib'
            proc = ctypes.CDLL(library, use_errno=True)
            read_usage = proc.proc_pid_rusage
            read_usage.argtypes = [ctypes.c_int, ctypes.c_int, ctypes.c_void_p]
            read_usage.restype = ctypes.c_int
            usage_v0 = (ctypes.c_uint64*12)()
            if read_usage(pid, 0, ctypes.byref(usage_v0)) != 0:
                return None
            resident_bytes = usage_v0[8]
            return (resident_bytes+1023)//1024
        if sys.platform.startswith('linux'):
            pages = Path(f'/proc/{pid}/statm').read_text().split()[1]
            page_size = os.sysconf('SC_PAGE_SIZE')
            return (int(pages)*page_size+1023)//1024
    except (OSError, AttributeError, IndexError, ValueError):
        return None
    return None


class FulfillmentDemo:
    """Run fixture provider, actual Lumen, and actual engine on isolated ports."""

    def __init__(self, runtime, *, auto_repair=True, live_bootstrap_pending=False):
        self.runtime = Path(runtime).resolve()
        self.auto_repair = bool(auto_repair)
        self.live_bootstrap_pending = bool(live_bootstrap_pending)
        if self.live_bootstrap_pending and not self.auto_repair:
            raise ValueError('Pending bootstrap requires automatic repair')
        self.run_id = 'uat-'+secrets.token_hex(8)
        self.run_prefix = 'uat_fixture_'+secrets.token_hex(4)
        self.processes = {}
        self.logs = {}
        self.urls = {}
        self.control_key = None
        self.key = secrets.token_bytes(32)
        self.engine_command = None
        self.config_path = self.runtime/'live-config.json'
        self.key_file = self.runtime/'shared.key'

    def _start(self, role, command, timeout=60):
        log = (self.runtime/(role+'.log')).open('ab')
        self.logs[role] = log
        process = subprocess.Popen(command, stdout=subprocess.PIPE, stderr=log, text=True)
        self.processes[role] = process
        with selectors.DefaultSelector() as selector:
            selector.register(process.stdout, selectors.EVENT_READ)
            if not selector.select(timeout=timeout):
                raise RuntimeError(f'{role} did not announce readiness')
            line = process.stdout.readline()
        if not line:
            raise RuntimeError(f'{role} exited during startup')
        try:
            announcement = json.loads(line)
            port = int(announcement['port'])
            if not 1 <= port <= 65535:
                raise ValueError('Invalid port')
        except (ValueError, KeyError, TypeError, json.JSONDecodeError) as exc:
            raise RuntimeError(f'{role} returned an invalid startup announcement') from exc
        self.urls[role] = f'http://127.0.0.1:{port}'
        with urlopen(self.urls[role]+'/health', timeout=5) as response:
            if response.status != 200:
                raise RuntimeError(f'{role} failed its health check')
        if role == 'provider':
            self.control_key = announcement['control_key']
        return process

    def start(self):
        self.runtime.mkdir(parents=True, exist_ok=True, mode=0o700)
        _write_private(self.key_file, self.key.hex().encode('ascii')+b'\n')
        secret = self.runtime/'fixture-only-adapty-key'
        _write_private(secret, b'not-a-real-provider-key; fixture transport only\n')
        customer_ids = [f'{self.run_prefix}-{index:03d}' for index in range(100)]
        config = {'app_id': APP_ID, 'title': APP_TITLE,
            'environment': APP_ENVIRONMENT, 'source_environment': SOURCE_ENVIRONMENT,
            'seed': {'revision': 'synthetic-fixture-v1', 'run_prefix': self.run_prefix},
            'customer_user_ids': customer_ids, 'secret_key_file': str(secret)}
        _write_private(self.config_path, json.dumps(config).encode('utf-8'))
        self._start('provider', [sys.executable, str(Path(__file__).resolve()),
            '--serve-provider', '--port', '0', '--key-file', str(self.key_file),
            '--run-id', self.run_id, '--run-prefix', self.run_prefix])
        engine_port = free_port()
        lumen_command = [sys.executable, '-u', str(SERVICE), '--role', 'lumen',
            '--port', '0', '--db', str(self.runtime/'lumen.sqlite3'),
            '--key-file', str(self.key_file), '--provider-url', self.urls['provider'],
            '--collector-url', f'http://127.0.0.1:{engine_port}/api/recovery/collector',
            '--demo', '--live-config', str(self.config_path)]
        if self.live_bootstrap_pending:
            lumen_command.append('--live-bootstrap-pending')
        self._start('lumen', lumen_command)
        command = [sys.executable, '-u', str(SERVICE), '--role', 'engine',
            '--port', str(engine_port), '--db', str(self.runtime/'engine.sqlite3'),
            '--key-file', str(self.key_file), '--provider-url', self.urls['provider'],
            '--lumen-url', self.urls['lumen'], '--demo', '--live-config', str(self.config_path)]
        if self.auto_repair:
            command.append('--auto-repair')
        if self.live_bootstrap_pending:
            command.append('--live-bootstrap-pending')
        self.engine_command = command
        self._start('engine', command)
        return self

    def set_source_cooldown(self, seconds):
        from urllib.request import Request
        request = Request(self.urls['provider']+'/fixture/cooldown',
            data=json.dumps({'seconds': seconds}).encode('utf-8'), method='POST',
            headers={'Content-Type': 'application/json',
                     'X-Fixture-Control': self.control_key})
        with urlopen(request, timeout=5) as response:
            return json.load(response)

    def update_source_profile(self, user_id, **changes):
        from urllib.request import Request
        request = Request(self.urls['provider']+'/fixture/profile',
            data=json.dumps({'user_id': user_id, **changes}).encode('utf-8'), method='POST',
            headers={'Content-Type': 'application/json',
                     'X-Fixture-Control': self.control_key})
        with urlopen(request, timeout=5) as response:
            return json.load(response)

    def source_fixture_status(self):
        from urllib.request import Request
        request = Request(self.urls['provider']+'/fixture/status',
            headers={'X-Fixture-Control': self.control_key})
        with urlopen(request, timeout=5) as response:
            return json.load(response)

    def pause_source_profile_reads(self, after):
        return self._fixture_post('profile-pause', {'after': after})

    def release_source_profile_reads(self):
        return self._fixture_post('profile-release', {})

    def _fixture_post(self, path, body):
        from urllib.request import Request
        request = Request(self.urls['provider']+'/fixture/'+path,
            data=json.dumps(body).encode('utf-8'), method='POST',
            headers={'Content-Type': 'application/json',
                     'X-Fixture-Control': self.control_key})
        with urlopen(request, timeout=5) as response:
            return json.load(response)

    def stop_role(self, role):
        process = self.processes.pop(role, None)
        if process:
            if process.poll() is None:
                process.terminate()
                try:
                    process.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    process.kill()
                    process.wait(timeout=5)
            if process.stdout:
                process.stdout.close()
        log = self.logs.pop(role, None)
        if log:
            log.close()

    def restart_engine(self):
        if not self.engine_command:
            raise RuntimeError('Engine has not been started')
        self.stop_role('engine')
        return self._start('engine', self.engine_command)

    def measurements(self):
        """Measure process RSS and runtime file sizes without opening a database."""
        rss_kb = {}
        for role, process in self.processes.items():
            rss_kb[role] = _process_rss_kb(process.pid)
        storage_bytes = 0
        for path in self.runtime.iterdir():
            if (not path.is_file() or not (path.name.endswith('.sqlite3')
                    or '.sqlite3-' in path.name or path.name.endswith('.sqlite3-wal')
                    or path.name.endswith('.sqlite3-shm'))):
                continue
            try:
                storage_bytes += path.stat().st_size
            except FileNotFoundError:
                continue
        return {'process_rss_kb': rss_kb, 'runtime_storage_bytes': storage_bytes}

    def close(self):
        for role in ('engine', 'lumen', 'provider'):
            self.stop_role(role)

    def __enter__(self):
        try:
            return self.start()
        except BaseException:
            self.close()
            raise

    def __exit__(self, *_):
        self.close()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--serve-provider', action='store_true')
    parser.add_argument('--port', type=int, default=0)
    parser.add_argument('--key-file', type=Path)
    parser.add_argument('--run-id')
    parser.add_argument('--run-prefix')
    args = parser.parse_args()
    if not args.serve_provider or not args.key_file or not args.run_id or not args.run_prefix:
        parser.error('provider process requires --serve-provider, --key-file, --run-id, --run-prefix')
    if not 0 <= args.port <= 65535:
        parser.error('--port must be between 0 and 65535')
    serve_provider(args.port, args.key_file, args.run_id, args.run_prefix)


if __name__ == '__main__':
    main()
