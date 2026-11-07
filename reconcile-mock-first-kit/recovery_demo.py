#!/usr/bin/env python3
"""Launch three isolated local recovery services; never run a live provider seed."""
from __future__ import annotations

import argparse
import json
import os
from pathlib import Path
import secrets
import selectors
import signal
import socket
import subprocess
import sys
import time
from urllib.error import URLError
from urllib.request import urlopen

HERE = Path(__file__).resolve().parent


def free_port():
    with socket.socket() as listener:
        listener.bind(('127.0.0.1', 0))
        return listener.getsockname()[1]


def private_key(path):
    path.parent.mkdir(parents=True, exist_ok=True)
    try:
        fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    except FileExistsError:
        return
    with os.fdopen(fd, 'w') as output:
        output.write(secrets.token_hex(32))


class Demo:
    """Own only child processes and their runtime; useful to the external UAT harness."""
    def __init__(self, runtime, port=0):
        self.runtime = Path(runtime).resolve()
        self.port = port or free_port()
        self.processes = {}
        self.logs = {}
        self.urls = {}

    def start_role(self, role):
        key = self.runtime / 'collector.key'
        private_key(key)
        command = [sys.executable, '-u', str(HERE / 'recovery_service.py'),
                   '--role', role, '--port', str(self.port if role == 'engine' else 0),
                   '--db', str(self.runtime / (role + '.sqlite3')),
                   '--key-file', str(key), '--demo']
        if role in ('lumen', 'engine'):
            command += ['--provider-url', self.urls['provider']]
        if role == 'lumen':
            command += ['--collector-url', f'http://127.0.0.1:{self.port}/api/recovery/collector']
        if role == 'engine':
            command += ['--lumen-url', self.urls['lumen']]
        log = (self.runtime / (role + '.log')).open('ab')
        self.logs[role] = log
        process = subprocess.Popen(command, stdout=subprocess.PIPE, stderr=log, text=True)
        self.processes[role] = process
        with selectors.DefaultSelector() as selector:
            selector.register(process.stdout, selectors.EVENT_READ)
            if not selector.select(timeout=15):
                raise RuntimeError(f'{role} did not announce readiness; inspect {role}.log')
            line = process.stdout.readline()
        if not line:
            raise RuntimeError(f'{role} exited during startup; inspect {role}.log')
        try:
            announcement = json.loads(line)
            port = int(announcement['port'])
            if announcement['role'] != role or not 1 <= port <= 65535:
                raise ValueError('Invalid announcement')
        except (ValueError, KeyError, TypeError) as exc:
            raise RuntimeError(f'{role} returned an invalid startup announcement') from exc
        self.urls[role] = f'http://127.0.0.1:{port}'
        with urlopen(self.urls[role] + '/health', timeout=5) as response:
            if response.status != 200:
                raise RuntimeError(role + ' failed its health check')
        return process

    def start(self):
        self.runtime.mkdir(parents=True, exist_ok=True, mode=0o700)
        try:
            for role in ('provider', 'lumen', 'engine'):
                self.start_role(role)
        except BaseException:
            self.close()
            raise
        return self

    def stop_role(self, role):
        process = self.processes.pop(role, None)
        if process:
            if process.poll() is None:
                process.terminate()
                try:
                    process.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    process.kill()
                    process.wait(timeout=5)
            process.stdout.close()
        log = self.logs.pop(role, None)
        if log:
            log.close()

    def close(self):
        for role in ('engine', 'lumen', 'provider'):
            self.stop_role(role)

    def __enter__(self):
        return self.start()

    def __exit__(self, *_):
        self.close()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--port', type=int, default=8875)
    parser.add_argument('--runtime', type=Path, default=HERE / 'runtime' / 'recovery')
    args = parser.parse_args()
    if not 0 <= args.port <= 65535:
        parser.error('port must be between 0 and 65535')

    def terminate(*_):
        raise KeyboardInterrupt

    signal.signal(signal.SIGTERM, terminate)
    try:
        with Demo(args.runtime, args.port) as demo:
            print(json.dumps({'mode': 'FULL_MOCK', 'url': demo.urls['engine'],
                              'services': demo.urls, 'runtime': str(demo.runtime)}), flush=True)
            while True:
                for role, process in demo.processes.items():
                    if process.poll() is not None:
                        raise RuntimeError(f'{role} stopped unexpectedly; inspect {demo.runtime / (role + ".log")}')
                time.sleep(0.25)
    except KeyboardInterrupt:
        pass
    except (RuntimeError, OSError, URLError) as exc:
        raise SystemExit(str(exc)) from exc


if __name__ == '__main__':
    main()
