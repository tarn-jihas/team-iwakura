import copy
from http.client import HTTPConnection
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
from pathlib import Path
import sqlite3
import sys
import tempfile
import threading
import time
from urllib.parse import urlsplit
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import recovery_sdk
from recovery_sdk import (CollectorAuthError, CollectorHTTPError, CollectorSDK,
                          canonical, digest, http_transport, sign, validate_event)


KEY = b'local-recovery-test-key-0123456789abcdef'
RUN_ID = 'activation-stripe-20261107-v0'
APP = 'mock-lumen-activation'
OCCURRED_AT = '2026-11-07T12:00:00Z'
DETAILS = {
    'feature': 'premium_export', 'decision': 'deny',
    'reason_code': 'subscription_inactive',
    'projection_version': 'lumen-projection-v1',
    'cache_version': 'lumen-cache-v1',
    'policy_version': 'access-policy-v1',
    'adapter_version': 'lumen-adapter-v1', 'initiator': 'customer_demo',
}


class LocalCollector:
    def __init__(self):
        self.key, self.run_id, self.app = KEY, RUN_ID, APP
        self.events, self.requests = {}, []

    def handler(self):
        collector = self

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *_):
                pass

            def do_POST(self):
                raw = self.rfile.read(int(self.headers.get('Content-Length', 0)))
                try:
                    envelope = json.loads(raw)
                    signature = self.headers.get('X-Reconcile-Signature', '')
                    collector.requests.append((envelope, signature, self.headers.get('Content-Type')))
                    if not isinstance(envelope, dict) or set(envelope) != {'schema_version', 'event', 'sent_at'}:
                        raise ValueError('bad envelope')
                    if type(envelope['schema_version']) is not int or envelope['schema_version'] != 1:
                        raise ValueError('bad envelope version')
                    if type(envelope['sent_at']) is not int:
                        raise ValueError('bad timestamp')
                    if abs(time.time() - envelope['sent_at']) > 300 or sign(envelope, collector.key) != signature:
                        self.send_response(401); self.end_headers(); return
                    event = envelope['event']
                    validate_event(event, collector.run_id, collector.app, 'Production')
                    event_hash = digest(event)
                    previous = collector.events.get(event['event_id'])
                    if previous is not None and previous != event_hash:
                        self.send_response(409); self.end_headers(); return
                    collector.events[event['event_id']] = event_hash
                    receipt = {'accepted': True, 'event_id': event['event_id'],
                               'event_hash': event_hash, 'duplicate': previous is not None}
                    payload = canonical(receipt)
                    self.send_response(200)
                    self.send_header('Content-Type', 'application/json')
                    self.send_header('Content-Length', str(len(payload)))
                    self.end_headers(); self.wfile.write(payload)
                except ValueError:
                    self.send_response(400); self.end_headers()

        return Handler


class RecoverySDKTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix='recovery-sdk-')
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)

    def make_sdk(self, transport, name='outbox.sqlite3', **kwargs):
        return CollectorSDK(KEY, RUN_ID, APP, transport,
                            outbox_path=self.root / name, **kwargs)

    @staticmethod
    def send(url, envelope, key=KEY):
        parsed = urlsplit(url)
        connection = HTTPConnection('127.0.0.1', parsed.port, timeout=2)
        try:
            connection.request('POST', parsed.path, body=canonical(envelope),
                               headers={'Content-Type': 'application/json',
                                        'X-Reconcile-Signature': sign(envelope, key)})
            response = connection.getresponse()
            return response.status, response.read()
        finally:
            connection.close()

    def test_versioned_events_are_signed_and_loopback_collector_replays_idempotently(self):
        collector = LocalCollector()
        server = ThreadingHTTPServer(('127.0.0.1', 0), collector.handler())
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        self.addCleanup(lambda: (server.shutdown(), server.server_close(), thread.join(timeout=3)))
        url = f'http://127.0.0.1:{server.server_port}/api/recovery/collector'
        sdk = self.make_sdk(http_transport(url), collector_url=url)

        receipt = sdk.emit('feature_access_decided', 'u00001', OCCURRED_AT, DETAILS,
                           event_id='event-1')
        self.assertTrue(receipt['queued'])
        self.assertEqual(collector.requests, [], 'Enqueue must never perform network I/O')
        self.assertEqual(sdk.flush()['accepted'], 1)
        receipt = sdk.emit('feature_access_decided', 'u00001', OCCURRED_AT, DETAILS,
                           event_id='event-1')
        self.assertTrue(receipt['accepted'])
        self.assertFalse(receipt['queued'])
        self.assertEqual(receipt['event_hash'], next(iter(collector.events.values())))
        envelope, signature, content_type = collector.requests[-1]
        self.assertEqual(envelope['schema_version'], 1)
        self.assertEqual(envelope['event']['schema_version'], 1)
        self.assertEqual(signature, sign(envelope, KEY))
        self.assertEqual(content_type, 'application/json')

        replay = copy.deepcopy(envelope)
        replay['sent_at'] += 1
        status, body = self.send(url, replay)
        self.assertEqual(status, 200)
        self.assertTrue(json.loads(body)['duplicate'])

        conflict = copy.deepcopy(replay)
        conflict['event']['details']['decision'] = 'allow'
        status, _ = self.send(url, conflict)
        self.assertEqual(status, 409)
        self.assertEqual(len(collector.events), 1)

        wrong_app = copy.deepcopy(replay)
        wrong_app['event']['app'] = 'another-app'
        self.assertEqual(self.send(url, wrong_app)[0], 400)
        wrong_environment = copy.deepcopy(replay)
        wrong_environment['event']['environment'] = 'Sandbox'
        self.assertEqual(self.send(url, wrong_environment)[0], 400)
        self.assertEqual(self.send(url, replay, key=b'wrong-key-012345678901234567890123')[0], 401)
        with self.assertRaises(CollectorAuthError):
            http_transport(url)(replay, sign(replay, b'wrong-key-012345678901234567890123'))

    def test_allowlist_utc_scope_and_secret_safe_errors(self):
        delivered = []
        sdk = self.make_sdk(lambda envelope, signature: delivered.append(envelope) or {
            'accepted': True, 'event_id': envelope['event']['event_id'],
            'event_hash': digest(envelope['event']), 'duplicate': False,
        })
        for bad in (
            {**DETAILS, 'card_number': '4111111111111111'},
            {**DETAILS, 'purchase_token': 'secret-token'},
            {**DETAILS, 'reason_code': {'provider': 'credential'}},
        ):
            with self.subTest(fields=list(bad)):
                with self.assertRaises(ValueError) as error:
                    sdk.emit('feature_access_decided', 'u00001', OCCURRED_AT, bad)
                self.assertNotIn('4111111111111111', str(error.exception))
                self.assertNotIn('secret-token', str(error.exception))
        with self.assertRaisesRegex(ValueError, 'UTC'):
            sdk.emit('feature_access_decided', 'u00001', '2026-11-07T13:00:00+01:00', DETAILS)
        with self.assertRaisesRegex(ValueError, 'scope'):
            validate_event({
                'schema_version': 1, 'event_id': 'id', 'run_id': 'wrong', 'app': APP,
                'environment': 'Production', 'app_user_id': 'u00001',
                'kind': 'feature_access_decided', 'occurred_at': OCCURRED_AT,
                'correlation_id': 'id', 'source_event_id': 'id', 'details': DETAILS,
            }, RUN_ID, APP, 'Production')
        self.assertEqual(delivered, [])
        self.assertNotIn('secret-token', str(sdk.coverage()))

    def test_outage_survives_restart_and_drains_with_same_event_binding(self):
        class FailsOnce:
            def __init__(self): self.calls = 0
            def __call__(self, *_):
                self.calls += 1
                raise OSError('must not escape')

        failed = FailsOnce()
        first = self.make_sdk(failed)
        initial = first.emit('feature_access_decided', 'u00001', OCCURRED_AT,
                             DETAILS, event_id='durable-event')
        self.assertTrue(initial['queued'])
        first.flush()
        self.assertEqual(first.coverage()['queued'], 1)
        self.assertEqual(first.coverage()['failed'], 1)

        second = self.make_sdk(lambda envelope, signature: {
            'accepted': True, 'event_id': envelope['event']['event_id'],
            'event_hash': digest(envelope['event']), 'duplicate': False,
        })
        with patch.object(recovery_sdk.time, 'time', return_value=time.time() + 20):
            self.assertEqual(second.flush()['accepted'], 1)
        self.assertEqual(second.coverage()['queued'], 0)
        self.assertEqual(second.coverage()['accepted'], 1)
        duplicate = second.emit('feature_access_decided', 'u00001', OCCURRED_AT,
                                DETAILS, event_id='durable-event')
        self.assertTrue(duplicate['accepted'])

        with self.assertRaisesRegex(ValueError, 'different payload'):
            second.emit('feature_access_decided', 'u00001', OCCURRED_AT,
                        {**DETAILS, 'decision': 'allow'}, event_id='durable-event')

    def test_retry_after_is_deferred_without_sleep_and_attempts_are_bounded(self):
        calls = []

        def rate_limited(envelope, signature):
            calls.append(envelope)
            if len(calls) == 1:
                raise CollectorHTTPError(429, '30')
            return {'accepted': True, 'event_id': envelope['event']['event_id'],
                    'event_hash': digest(envelope['event']), 'duplicate': False}

        sdk = self.make_sdk(rate_limited)
        result = sdk.emit('feature_access_decided', 'u00001', OCCURRED_AT,
                          DETAILS, event_id='rate-limited')
        self.assertTrue(result['queued'])
        sdk.flush()
        self.assertEqual(len(calls), 1)
        self.assertEqual(sdk.flush()['failed'], 0)
        self.assertEqual(len(calls), 1)
        with patch.object(recovery_sdk.time, 'time', return_value=time.time() + 29):
            self.assertEqual(sdk.flush()['accepted'], 0)
        self.assertEqual(len(calls), 1)
        with patch.object(recovery_sdk.time, 'time', return_value=time.time() + 31):
            self.assertEqual(sdk.flush()['accepted'], 1)
        self.assertEqual(len(calls), 2)
        self.assertEqual(sdk.coverage()['retries'], 1)

        failures = []

        def offline(*_):
            failures.append(True)
            raise OSError('offline')

        exhausted = self.make_sdk(offline, name='attempt-budget.sqlite3')
        base = int(time.time())
        exhausted.emit('feature_access_decided', 'u00001', OCCURRED_AT,
                       DETAILS, event_id='attempt-budget')
        exhausted.flush()
        for current in (base + 3, base + 8, base + 17, base + 34):
            with patch.object(recovery_sdk.time, 'time', return_value=current):
                exhausted.flush()
        coverage = exhausted.coverage()
        self.assertEqual(len(failures), 5)
        self.assertEqual(coverage['queued'], 0)
        self.assertEqual(coverage['dropped'], 1)
        self.assertEqual(coverage['failed'], 5)
        self.assertEqual(coverage['retries'], 4)

    def test_outbox_and_retention_bounds_report_drops_without_failing_emit(self):
        with patch.object(recovery_sdk, '_MAX_PENDING', 2):
            sdk = self.make_sdk(lambda *_: (_ for _ in ()).throw(OSError('offline')))
            for event_id in ('one', 'two', 'three'):
                sdk.emit('feature_access_decided', 'u00001', OCCURRED_AT,
                         DETAILS, event_id=event_id)
                sdk.flush()
            coverage = sdk.coverage()
            self.assertEqual(coverage['queued'], 2)
            self.assertEqual(coverage['dropped'], 1)
            self.assertEqual(coverage['failed'], 2)
            self.assertEqual(coverage['last_error'], 'queue_full')

        retention = self.make_sdk(lambda *_: (_ for _ in ()).throw(OSError('offline')),
                                  name='retention.sqlite3')
        retention.emit('feature_access_decided', 'u00001', OCCURRED_AT,
                        DETAILS, event_id='expired-event')
        retention.flush()
        db = sqlite3.connect(retention.outbox_path)
        try:
            db.execute('UPDATE sdk_events SET created_at=?',
                       (int(time.time()) - recovery_sdk._RETENTION_SECONDS - 1,))
            db.commit()
        finally:
            db.close()
        retention.emit('feature_access_decided', 'u00001', OCCURRED_AT,
                        DETAILS, event_id='fresh-event')
        self.assertEqual(retention.coverage()['queued'], 1)
        self.assertEqual(retention.coverage()['dropped'], 1)

        unavailable = self.make_sdk(lambda *_: None, name=self.root)
        receipt = unavailable.emit('feature_access_decided', 'u00001', OCCURRED_AT, DETAILS)
        self.assertFalse(receipt['accepted'])
        self.assertFalse(receipt['queued'])
        self.assertEqual(unavailable.coverage()['dropped'], 1)
        self.assertEqual(unavailable.coverage()['last_error'], 'outbox_unavailable')

    def test_slow_delivery_does_not_hold_up_new_events_or_coverage(self):
        started, release = threading.Event(), threading.Event()

        def slow_transport(envelope, signature):
            started.set()
            release.wait(timeout=3)
            return {'accepted': True, 'event_id': envelope['event']['event_id'],
                    'event_hash': digest(envelope['event']), 'duplicate': False}

        sdk = self.make_sdk(slow_transport)
        sdk.emit('feature_access_decided', 'u00001', OCCURRED_AT, DETAILS, event_id='slow')
        delivery = threading.Thread(target=sdk.flush)
        delivery.start()
        try:
            self.assertTrue(started.wait(timeout=1))
            before = time.monotonic()
            receipt = sdk.emit('feature_access_decided', 'u00002', OCCURRED_AT, DETAILS, event_id='next')
            self.assertTrue(receipt['queued'])
            self.assertEqual(sdk.coverage()['queued'], 2)
            self.assertLess(time.monotonic() - before, 0.5, 'Network I/O blocked the application thread')
        finally:
            release.set()
            delivery.join(timeout=3)
        self.assertFalse(delivery.is_alive())

    def test_http_transport_rejects_non_loopback_and_unknown_paths(self):
        for url in (
            'https://127.0.0.1/api/recovery/collector',
            'http://example.com/api/recovery/collector',
            'http://127.0.0.1:8765/private',
            'http://127.0.0.1/api/recovery/collector?key=secret',
        ):
            with self.subTest(url=url):
                with self.assertRaises(ValueError):
                    http_transport(url)


if __name__ == '__main__':
    unittest.main()
