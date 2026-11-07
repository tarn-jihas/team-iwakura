#!/usr/bin/env python3
"""Run the isolated Lumen demo with read-only live Adapty entitlement evidence."""
from __future__ import annotations

import argparse
import json
from pathlib import Path
import signal
import time
from urllib.error import URLError
from urllib.request import urlopen

from recovery_demo import Demo, HERE
from recovery_live import load_config


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--config', type=Path,
                        default=HERE / 'runtime' / 'live-adapty' / 'live-config.json')
    parser.add_argument('--runtime', type=Path,
                        default=HERE / 'runtime' / 'live-adapty' / 'demo')
    parser.add_argument('--port', type=int, default=8876)
    parser.add_argument('--manual', action='store_true',
                        help='Keep the existing approval-gated manual recovery flow')
    args = parser.parse_args()
    if not 0 <= args.port <= 65535:
        parser.error('port must be between 0 and 65535')
    load_config(args.config)

    def terminate(*_):
        raise KeyboardInterrupt

    signal.signal(signal.SIGTERM, terminate)
    try:
        with Demo(args.runtime, args.port, live_config=args.config,
                  auto_repair=not args.manual) as demo:
            with urlopen(demo.urls['engine'] + '/api/recovery/live/status', timeout=15) as response:
                status = json.load(response)
            print(json.dumps({'mode': 'LIVE_ADAPTY_SEEDED', 'scenario': 'live_adapty',
                'url': demo.urls['engine'], 'lumen_url': demo.urls['lumen'],
                'services': demo.urls, 'runtime': str(demo.runtime),
                'ready': status.get('ready'), 'fault_status': status.get('fault_status'),
                'payment_verification': 'not_independently_verified'}), flush=True)
            while True:
                for role, process in demo.processes.items():
                    if process.poll() is not None:
                        raise RuntimeError(role + ' stopped unexpectedly; inspect its runtime log')
                time.sleep(0.25)
    except KeyboardInterrupt:
        pass
    except (RuntimeError, OSError, URLError) as exc:
        raise SystemExit(str(exc)) from exc


if __name__ == '__main__':
    main()
