import gzip
import json
import os
from pathlib import Path
import stat
import sys
import tempfile
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from adapty_seed_setup import demo_accounts, private_write


class SeedSetupTests(unittest.TestCase):
    def test_private_write_is_exclusive_and_private(self):
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder) / 'credential'
            private_write(path, 'test-only-value')
            self.assertEqual(stat.S_IMODE(path.stat().st_mode), 0o600)
            with self.assertRaises(FileExistsError):
                private_write(path, 'replacement')
            self.assertEqual(path.read_text(), 'test-only-value')
            link = Path(folder) / 'link'
            os.symlink(path, link)
            with self.assertRaises(FileExistsError):
                private_write(link, 'replacement')

    def test_candidates_preserve_ids_and_exclude_unsupported_lifecycles(self):
        with tempfile.TemporaryDirectory() as folder:
            source = Path(folder)
            (source / 'data').mkdir()
            valid = {'t': -100, 'purchase_type': 'subscription', 'product': 'annual',
                     'exp': 90000, 'offer': None, 'refunded': None, 'billing': None}
            rejected = [dict(valid, exp=-1), dict(valid, offer='free_trial'),
                        dict(valid, refunded=-10), dict(valid, billing=-10),
                        dict(valid, product='pro_annual')]
            users = [{'i': i, 'tx': [tx]} for i, tx in enumerate(rejected)]
            users += [{'i': i, 'tx': [valid]} for i in range(10, 115)]
            with gzip.open(source / 'data' / 'lumen_dataset.json.gz', 'wt') as output:
                json.dump({'users': users}, output)
            ids = demo_accounts(source, 'lumen_123456_')
            self.assertEqual(ids, [f'lumen_123456_{i:05d}' for i in range(10, 110)])

    def test_short_candidate_registry_is_rejected(self):
        with tempfile.TemporaryDirectory() as folder:
            source = Path(folder)
            (source / 'data').mkdir()
            with gzip.open(source / 'data' / 'lumen_dataset.json.gz', 'wt') as output:
                json.dump({'users': []}, output)
            with self.assertRaisesRegex(ValueError, 'fewer than 100'):
                demo_accounts(source, 'lumen_123456_')
