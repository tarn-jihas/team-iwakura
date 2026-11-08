"""Exercise slow fresh-source reads through independent local HTTP processes."""
import json
from pathlib import Path
import sys
import tempfile
import time
import unittest
from urllib.error import HTTPError
from urllib.request import Request, urlopen

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
from acceptance.support.fulfillment_fixture import FulfillmentDemo


def public_request(base, path, body=None, timeout=15):
    raw = None if body is None else json.dumps(body).encode('utf-8')
    request = Request(base+path, data=raw,
        headers={'Content-Type': 'application/json'} if raw is not None else {})
    try:
        response = urlopen(request, timeout=timeout)
    except HTTPError as error:
        response = error
    with response:
        payload = response.read()
        if 'json' in response.headers.get('Content-Type', ''):
            payload = json.loads(payload) if payload else None
        return response.status, payload


def wait_for(base, path, predicate, timeout=120):
    deadline = time.monotonic()+timeout
    latest = None
    while time.monotonic() < deadline:
        code, latest = public_request(base, path, timeout=15)
        if code == 200 and predicate(latest):
            return latest
        time.sleep(.05)
    raise AssertionError(f'Timed out waiting for public state: {latest!r}')


class FulfillmentSourceWaitHTTPTests(unittest.TestCase):
    def test_bootstrap_survives_fresh_source_read_paused_over_five_seconds(self):
        with tempfile.TemporaryDirectory(prefix='reconcile-source-wait-') as root:
            with FulfillmentDemo(Path(root), live_bootstrap_pending=True) as demo:
                base = demo.urls['engine']
                demo.pause_source_profile_reads(after=1)
                status, accepted = public_request(base, '/api/recovery/simulation', {
                    'action': 'bootstrap', 'operation_key': 'integration-source-wait'})
                self.assertIn(status, (200, 202), accepted)

                deadline = time.monotonic()+30
                while time.monotonic() < deadline:
                    if demo.source_fixture_status()['profile_read_paused']:
                        break
                    time.sleep(.05)
                else:
                    self.fail('Bootstrap did not reach the paused fresh-source read')

                time.sleep(7)
                demo.release_source_profile_reads()
                final = wait_for(base, '/api/recovery/simulation',
                    lambda value: value['bootstrap_status'] in ('completed', 'failed')
                        and 'result' in value)
                self.assertEqual(final['bootstrap_status'], 'completed', final)
                self.assertEqual(final['result']['source_observed'], 100)
                self.assertEqual(final['result']['handler_completed'], 76)
                self.assertEqual(final['result']['handler_failed'], 24)
                self.assertEqual(final['result']['repaired'], 23)
                self.assertEqual(final['result']['unresolved'], 1)
                self.assertEqual(final['result']['customer_denials'], 0)
                self.assertEqual(final['result']['manual_incidents'], 0)

                status, monitor = public_request(base,
                    '/api/recovery/monitor?cursor=0&limit=50')
                self.assertEqual(status, 200, monitor)
                self.assertEqual(len(monitor['incidents']), 1)
                incident = monitor['incidents'][0]
                self.assertEqual(incident['status'], 'unresolved')
                self.assertEqual(incident['affected_accounts'], 24)
                self.assertEqual(incident['repaired_accounts'], 23)


if __name__ == '__main__':
    unittest.main()
