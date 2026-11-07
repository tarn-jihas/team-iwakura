import tempfile
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import recovery_contracts
import recovery_domain


class RecoveryDomainTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        root = Path(self.temp.name)
        self.provider_db = root / 'provider.sqlite3'
        self.adapty_db = root / 'adapty.sqlite3'
        self.lumen_db = root / 'lumen.sqlite3'
        recovery_domain.init_provider(self.provider_db, self.adapty_db, 'stripe', 0, reset=True)
        recovery_domain.init_lumen(self.lumen_db, 'stripe', 0, reset=True)

    def tearDown(self):
        self.temp.cleanup()

    def test_validation_accepts_and_records_object_contract_trace(self):
        recovery_domain.repair_catalog(self.adapty_db, {
            'provider': 'stripe', 'product_id': 'premium.annual',
            'price_id': 'price_annual_new', 'operation_key': 'catalog-test-1',
        })
        user_id = 'u00000'
        transaction_id = 'txn-u00000'
        wire = recovery_contracts.validation_request('stripe', user_id, transaction_id)
        trace = {'provider': 'stripe', **wire}

        result = recovery_domain.provider_validate(
            self.provider_db, self.adapty_db,
            {'provider': 'stripe', 'transaction_id': transaction_id, 'user_id': user_id,
             'operation_key': 'validation-test-1', 'contract_trace': trace},
        )

        profile = recovery_domain.adapty_profiles(self.adapty_db, user_id)
        self.assertTrue(result['accepted'])
        self.assertEqual(result['request_contract'], trace)
        self.assertEqual(profile['status'], 'active')
        self.assertEqual(profile['transaction_id'], transaction_id)

    def test_validation_operation_key_is_bound_to_request(self):
        recovery_domain.repair_catalog(self.adapty_db, {
            'provider': 'stripe', 'product_id': 'premium.annual',
            'price_id': 'price_annual_new', 'operation_key': 'catalog-test-2',
        })
        user_id = 'u00000'
        transaction_id = 'txn-u00000'
        trace = {'provider': 'stripe', **recovery_contracts.validation_request(
            'stripe', user_id, transaction_id)}
        request = {'provider': 'stripe', 'transaction_id': transaction_id,
                   'user_id': user_id, 'operation_key': 'validation-test-2',
                   'contract_trace': trace}
        first = recovery_domain.provider_validate(self.provider_db, self.adapty_db, request)
        duplicate = recovery_domain.provider_validate(self.provider_db, self.adapty_db, request)
        self.assertFalse(first['duplicate'])
        self.assertTrue(duplicate['duplicate'])

        changed = {**request, 'transaction_id': 'txn-u00001'}
        with self.assertRaisesRegex(ValueError, 'different request'):
            recovery_domain.provider_validate(self.provider_db, self.adapty_db, changed)

    def test_missing_profile_self_heal_never_grants_access(self):
        before = recovery_domain.lumen_access(self.lumen_db, 'u00000')
        result = recovery_domain.lumen_demo_fault(
            self.lumen_db, 'self_heal', user_id='u00000', entitlement=None)
        after = recovery_domain.lumen_access(self.lumen_db, 'u00000')

        self.assertFalse(before['allowed'])
        self.assertFalse(after['allowed'])
        self.assertFalse(after['active'])
        self.assertEqual(result['status'], 'no_current_entitlement')
        self.assertGreater(after['projection_revision'], before['projection_revision'])

    def test_offline_fixture_is_paginated_as_unverified_history_only(self):
        recovery_domain.init_provider(
            self.provider_db, self.adapty_db, 'offline', 0, reset=True,
            run_id='test-offline-run')
        recovery_domain.init_lumen(self.lumen_db, 'offline', 0, reset=True,
                                   run_id='test-offline-run')

        accounts = recovery_domain.provider_accounts(self.provider_db, limit=1000)
        first_history = recovery_domain.provider_history(self.provider_db, limit=1000)
        last_history = recovery_domain.provider_history(
            self.provider_db, cursor='29000', limit=1000)
        profiles = recovery_domain.adapty_profiles(self.adapty_db, limit=1000)
        clients = recovery_domain.lumen_accounts(self.lumen_db, limit=1000)
        account_42 = next(item for item in accounts['items'] if item['user_id'] == 'u00042')
        db = recovery_domain.connect(self.provider_db)
        try:
            manifest = recovery_domain.manifest(db)
        finally:
            db.close()

        self.assertEqual(accounts['total'], 50000)
        self.assertEqual(first_history['total'], 29794)
        self.assertEqual(len(first_history['items']), 1000)
        self.assertEqual(first_history['next_cursor'], '1000')
        self.assertEqual(len(last_history['items']), 794)
        self.assertIsNone(last_history['next_cursor'])
        self.assertTrue(all(item['payment_verification'] == 'unverified_synthetic_history'
                            for item in first_history['items']))
        self.assertEqual(profiles['total'], 0)
        self.assertEqual(clients['total'], 0)
        self.assertEqual(recovery_domain.provider_evidence(self.provider_db)['total'], 0)
        self.assertEqual(account_42['provider_customer_id'], 'lumen_test_offline_run_00042')
        self.assertEqual(account_42['identity_status'], 'unknown')
        self.assertEqual(manifest['official_import']['transactions'], 29794)
        self.assertEqual(manifest['provenance'], 'official_hackathon_synthetic')
        self.assertEqual(manifest['payment_verification'], 'unverified_synthetic_history')


if __name__ == '__main__':
    unittest.main()
