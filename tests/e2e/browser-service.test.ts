import { describe, expect, it } from 'vitest';
import nock from 'nock';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, writeFile, rm, readFile, access } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { createServer } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';
import { browserAgentEnv } from '../../packages/core/src/utils/browser-env.js';
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

describe('user starts Disclaude and shares its managed browser', () => {
  it.skipIf(!enabled)('runs the product IPC entry, hands over shared page state, then shuts down and restarts', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dc-browser-e2e-'));
    console.info('BROWSER_SERVICE_TEST_ROOT', root);
    const socket = join(root, 'browser.sock');
    const config = join(root, 'config.json');
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
    const env: NodeJS.ProcessEnv = { ...process.env, DISCLAUDE_CONFIG_PATH: config, LOCKFILE_PATH: join(root, 'service.pid'),
      BU_CDP_URL: '', BU_CDP_WS: '',
      DISCLAUDE_BROWSER_MODE: 'coordinated', DISCLAUDE_BROWSER_SOCKET: socket,
      DISCLAUDE_BROWSER_PYTHON: process.env.DISCLAUDE_E2E_BROWSER_PYTHON,
      DISCLAUDE_CHROMIUM_BINARY: process.env.DISCLAUDE_E2E_CHROMIUM,
      DISCLAUDE_CHROMIUM_PROFILE: join(root, 'profile'), DISCLAUDE_CHROMIUM_HEADLESS: '1',
      DISCLAUDE_BROWSER_WORKSPACE: root,
    };
    delete env.DISCLAUDE_BROWSER_TARGET;
    env.DISCLAUDE_BROWSER_EVENTS = join(root, 'browser-events.ndjson');
    const executable = resolve('bin/disclaude.js');
    const callers = new Set<ReturnType<typeof spawn>>();
    const crashDescendants = new Set<number>();
    const callerClosures = new Map<ReturnType<typeof spawn>, Promise<void>>();
    let child: ReturnType<typeof spawn> | undefined;
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
        const taskEnv = browserAgentEnv({ ...env, DISCLAUDE_BROWSER_BIN: join(root, 'bin'), BU_CDP_URL: 'http://stale.invalid:9223', BU_CDP_WS: 'ws://stale.invalid' });
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
        await expect(run(`open(${JSON.stringify(bypassMarker)}, 'w').write('bypassed')\n`, {
          ...taskEnv, DISCLAUDE_BROWSER_SOCKET: join(root, 'missing.sock'),
          BU_CDP_URL: 'http://127.0.0.1:9222',
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
              : backend === 'codex' ? new CodexAgentProvider({ env: taskEnv, transport: 'app-server', builtinsDir: naturalTask ? resolve('.') : root, execTimeoutMs: 90_000 })
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
                : backend === 'pi' ? process.env.DISCLAUDE_E2E_BROWSER_PI_MODEL : undefined;
            const stream = provider.queryStream(input(), { cwd: root, settingSources: [], env: taskEnv,
              ...(['claude', 'pi'].includes(backend) ? { tools: ['Bash'], allowedTools: ['Bash'] } : {}), ...(model ? { model } : {}) });
            const messages: AgentMessage[] = [];
            let timedOut = false;
            const deadline = setTimeout(() => { timedOut = true; void stream.handle.cancel(); }, 90_000);
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
          await verifyModelContention(root, taskEnv, serviceUrl, join(root, 'browser-events.ndjson'));
        }
        if (attempt === 0 && process.env.DISCLAUDE_E2E_BROWSER_STRESS === '1') {
          await verifyRepeatedHandoffs(join(root, 'browser-events.ndjson'), run);
        }
        await writeFile(join(root, 'profile', 'preserve-test.txt'), 'user profile retained');
        const cdpPort = (await readFile(join(root, 'profile', 'DevToolsActivePort'), 'utf8')).split('\n')[0];
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
          process.kill(ownership.pid, 'SIGKILL');
          // The live service must reclaim its broker's browser tree and owned IPC,
          // fail subsequent calls closed, and permit an explicit clean restart.
          let browserStopped = false;
          for (let i = 0; i < 100 && !browserStopped; i++) {
            browserStopped = await fetch(`http://127.0.0.1:${cdpPort}/json/version`, { signal: AbortSignal.timeout(200) }).then(() => false, () => true);
            if (!browserStopped) { await delay(50); }
          }
          expect(browserStopped).toBe(true);
          expect(await active).toBe('interrupted');
          const descendantAlive = (): boolean => { try { process.kill(descendant, 0); return true; } catch { return false; } };
          for (let i = 0; i < 100 && descendantAlive(); i++) { await delay(50); }
          expect(descendantAlive()).toBe(false);
          crashDescendants.delete(descendant);
          await expect(access(crashMarker)).rejects.toThrow();
          await expect(exec(process.execPath, [executable, 'browser', 'status'], { env, cwd: root, timeout: 5000 })).rejects.toThrow();
        }
        await stop();
        await expect(access(socket)).rejects.toThrow();
        await expect(access(socket + '.lock')).rejects.toThrow();
        await expect(fetch(`http://127.0.0.1:${cdpPort}/json/version`, { signal: AbortSignal.timeout(1000) })).rejects.toThrow();
        expect(await readFile(join(root, 'profile', 'preserve-test.txt'), 'utf8')).toBe('user profile retained');
        await rejectUpstream();
        await expect(exec(process.execPath, [executable, 'browser', 'status'], { env, cwd: root, timeout: 5000 })).rejects.toThrow();
      }
    } catch (error) {
      // The isolated service uses a generated offline config. Retain its failure
      // diagnostics instead of reducing broker failures to a client EOF alone.
      // Client EOF can precede the supervisor's process-exit diagnostic.
      // Give that callback a bounded opportunity to flush before deleting the
      // isolated run directory; do not retain whole browser profiles for logs.
      await delay(500);
      console.error('BROWSER_SERVICE_FAILURE', output.slice(-16_000));
      const events = await readFile(env.DISCLAUDE_BROWSER_EVENTS!, 'utf8').catch(() => 'No coordinator events written');
      console.error('BROWSER_COORDINATOR_EVENTS', events.slice(-16_000));
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
      const settled = await Promise.allSettled([stopCallers(), stopDescendants(), stop()]);
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
