#!/usr/bin/env python3
"""POSIX timeout fallback for macOS hosts without GNU timeout."""
import os
import signal
import subprocess
import sys


def signal_group(process, sig):
    try:
        os.killpg(process.pid, sig)
    except ProcessLookupError:
        pass


def stop_group(process):
    signal_group(process, signal.SIGTERM)
    try:
        process.wait(timeout=2)
    except subprocess.TimeoutExpired:
        pass
    # The immediate child may exit before grandchildren that ignored TERM.
    signal_group(process, signal.SIGKILL)
    process.wait()


def interrupted(signum, _frame):
    stop_group(process)
    sys.exit(128 + signum)


seconds = float(sys.argv[1])
process = subprocess.Popen(sys.argv[2:], start_new_session=True)
signal.signal(signal.SIGTERM, interrupted)
signal.signal(signal.SIGINT, interrupted)
try:
    code = process.wait(timeout=seconds)
    sys.exit(code if code >= 0 else 128 - code)
except subprocess.TimeoutExpired:
    stop_group(process)
    sys.exit(124)
