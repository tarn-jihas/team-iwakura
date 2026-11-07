"""Thin server SDK for versioned, signed Reconcile recovery events."""
from __future__ import annotations

from datetime import datetime, timezone
from email.utils import parsedate_to_datetime
import hashlib
import hmac
import http.client
import json
import math
import os
from pathlib import Path
import sqlite3
import threading
import time
from urllib.parse import urlsplit
from uuid import uuid4

SCHEMA_VERSION = 1
KINDS = frozenset({
    'webhook_received', 'handler_completed', 'access_projection_changed',
    'feature_access_decided', 'source_entitlement_observed',
    'resync_requested', 'resync_completed', 'verification_completed',
})
EVENT_FIELDS = frozenset({
    'schema_version', 'event_id', 'run_id', 'app', 'environment', 'app_user_id',
    'kind', 'occurred_at', 'correlation_id', 'source_event_id', 'details',
})
STATE_FIELDS = frozenset({
    'active', 'premium', 'expires_at', 'revision', 'cache_revision',
    'projection_revision', 'source_hash', 'invalidated', 'cached_at',
})
DETAIL_FIELDS = frozenset({
    'event_type', 'handler_version', 'received_at', 'processed_at', 'outcome',
    'reason_code', 'projection_version', 'cache_version', 'source_hash',
    'before', 'after', 'cache_invalidated', 'feature', 'decision',
    'policy_version', 'adapter_version', 'initiator', 'starts_at', 'expires_at',
    'action_id', 'expected_revision', 'actual_revision',
})
_DETAIL_KEYS = {
    'webhook_received': frozenset({'event_type', 'handler_version', 'received_at', 'processed_at', 'outcome'}),
    'handler_completed': frozenset({'event_type', 'handler_version', 'received_at', 'processed_at', 'outcome', 'reason_code'}),
    'source_entitlement_observed': frozenset({'source_hash', 'starts_at', 'expires_at', 'adapter_version', 'outcome', 'reason_code'}),
    'feature_access_decided': frozenset({'feature', 'decision', 'reason_code', 'projection_version', 'cache_version', 'policy_version', 'adapter_version', 'initiator'}),
    'resync_requested': frozenset({'action_id', 'source_hash', 'expected_revision', 'policy_version', 'adapter_version', 'projection_version', 'cache_version', 'outcome', 'reason_code'}),
    'resync_completed': frozenset({'action_id', 'source_hash', 'expected_revision', 'policy_version', 'adapter_version', 'projection_version', 'cache_version', 'outcome', 'reason_code', 'processed_at', 'cache_invalidated', 'actual_revision'}),
    'verification_completed': frozenset({'feature', 'decision', 'outcome', 'reason_code', 'action_id', 'policy_version', 'adapter_version', 'projection_version', 'cache_version', 'actual_revision'}),
}
_PROJECTION_CANCEL_FIELDS = frozenset({
    'event_type', 'handler_version', 'projection_version', 'cache_version',
    'source_hash', 'before', 'after', 'processed_at', 'reason_code', 'cache_invalidated',
})
_PROJECTION_RESYNC_FIELDS = frozenset({
    'action_id', 'source_hash', 'expected_revision', 'policy_version',
    'adapter_version', 'projection_version', 'cache_version', 'outcome',
    'before', 'after', 'cache_invalidated',
})
_REASONS = frozenset({
    'allowed', 'policy_restricted', 'identity_ambiguous', 'identity_mismatch',
    'identity_unavailable', 'cache_unavailable', 'cache_stale',
    'subscription_expired', 'subscription_inactive', 'none',
    'source_unavailable', 'identity_source_mismatch', 'approved_resync',
    'resync_completed', 'cache_refresh_skipped', 'renewal_cancelled',
    'handler_completed',
})
_MAX_EVENT_BYTES = 16 * 1024
_MAX_PENDING = 1000
_MAX_RECORDS = 2000
_RETENTION_SECONDS = 30 * 24 * 60 * 60
_MAX_ATTEMPTS = 5
_BATCH_SIZE = 25


class CollectorAuthError(ValueError):
    """Raised for invalid collector keys, signatures, or event scopes."""

    def __init__(self, status=None):
        self.status = status
        super().__init__('Collector authentication failed')


class CollectorHTTPError(RuntimeError):
    """HTTP failure with only bounded, non-sensitive retry metadata."""

    def __init__(self, status, retry_after=None):
        self.status = status if type(status) is int else 0
        self.retry_after = _retry_seconds(retry_after, 1) if self.status == 429 else None
        super().__init__('Collector request failed (HTTP '+str(self.status)+')')


def canonical(value):
    return json.dumps(value, sort_keys=True, separators=(',', ':'),
                      ensure_ascii=False, allow_nan=False).encode('utf-8')


def digest(value):
    return hashlib.sha256(canonical(value)).hexdigest()


def _key(key):
    value = key.encode('utf-8') if isinstance(key, str) else key
    if not isinstance(value, bytes) or len(value) < 32:
        raise CollectorAuthError()
    return value


def sign(envelope, key):
    return hmac.new(_key(key), canonical(envelope), hashlib.sha256).hexdigest()


def _text(value, name, limit=256):
    if (not isinstance(value, str) or not value or value != value.strip()
            or len(value) > limit or any(ord(char) < 32 or ord(char) == 127 for char in value)):
        raise ValueError('Invalid collector '+name)


def _timestamp(value, name, allow_none=False):
    if allow_none and value is None:
        return
    if not isinstance(value, str):
        raise ValueError('Invalid collector '+name)
    try:
        parsed = datetime.fromisoformat(value.replace('Z', '+00:00'))
    except ValueError as exc:
        raise ValueError('Invalid collector '+name) from exc
    if parsed.tzinfo is None or parsed.utcoffset() != timezone.utc.utcoffset(parsed):
        raise ValueError('Collector '+name+' must be UTC')


def _state(value, name):
    if not isinstance(value, dict) or set(value) - STATE_FIELDS:
        raise ValueError('Invalid collector '+name+' state')
    for field, item in value.items():
        if field in ('active', 'premium', 'invalidated'):
            if type(item) is not bool:
                raise ValueError('Invalid collector state value')
        elif field in ('revision', 'cache_revision', 'projection_revision'):
            if type(item) is not int or item < 0:
                raise ValueError('Invalid collector state value')
        elif field in ('expires_at', 'cached_at'):
            _timestamp(item, field, allow_none=True)
        else:
            _text(item, field)


def _validate_details(kind, details):
    if not isinstance(details, dict) or set(details) - DETAIL_FIELDS:
        raise ValueError('Collector details do not match the metadata contract')
    if kind == 'access_projection_changed':
        expected = _PROJECTION_RESYNC_FIELDS if 'action_id' in details else _PROJECTION_CANCEL_FIELDS
    else:
        expected = _DETAIL_KEYS[kind]
    if set(details) != expected:
        raise ValueError('Collector details do not match the event contract')

    for field, value in details.items():
        if field in ('before', 'after'):
            _state(value, field)
        elif field in ('starts_at', 'expires_at', 'processed_at', 'received_at'):
            _timestamp(value, field, allow_none=field in ('starts_at', 'expires_at'))
        elif field in ('expected_revision', 'actual_revision'):
            if type(value) is not int or value < 0:
                raise ValueError('Invalid collector '+field)
        elif field == 'cache_invalidated':
            if type(value) is not bool:
                raise ValueError('Invalid collector '+field)
        else:
            _text(value, field)

    if 'feature' in details and details['feature'] != 'premium_export':
        raise ValueError('Unsupported collector feature')
    if 'decision' in details and details['decision'] not in ('allow', 'deny'):
        raise ValueError('Unsupported collector decision')
    if 'initiator' in details and details['initiator'] not in ('customer_demo', 'reconcile_probe'):
        raise ValueError('Unsupported collector initiator')
    if 'reason_code' in details and details['reason_code'] not in _REASONS:
        raise ValueError('Unsupported collector reason code')
    if 'event_type' in details and details['event_type'] != 'subscription_renewal_cancelled':
        raise ValueError('Unsupported collector event type')
    if 'handler_version' in details and details['handler_version'] not in ('cancel-handler-v1', 'cancel-handler-v2'):
        raise ValueError('Unsupported collector handler version')
    if 'outcome' in details:
        outcomes = {
            'webhook_received': ('accepted',),
            'handler_completed': ('completed',),
            'source_entitlement_observed': ('observed', 'unavailable'),
            'resync_requested': ('requested',),
            'resync_completed': ('accepted',),
            'verification_completed': ('verified', 'failed'),
        }
        if details['outcome'] not in outcomes.get(kind, ('projection_updated',)):
            raise ValueError('Unsupported collector outcome')


def validate_event(event, run_id=None, app=None, environment=None):
    """Validate one exact version-1 collector DTO and optional fixed scope."""
    if not isinstance(event, dict) or set(event) != EVENT_FIELDS:
        raise ValueError('Collector event fields do not match the metadata contract')
    if type(event['schema_version']) is not int or event['schema_version'] != SCHEMA_VERSION:
        raise ValueError('Unsupported collector event schema version')
    for name in EVENT_FIELDS - {'schema_version', 'details'}:
        _text(event[name], name, 128 if name in ('run_id', 'app', 'environment', 'app_user_id') else 256)
    _timestamp(event['occurred_at'], 'occurred_at')
    if event['kind'] not in KINDS:
        raise ValueError('Unsupported collector event kind')
    if run_id is not None and event['run_id'] != run_id:
        raise ValueError('Collector run scope mismatch')
    if app is not None and event['app'] != app:
        raise ValueError('Collector app scope mismatch')
    if environment is not None and event['environment'] != environment:
        raise ValueError('Collector environment scope mismatch')
    _validate_details(event['kind'], event['details'])
    if len(canonical(event)) > _MAX_EVENT_BYTES:
        raise ValueError('Collector event is too large')


def _http_target(url, timeout):
    if (isinstance(timeout, bool) or not isinstance(timeout, (int, float))
            or not 0 < timeout <= 5):
        raise ValueError('Collector timeout must be from 0 to 5 seconds')
    try:
        parsed = urlsplit(url)
        port = parsed.port or 80
    except (TypeError, ValueError) as exc:
        raise ValueError('Collector URL must use a loopback HTTP endpoint') from exc
    if (parsed.scheme != 'http' or parsed.hostname != '127.0.0.1'
            or parsed.username or parsed.password or parsed.fragment or parsed.query
            or parsed.path not in ('/api/recovery/collector', '/api/collector/events')
            or not 1 <= port <= 65535):
        raise ValueError('Collector URL must use a loopback HTTP endpoint')
    return parsed.path, port, timeout


def http_transport(url, timeout=3):
    """Create a bounded HTTP transport restricted to the local collector."""
    path, port, timeout = _http_target(url, timeout)

    def deliver(envelope, signature):
        connection = http.client.HTTPConnection('127.0.0.1', port, timeout=timeout)
        try:
            connection.request('POST', path, body=canonical(envelope), headers={
                'Content-Type': 'application/json', 'Accept': 'application/json',
                'X-Reconcile-Signature': signature,
            })
            response = connection.getresponse()
            if response.status in (401, 403):
                response.read(1024)
                raise CollectorAuthError(response.status)
            if response.status != 200:
                retry_after = response.getheader('Retry-After') if response.status == 429 else None
                response.read(1024)
                raise CollectorHTTPError(response.status, retry_after)
            payload = response.read(16 * 1024 + 1)
            if len(payload) > 16 * 1024:
                raise ValueError('Collector acknowledgement is too large')
            try:
                result = json.loads(payload)
            except (ValueError, UnicodeDecodeError) as exc:
                raise ValueError('Collector acknowledgement is invalid') from exc
            if not isinstance(result, dict):
                raise ValueError('Collector acknowledgement is invalid')
            return result
        finally:
            connection.close()

    return deliver


def _retry_seconds(value, attempt):
    fallback = min(2 ** min(attempt, 6), 60)
    if value is None:
        return fallback
    try:
        try:
            seconds = float(value)
        except (TypeError, ValueError):
            deadline = parsedate_to_datetime(value)
            if deadline.tzinfo is None:
                return fallback
            seconds = (deadline - datetime.now(timezone.utc)).total_seconds()
        return min((2 ** 63 - 1) - math.ceil(time.time()), max(1, math.ceil(seconds)))
    except (TypeError, ValueError, OverflowError):
        return fallback


class CollectorSDK:
    """Version, sign, and durably retry bounded collector metadata events."""

    def __init__(self, key, run_id, app, transport, *, outbox_path,
                 collector_url=None, environment='Production'):
        self.key = _key(key)
        _text(run_id, 'run_id', 128)
        _text(app, 'app', 128)
        _text(environment, 'environment', 128)
        if collector_url is not None:
            _http_target(collector_url, 3)
        if transport is None:
            if collector_url is None:
                raise ValueError('A collector transport or URL is required')
            transport = http_transport(collector_url)
        if not callable(transport):
            raise ValueError('Collector transport must be callable')
        try:
            self.outbox_path = Path(os.fspath(outbox_path))
        except (TypeError, ValueError) as exc:
            raise ValueError('Invalid collector outbox path') from exc
        if not str(self.outbox_path):
            raise ValueError('Invalid collector outbox path')
        self.run_id, self.app, self.environment = run_id, app, environment
        self.transport = transport
        self._lock = threading.RLock()
        self._flush_lock = threading.Lock()
        self._last_error = None
        self._memory = {'accepted': 0, 'dropped': 0, 'failed': 0, 'retries': 0}
        try:
            db = self._db()
            db.close()
        except (OSError, sqlite3.Error):
            self._last_error = 'outbox_unavailable'

    def _db(self):
        self.outbox_path.parent.mkdir(parents=True, exist_ok=True)
        db = sqlite3.connect(self.outbox_path, timeout=0.2, isolation_level=None)
        db.row_factory = sqlite3.Row
        db.execute('PRAGMA busy_timeout=200')
        db.execute('PRAGMA synchronous=FULL')
        db.executescript('''
            CREATE TABLE IF NOT EXISTS sdk_events(
                event_id TEXT PRIMARY KEY, event_hash TEXT NOT NULL, event_json TEXT NOT NULL,
                state TEXT NOT NULL CHECK(state IN ('queued','accepted','dropped')),
                created_at INTEGER NOT NULL, attempts INTEGER NOT NULL DEFAULT 0,
                next_attempt_at INTEGER NOT NULL DEFAULT 0, last_error TEXT
            );
            CREATE TABLE IF NOT EXISTS sdk_stats(key TEXT PRIMARY KEY, value INTEGER NOT NULL);
            CREATE TABLE IF NOT EXISTS sdk_meta(key TEXT PRIMARY KEY, value TEXT NOT NULL);
        ''')
        try:
            os.chmod(self.outbox_path, 0o600)
        except OSError:
            pass
        return db

    def _sync_memory(self, db):
        increments = {name: value for name, value in self._memory.items() if value}
        if increments or self._last_error is not None:
            db.execute('BEGIN IMMEDIATE')
            for name, value in increments.items():
                db.execute('INSERT INTO sdk_stats(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=value+excluded.value',
                           (name, value))
            if self._last_error is not None:
                db.execute('INSERT INTO sdk_meta(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value',
                           ('last_error', self._last_error))
            db.execute('COMMIT')
            for name in increments:
                self._memory[name] = 0

    @staticmethod
    def _inc(db, name, amount=1):
        db.execute('INSERT INTO sdk_stats(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=value+excluded.value',
                   (name, amount))

    def _save_event(self, event, event_hash):
        db = None
        try:
            db = self._db()
            self._sync_memory(db)
            db.execute('BEGIN IMMEDIATE')
            now = int(time.time())
            cutoff = now - _RETENTION_SECONDS
            stale_queued = db.execute("SELECT COUNT(*) FROM sdk_events WHERE state='queued' AND created_at<?", (cutoff,)).fetchone()[0]
            if stale_queued:
                db.execute("UPDATE sdk_events SET state='dropped',last_error='retention_expired' WHERE state='queued' AND created_at<?", (cutoff,))
                self._inc(db, 'dropped', stale_queued)
            db.execute('DELETE FROM sdk_events WHERE created_at<?', (cutoff,))
            previous = db.execute('SELECT event_hash,state FROM sdk_events WHERE event_id=?', (event['event_id'],)).fetchone()
            if previous is not None:
                if previous['event_hash'] != event_hash:
                    db.execute('ROLLBACK')
                    raise ValueError('Collector event ID is already bound to a different payload')
                db.execute('COMMIT')
                return previous['state']
            total = db.execute('SELECT COUNT(*) FROM sdk_events').fetchone()[0]
            while total >= _MAX_RECORDS:
                old = db.execute("SELECT event_id FROM sdk_events WHERE state!='queued' ORDER BY created_at,event_id LIMIT 1").fetchone()
                if old is None:
                    break
                db.execute('DELETE FROM sdk_events WHERE event_id=?', (old['event_id'],))
                total -= 1
            pending = db.execute("SELECT COUNT(*) FROM sdk_events WHERE state='queued'").fetchone()[0]
            state = 'queued' if pending < _MAX_PENDING and total < _MAX_RECORDS else 'dropped'
            db.execute('INSERT INTO sdk_events(event_id,event_hash,event_json,state,created_at,last_error) VALUES(?,?,?,?,?,?)',
                       (event['event_id'], event_hash, canonical(event).decode('utf-8'), state, now,
                        None if state == 'queued' else 'queue_full'))
            if state == 'dropped':
                self._inc(db, 'dropped')
                db.execute('INSERT INTO sdk_meta(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value',
                           ('last_error', 'queue_full'))
                self._last_error = 'queue_full'
            db.execute('COMMIT')
            return state
        except ValueError:
            raise
        except (OSError, sqlite3.Error):
            if db is not None and db.in_transaction:
                db.execute('ROLLBACK')
            self._memory['dropped'] += 1
            self._last_error = 'outbox_unavailable'
            return 'dropped'
        finally:
            if db is not None:
                db.close()

    def _take_batch(self, limit=_BATCH_SIZE):
        db = self._db()
        try:
            self._sync_memory(db)
            db.execute('BEGIN IMMEDIATE')
            now = int(time.time())
            exhausted = db.execute("SELECT event_id FROM sdk_events WHERE state='queued' AND attempts>=?", (_MAX_ATTEMPTS,)).fetchall()
            if exhausted:
                db.executemany("UPDATE sdk_events SET state='dropped',last_error='attempts_exhausted' WHERE event_id=?", ((row['event_id'],) for row in exhausted))
                self._inc(db, 'dropped', len(exhausted))
            rows = db.execute("SELECT event_id,event_hash,event_json,attempts FROM sdk_events WHERE state='queued' AND next_attempt_at<=? ORDER BY created_at,event_id LIMIT ?", (now, limit)).fetchall()
            for row in rows:
                db.execute('UPDATE sdk_events SET attempts=attempts+1 WHERE event_id=? AND state=\'queued\'', (row['event_id'],))
            db.execute('COMMIT')
            return [(row['event_id'], row['event_hash'], row['event_json'], row['attempts'] + 1) for row in rows]
        except Exception:
            if db.in_transaction:
                db.execute('ROLLBACK')
            raise
        finally:
            db.close()

    def _finish(self, event_id, *, accepted=False, error=None, retry_after=None, attempt=1, permanent=False):
        db = self._db()
        try:
            self._sync_memory(db)
            db.execute('BEGIN IMMEDIATE')
            if accepted:
                changed = db.execute("UPDATE sdk_events SET state='accepted',next_attempt_at=0,last_error=NULL WHERE event_id=? AND state='queued'", (event_id,)).rowcount
                if changed:
                    self._inc(db, 'accepted')
                    db.execute("INSERT INTO sdk_meta(key,value) VALUES('last_error','') ON CONFLICT(key) DO UPDATE SET value='' ")
                    self._last_error = None
            else:
                retry = not permanent and attempt < _MAX_ATTEMPTS
                if retry:
                    delay = _retry_seconds(retry_after, attempt)
                    db.execute("UPDATE sdk_events SET next_attempt_at=?,last_error=? WHERE event_id=? AND state='queued'",
                               (math.ceil(time.time()) + delay, error, event_id))
                    self._inc(db, 'retries')
                else:
                    db.execute("UPDATE sdk_events SET state='dropped',last_error=? WHERE event_id=? AND state='queued'",
                               (error, event_id))
                    self._inc(db, 'dropped')
                self._inc(db, 'failed')
                self._last_error = error
                db.execute('INSERT INTO sdk_meta(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value',
                           ('last_error', error))
            db.execute('COMMIT')
        except Exception:
            if db.in_transaction:
                db.execute('ROLLBACK')
            raise
        finally:
            db.close()

    def emit(self, kind, user_id, occurred_at, details, *, event_id=None,
             source_event_id=None, correlation_id=None):
        event_id = str(uuid4()) if event_id is None else event_id
        source_event_id = event_id if source_event_id is None else source_event_id
        correlation_id = event_id if correlation_id is None else correlation_id
        event = {
            'schema_version': SCHEMA_VERSION,
            'event_id': event_id, 'run_id': self.run_id, 'app': self.app,
            'environment': self.environment, 'app_user_id': user_id,
            'kind': kind, 'occurred_at': occurred_at,
            'correlation_id': correlation_id,
            'source_event_id': source_event_id,
            'details': details,
        }
        validate_event(event, self.run_id, self.app, self.environment)
        payload = canonical(event)
        event = json.loads(payload)
        event_hash = hashlib.sha256(payload).hexdigest()
        with self._lock:
            state = self._save_event(event, event_hash)
            return {
                'event_id': event_id, 'event_hash': event_hash,
                'queued': state == 'queued', 'accepted': state == 'accepted',
            }

    def flush(self):
        """Attempt one bounded batch; retries are deferred without sleeping."""
        return self._flush(_BATCH_SIZE)

    def _flush(self, limit):
        result = {'accepted': 0, 'dropped': 0, 'failed': 0, 'retries': 0}
        if not self._flush_lock.acquire(blocking=False):
            return result
        try:
            try:
                with self._lock:
                    rows = self._take_batch(limit)
            except (OSError, sqlite3.Error):
                self._last_error = 'outbox_unavailable'
                return result
            for event_id, event_hash, event_json, attempt in rows:
                accepted, error, retry_after, permanent = False, None, None, False
                try:
                    event = json.loads(event_json)
                    envelope = {'schema_version': SCHEMA_VERSION, 'event': event,
                                'sent_at': int(time.time())}
                    receipt = self.transport(envelope, sign(envelope, self.key))
                    if (not isinstance(receipt, dict) or receipt.get('accepted') is not True
                            or receipt.get('event_id') != event_id
                            or receipt.get('event_hash') != event_hash
                            or type(receipt.get('duplicate')) is not bool):
                        raise ValueError('invalid_ack')
                    accepted = True
                except CollectorHTTPError as exc:
                    permanent = 400 <= exc.status < 500 and exc.status != 429
                    error = 'http_'+str(exc.status)
                    retry_after = exc.retry_after
                except CollectorAuthError as exc:
                    error = 'http_'+str(exc.status) if exc.status in (401, 403) else 'auth_error'
                    permanent = True
                except Exception as exc:
                    error = 'invalid_ack' if isinstance(exc, ValueError) else 'transport_error'
                try:
                    with self._lock:
                        self._finish(event_id, accepted=accepted, error=error,
                                     retry_after=retry_after, attempt=attempt, permanent=permanent)
                except (OSError, sqlite3.Error):
                    self._last_error = 'outbox_unavailable'
                else:
                    if accepted:
                        result['accepted'] += 1
                if not accepted:
                    result['failed'] += 1
                    if permanent or attempt >= _MAX_ATTEMPTS:
                        result['dropped'] += 1
                    else:
                        result['retries'] += 1
            return result
        finally:
            self._flush_lock.release()

    def coverage(self):
        """Return durable aggregate delivery counts without event contents."""
        with self._lock:
            return self._coverage()

    def _coverage(self):
        db = None
        try:
            db = self._db()
            self._sync_memory(db)
            counts = {row['key']: row['value'] for row in db.execute('SELECT key,value FROM sdk_stats')}
            queued = db.execute("SELECT COUNT(*) FROM sdk_events WHERE state='queued'").fetchone()[0]
            row = db.execute("SELECT value FROM sdk_meta WHERE key='last_error'").fetchone()
            last_error = None if row is None or not row['value'] else row['value']
            return {
                'queued': queued,
                'accepted': counts.get('accepted', 0),
                'dropped': counts.get('dropped', 0),
                'failed': counts.get('failed', 0),
                'retries': counts.get('retries', 0),
                'last_error': last_error,
            }
        except (OSError, sqlite3.Error):
            self._last_error = 'outbox_unavailable'
            return {
                'queued': 0, 'accepted': self._memory['accepted'],
                'dropped': self._memory['dropped'], 'failed': self._memory['failed'],
                'retries': self._memory['retries'], 'last_error': self._last_error,
            }
        finally:
            if db is not None:
                db.close()
