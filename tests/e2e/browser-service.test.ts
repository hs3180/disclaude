import { describe, expect, it } from 'vitest';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, writeFile, rm, readFile, access } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { createServer } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';
import { browserAgentEnv } from '../../packages/core/src/utils/browser-env.js';

const exec = promisify(execFile);
const enabled = Boolean(process.env.DISCLAUDE_E2E_CHROMIUM && process.env.DISCLAUDE_E2E_BROWSER_PYTHON);

describe('user starts Disclaude and shares its managed browser', () => {
  it.skipIf(!enabled)('runs the product IPC entry, hands over shared page state, then shuts down and restarts', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dc-browser-e2e-'));
    const socket = join(root, 'browser.sock');
    const config = join(root, 'config.json');
    const probe = createServer();
    await new Promise<void>(done => probe.listen(0, '127.0.0.1', done));
    const port = (probe.address() as { port: number }).port;
    await new Promise<void>(done => probe.close(() => done()));
    await writeFile(config, JSON.stringify({
      agent: { agentBackend: 'claude', provider: 'anthropic', model: 'claude-sonnet-4' },
      anthropic: { apiKey: 'offline-test-placeholder' },
      workspace: { dir: root }, channels: { feishu: { enabled: false }, rest: { host: '127.0.0.1', port, fileStorageDir: join(root, 'files') } },
      logging: { level: 'silent' },
    }));
    const env: NodeJS.ProcessEnv = { ...process.env, DISCLAUDE_CONFIG_PATH: config, LOCKFILE_PATH: join(root, 'service.pid'),
      BU_CDP_URL: '', BU_CDP_WS: '',
      DISCLAUDE_BROWSER_MODE: 'coordinated', DISCLAUDE_BROWSER_SOCKET: socket,
      DISCLAUDE_BROWSER_PYTHON: process.env.DISCLAUDE_E2E_BROWSER_PYTHON,
      DISCLAUDE_CHROMIUM_BINARY: process.env.DISCLAUDE_E2E_CHROMIUM,
      DISCLAUDE_CHROMIUM_PROFILE: join(root, 'profile'), DISCLAUDE_CHROMIUM_HEADLESS: '1',
      DISCLAUDE_BROWSER_WORKSPACE: root,
    };
    delete env.DISCLAUDE_BROWSER_TARGET;
    delete env.DISCLAUDE_BROWSER_EVENTS;
    const executable = resolve('bin/disclaude.js');
    let child: ReturnType<typeof spawn> | undefined;
    let output = '';
    let exited: Promise<number | null> | undefined;
    async function stop(): Promise<void> {
      if (!child || child.exitCode !== null || child.signalCode !== null) { return; }
      child.kill('SIGTERM');
      const code = await Promise.race([exited, delay(20_000).then(() => 'timeout')]);
      if (code === 'timeout') { child.kill('SIGKILL'); throw new Error('Disclaude shutdown timed out'); }
      expect(code, output).toBe(0);
    }
    try {
      for (let attempt = 0; attempt < 2; attempt++) {
        output = '';
        child = spawn(process.execPath, [executable, 'start', '--config', config, '--api-port', '0'], { env, cwd: root, stdio: ['ignore', 'pipe', 'pipe'] });
        child.stdout!.on('data', d => { output += d.toString(); });
        child.stderr!.on('data', d => { output += d.toString(); });
        exited = new Promise(done => child!.once('close', done));
        for (let i = 0; i < 450 && !output.includes('HTTP API server started on'); i++) {
          if (child.exitCode !== null) { throw new Error(output); }
          await delay(100);
        }
        expect(output).toContain('HTTP API server started on');
        const status = await exec(process.execPath, [executable, 'browser', 'status'], { env, cwd: root, timeout: 5000 });
        expect(JSON.parse(status.stdout).state).toBe('idle');
        const taskEnv = browserAgentEnv({ ...env, DISCLAUDE_BROWSER_BIN: join(root, 'bin'), BU_CDP_URL: 'http://stale.invalid:9223', BU_CDP_WS: 'ws://stale.invalid' });
        expect(taskEnv.BU_CDP_URL).toBeUndefined();
        expect(taskEnv.BU_CDP_WS).toBeUndefined();
        const run = (script: string): Promise<string> => new Promise((done, reject) => {
          const task = spawn('browser-use', [], { env: taskEnv, cwd: root, stdio: ['pipe', 'pipe', 'pipe'] });
          let stdout = '', stderr = '';
          task.stdout.on('data', d => { stdout += d; }); task.stderr.on('data', d => { stderr += d; });
          task.on('error', reject);
          task.on('close', code => code === 0 ? done(stdout) : reject(new Error(stderr)));
          task.stdin.end(script);
        });
        await run("goto_url('data:text/html,<h1>Shared research</h1><input id=value>')\nassert wait_for_element('#value')\nfill_input('#value','first')\n");
        const results = await Promise.all([
          run("import time\nfill_input('#value','handoff')\ntime.sleep(0.4)\nprint(js(\"document.querySelector('#value').value\"))\n"),
          run("print(js(\"document.querySelector('#value').value\"))\n"),
        ]);
        expect(results[0]).toContain('handoff');
        // Both callers receive the same real target; ordering is established by the broker.
        expect(results[1]).toMatch(/first|handoff/u);
        expect(await run("print(js(\"document.querySelector('#value').value\"))\n")).toContain('handoff');
        await writeFile(join(root, 'profile', 'preserve-test.txt'), 'user profile retained');
        const cdpPort = (await readFile(join(root, 'profile', 'DevToolsActivePort'), 'utf8')).split('\n')[0];
        await stop();
        await expect(access(socket)).rejects.toThrow();
        await expect(access(socket + '.lock')).rejects.toThrow();
        await expect(fetch(`http://127.0.0.1:${cdpPort}/json/version`, { signal: AbortSignal.timeout(1000) })).rejects.toThrow();
        expect(await readFile(join(root, 'profile', 'preserve-test.txt'), 'utf8')).toBe('user profile retained');
        await expect(exec(process.execPath, [executable, 'browser', 'status'], { env, cwd: root, timeout: 5000 })).rejects.toThrow();
      }
    } finally { await stop(); await rm(root, { recursive: true, force: true }); }
  }, 180_000);
});
