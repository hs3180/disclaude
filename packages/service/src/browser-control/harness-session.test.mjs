import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { BrowserHarnessSession } from './harness-session.mjs';

const roots = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixturePython(directory) {
  const executable = join(directory, 'fake-python.mjs');
  writeFileSync(executable, `#!/usr/bin/env node
if (process.argv.includes('browser_harness.daemon')) {
  process.stderr.write(JSON.stringify({ pythonHome: process.env.PYTHONHOME ?? null, pythonPath: process.env.PYTHONPATH ?? null, virtualEnv: process.env.VIRTUAL_ENV ?? null, condaPrefix: process.env.CONDA_PREFIX ?? null, noUserSite: process.env.PYTHONNOUSERSITE ?? null, parentPid: process.env.DISCLAUDE_BROWSER_PARENT_PID ?? null, guardedRunner: process.argv.some(argument => argument.includes('runpy.run_module')) }) + '\\n');
  setInterval(() => {}, 1000);
} else {
  let code = '';
  process.stdin.on('data', chunk => { code += chunk; });
  process.stdin.on('end', () => {
    if (process.env.FIXTURE_CLI_HANG === '1') {
      setInterval(() => {}, 1000);
      return;
    }
    process.stdout.write(code.includes('COORDINATED_TARGET') ? 'COORDINATED_TARGET=0123456789abcdef\\n' : 'SCRIPT_OK\\n');
  });
}
`, { mode: 0o700 });
  return executable;
}

describe('in-process Python browser harness session', () => {
  it('starts the daemon, executes CLI scripts, and stops its process group', async () => {
    const root = mkdtempSync(join(tmpdir(), 'disclaude-harness-session-'));
    roots.push(root);
    const python = fixturePython(root);
    const events = [];
    const session = new BrowserHarnessSession({
      python,
      cwd: root,
      runtime: join(root, 'runtime'),
      url: 'ws://fixture.invalid',
      target: 'fixture-target',
      env: {
        ...process.env,
        PYTHONHOME: '/fixture/python-home',
        PYTHONPATH: '/fixture/python-path',
        VIRTUAL_ENV: '/fixture/other-venv',
        CONDA_PREFIX: '/fixture/conda',
      },
      onEvent: event => events.push(event),
    });

    const started = await session.start();
    expect(started).toMatchObject({ python, cwd: root });
    expect(events).toContainEqual(expect.objectContaining({ type: 'daemon-started', pid: started.pid }));
    const result = await session.execute('print("SCRIPT_OK")', root);
    expect(result).toEqual({
      result: { stdout: 'SCRIPT_OK\n', stderr: '', code: 0, signal: null },
      target: '0123456789abcdef',
    });
    expect(session.stderr).toContain('"pythonHome":null');
    expect(session.stderr).toContain('"pythonPath":null');
    expect(session.stderr).toContain('"noUserSite":"1"');
    expect(session.stderr).toContain(`"parentPid":"${process.pid}"`);
    expect(session.stderr).toContain('"guardedRunner":true');

    await session.stop();
    expect(session.daemonProcess.closed).toBe(true);
    expect(events).toContainEqual(expect.objectContaining({ type: 'daemon-exit', signal: 'SIGTERM' }));
  });

  it('bounds readiness polling and reports captured Python diagnostics', async () => {
    const root = mkdtempSync(join(tmpdir(), 'disclaude-harness-session-'));
    roots.push(root);
    const python = fixturePython(root);
    const session = new BrowserHarnessSession({
      python,
      cwd: root,
      runtime: join(root, 'runtime'),
      url: 'ws://fixture.invalid',
      target: 'fixture-target',
      startupMs: 80,
      env: { ...process.env, FIXTURE_CLI_HANG: '1' },
    });

    await expect(session.start()).rejects.toThrow(/readiness timeout|timeout; outcome unknown/u);
    await session.stop();
    expect(session.daemonProcess.closed).toBe(true);
  });
});
