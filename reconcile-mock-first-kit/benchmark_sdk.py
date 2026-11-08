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


def receipt_details(index, trace_enabled):
    details = {'action_id': f'action-{index:04d}', 'source_hash': 'a'*64,
        'expected_revision': 1, 'policy_version': 'policy-v2',
        'adapter_version': 'adapter-v2', 'projection_version': 'handler-v2',
        'cache_version': 'cache-v2', 'outcome': 'projection_updated',
        'before': {'active': False, 'projection_revision': 1},
        'after': {'active': True, 'projection_revision': 2},
        'cache_invalidated': False, 'processing_id': f'processing-{index:04d}',
        'trace_id': f'trace-{index:04d}', 'transaction_id': f'txn-{index:04d}',
        'steps': [],
        'revisions': {'identity': 1, 'policy': 1, 'projection': 2, 'cache': 2}}
    if trace_enabled:
        details['steps'] = [{'name': 'projection_commit', 'status': 'completed',
            'owner': 'lumen', 'result': 'committed', 'revision': 2}]
    return details


def enqueue(sdk, count, trace_enabled=False):
    durations = []
    occurred_at = datetime.now(timezone.utc).isoformat()
    for index in range(count):
        started = time.perf_counter_ns()
        receipt = sdk.emit('access_projection_changed', f'benchmark-{index % 100:03d}',
            occurred_at, receipt_details(index, trace_enabled), schema_version=2)
        durations.append((time.perf_counter_ns()-started)/1_000_000)
        assert receipt['queued'], 'Benchmark events must fit the durable outbox'
    return latency_summary(durations)


def run(count=500):
    key = secrets.token_bytes(32)
    received_sizes = {'trace_off': [], 'trace_on': []}
    network_requests = {'count': 0}

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
            trace_profile = 'trace_on' if event['details']['steps'] else 'trace_off'
            received_sizes[trace_profile].append(len(raw))
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
            transport = http_transport(url)

            def measured_transport(envelope, signature):
                network_requests['count'] += 1
                return transport(envelope, signature)

            profiles = {}
            for name, trace_enabled in (('trace_off', False), ('trace_on', True)):
                sdk = CollectorSDK(key, 'sdk-benchmark', 'benchmark-app', measured_transport,
                    outbox_path=Path(folder)/(name+'.db'), environment='benchmark', collector_url=url)
                enqueue_ms = enqueue(sdk, count, trace_enabled)
                backlog = sdk.coverage()['queued']
                network_before_delivery = network_requests['count']
                assert network_before_delivery == 0, 'emit must not make a network request'
                started = time.perf_counter()
                while sdk.coverage()['queued']:
                    assert sdk.flush()['accepted'] > 0, 'Local collector must acknowledge the batch'
                flush_seconds = time.perf_counter()-started
                coverage = sdk.coverage()
                sizes = received_sizes[name]
                assert len(sizes) == count
                assert coverage['accepted'] == count and coverage['dropped'] == 0
                profiles[name] = {
                    'schema_version': 2,
                    'enqueue_ms': enqueue_ms,
                    'network_requests_during_emit': network_before_delivery,
                    'outbox_backlog_before_delivery': backlog,
                    'outbox_backlog_after_delivery': coverage['queued'],
                    'outbox_dropped': coverage['dropped'],
                    'delivery_http_requests': network_requests['count']-network_before_delivery,
                    'request_json_bytes_total': sum(sizes),
                    'request_json_bytes_per_event': round(sum(sizes)/count, 2),
                    'request_json_bytes_max': max(sizes),
                    'local_delivery_seconds': round(flush_seconds, 4),
                    'delivery_accepted': coverage['accepted'],
                }
                network_requests['count'] = 0
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
        trace_off = profiles['trace_off']
        return {'measured_at': datetime.now(timezone.utc).isoformat(),
            'python': platform.python_version(), 'platform': platform.platform(),
            'sample_events_per_profile': count, 'profiles': profiles,
            'sample_events': count, 'enqueue_ms': trace_off['enqueue_ms'],
            'collector_outage_enqueue_ms': outage_latency,
            'network_requests_during_enqueue': trace_off['network_requests_during_emit'],
            'delivery_http_requests': trace_off['delivery_http_requests'],
            'request_json_bytes_total': trace_off['request_json_bytes_total'],
            'request_json_bytes_per_event': trace_off['request_json_bytes_per_event'],
            'request_json_bytes_max': trace_off['request_json_bytes_max'],
            'local_delivery_seconds': trace_off['local_delivery_seconds'],
            'delivery_accepted': trace_off['delivery_accepted'], 'delivery_dropped': trace_off['outbox_dropped'],
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
