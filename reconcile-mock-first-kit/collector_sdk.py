"""Small server-side SDK for our local subscription/access journal, not card data."""
from datetime import datetime, timezone
import hashlib
import hmac
import http.client
import json
import time
from urllib.parse import urlsplit
from uuid import uuid4

KINDS = frozenset({
    'webhook_received', 'handler_completed', 'access_projection_changed',
    'feature_access_decided', 'resync_requested', 'resync_completed',
    'verification_completed', 'source_entitlement_observed',
})
DETAIL_FIELDS = frozenset({
    'transaction_id', 'original_transaction_id', 'currency', 'amount', 'starts_at',
    'expires_at', 'source_hash', 'handler_version', 'projection_version',
    'cache_version', 'before', 'after', 'feature', 'decision', 'reason_code',
    'action_id', 'outcome', 'policy_version', 'adapter_version', 'initiator',
    'received_at', 'processed_at', 'event_type', 'expected_revision',
    'actual_revision', 'cache_invalidated',
})
STATE_FIELDS = frozenset({
    'active', 'premium', 'expires_at', 'revision', 'cache_revision',
    'projection_revision', 'source_hash', 'invalidated', 'cached_at',
})
EVENT_FIELDS = frozenset({
    'event_id', 'run_id', 'app', 'environment', 'app_user_id', 'kind',
    'occurred_at', 'correlation_id', 'source_event_id', 'details',
})


class CollectorAuthError(ValueError):
    pass


def canonical(value):
    return json.dumps(value, sort_keys=True, separators=(',', ':'), ensure_ascii=False, allow_nan=False).encode('utf-8')


def digest(value):
    return hashlib.sha256(canonical(value)).hexdigest()


def _key(key):
    value = key.encode() if isinstance(key, str) else key
    if not isinstance(value, bytes) or len(value) < 32:
        raise ValueError('Collector key must contain at least 32 bytes')
    return value


def sign(envelope, key):
    return hmac.new(_key(key), canonical(envelope), hashlib.sha256).hexdigest()


def _text(value, name):
    if not isinstance(value, str) or not value.strip() or len(value) > 256:
        raise ValueError('Invalid collector '+name)


def validate_event(event, run_id, app):
    if not isinstance(event, dict) or set(event) != EVENT_FIELDS:
        raise ValueError('Collector event fields do not match the metadata contract')
    for name in EVENT_FIELDS - {'details'}:
        _text(event[name], name)
    if event['run_id'] != run_id or event['app'] != app or event['environment'] != 'Production':
        raise ValueError('Collector scope mismatch')
    if event['kind'] not in KINDS:
        raise ValueError('Unsupported collector event kind')
    try:
        occurred = datetime.fromisoformat(event['occurred_at'].replace('Z', '+00:00'))
    except (ValueError, TypeError) as exc:
        raise ValueError('Invalid occurrence timestamp') from exc
    if occurred.tzinfo is None:
        raise ValueError('Occurrence timestamp must include its timezone')
    details = event['details']
    if not isinstance(details, dict) or set(details) - DETAIL_FIELDS:
        raise ValueError('Only allowlisted subscription/access metadata is accepted')
    for name, value in details.items():
        if name in ('before', 'after'):
            if not isinstance(value, dict) or set(value) - STATE_FIELDS:
                raise ValueError('Invalid client-state metadata')
            values = value.values()
        else:
            values = [value]
        if any(not isinstance(item, (str, int, float, bool, type(None))) for item in values):
            raise ValueError('Collector metadata must be scalar')
    if len(canonical(event)) > 16 * 1024:
        raise ValueError('Collector event is too large')


def ingest_event(events, seen, key, run_id, app, envelope, signature, now=None):
    """Validate before touching the journal; caller persists the enclosing state."""
    if not isinstance(envelope, dict) or set(envelope) != {'event', 'sent_at'}:
        raise ValueError('Invalid collector envelope')
    sent_at = envelope['sent_at']
    if isinstance(sent_at, bool) or not isinstance(sent_at, int):
        raise CollectorAuthError('Invalid collector signing time')
    if abs((time.time() if now is None else now) - sent_at) > 300:
        raise CollectorAuthError('Collector signature expired')
    if not isinstance(signature, str) or not hmac.compare_digest(sign(envelope, key), signature):
        raise CollectorAuthError('Invalid collector signature')
    event = envelope['event']
    validate_event(event, run_id, app)
    event_hash = digest(event)
    previous = seen.get(event['event_id'])
    if previous is not None:
        if previous != event_hash:
            raise ValueError('Collector event ID already has a different payload')
        return {'accepted': True, 'duplicate': True, 'event_id': event['event_id'], 'event_hash': event_hash}
    recorded_at = datetime.fromtimestamp(time.time() if now is None else now, timezone.utc).isoformat()
    # Reparse canonical bytes so a caller cannot mutate already-recorded evidence.
    events.append({**json.loads(canonical(event)), 'payload_hash': event_hash,
                   'recorded_at_wall': recorded_at, 'signature_verified': True,
                   'provenance': 'client_simulator'})
    seen[event['event_id']] = event_hash
    return {'accepted': True, 'duplicate': False, 'event_id': event['event_id'], 'event_hash': event_hash}


def http_transport(url, timeout=5):
    parsed = urlsplit(url)
    if parsed.scheme != 'http' or parsed.hostname != '127.0.0.1' or parsed.username or parsed.password or parsed.fragment or parsed.query or parsed.path != '/api/collector/events':
        raise ValueError('Demo collector transport requires http://127.0.0.1:<port>/api/collector/events')
    port = parsed.port or 80

    def deliver(envelope, signature):
        connection = http.client.HTTPConnection('127.0.0.1', port, timeout=timeout)
        try:
            connection.request('POST', parsed.path, body=canonical(envelope), headers={
                'Content-Type': 'application/json', 'X-Reconcile-Signature': signature,
            })
            response = connection.getresponse()
            payload = response.read(1024 * 1024)
            if response.status != 200:
                raise ValueError('Local collector rejected event (HTTP '+str(response.status)+')')
            return json.loads(payload)
        finally:
            connection.close()
    return deliver


class CollectorSDK:
    def __init__(self, key, run_id, app, transport):
        self.key = _key(key)
        self.run_id = run_id
        self.app = app
        self.transport = transport

    def emit(self, kind, app_user_id, occurred_at, details, *, event_id=None,
             source_event_id=None, correlation_id=None):
        event_id = event_id or str(uuid4())
        event = {'event_id': event_id, 'run_id': self.run_id, 'app': self.app,
                 'environment': 'Production', 'app_user_id': app_user_id,
                 'kind': kind, 'occurred_at': occurred_at, 'details': details,
                 'source_event_id': source_event_id or event_id,
                 'correlation_id': correlation_id or event_id}
        validate_event(event, self.run_id, self.app)
        envelope = {'event': event, 'sent_at': int(time.time())}
        receipt = self.transport(envelope, sign(envelope, self.key))
        if not isinstance(receipt, dict) or receipt.get('accepted') is not True or receipt.get('event_id') != event_id or receipt.get('event_hash') != digest(event):
            raise ValueError('Collector did not acknowledge this exact event')
        return receipt
