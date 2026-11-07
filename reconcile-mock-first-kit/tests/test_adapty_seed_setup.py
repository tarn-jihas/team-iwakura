import gzip
import json
import os
from pathlib import Path
import stat
import sys
import tempfile
import unittest
from unittest.mock import patch
from subprocess import CompletedProcess

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from adapty_seed_setup import demo_accounts, private_write, read_cli_catalog


class SeedSetupTests(unittest.TestCase):
    def test_cli_catalog_reads_all_pages_and_drops_unneeded_fields(self):
        def reply(page, item):
            return CompletedProcess([], 0, json.dumps({'data': [item], 'meta': {
                'pagination': {'page': page, 'pages': 2, 'count': 2}}}), '')
        app_id = '46a573aa-8c90-4b4b-ba72-2349ae9fb030'
        with patch('adapty_seed_setup.subprocess.run', side_effect=[
                CompletedProcess([], 0, 'adapty/0.18.0', ''),
                reply(1, {'id': 'b', 'title': 'Annual', 'secret_key': 'do-not-export',
                    'vendor_products': {'app_store': {'product_id': 'annual', 'extra': 'omit'}}}),
                reply(2, {'id': 'a', 'title': 'Monthly'})]) as command:
            result = read_cli_catalog(app_id)
        self.assertEqual(result['product_count'], 2)
        self.assertEqual([p['id'] for p in result['products']], ['a', 'b'])
        self.assertNotIn('do-not-export', json.dumps(result))
        self.assertEqual(command.call_args_list[-1].args[0][-5:], ['--page', '2', '--page-size', '100', '--json'])

    def test_cli_catalog_rejects_silent_truncation(self):
        response = {'data': [], 'meta': {'pagination': {'page': 1, 'pages': 1, 'count': 6}}}
        with patch('adapty_seed_setup.subprocess.run', side_effect=[
                CompletedProcess([], 0, 'adapty/0.18.0', ''),
                CompletedProcess([], 0, json.dumps(response), '')]):
            with self.assertRaisesRegex(ValueError, 'incomplete'):
                read_cli_catalog('46a573aa-8c90-4b4b-ba72-2349ae9fb030')

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
