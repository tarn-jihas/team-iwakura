import copy
from pathlib import Path
import sys
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from recovery_contracts import validation_request, validate_request


class RecoveryContractTests(unittest.TestCase):
    def test_stripe_json_api_and_paddle_flat_contract_are_distinct(self):
        stripe = validation_request('stripe', 'account-7', 'transaction-7')
        paddle = validation_request('paddle', 'account-7', 'transaction-7')
        self.assertEqual(stripe['content_type'], 'application/vnd.api+json')
        self.assertEqual(stripe['path'], '/api/v1/sdk/purchase/stripe/token/validate/')
        self.assertEqual(stripe['body']['data']['type'], 'stripe_receipt_validation_result')
        self.assertEqual(paddle['content_type'], 'application/json')
        self.assertEqual(paddle['path'], '/api/v2/server-side-api/purchase/paddle/token/validate/')
        self.assertEqual(set(paddle['body']), {'customer_user_id', 'paddle_token'})
        self.assertEqual(validate_request('stripe', stripe)['customer_user_id'], 'account-7')
        self.assertEqual(validate_request('paddle', paddle)['customer_user_id'], 'account-7')
        for provider, request in [('stripe', paddle), ('paddle', stripe)]:
            with self.assertRaises(ValueError):
                validate_request(provider, request)

    def test_purchase_reference_is_deterministic_and_preserves_distinct_transactions(self):
        first = validation_request('paddle', 'u1', 'txn-one')
        self.assertEqual(first, validation_request('paddle', 'u1', 'txn-one'))
        self.assertNotEqual(first['body']['paddle_token'], validation_request('paddle', 'u1', 'txn_one')['body']['paddle_token'])
        self.assertTrue(first['body']['paddle_token'].startswith('txn_mock_'))

    def test_malformed_and_unsupported_validation_cannot_be_a_generic_grant(self):
        original = validation_request('stripe', 'u1', 'txn-1')
        for provider in ('apple', 'google', 'custom'):
            with self.assertRaises(ValueError):
                validation_request(provider, 'u1', 'txn-1')
        malformed = copy.deepcopy(original)
        malformed['body']['data']['attributes']['grant_premium'] = True
        with self.assertRaises(ValueError):
            validate_request('stripe', malformed)
        malformed = copy.deepcopy(original)
        malformed['body']['data']['attributes']['stripe_token'] = 'txn_wrong_provider'
        with self.assertRaises(ValueError):
            validate_request('stripe', malformed)


if __name__ == '__main__':
    unittest.main()
