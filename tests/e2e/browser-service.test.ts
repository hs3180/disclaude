import { describe, expect, it } from 'vitest';
import nock from 'nock';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, writeFile, rm, readFile, access } from 'node:fs/promises';
import { delimiter, dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { createServer } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';
import { browserAgentEnv, resolveBrowserSocketPath } from '../../packages/core/src/utils/browser-env.js';
import { ClaudeSDKProvider } from '../../packages/core/src/sdk/providers/claude/provider.js';
import { PiAgentProvider } from '../../packages/core/src/sdk/providers/pi/provider.js';
import { CodexAgentProvider } from '../../packages/core/src/sdk/providers/codex/provider.js';
import type { AgentMessage } from '../../packages/core/src/sdk/types.js';
import { DeepSeekHarnessProvider } from '../../packages/core/src/sdk/providers/deepseek/provider.js';
import { verifyModelContention } from './helpers/browser-model-contention.js';
import { verifyRepeatedHandoffs } from './helpers/browser-handoff-stress.js';

const exec = promisify(execFile);
const enabled = Boolean(process.env.DISCLAUDE_E2E_CHROMIUM && process.env.DISCLAUDE_E2E_BROWSER_PYTHON);
const restartCycles = Number.parseInt(process.env.DISCLAUDE_E2E_BROWSER_RESTART_CYCLES || '3', 10);
const configuredRestartCycles = Number.isInteger(restartCycles) && restartCycles >= 2 && restartCycles <= 5 ? restartCycles : 3;
// Real-model browser turns can be slower than the deterministic IPC path on
// a busy operator machine. Keep CI's default bounded while allowing an
// explicitly requested acceptance run to use a larger, still finite budget.
const modelTimeout = Number.parseInt(process.env.DISCLAUDE_E2E_BROWSER_MODEL_TIMEOUT_MS || '90000', 10);
const configuredModelTimeout = Number.isInteger(modelTimeout) && modelTimeout >= 30_000 && modelTimeout <= 300_000 ? modelTimeout : 90_000;
// Real model acceptance in this repository is intentionally pinned to the
// operator-approved model. Do not inherit a user's global Codex default: that
// would make the evidence non-reproducible and could silently exercise another
// model.
const CODEX_BROWSER_ACCEPTANCE_MODEL = 'gpt-5.6-luna';

async function stopProcessGroup(child: ReturnType<typeof spawn>): Promise<void> {
  if (!child.pid || child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise<void>(resolve => child.once('close', () => resolve()));
  try {
    if (process.platform === 'win32') child.kill('SIGTERM');
    else process.kill(-child.pid, 'SIGTERM');
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error; }
  if (await Promise.race([exited.then(() => true), delay(5000, false, { ref: false })])) return;
  try {
    if (process.platform === 'win32') child.kill('SIGKILL');
    else process.kill(-child.pid, 'SIGKILL');
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error; }
  await Promise.race([exited, delay(5000, undefined, { ref: false })]);
  if (child.exitCode === null && child.signalCode === null) throw new Error('Owned Chromium process group did not exit');
}

async function startDeployedChromium(binary: string, profile: string) {
  await mkdir(profile, { recursive: true, mode: 0o700 });
  const child = spawn(binary, [
    '--remote-debugging-port=0', '--remote-debugging-address=127.0.0.1',
    `--user-data-dir=${profile}`, '--no-first-run', '--no-default-browser-check',
    '--headless=new', '--disable-dev-shm-usage', ...(process.getuid?.() === 0 ? ['--no-sandbox'] : []), 'about:blank',
  ], { stdio: ['ignore', 'ignore', 'pipe'], detached: process.platform !== 'win32' });
  let stderr = '', startupError: Error | undefined;
  child.stderr?.on('data', chunk => { stderr = (stderr + chunk.toString()).slice(-4000); });
  child.on('error', error => { startupError = error; });
  try {
    for (let attempt = 0; attempt < 150; attempt++) {
      if (startupError) throw startupError;
      if (child.exitCode !== null || child.signalCode !== null) {
        throw new Error(`Deployed Chromium exited before CDP readiness: ${stderr || 'no browser diagnostics'}`);
      }
      const active = await readFile(join(profile, 'DevToolsActivePort'), 'utf8').catch(() => '');
      const port = Number(active.split('\n')[0]);
      if (Number.isInteger(port) && port > 0 && port < 65536) {
        const response = await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(500) }).catch(() => undefined);
        if (response?.ok) return { child, port };
      }
      await delay(100);
    }
    throw new Error(`Deployed Chromium CDP startup timed out: ${stderr || 'no browser diagnostics'}`);
  } catch (error) {
    await stopProcessGroup(child);
    throw error;
  }
}

describe('user starts Disclaude and coordinates an already deployed browser', () => {
  it.skipIf(!enabled)('runs the product IPC entry, hands over shared page state, then shuts down and restarts', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dc-browser-e2e-'));
    console.info('BROWSER_SERVICE_TEST_ROOT', root);
    let socket = '';
    const config = join(root, 'config.json');
    const profile = join(root, 'profile');
    const chromiumConfig = join(root, 'chromium-cdp.json');
    const probe = createServer();
    let serviceUrl = '';
    const contentionModel = process.env.DISCLAUDE_E2E_BROWSER_CONTENTION_MODEL;
    try {
      await new Promise<void>((done, reject) => { probe.once('error', reject); probe.listen(0, '127.0.0.1', done); });
      const port = (probe.address() as { port: number }).port;
      await new Promise<void>(done => probe.close(() => done()));
      serviceUrl = `http://127.0.0.1:${port}`;
      await writeFile(config, JSON.stringify({
        agent: { agentBackend: 'claude', provider: 'anthropic', model: contentionModel || 'claude-sonnet-4' },
        ...(contentionModel ? {} : { anthropic: { apiKey: 'offline-test-placeholder' } }),
        workspace: { dir: root }, channels: { feishu: { enabled: false }, rest: { host: '127.0.0.1', port, fileStorageDir: join(root, 'files') } },
        logging: { level: 'info' },
      }), { mode: 0o600 });
    } catch (error) {
      if (probe.listening) { await new Promise<void>(done => probe.close(() => done())); }
      try { await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); }
      catch (cleanupError) { throw new AggregateError([error, cleanupError], `Browser test setup cleanup failed; inspect ${root}`); }
      throw error;
    }
    const browserPython = process.env.DISCLAUDE_E2E_BROWSER_PYTHON!;
    const runtimeDirectory = join(root, 'runtime');
    await mkdir(runtimeDirectory, { recursive: true, mode: 0o700 });
    const env: NodeJS.ProcessEnv = { ...process.env, DISCLAUDE_CONFIG_PATH: config, LOCKFILE_PATH: join(root, 'service.pid'),
      PATH: [dirname(browserPython), process.env.PATH || ''].filter(Boolean).join(delimiter),
      XDG_RUNTIME_DIR: runtimeDirectory,
      DISCLAUDE_CHROMIUM_CONFIG: chromiumConfig,
    };
    socket = resolveBrowserSocketPath(env);
    const executable = resolve('bin/disclaude.js');
    const callers = new Set<ReturnType<typeof spawn>>();
    const crashDescendants = new Set<number>();
    const callerClosures = new Map<ReturnType<typeof spawn>, Promise<void>>();
    let child: ReturnType<typeof spawn> | undefined;
    let chromiumProcess: ReturnType<typeof spawn> | undefined;
    let cdpPort = 0;
    let serviceCrashed = false;
    let output = '';
    let exited: Promise<number | null> | undefined;
    async function stop(): Promise<void> {
      if (!child) { return; }
      if (child.exitCode === null && child.signalCode === null) { child.kill('SIGTERM'); }
      const code = await Promise.race([exited, delay(20_000, undefined, { ref: false }).then(() => 'timeout')]);
      if (code === 'timeout') {
        child.kill('SIGKILL');
        await Promise.race([exited, delay(5000, undefined, { ref: false })]);
        throw new Error('Disclaude shutdown timed out; browser termination must be checked before cleanup');
      }
      expect(code, output).toBe(0);
    }
    const localHost = /^(?:127\.0\.0\.1|localhost)(?::\d+)?$/u;
    nock.enableNetConnect(localHost);
    if (process.env.DISCLAUDE_E2E_BROWSER_PI_MODEL) {
      const api = new URL(process.env.ANTHROPIC_BASE_URL || 'https://api.anthropic.com');
      const apiHostWithPort = `${api.hostname}:${api.port || (api.protocol === 'https:' ? '443' : '80')}`;
      nock.enableNetConnect(host => localHost.test(host) || host === api.host || host === apiHostWithPort);
    }
    let invocation = 0;
    try {
      const deployed = await startDeployedChromium(process.env.DISCLAUDE_E2E_CHROMIUM!, profile);
      chromiumProcess = deployed.child;
      cdpPort = deployed.port;
      await writeFile(chromiumConfig, JSON.stringify({ version: 1, environment: {
        CHROMIUM_CDP_BINARY: process.env.DISCLAUDE_E2E_CHROMIUM!,
        CHROMIUM_CDP_PROFILE_DIR: profile,
        CHROMIUM_CDP_PORT: String(cdpPort),
        CHROMIUM_CDP_ADDRESS: '127.0.0.1',
        CHROMIUM_CDP_HEADED: '0',
        CHROMIUM_CDP_AUTOSTART: '0',
      } }), { mode: 0o600 });
      for (let attempt = 0; attempt < configuredRestartCycles; attempt++) {
        output = '';
        child = spawn(process.execPath, [executable, 'start', '--config', config, '--api-port', '0'], { env, cwd: root, stdio: ['ignore', 'pipe', 'pipe'] });
        child.stdout!.on('data', d => { output += d.toString(); });
        child.stderr!.on('data', d => { output += d.toString(); });
        exited = new Promise(done => child!.once('close', done));
        // Allow the service's 45-second readiness deadline to report its own failure.
        for (let i = 0; i < 600 && !output.includes('HTTP API server started on'); i++) {
          if (child.exitCode !== null || child.signalCode !== null) { throw new Error(output); }
          await delay(100);
        }
        expect(output).toContain('HTTP API server started on');
        const status = await exec(process.execPath, [executable, 'browser', 'status'], { env, cwd: root, timeout: 5000 });
        expect(JSON.parse(status.stdout).state).toBe('idle');
        const taskEnv = browserAgentEnv({ ...env, BU_CDP_URL: 'http://stale.invalid:9223', BU_CDP_WS: 'ws://stale.invalid' });
        // A wrong upstream executable must fail before reaching a default daemon.
        const rejectUpstream = () => expect(exec(process.env.DISCLAUDE_E2E_BROWSER_PYTHON!,
          ['-c', 'from browser_harness.run import main; main()'], { env: taskEnv, cwd: root, timeout: 10_000 }))
          .rejects.toMatchObject({ stderr: expect.stringMatching(/FileExistsError|NotADirectoryError/u) });
        await rejectUpstream();
        expect(taskEnv.BU_CDP_URL).toBeUndefined();
        expect(taskEnv.BU_CDP_WS).toBeUndefined();
        const run = (script: string, invocationEnv = taskEnv, onSpawn?: (task: ReturnType<typeof spawn>) => void): Promise<string> => new Promise((done, reject) => {
          const invocationId = ++invocation;
          const task = spawn('browser-use', [], { env: invocationEnv, cwd: root, stdio: ['pipe', 'pipe', 'pipe'] });
          callers.add(task);
          callerClosures.set(task, new Promise<void>(closed => task.once('close', () => {
            callers.delete(task); callerClosures.delete(task); closed();
          })));
          onSpawn?.(task);
          let stdout = '', stderr = '';
          task.stdout.on('data', d => { stdout += d; }); task.stderr.on('data', d => { stderr += d; });
          task.on('error', reject);
          task.on('close', code => code === 0 ? done(stdout) : reject(new Error(
            `Browser invocation ${invocationId} failed (exit ${code}): ${stderr}`,
          )));
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
        // An unavailable IPC service must not execute Python through an upstream
        // daemon, even when one invocation carries stale direct-CDP settings.
        const bypassMarker = join(root, 'bypass-marker');
        const missingCoordinatorEnv = browserAgentEnv({
          ...taskEnv,
          DISCLAUDE_CONFIG_PATH: join(root, 'missing-config.yaml'),
          BU_CDP_URL: 'http://127.0.0.1:9222',
        });
        await expect(run(`open(${JSON.stringify(bypassMarker)}, 'w').write('bypassed')\n`, {
          ...missingCoordinatorEnv,
        })).rejects.toThrow(/ENOENT|connect|socket/i);
        await expect(access(bypassMarker)).rejects.toThrow();
        expect(await run("print(js(\"document.querySelector('#value').value\"))\n")).toContain('handoff');
        // A real caller dies after its script starts; its queued successor must
        // acquire control only after reclamation, without replaying unknown work.
        const startedMarker = join(root, `started-${attempt}`);
        const abandonedMarker = join(root, `abandoned-${attempt}`);
        let abandoned: ReturnType<typeof spawn> | undefined;
        const abandonedResult = run(`import time\nopen(${JSON.stringify(startedMarker)}, 'w').write('started')\ntime.sleep(20)\nopen(${JSON.stringify(abandonedMarker)}, 'w').write('must-not-run')\n`, taskEnv, task => { abandoned = task; }).then(() => 'unexpected success', () => 'interrupted');
        let started = false;
        for (let i = 0; i < 200 && !started; i++) {
          started = await access(startedMarker).then(() => true, () => false);
          if (!started) { await delay(100); }
        }
        expect(started).toBe(true);
        if (process.env.DISCLAUDE_E2E_BROWSER_FAIL_DURING_CALL === '1') {
          throw new Error('Injected browser E2E failure while an owned caller is active');
        }
        const successor = run("print(js(\"document.querySelector('#value').value\"))\n");
        abandoned?.kill('SIGKILL');
        expect(await abandonedResult).toBe('interrupted');
        expect(await successor).toContain('handoff');
        await expect(access(abandonedMarker)).rejects.toThrow();
        if (attempt === 0) {
          let previous = 'handoff';
          const backends = [
            ...(process.env.DISCLAUDE_E2E_BROWSER_MODEL ? ['deepseek'] : []),
            ...(process.env.DISCLAUDE_E2E_BROWSER_CODEX === '1' ? ['codex'] : []),
            ...(process.env.DISCLAUDE_E2E_BROWSER_CLAUDE_MODEL ? ['claude'] : []),
            ...(process.env.DISCLAUDE_E2E_BROWSER_PI_MODEL ? ['pi'] : []),
          ];
          for (const backend of backends) {
            const naturalTask = backend === 'codex' && process.env.DISCLAUDE_E2E_BROWSER_NATURAL === '1';
            if (backend === 'deepseek') {
              expect(process.env.DEEPSEEK_API_KEY).toBeTruthy();
              await mkdir(join(root, 'dsh-home'), { mode: 0o700 });
            }
            const provider = backend === 'deepseek'
              ? new DeepSeekHarnessProvider({ env: taskEnv, dshHome: join(root, 'dsh-home') })
              : backend === 'codex' ? new CodexAgentProvider({
                env: taskEnv,
                transport: 'app-server',
                builtinsDir: naturalTask ? resolve('.') : root,
              })
                : backend === 'claude' ? new ClaudeSDKProvider() : new PiAgentProvider();
            const marker = `${backend}-model-handoff-${Date.now()}`;
            const script = `print("PREVIOUS:" + js("document.querySelector('#value').value"))\nassert js("document.querySelector('#value').value") == ${JSON.stringify(previous)}\nfill_input('#value', ${JSON.stringify(marker)})\nprint(js("document.querySelector('#value').value"))\n`;
            async function* input() {
              if (naturalTask) {
                yield { role: 'user' as const, content: `Use the available browser skill to inspect the currently open shared page. Report the input's existing value, replace it with ${marker}, and save a screenshot as browser-task.png in the current workspace. Verify the new value and report it. Keep the existing page open. This is an isolated acceptance workspace; follow its configured browser access and do not access other host services or unrelated files.` };
                return;
              }
              const quotedScript = "'" + script.replaceAll("'", "'\\''") + "'";
              yield { role: 'user' as const, content: `Use your Bash/shell tool to run exactly this command:\nprintf '%s' ${quotedScript} | browser-use\nThen report the value. The shared page is already open. Do not invoke skills, search files, discover other tools, launch another browser, use direct CDP, delegate, or modify unrelated files.` };
            }
            const model = backend === 'deepseek' ? process.env.DISCLAUDE_E2E_BROWSER_MODEL
              : backend === 'claude' ? process.env.DISCLAUDE_E2E_BROWSER_CLAUDE_MODEL
                : backend === 'pi' ? process.env.DISCLAUDE_E2E_BROWSER_PI_MODEL
                  : CODEX_BROWSER_ACCEPTANCE_MODEL;
            const stream = provider.queryStream(input(), { cwd: root, settingSources: [], env: taskEnv,
              ...(['claude', 'pi'].includes(backend) ? { tools: ['Bash'], allowedTools: ['Bash'] } : {}), ...(model ? { model } : {}) });
            const messages: AgentMessage[] = [];
            let timedOut = false;
            const deadline = setTimeout(() => { timedOut = true; void stream.handle.cancel(); }, configuredModelTimeout);
            try {
              for await (const message of stream.iterator) { messages.push(message); }
              expect(timedOut).toBe(false);
              const result = messages.findLast(message => message.type === 'result');
              expect(result).toBeDefined();
              expect(result?.metadata?.terminatedReason, result?.content).toBeUndefined();
              expect(messages.some(message => message.type === 'error')).toBe(false);
              expect(messages.some(message => message.type === 'tool_use'), JSON.stringify(messages.filter(message => message.type === 'text' || message.type === 'error'))).toBe(true);
              if (naturalTask) {
                expect(messages.some(message => message.type === 'tool_result' && message.content.includes('Skill: browser-use'))).toBe(true);
                expect(messages.some(message => ['text', 'tool_result'].includes(message.type) && message.content.includes(previous))).toBe(true);
                expect((await readFile(join(root, 'browser-task.png'))).subarray(0, 8).toString('hex')).toBe('89504e470d0a1a0a');
              } else {
                expect(messages.some(message => message.type === 'tool_result' && message.content.includes(`PREVIOUS:${previous}`))).toBe(true);
              }
              if (backend === 'deepseek') { expect(result?.metadata?.stopReason).toBe('completed'); }
              expect(await run("print(js(\"document.querySelector('#value').value\"))\n")).toContain(marker);
              console.info('BROWSER_MODEL_HANDOFF', JSON.stringify({ backend, naturalTask, previousStateVerified: true, independentReadback: true }));
              previous = marker;
            } finally { clearTimeout(deadline); stream.handle.close(); provider.dispose(); }
          }
        }
        if (attempt === 0 && process.env.DISCLAUDE_E2E_BROWSER_CONTENTION_MODEL) {
          await verifyModelContention(root, taskEnv, serviceUrl);
        }
        if (attempt === 0 && process.env.DISCLAUDE_E2E_BROWSER_STRESS === '1') {
          await verifyRepeatedHandoffs(run);
        }
        await writeFile(join(profile, 'preserve-test.txt'), 'user profile retained');
        // Establish a real positive probe before negative stop/crash assertions;
        // a blocked loopback request must not masquerade as browser shutdown.
        expect((await fetch(`http://127.0.0.1:${cdpPort}/json/version`, { signal: AbortSignal.timeout(5000) })).ok).toBe(true);
        if (attempt === 0) {
          const descendantFile = join(root, 'crash-descendant.pid');
          const crashMarker = join(root, 'crash-must-not-run');
          const descendantCode = `import time; time.sleep(20); open(${JSON.stringify(crashMarker)}, 'w').write('must-not-run')`;
          const active = run(`import subprocess, sys, time\np = subprocess.Popen([sys.executable, '-c', ${JSON.stringify(descendantCode)}])\nopen(${JSON.stringify(descendantFile)}, 'w').write(str(p.pid))\ntime.sleep(20)\n`).then(() => 'unexpected success', () => 'interrupted');
          let descendantReady = false;
          for (let i = 0; i < 100 && !descendantReady; i++) {
            descendantReady = await access(descendantFile).then(() => true, () => false);
            if (!descendantReady) { await delay(50); }
          }
          expect(descendantReady).toBe(true);
          const descendant = Number(await readFile(descendantFile, 'utf8'));
          crashDescendants.add(descendant);
          const ownership = JSON.parse(await readFile(socket + '.lock', 'utf8')) as { pid: number };
          const apiStatus = await fetch(new URL('/api/status', serviceUrl)).then(response => response.json()) as {
            browserIpc?: { pid?: number };
          };
          expect(ownership.pid).toBe(apiStatus.browserIpc?.pid);
          process.kill(ownership.pid, 'SIGKILL');
          // The coordinator shares the service PID. Its worker group must clean
          // itself up on IPC disconnect, while the separately deployed browser
          // remains alive and keeps owning its profile.
          const wrapperExitCode = await Promise.race([exited, delay(5000, 'timeout', { ref: false })]);
          expect(wrapperExitCode).not.toBe('timeout');
          expect(wrapperExitCode).not.toBeNull();
          expect(child.exitCode).not.toBeNull();
          serviceCrashed = true;
          expect(await active).toBe('interrupted');
          const descendantAlive = (): boolean => { try { process.kill(descendant, 0); return true; } catch { return false; } };
          for (let i = 0; i < 100 && descendantAlive(); i++) { await delay(50); }
          expect(descendantAlive()).toBe(false);
          crashDescendants.delete(descendant);
          await expect(access(crashMarker)).rejects.toThrow();
          expect((await fetch(`http://127.0.0.1:${cdpPort}/json/version`, { signal: AbortSignal.timeout(1000) })).ok).toBe(true);
          expect(await readFile(join(profile, 'preserve-test.txt'), 'utf8')).toBe('user profile retained');
          await expect(access(socket)).resolves.toBeUndefined();
          await expect(access(socket + '.lock')).resolves.toBeUndefined();
          await expect(exec(process.execPath, [executable, 'browser', 'status'], { env, cwd: root, timeout: 5000 })).rejects.toThrow();
        }
        if (!serviceCrashed) {
          await stop();
          await expect(access(socket)).rejects.toThrow();
          await expect(access(socket + '.lock')).rejects.toThrow();
        }
        expect((await fetch(`http://127.0.0.1:${cdpPort}/json/version`, { signal: AbortSignal.timeout(1000) })).ok).toBe(true);
        expect(await readFile(join(profile, 'preserve-test.txt'), 'utf8')).toBe('user profile retained');
        await rejectUpstream();
        await expect(exec(process.execPath, [executable, 'browser', 'status'], { env, cwd: root, timeout: 5000 })).rejects.toThrow();
        if (serviceCrashed) { child = undefined; exited = undefined; serviceCrashed = false; }
      }
    } catch (error) {
      // Retain isolated service/browser diagnostics instead of reducing failures
      // to a client EOF alone. Do not retain whole browser profiles for logs.
      await delay(500);
      console.error('BROWSER_SERVICE_FAILURE', output.slice(-16_000));
      const processes = await exec('ps', ['-ww', '-axo', 'pid=,ppid=,stat=,etime=,command='])
        .then(result => result.stdout)
        .catch(error => `process snapshot unavailable: ${error.message}`);
      const ownedProcesses = processes.split('\n')
        .filter(line => line.includes(root) || line.includes('browser_harness') || line.includes('browser-use') || line.includes('Google Chrome'))
        .slice(-200)
        .join('\n');
      console.error('BROWSER_PROCESS_SNAPSHOT', ownedProcesses || 'No owned browser/harness processes found');
      throw error;
    } finally {
      nock.enableNetConnect(localHost);
      const stopCallers = async (): Promise<void> => {
        const pending = [...callerClosures.values()];
        for (const caller of callers) { caller.kill('SIGTERM'); }
        const closed = await Promise.race([Promise.all(pending).then(() => true), delay(5000, undefined, { ref: false }).then(() => false)]);
        if (!closed) {
          for (const caller of callers) { caller.kill('SIGKILL'); }
          const killed = await Promise.race([Promise.all(pending).then(() => true), delay(5000, undefined, { ref: false }).then(() => false)]);
          if (!killed) { throw new Error('Browser test callers did not close'); }
        }
      };
      const stopDescendants = async (): Promise<void> => {
        for (const pid of crashDescendants) {
          try { process.kill(pid, 'SIGKILL'); }
          catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') { throw error; } }
        }
        const deadline = Date.now() + 5000;
        while (crashDescendants.size && Date.now() < deadline) {
          for (const pid of crashDescendants) {
            try { process.kill(pid, 0); }
            catch (error) { if ((error as NodeJS.ErrnoException).code === 'ESRCH') { crashDescendants.delete(pid); } }
          }
          if (crashDescendants.size) { await delay(50); }
        }
        if (crashDescendants.size) { throw new Error('Browser crash-fixture descendants still present'); }
      };
      // Attempt every owned resource cleanup even if another one fails.
      const stopBrowser = async (): Promise<void> => { if (chromiumProcess) await stopProcessGroup(chromiumProcess); };
      const settled = await Promise.allSettled([stopCallers(), stopDescendants(), stop(), stopBrowser()]);
      const failures = settled.flatMap(result => result.status === 'rejected' ? [result.reason] : []);
      if (failures.length) {
        throw new AggregateError(failures, `Browser test files retained at ${root}: resource termination unconfirmed; inspect owned processes before removing`);
      }
      try { await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); }
      catch (error) { throw new Error(`Browser test cleanup failed; inspect residual files at ${root}`, { cause: error }); }
      await expect(access(root)).rejects.toMatchObject({ code: 'ENOENT' });
      console.info('BROWSER_SERVICE_CLEANUP', JSON.stringify({ rootRemoved: true, callersClosed: true, crashDescendantsGone: true }));
    }
  }, 480_000);
});
