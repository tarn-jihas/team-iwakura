#!/usr/bin/env python3
"""Run the pinned official seed once in an existing, isolated hackathon app."""
from __future__ import annotations

import argparse
from datetime import datetime, timezone
import gzip
import hashlib
import json
import os
from pathlib import Path
import re
import stat
import subprocess
import sys

REVISION = '77d39ed807a66bbebcf24fe67c42be4fc9ef4c82'
SCRIPT_SHA256 = '9477a90e19d8a8e4c85a68dac0ab58bed2a75bb1f8af2aed9ab34cb8a991a156'
DATASET_SHA256 = '9943d29ded31266d48cf067ff942723ffcbd2d1e64692871b1f0a63a50acb9dd'
TITLE = 'Lumen - AI Photo Editor (Hackathon)'
HERE = Path(__file__).resolve().parent


def private_write(path, value):
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(fd, 'w') as stream:
        stream.write(value)
        stream.flush()
        os.fsync(stream.fileno())


def demo_accounts(source, prefix):
    """Choose candidates only; the live adapter must independently check access."""
    with gzip.open(source / 'data' / 'lumen_dataset.json.gz', 'rt') as stream:
        data = json.load(stream)
    accounts = []
    for user in data['users']:
        latest = max(user['tx'], key=lambda tx: tx['t'], default={})
        if (latest.get('purchase_type') == 'subscription'
                and latest.get('product') != 'pro_annual'
                and (latest.get('exp') or 0) > 86400
                and latest.get('offer') != 'free_trial'
                and latest.get('refunded') is None and latest.get('billing') is None):
            accounts.append(prefix + f"{user['i']:05d}")
            if len(accounts) == 100:
                return accounts
    raise ValueError('Official seed has fewer than 100 suitable account candidates')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--source', type=Path, required=True)
    parser.add_argument('--app-id', required=True)
    parser.add_argument('--runtime', type=Path, default=HERE / 'runtime' / 'live-adapty')
    args = parser.parse_args()
    source, runtime = args.source.resolve(), args.runtime.resolve()
    script = source / 'seed_adapty.py'
    if hashlib.sha256(script.read_bytes()).hexdigest() != SCRIPT_SHA256:
        parser.error('Seed script does not match the reviewed official revision')
    dataset = source / 'data' / 'lumen_dataset.json.gz'
    if hashlib.sha256(dataset.read_bytes()).hexdigest() != DATASET_SHA256:
        parser.error('Dataset does not match the pinned official fixture')
    runtime.mkdir(parents=True, exist_ok=True, mode=0o700)
    if stat.S_IMODE(runtime.stat().st_mode) & 0o077:
        parser.error('Runtime directory must be private (mode 0700)')
    if (runtime / 'seed-started.json').exists():
        parser.error('Seed already started here; inspect its log/status rather than replaying it')
    result = subprocess.run(['adapty', 'apps', 'get', args.app_id, '--json'],
                            capture_output=True, text=True, timeout=30)
    if result.returncode:
        parser.error('Adapty CLI could not read this app; check authentication')
    app = json.loads(result.stdout)
    app = app.get('data', app)
    if app.get('id') != args.app_id or app.get('title') != TITLE:
        parser.error('App identity/title does not match the isolated official Lumen demo')
    key = app.get('secret_key')
    if not isinstance(key, str) or not key.startswith('secret_'):
        parser.error('CLI did not return an app secret key')
    key_file = runtime / 'adapty-secret.key'
    private_write(key_file, key)
    started = datetime.now(timezone.utc).isoformat()
    seed = {'revision': REVISION, 'script_sha256': SCRIPT_SHA256, 'dataset_sha256': DATASET_SHA256,
            'app_id': args.app_id, 'started_at': started,
            'provenance': 'official_synthetic_seed', 'store_charges': False}
    private_write(runtime / 'seed-started.json', json.dumps(seed, indent=2) + '\n')
    environment = dict(os.environ, ADAPTY_SECRET_KEY=key, PYTHONUNBUFFERED='1')
    log_path = runtime / 'official-seed.log'
    print('Seeding the isolated Lumen app. Private log: ' + str(log_path), flush=True)
    with os.fdopen(os.open(log_path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600), 'w') as log:
        process = subprocess.Popen([sys.executable, '-u', str(script), '--app-id', args.app_id,
                                    '--skip-config'], cwd=source, env=environment,
                                   stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
        try:
            for line in process.stdout:
                log.write(line.replace(key, '[REDACTED]'))
                log.flush()
            code = process.wait()
        finally:
            process.stdout.close()
            if process.poll() is None:
                process.terminate()
                process.wait(timeout=10)
    content = log_path.read_text()
    prefix = re.search(r"customer user ids: '(lumen_\d{6}_)00000'", content)
    counts = re.search(r'profiles:\s+(\d+) created, (\d+) failed.*?transactions:\s+(\d+) sent, (\d+) failed', content, re.S)
    ok = code == 0 and prefix and counts and counts[2] == '0' and counts[4] == '0'
    status = {**seed, 'finished_at': datetime.now(timezone.utc).isoformat(),
              'status': 'complete' if ok else 'requires_inspection', 'exit_code': code}
    if counts:
        status.update(profiles_created=int(counts[1]), profiles_failed=int(counts[2]),
                      transactions_sent=int(counts[3]), transactions_failed=int(counts[4]))
    if prefix:
        status['run_prefix'] = prefix[1]
    private_write(runtime / 'seed-status.json', json.dumps(status, indent=2) + '\n')
    if not ok:
        raise SystemExit('Seed is incomplete; inspect the private log. It was not automatically repeated.')
    config = {'app_id': args.app_id, 'title': TITLE, 'secret_key_file': str(key_file),
              'environment': 'hackathon_seed', 'source_environment': 'Production',
              'seed': status, 'customer_user_ids': demo_accounts(source, prefix[1])}
    private_write(runtime / 'live-config.json', json.dumps(config, indent=2) + '\n')
    print(json.dumps({'status': 'complete', 'app_id': args.app_id,
                      'profiles': int(counts[1]), 'transactions': int(counts[3]),
                      'config': str(runtime / 'live-config.json')}), flush=True)


if __name__ == '__main__':
    main()
