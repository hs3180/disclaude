#!/usr/bin/env python3
"""Isolated macOS install/upgrade/rollback rehearsal; never targets a default label.

python3 scripts/rehearse-launchd.py --baseline-entry /absolute/old/dist/cli.js --output /absolute/evidence
Uses no Feishu credentials or model calls. Keeps evidence/workspace for review.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import socket
import subprocess
import sys
import tempfile
import time
import urllib.request
import uuid

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--baseline-entry', type=Path, required=True)
parser.add_argument('--output', type=Path, required=True)
args = parser.parse_args()
if sys.platform != 'darwin':
    parser.error('macOS launchd is required')
root = Path(__file__).resolve().parent.parent
candidate = root / 'packages/service/dist/cli.js'
baseline = args.baseline_entry.resolve()
for entry in (baseline, candidate):
    if not entry.is_file():
        parser.error('Build the baseline and candidate first: ' + str(entry))
state = Path(tempfile.mkdtemp(prefix='disclaude-launchd-rehearsal-'))
label = 'com.disclaude.test.rc-' + uuid.uuid4().hex[:12]
workspace = state / 'workspace'
workspace.mkdir()
proof = workspace / 'preserved.txt'
proof.write_text('PRESERVE_ACROSS_UPGRADE_AND_ROLLBACK\n')
with socket.socket() as probe:
    probe.bind(('127.0.0.1', 0))
    rest_port = probe.getsockname()[1]
config = state / 'config.json'
config.write_text(json.dumps({'workspace': {'dir': str(workspace)},
    'agent': {'agentBackend': 'codex', 'model': 'gpt-5.6-sol'},
    'channels': {'rest': {'port': rest_port, 'host': '127.0.0.1', 'fileStorageDir': str(state / 'files')}},
    'logging': {'level': 'info', 'pretty': False}}))
env = {**os.environ, 'DISCLAUDE_LAUNCHD_ISOLATED': '1',
    'DISCLAUDE_LAUNCHD_LABEL': label, 'DISCLAUDE_LAUNCHD_STATE_DIR': str(state),
    'DISCLAUDE_LAUNCHD_CONFIG_PATH': str(config), 'DISCLAUDE_LAUNCHD_API_PORT': '0'}
# Do not inherit address or auth overrides intended for an existing service.
for key in ('DISCLAUDE_API_BASE_URL', 'DISCLAUDE_API_TOKEN', 'DISCLAUDE_LAUNCHD_API_TOKEN'):
    env.pop(key, None)
record = {'state': str(state), 'label': label, 'stages': [], 'outcome': 'running'}
args.output.mkdir(parents=True, exist_ok=True)
loaded = False

def runtime_identity(entry):
    checkout = entry.parents[3]
    digest = hashlib.sha256()
    files = sorted(checkout.glob('packages/*/dist/**/*.js'))
    if not files:
        raise RuntimeError('No built runtime files for ' + str(entry))
    for file in files:
        digest.update(str(file.relative_to(checkout)).encode())
        digest.update(file.read_bytes())
    revision = subprocess.check_output(['git', '-C', str(checkout), 'rev-parse', 'HEAD'], text=True).strip()
    return {'sourceCommit': revision, 'runtimeSha256': digest.hexdigest(), 'runtimeFiles': len(files)}


def command(name, entry):
    result = subprocess.run(['node', str(root / 'scripts/launchd.mjs'), 'isolated', name],
        env={**env, 'DISCLAUDE_LAUNCHD_ENTRY': str(entry)}, cwd=root,
        capture_output=True, text=True, timeout=45)
    (args.output / (str(len(record['stages'])) + '-' + name + '.log')).write_text(result.stdout + result.stderr)
    if result.returncode:
        raise RuntimeError(name + ' failed: ' + result.stderr[-1500:])

def wait_health(offset):
    stdout = state / 'logs/launchd-stdout.log'
    deadline = time.monotonic() + 30
    while time.monotonic() < deadline:
        text = stdout.read_text()[offset:] if stdout.exists() else ''
        matches = re.findall(r'HTTP API server started on (http://127\.0\.0\.1:\d+)', text)
        if matches:
            url = matches[-1]
            try:
                with urllib.request.urlopen(url + '/api/ping', timeout=2) as response:
                    if json.load(response).get('pong') is True:
                        return url
            except (OSError, ValueError):
                pass
        time.sleep(.2)
    raise RuntimeError('Health timeout; inspect isolated logs under ' + str(state))

try:
    for stage, entry in [('install', baseline), ('upgrade', candidate), ('rollback', baseline)]:
        if loaded:
            command('stop', entry)
            loaded = False
        stdout = state / 'logs/launchd-stdout.log'
        offset = len(stdout.read_text()) if stdout.exists() else 0
        # Set before invoking install: cleanup still runs if load partly succeeds.
        loaded = True
        command('install', entry)
        url = wait_health(offset)
        assert proof.read_text() == 'PRESERVE_ACROSS_UPGRADE_AND_ROLLBACK\n'
        command('status', entry)
        record['stages'].append({'stage': stage, 'entry': str(entry),
            'entrySha256': hashlib.sha256(entry.read_bytes()).hexdigest(), **runtime_identity(entry), 'url': url,
            'health': 'pong', 'workspacePreserved': True})
        print(stage + ': PASS', flush=True)
    record['outcome'] = 'pass'
except Exception as error:
    record['outcome'] = 'fail'
    record['error'] = str(error)
finally:
    try:
        if loaded:
            command('stop', candidate)
        command('uninstall', candidate)
        check = subprocess.run(['launchctl', 'list', label], capture_output=True)
        if check.returncode == 0:
            raise RuntimeError('Test service still loaded after cleanup')
        if (state / 'LaunchAgents' / (label + '.plist')).exists():
            raise RuntimeError('Test plist remains after uninstall')
        record['cleanup'] = 'pass'
    except Exception as error:
        record['cleanup'] = str(error)
        record['outcome'] = 'fail'
    (args.output / 'launchd-rehearsal.json').write_text(json.dumps(record, indent=2))
print(json.dumps(record, indent=2))
sys.exit(0 if record['outcome'] == 'pass' else 1)
