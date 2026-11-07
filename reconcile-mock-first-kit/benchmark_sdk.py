#!/usr/bin/env python3
"""Measure the real SDK's durable enqueue and local HTTP payload overhead."""
from __future__ import annotations

import argparse
from datetime import datetime, timezone
import hashlib
import hmac
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import math
from pathlib import Path
import platform
import secrets
import tempfile
import threading
import time

from recovery_sdk import CollectorSDK, canonical, http_transport, sign, validate_event


def latency_summary(samples):
    ordered = sorted(samples)
    return {name: round(ordered[min(len(ordered)-1, math.ceil(len(ordered)*p)-1)], 4)
            for name, p in (('p50', .5), ('p95', .95), ('max', 1))}


def enqueue(sdk, count):
    durations = []
    occurred_at = datetime.now(timezone.utc).isoformat()
    for index in range(count):
        started = time.perf_counter_ns()
        receipt = sdk.emit('feature_access_decided', f'benchmark-{index % 100:03d}',
            occurred_at, {'feature': 'premium_export', 'decision': 'allow',
                'reason_code': 'allowed', 'projection_version': 'projection-v1',
                'cache_version': 'cache-v1', 'policy_version': 'policy-v1',
                'adapter_version': 'adapter-v1', 'initiator': 'customer_demo'})
        durations.append((time.perf_counter_ns()-started)/1_000_000)
        assert receipt['queued'], 'Benchmark events must fit the durable outbox'
    return latency_summary(durations)


def run(count=500):
    key = secrets.token_bytes(32)
    received_sizes = []

    class Collector(BaseHTTPRequestHandler):
        def log_message(self, *_):
            pass

        def do_POST(self):
            raw = self.rfile.read(int(self.headers['Content-Length']))
            envelope = json.loads(raw)
            if not hmac.compare_digest(self.headers.get('X-Reconcile-Signature', ''),
                                       sign(envelope, key)):
                self.send_error(401)
                return
            event = envelope['event']
            validate_event(event, 'sdk-benchmark', 'benchmark-app', 'benchmark')
            received_sizes.append(len(raw))
            response = canonical({'accepted': True, 'event_id': event['event_id'],
                'event_hash': hashlib.sha256(canonical(event)).hexdigest(), 'duplicate': False})
            self.send_response(200)
            self.send_header('Content-Type', 'application/json')
            self.send_header('Content-Length', str(len(response)))
            self.end_headers()
            self.wfile.write(response)

    with tempfile.TemporaryDirectory(prefix='reconcile-sdk-benchmark-') as folder:
        server = ThreadingHTTPServer(('127.0.0.1', 0), Collector)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        try:
            url = f'http://127.0.0.1:{server.server_port}/api/recovery/collector'
            sdk = CollectorSDK(key, 'sdk-benchmark', 'benchmark-app', http_transport(url),
                outbox_path=Path(folder)/'online.db', environment='benchmark', collector_url=url)
            online_latency = enqueue(sdk, count)
            assert not received_sizes, 'emit must not make a network request'
            started = time.perf_counter()
            while sdk.coverage()['queued']:
                assert sdk.flush()['accepted'] > 0, 'Local collector must acknowledge the batch'
            flush_seconds = time.perf_counter()-started
            assert len(received_sizes) == count
            assert sdk.coverage()['accepted'] == count and sdk.coverage()['dropped'] == 0
        finally:
            server.shutdown()
            server.server_close()
            thread.join(timeout=3)

        failed_attempts = 0

        def unavailable(*_):
            nonlocal failed_attempts
            failed_attempts += 1
            raise OSError('isolated collector outage')

        offline = CollectorSDK(key, 'sdk-benchmark', 'benchmark-app', unavailable,
            outbox_path=Path(folder)/'offline.db', environment='benchmark')
        outage_latency = enqueue(offline, count)
        assert failed_attempts == 0, 'Collector failure must be outside the enqueue path'
        offline.flush()
        assert failed_attempts > 0 and offline.coverage()['queued'] == count
        assert offline.coverage()['dropped'] == 0
        return {'measured_at': datetime.now(timezone.utc).isoformat(),
            'python': platform.python_version(), 'platform': platform.platform(),
            'sample_events': count, 'enqueue_ms': online_latency,
            'collector_outage_enqueue_ms': outage_latency,
            'network_requests_during_enqueue': 0, 'delivery_http_requests': len(received_sizes),
            'request_json_bytes_total': sum(received_sizes),
            'request_json_bytes_per_event': round(sum(received_sizes)/count, 2),
            'request_json_bytes_max': max(received_sizes),
            'local_delivery_seconds': round(flush_seconds, 4),
            'delivery_accepted': count, 'delivery_dropped': 0,
            'outage_first_flush_attempts': failed_attempts,
            'outage_events_retained': offline.coverage()['queued'],
            'limits': ['Local machine and loopback HTTP, not a production load test.',
                'Bytes count JSON request bodies; HTTP/TCP/TLS overhead is excluded.',
                'Latency includes validation and durable SQLite enqueue, not the whole app request.',
                'One HTTP request per event; flush selection is not network batching.']}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--events', type=int, default=500)
    parser.add_argument('--output', type=Path)
    args = parser.parse_args()
    if not 10 <= args.events <= 1000:
        parser.error('events must be between 10 and 1000')
    result = run(args.events)
    if args.output:
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_text(json.dumps(result, indent=2)+'\n')
    print(json.dumps(result, indent=2))


if __name__ == '__main__':
    main()
