from pathlib import Path
import sys
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import hackathon_data as data


class HackathonDataTests(unittest.TestCase):
    def sample(self):
        return next(data.csv_rows(data.FIXTURES / 'transactions.csv.gz'))

    def test_official_checksums_and_identity_are_preserved(self):
        manifest = data.verify_files()
        row = self.sample()
        normalized = data.normalized_transaction(row)
        self.assertEqual(normalized['user_id'], 'u00000')
        self.assertEqual(normalized['renew_status_changed_at'], row['renew_status_changed_at'])
        self.assertEqual(normalized['payment_verification'], 'unverified_synthetic_history')
        self.assertEqual(manifest['files']['users.csv.gz']['rows'], 50000)

    def test_cancelled_renewal_does_not_end_current_period(self):
        row = self.sample()
        self.assertEqual(row['renew_status'], 'false')
        self.assertEqual(data.lifecycle([row], data.timestamp(data.ANCHOR)), 'current_synthetic_purchase')
        self.assertEqual(data.lifecycle([row], data.timestamp(row['expires_at'])), 'no_current_period')

    def test_refund_trial_future_and_billing_require_distinct_assessments(self):
        row = self.sample()
        at = data.timestamp(data.ANCHOR)
        self.assertEqual(data.lifecycle([{**row, 'refunded_at': data.ANCHOR}], at), 'no_current_period')
        self.assertEqual(data.lifecycle([{**row, 'offer': 'free_trial', 'price_local': '0'}], at), 'trial')
        self.assertEqual(data.lifecycle([{**row, 'billing_issue_detected_at': data.ANCHOR}], at), 'needs_billing_policy')
        self.assertEqual(data.lifecycle([{**row, 'purchased_at': '2027-01-01T00:00:00Z'}], at), 'no_purchase_history')

    def test_boundary_rejects_untrusted_dates_prices_and_ids(self):
        row = self.sample()
        for field, value in [('seq', '-1'), ('price_local', 'NaN'), ('price_local', '-1'),
                             ('currency', 'usd'), ('purchased_at', '2026-01-01'),
                             ('expires_at', '2000-01-01T00:00:00Z')]:
            with self.subTest(field=field, value=value), self.assertRaises(ValueError):
                data.normalized_transaction({**row, field: value})


if __name__ == '__main__':
    unittest.main()
