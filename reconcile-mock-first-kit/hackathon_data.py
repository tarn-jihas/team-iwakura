"""Verified offline import of the official synthetic Lumen fixture; no network calls."""
from __future__ import annotations

import argparse
from collections import Counter
import csv
from datetime import datetime, timezone
from decimal import Decimal, InvalidOperation
import gzip
import hashlib
import json
from pathlib import Path
import resource
import sqlite3
import sys
import tempfile
import time

FIXTURES = Path(__file__).resolve().parent / 'fixtures' / 'hackathon'
ANCHOR = '2026-11-03T00:12:04Z'


def timestamp(value):
    if not isinstance(value, str) or not value:
        raise ValueError('An explicit timestamp is required')
    try:
        result = datetime.fromisoformat(value.replace('Z', '+00:00'))
    except ValueError as exc:
        raise ValueError('Invalid fixture timestamp') from exc
    if result.tzinfo is None:
        raise ValueError('Fixture timestamps must include timezone')
    return result.astimezone(timezone.utc)


def normalized_transaction(row):
    """Retain source IDs/lifecycle; normalized values never claim payment verification."""
    for field in ('user_id', 'seq', 'purchase_type', 'product', 'store_product_id', 'currency'):
        if not isinstance(row.get(field), str) or not row[field].strip():
            raise ValueError('Missing fixture field: ' + field)
    if not row['seq'].isdigit():
        raise ValueError('Transaction sequence must be a nonnegative integer')
    if row['purchase_type'] not in ('subscription', 'one_time_purchase'):
        raise ValueError('Unsupported fixture purchase type')
    currency = row['currency']
    if len(currency) != 3 or not currency.isascii() or not currency.isalpha() or currency != currency.upper():
        raise ValueError('Invalid currency')
    try:
        price = Decimal(row['price_local'])
    except (InvalidOperation, KeyError, TypeError) as exc:
        raise ValueError('Invalid fixture price') from exc
    if not price.is_finite() or price < 0:
        raise ValueError('Fixture price must be finite and nonnegative')
    purchased = timestamp(row['purchased_at'])
    for field in ('expires_at', 'originally_purchased_at', 'renew_status_changed_at',
                  'billing_issue_detected_at', 'refunded_at'):
        if row.get(field):
            timestamp(row[field])
    if row.get('expires_at') and timestamp(row['expires_at']) < purchased:
        raise ValueError('Expiry precedes purchase')
    if row.get('renew_status', '') not in ('', 'true', 'false'):
        raise ValueError('Invalid renewal status')
    return {**row, 'seq': int(row['seq']), 'price_local': format(price, 'f'),
            'provenance': 'official_hackathon_synthetic',
            'payment_verification': 'unverified_synthetic_history'}


def verify_files(directory=FIXTURES):
    directory = Path(directory)
    manifest = json.loads((directory / 'manifest.json').read_text())
    for name, spec in manifest['files'].items():
        path = directory / name
        with path.open('rb') as stream:
            checksum = hashlib.sha256()
            for block in iter(lambda: stream.read(1024 * 1024), b''):
                checksum.update(block)
            actual = checksum.hexdigest()
        if actual != spec['sha256']:
            raise ValueError('Fixture checksum mismatch: ' + name)
    return manifest


def csv_rows(path):
    with gzip.open(path, 'rt', encoding='utf-8', newline='') as stream:
        yield from csv.DictReader(stream)


def import_offline(connection, directory=FIXTURES):
    """Transactional streaming import; unique keys prevent silent duplicate loss."""
    directory = Path(directory)
    manifest = verify_files(directory)
    connection.execute('PRAGMA foreign_keys=ON')
    connection.executescript('''
        CREATE TABLE IF NOT EXISTS users(id TEXT PRIMARY KEY, platform TEXT NOT NULL, raw TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS transactions(
            user_id TEXT NOT NULL REFERENCES users(id), seq INTEGER NOT NULL,
            raw TEXT NOT NULL, PRIMARY KEY(user_id,seq));
        CREATE TABLE IF NOT EXISTS provenance(id INTEGER PRIMARY KEY CHECK(id=1), raw TEXT NOT NULL);
    ''')
    if connection.execute('SELECT count(*) FROM users').fetchone()[0]:
        raise ValueError('Import destination must be empty; existing data is preserved')
    user_count = transaction_count = 0
    try:
        with connection:
            for row in csv_rows(directory / 'users.csv.gz'):
                if not row.get('user_id') or row.get('platform') not in ('iOS', 'Android'):
                    raise ValueError('Invalid fixture account')
                timestamp(row['install_at'])
                connection.execute('INSERT INTO users VALUES(?,?,?)',
                                   (row['user_id'], row['platform'], json.dumps(row, sort_keys=True)))
                user_count += 1
            for row in csv_rows(directory / 'transactions.csv.gz'):
                item = normalized_transaction(row)
                connection.execute('INSERT INTO transactions VALUES(?,?,?)',
                                   (item['user_id'], item['seq'], json.dumps(item, sort_keys=True)))
                transaction_count += 1
            if user_count != manifest['files']['users.csv.gz']['rows'] or transaction_count != manifest['files']['transactions.csv.gz']['rows']:
                raise ValueError('Fixture row count mismatch')
            connection.execute('INSERT INTO provenance VALUES(1,?)', (json.dumps(manifest, sort_keys=True),))
    except sqlite3.IntegrityError as exc:
        raise ValueError('Duplicate identity/transaction or unknown account in fixture') from exc
    return {'users': user_count, 'transactions': transaction_count, 'revision': manifest['revision']}


def lifecycle(rows, at):
    """Offline lifecycle assessment only: no invented Adapty or client observations."""
    current, seen_purchase = [], False
    for row in rows:
        if timestamp(row['purchased_at']) > at:
            continue
        seen_purchase = True
        if row.get('refunded_at') and timestamp(row['refunded_at']) <= at:
            continue
        if row.get('expires_at') and timestamp(row['expires_at']) <= at:
            continue
        if row.get('billing_issue_detected_at') and timestamp(row['billing_issue_detected_at']) <= at:
            current.append('needs_billing_policy')
        elif row.get('offer') and Decimal(row['price_local']) == 0:
            current.append('trial')
        else:
            current.append('current_synthetic_purchase')
    for status in ('current_synthetic_purchase', 'trial', 'needs_billing_policy'):
        if status in current:
            return status
    return 'no_current_period' if seen_purchase else 'no_purchase_history'


def scan_offline(connection, at=ANCHOR, page_size=500):
    if isinstance(page_size, bool) or not isinstance(page_size, int) or not 1 <= page_size <= 2000:
        raise ValueError('page_size must be between 1 and 2000')
    at = timestamp(at)
    cursor = ''
    counts, accounts, transactions, pages = Counter(), 0, 0, 0
    fingerprint = hashlib.sha256()
    while True:
        users = connection.execute('SELECT id FROM users WHERE id>? ORDER BY id LIMIT ?', (cursor, page_size)).fetchall()
        if not users:
            break
        end = users[-1][0]
        grouped = {user_id: [] for (user_id,) in users}
        for user_id, raw in connection.execute('SELECT user_id,raw FROM transactions WHERE user_id>? AND user_id<=? ORDER BY user_id,seq', (cursor, end)):
            grouped[user_id].append(json.loads(raw))
            transactions += 1
        for user_id, rows in grouped.items():
            status = lifecycle(rows, at)
            counts[status] += 1
            fingerprint.update((user_id + ':' + status + '\n').encode())
        accounts += len(users)
        pages += 1
        cursor = end
    return {'accounts_scanned': accounts, 'transactions_scanned': transactions,
            'pages': pages, 'page_size': page_size, 'complete': True,
            'lifecycle_counts': dict(counts), 'result_hash': fingerprint.hexdigest(),
            'payment_confirmation': 'unverified_synthetic_history',
            'adapty_coverage': 'not_observed', 'client_gate_coverage': 'not_observed',
            'repair_eligible': 0, 'scope': 'offline_source_lifecycle_only'}


def check(directory=FIXTURES):
    started = time.perf_counter()
    with tempfile.TemporaryDirectory(prefix='reconcile-offline-') as temporary:
        with sqlite3.connect(Path(temporary) / 'fixture.sqlite3') as connection:
            imported = import_offline(connection, directory)
            first = scan_offline(connection)
            second = scan_offline(connection, page_size=731)
            assert first['result_hash'] == second['result_hash'], 'Pagination changed assessment'
            assert first['accounts_scanned'] == imported['users']
            assert first['transactions_scanned'] == imported['transactions']
    with gzip.open(Path(directory) / 'lumen_dataset.json.gz', 'rt') as stream:
        compact = json.load(stream)
        assert len(compact['users']) == 5000
    peak = resource.getrusage(resource.RUSAGE_SELF).ru_maxrss
    return {'mode': 'OFFLINE_SYNTHETIC', 'import': imported, 'scan': first,
            'pagination_invariant': True, 'compact_users': len(compact['users']),
            'elapsed_seconds': round(time.perf_counter() - started, 3),
            'peak_rss_mib': round(peak / (1024 * 1024 if sys.platform == 'darwin' else 1024), 2),
            'measurement': 'local process high-water RSS; includes both scans and fixture validation'}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('command', choices=['check'])
    parser.add_argument('--output', type=Path)
    args = parser.parse_args()
    result = json.dumps(check(), indent=2) + '\n'
    if args.output:
        args.output.write_text(result)
    print(result)


if __name__ == '__main__':
    main()
