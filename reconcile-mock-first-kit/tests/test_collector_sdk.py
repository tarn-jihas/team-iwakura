import copy
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
from pathlib import Path
import sys
import threading
import time
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from collector_sdk import CollectorSDK, CollectorAuthError, canonical, digest, http_transport, ingest_event, sign


class CollectorSDKTests(unittest.TestCase):
    def setUp(self):
        self.key = 'local-test-key-' * 4
        self.events, self.seen = [], {}
        self.sink = lambda envelope, signature: ingest_event(self.events, self.seen, self.key, 'run-1', 'mock-lumen-access', envelope, signature)
        self.sdk = CollectorSDK(self.key, 'run-1', 'mock-lumen-access', self.sink)

    def emit(self, details=None, event_id='event-1'):
        return self.sdk.emit('feature_access_decided', 'user-1', '2026-11-03T00:12:04Z',
                             details or {'feature': 'premium_export', 'decision': 'deny', 'initiator': 'customer_demo'}, event_id=event_id)

    def test_signed_events_are_immutable_idempotent_and_acknowledged(self):
        details = {'decision': 'deny', 'before': {'premium': False, 'revision': 2}}
        self.assertFalse(self.emit(details)['duplicate'])
        self.assertTrue(self.emit(details)['duplicate'])
        details['before']['premium'] = True
        self.assertFalse(self.events[0]['details']['before']['premium'])
        self.assertEqual(len(self.events), 1)
        self.assertTrue(self.events[0]['signature_verified'])
        with self.assertRaisesRegex(ValueError, 'different payload'):
            self.emit({'decision': 'allow'})
        self.assertEqual(len(self.events), 1)

    def test_secret_fields_and_unbounded_payloads_never_enter_journal(self):
        for details in ({'card_number': 'redacted'}, {'before': {'cvv': 'redacted'}}, {'decision': {'card': 'redacted'}}, {'reason_code': 'x' * 17000}):
            with self.subTest(details=list(details)):
                with self.assertRaises(ValueError): self.emit(details)
        self.assertEqual(self.events, [])

    def test_signatures_timestamps_scope_and_ack_are_validated(self):
        self.emit()
        event = {key: value for key, value in self.events[0].items() if key not in ('payload_hash', 'recorded_at_wall', 'signature_verified', 'provenance')}
        envelope = {'event': event, 'sent_at': int(time.time())}
        with self.assertRaises(CollectorAuthError): self.sink(envelope, 'invalid')
        expired = {**envelope, 'sent_at': envelope['sent_at'] - 301}
        with self.assertRaises(CollectorAuthError): self.sink(expired, sign(expired, self.key))
        wrong = copy.deepcopy(envelope); wrong['event']['run_id'] = 'other-run'
        with self.assertRaisesRegex(ValueError, 'scope'): self.sink(wrong, sign(wrong, self.key))
        self.sdk.transport = lambda *_: {'accepted': True, 'event_id': 'event-1', 'event_hash': 'wrong'}
        with self.assertRaisesRegex(ValueError, 'exact event'): self.emit()

    def test_transport_is_loopback_only(self):
        for url in ('https://127.0.0.1/api/collector/events', 'http://example.com/api/collector/events', 'http://localhost/api/collector/events', 'http://127.0.0.1/private'):
            with self.assertRaises(ValueError): http_transport(url)

    def test_sdk_sends_signed_metadata_to_actual_http_collector(self):
        sink = self.sink
        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *_): pass
            def do_POST(self):
                self.server.paths.append(self.path)
                envelope = json.loads(self.rfile.read(int(self.headers['Content-Length'])))
                result = sink(envelope, self.headers['X-Reconcile-Signature'])
                data = canonical(result)
                self.send_response(200); self.send_header('Content-Length', str(len(data))); self.end_headers(); self.wfile.write(data)
        server = ThreadingHTTPServer(('127.0.0.1', 0), Handler); server.paths = []
        thread = threading.Thread(target=server.serve_forever, daemon=True); thread.start()
        try:
            self.sdk.transport = http_transport(f'http://127.0.0.1:{server.server_port}/api/collector/events')
            receipt = self.emit()
            self.assertEqual(receipt['event_hash'], self.events[0]['payload_hash'])
            self.assertEqual(server.paths, ['/api/collector/events'])
        finally:
            server.shutdown(); server.server_close(); thread.join(timeout=3)


if __name__ == '__main__': unittest.main()
