from datetime import datetime, timezone
import json
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import recovery_live


APP_ID = recovery_live.APP_ID
CUSTOMER = 'lumen_916965_00000'
NOW = datetime(2026, 11, 7, 20, 0, tzinfo=timezone.utc)


def profile(store='app_store'):
    level = {'store': store, 'store_product_id': 'lumen.annual',
        'store_transaction_id': 'txn-1', 'purchased_at': '2026-08-09T03:06:34+00:00',
        'starts_at': None, 'expires_at': '2027-08-09T03:06:34+00:00',
        'is_in_grace_period': False, 'renewal_cancelled_at': '2026-11-07T19:21:25Z',
        'cancellation_reason': 'voluntarily_cancelled', 'billing_issue_detected_at': None,
        'access_level_id': 'premium', 'offer': None}
    subscription = {**level, 'environment': 'Production', 'offer': None,
                    'cancellation_reason': None, 'is_in_grace_period': False}
    return {'app_id': APP_ID, 'profile_id': 'profile-1', 'customer_user_id': CUSTOMER,
        'timestamp': '2026-11-07T20:00:00Z', 'custom_attributes': {},
        'access_levels': [level], 'subscriptions': [subscription], 'non_subscriptions': []}


class LiveAdaptyTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.key_path = Path(self.temp.name) / 'adapty.key'
        self.key_path.write_text('test-secret-that-must-not-escape')
        self.key_path.chmod(0o600)
        self.config = {'app_id': APP_ID, 'secret_key_file': str(self.key_path)}

    def normalize(self, raw, user=CUSTOMER):
        return recovery_live.normalize_profile(raw, self.config, user, NOW)

    def test_normalizes_current_cancelled_renewal_without_payment_claim(self):
        result = self.normalize(profile())
        self.assertEqual(result['status'], 'active')
        self.assertEqual(result['entitlement']['starts_at'], '2026-08-09T03:06:34Z')
        self.assertEqual(result['entitlement']['product_id'], 'lumen.annual')
        self.assertEqual(result['payment_verification'], 'not_independently_verified')
        self.assertNotIn('amount', result['entitlement'])
        self.assertNotIn('payment_state', result['entitlement'])

    def test_timestamp_is_not_part_of_source_fingerprint(self):
        first, second = profile(), profile()
        second['timestamp'] = '2026-11-07T20:01:00Z'
        self.assertEqual(self.normalize(first)['source_fingerprint'],
                         self.normalize(second)['source_fingerprint'])
        second['subscriptions'][0]['expires_at'] = '2027-08-10T03:06:34+00:00'
        self.assertNotEqual(self.normalize(first)['source_fingerprint'],
                            self.normalize(second)['source_fingerprint'])

    def test_play_store_entitlement_is_supported(self):
        result = self.normalize(profile('play_store'))
        self.assertEqual(result['status'], 'active')
        self.assertEqual(result['entitlement']['subscription_environment'], 'Production')

    def test_wrong_app_or_customer_fails_closed(self):
        raw = profile()
        raw['app_id'] = 'another-app'
        self.assertEqual(self.normalize(raw)['reason'], 'identity_scope_mismatch')
        raw = profile()
        raw['customer_user_id'] = 'another-customer'
        self.assertEqual(self.normalize(raw)['reason'], 'identity_scope_mismatch')

    def test_expired_trial_and_grace_periods_are_not_active(self):
        expired = profile()
        expired['access_levels'][0]['expires_at'] = '2026-11-06T00:00:00Z'
        expired['subscriptions'][0]['expires_at'] = '2026-11-06T00:00:00Z'
        self.assertEqual(self.normalize(expired)['reason'], 'subscription_expired')
        trial = profile()
        trial['subscriptions'][0]['offer'] = {'type': 'trial'}
        self.assertEqual(self.normalize(trial)['reason'], 'trial_period')
        grace = profile()
        grace['access_levels'][0]['is_in_grace_period'] = True
        grace['subscriptions'][0]['is_in_grace_period'] = True
        self.assertEqual(self.normalize(grace)['reason'], 'grace_period')

    def test_refund_revocation_billing_and_mismatched_source_bindings_fail_closed(self):
        refunded = profile()
        refunded['access_levels'][0]['cancellation_reason'] = 'refunded'
        self.assertNotEqual(self.normalize(refunded)['status'], 'active')
        revoked = profile()
        revoked['subscriptions'][0]['revoked_at'] = '2026-11-01T00:00:00Z'
        self.assertNotEqual(self.normalize(revoked)['status'], 'active')
        billing = profile()
        billing['subscriptions'][0]['billing_issue_detected_at'] = '2026-11-01T00:00:00Z'
        self.assertNotEqual(self.normalize(billing)['status'], 'active')
        wrong_environment = profile()
        wrong_environment['subscriptions'][0]['environment'] = 'Sandbox'
        self.assertNotEqual(self.normalize(wrong_environment)['status'], 'active')
        wrong_expiry = profile()
        wrong_expiry['subscriptions'][0]['expires_at'] = '2027-08-10T03:06:34+00:00'
        self.assertNotEqual(self.normalize(wrong_expiry)['status'], 'active')

    def test_https_transport_uses_fixed_host_path_and_customer_header(self):
        class Response:
            status = 200

            def read(self, _):
                return json.dumps({'data': profile()}).encode()

            def getheader(self, _):
                return None

        class Connection:
            def __init__(self, host, timeout):
                calls.append(('connect', host, timeout))

            def request(self, method, path, headers):
                calls.append(('request', method, path, headers))

            def getresponse(self):
                return Response()

            def close(self):
                pass

        calls = []
        reader = recovery_live.AdaptyReader(self.config)
        with patch.object(recovery_live.http.client, 'HTTPSConnection', Connection):
            result = reader.read(CUSTOMER)
        self.assertEqual(result['status'], 'active')
        self.assertEqual(calls[0], ('connect', recovery_live.API_HOST, 5))
        _, method, path, headers = calls[1]
        self.assertEqual((method, path), ('GET', recovery_live.API_PATH))
        self.assertEqual(headers['adapty-customer-user-id'], CUSTOMER)
        self.assertTrue(headers['Authorization'].startswith('Api-Key '))
        self.assertNotIn(self.key_path.read_text(), json.dumps(result))


if __name__ == '__main__':
    unittest.main()
