import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { EventEmitter } from 'node:events';
import { inflateSync } from 'node:zlib';
import { buildPatch } from '../../bin/jupyter-patch.js';
import { deployTerminal } from '../../bin/jupyter-terminal.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const cli = join(root, 'bin/disclaude.js');
const run = (args, options = {}) =>
  execFileSync(process.execPath, [cli, 'jupyter', 'patch', ...args], {
    encoding: 'utf8',
    ...options,
  });
const sha = (data) => createHash('sha256').update(data).digest('hex');

function fixture() {
  const path = mkdtempSync(join(tmpdir(), 'jupyter-cli-'));
  mkdirSync(join(path, 'bin'));
  return path;
}

test('public CLI generates reproducible artifacts outside the checkout with no host Python or PATH tools', () => {
  const path = fixture();
  try {
    const options = { cwd: path, env: { ...process.env, PATH: '' } };
    const info = JSON.parse(run(['info'], options));
    assert.equal(info.target, 'jupyter_server_nbmodel');
    assert.equal(info.activation.hotApplySupported, false);
    assert.equal(info.activation.serverRestartRequired, true);
    const first = JSON.parse(run(['generate', '--output', join(path, 'first.pyz')], options));
    const second = JSON.parse(run(['generate', '--output', join(path, 'second.pyz')], options));
    assert.equal(first.sha256, second.sha256);
    assert.equal(first.sha256, sha(readFileSync(first.artifact)));
    assert.equal(first.manifestSha256, info.manifestSha256);
    assert.equal(readFileSync(first.artifact + '.sha256', 'utf8').split(' ')[0], first.sha256);
    writeFileSync(join(path, 'owned.pyz'), 'existing-user-file');
    const refused = spawnSync(
      process.execPath,
      [cli, 'jupyter', 'patch', 'generate', '--output', join(path, 'owned.pyz')],
      options
    );
    assert.notEqual(refused.status, 0);
    assert.equal(readFileSync(join(path, 'owned.pyz'), 'utf8'), 'existing-user-file');
  } finally {
    rmSync(path, { recursive: true, force: true });
  }
});

test('removed transports and lifecycle options are refused before authentication or any external command', () => {
  const path = fixture();
  try {
    for (const action of ['prepare', 'apply', 'rollback', 'status'])
      for (const option of [
        '--ssh',
        '--container',
        '--service',
        '--system',
        '--restart',
        '--stopped',
        'constructor',
        '__proto__',
      ]) {
        const result = spawnSync(
          process.execPath,
          [cli, 'jupyter', 'patch', action, option, 'fixture'],
          { encoding: 'utf8', cwd: path, env: { ...process.env, PATH: '' } }
        );
        assert.notEqual(result.status, 0);
        assert(result.stderr.includes('Unknown option or missing value: ' + option));
      }
    const help = run(['--help'], { cwd: path, env: { ...process.env, PATH: '' } });
    assert.match(help, /authenticated Jupyter Terminal/);
    assert(!/--ssh|--container|--service|--restart|--stopped/.test(help));
  } finally {
    rmSync(path, { recursive: true, force: true });
  }
});

test('hot activation and relative target paths are refused before login', () => {
  for (const args of [
    ['apply', '--hot'],
    ['prepare', '--state-dir', 'relative'],
    ['prepare', '--python', '-invalid'],
  ]) {
    const result = spawnSync(process.execPath, [cli, 'jupyter', 'patch', ...args], {
      encoding: 'utf8',
      env: { ...process.env, PATH: '' },
    });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Hot activation|Target paths|Unknown option|Invalid target/);
  }
});

test('Terminal arguments preserve selected paths as data', async () => {
  const { terminalArguments } = await import('../../bin/jupyter-patch.js');
  const state = "/chosen path/'$(touch literal)";
  assert.deepEqual(
    terminalArguments({
      action: 'apply',
      stateDir: state,
      configFile: '/custom/config.py',
      frontendDir: '/custom/lab',
    }),
    [
      'apply',
      '--config-file',
      '/custom/config.py',
      '--frontend-dir',
      '/custom/lab',
      '--state-dir',
      state,
    ]
  );
});

test('valid Python paths with spaces reach authentication while control characters are refused', () => {
  const path = fixture();
  try {
    for (const python of ['/custom/env/bin/python', '/chosen Python with spaces']) {
      const result = spawnSync(
        process.execPath,
        [cli, 'jupyter', 'patch', 'prepare', '--python', python, '--no-interactive'],
        { cwd: path, encoding: 'utf8', env: { PATH: '' } }
      );
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /missing.*URL|\.env\/environment variables/i);
      assert.doesNotMatch(result.stderr, /Invalid target Python executable/);
    }
    for (const python of ['/env/bin/py\nthon', '/env/bin/py\rthon']) {
      const result = spawnSync(
        process.execPath,
        [cli, 'jupyter', 'patch', 'prepare', '--python', python],
        { cwd: path, encoding: 'utf8', env: { PATH: '' } }
      );
      assert.match(result.stderr, /Invalid target Python executable/);
    }
  } finally {
    rmSync(path, { recursive: true, force: true });
  }
});

function terminalFixture(closeEarly = false, forbidden = false, action = 'prepare') {
  const calls = [],
    commands = [];
  let received, socketHeaders;
  class Socket extends EventEmitter {
    constructor(url, options) {
      super();
      socketHeaders = options.headers;
      queueMicrotask(() => this.emit('open'));
    }
    send(message) {
      const [kind, command] = JSON.parse(message);
      assert.equal(kind, 'stdin');
      commands.push(command);
      if (commands.length === 1) {
        if (closeEarly) return queueMicrotask(() => this.emit('close'));
        const encoded = command.match(/[A-Za-z0-9+/=]{100,}/)[0];
        const script = inflateSync(Buffer.from(encoded, 'base64')).toString('utf8');
        this.ready = script.match(/REPAIR_READY_[a-z0-9]+/)[0];
        this.receipt = script.match(/REPAIR_RESULT_[a-z0-9]+/)[0];
        // POSIX shells can prefix Python's first line with bracketed-paste
        // control sequences. The marker must still be recognized once only.
        queueMicrotask(() =>
          this.emit(
            'message',
            Buffer.from(JSON.stringify(['stdout', '\x1b[?2004l\r' + this.ready + '\r\n']))
          )
        );
      } else if (command.trim() === this.receipt) {
        received = Buffer.from(commands.slice(1, -1).join('').replaceAll('\n', ''), 'base64');
        const output =
          this.receipt +
          JSON.stringify({
            ok: true,
            result: {
              phase:
                action === 'apply' ? 'applied' : action === 'rollback' ? 'rolled_back' : 'prepared',
              deployment: 'environment',
              serverRestartRequired: ['apply', 'rollback'].includes(action),
              runningCodeVerified: false,
            },
          }) +
          '\r\n';
        const middle = Math.floor(output.length / 2);
        queueMicrotask(() => {
          this.emit('message', Buffer.from(JSON.stringify(['stdout', output.slice(0, middle)])));
          this.emit('message', Buffer.from(JSON.stringify(['stdout', output.slice(middle)])));
        });
      } else {
        assert(command.length <= 1025, 'PTY lines must remain bounded');
      }
    }
    terminate() {
      this.emit('close');
    }
  }
  const client = {
    async response(route, method) {
      calls.push([route, method]);
      return {
        ok: !forbidden,
        status: forbidden ? 403 : method === 'DELETE' ? 204 : 200,
        body: { async cancel() {} },
      };
    },
    async responseText() {
      return JSON.stringify({ name: 'owned-terminal' });
    },
    async socket(route) {
      calls.push([route, 'WS']);
      return {
        url: 'ws://owned.invalid/prefix/' + route,
        headers: { Cookie: 'host-private-cookie' },
      };
    },
  };
  return {
    client,
    WebSocket: Socket,
    calls,
    commands,
    received: () => received,
    headers: () => socketHeaders,
  };
}

test('Terminal streams the same repair with bounded PTY lines, handles fragmented/control output and closes only its own terminal', async () => {
  const fixture = terminalFixture(),
    patch = buildPatch();
  const result = await deployTerminal({ action: 'prepare' }, patch, ['prepare'], fixture);
  assert.equal(result.transport, 'jupyter-terminal');
  assert.equal(result.artifactSha256, sha(patch.bytes));
  assert.deepEqual(fixture.received(), patch.bytes);
  assert.equal(fixture.headers().Cookie, 'host-private-cookie');
  assert(!fixture.commands.join('').includes('host-private-cookie'));
  assert.deepEqual(fixture.calls, [
    ['api/terminals', 'POST'],
    ['terminals/websocket/owned-terminal', 'WS'],
    ['api/terminals/owned-terminal', 'DELETE'],
  ]);
});

test('Terminal connection failure does not replay preparation and still closes its owned terminal', async () => {
  const fixture = terminalFixture(true);
  await assert.rejects(
    deployTerminal({ action: 'status' }, buildPatch(), ['status'], fixture),
    /before a verified receipt/
  );
  assert.equal(fixture.commands.length, 1);
  assert.equal(fixture.calls.filter(([, method]) => method === 'POST').length, 1);
  assert.deepEqual(fixture.calls.at(-1), ['api/terminals/owned-terminal', 'DELETE']);
});

test('Disabled/unauthorized terminals fail without a socket or deleting an unknown terminal', async () => {
  const fixture = terminalFixture(false, true);
  await assert.rejects(
    deployTerminal({ action: 'prepare' }, buildPatch(), ['prepare'], fixture),
    /HTTP 403/
  );
  assert.deepEqual(fixture.calls, [['api/terminals', 'POST']]);
  assert.equal(fixture.commands.length, 0);
});

test('Terminal apply and rollback install files without managing Server lifecycle', async () => {
  for (const action of ['apply', 'rollback']) {
    const fixture = terminalFixture(false, false, action);
    const result = await deployTerminal({ action }, buildPatch(), [action], fixture);
    assert.equal(result.phase, action === 'apply' ? 'applied' : 'rolled_back');
    assert.equal(result.serverRestartRequired, true);
    assert.equal(result.runningCodeVerified, false);
    assert.deepEqual(
      fixture.calls.map(([route]) => route),
      ['api/terminals', 'terminals/websocket/owned-terminal', 'api/terminals/owned-terminal']
    );
  }
});

test('an unknown apply result is not replayed and only its own Terminal is closed', async () => {
  const fixture = terminalFixture(true);
  await assert.rejects(
    deployTerminal({ action: 'apply' }, buildPatch(), ['apply'], fixture),
    /before a verified receipt/
  );
  assert.equal(fixture.commands.length, 1);
  assert.equal(fixture.calls.filter(([, method]) => method === 'POST').length, 1);
  assert.deepEqual(fixture.calls.at(-1), ['api/terminals/owned-terminal', 'DELETE']);
});
