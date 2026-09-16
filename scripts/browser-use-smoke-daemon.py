#!/usr/bin/env python3
"""Read-only cold-start assertion; never starts or signals a browser daemon."""
import os
import sys
from browser_harness import _ipc

name = os.environ['BU_NAME']
# Probe plus the pending PID record: a spawning daemon may not answer IPC yet.
if _ipc.identify(name) is not None or _ipc.pid_path(name).exists():
    print('Smoke daemon is live or still starting', file=sys.stderr)
    sys.exit(1)
print('DAEMON_STOPPED')
