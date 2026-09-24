import { describe, expect, it } from 'vitest';
import nock from 'nock';
import { randomUUID } from 'node:crypto';
import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:net';
import { homedir } from 'node:os';
import { delimiter, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import {
  access,
  lstat,
  mkdir,
  readFile,
  realpath,
  readdir,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { browserAgentEnv } from '../../packages/core/src/utils/browser-env.js';
import {
  connectBrowser,
  withBrowserLease,
} from '../../packages/service/src/browser-control/client.mjs';

const exec = promisify(execFile);
const enabled = process.env.DISCLAUDE_E2E_BROWSER_MIGRATION === '1';
const LEGACY_LABEL = 'com.disclaude.browser-ipc';
const LEGACY_UNIT = 'disclaude-browser-ipc.service';
const IMPORTED_KEYS = [
  'DISCLAUDE_BROWSER_MODE',
  'DISCLAUDE_BROWSER_SOCKET',
  'DISCLAUDE_BROWSER_PYTHON',
  'DISCLAUDE_BROWSER_WORKSPACE',
  'DISCLAUDE_BROWSER_EVENTS',
  'DISCLAUDE_BROWSER_TARGET',
  'BU_CDP_URL',
  'BH_HOME',
] as const;

type ManagedProcess = {
  child: ChildProcess;
  output: () => string;
  closed: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
};

function within(parent: string, child: string): boolean {
  const path = relative(parent, child);
  return path === '' || (!isAbsolute(path) && !path.startsWith(`..${sep}`) && path !== '..');
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(label)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
}

function pidIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

async function exists(path: string): Promise<boolean> {
  return access(path).then(
    () => true,
    () => false
  );
}

async function pathEntryExists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return false;
    }
    throw error;
  }
}

async function assertSafeParents(path: string, home: string): Promise<void> {
  let current = resolve(path);
  const root = resolve(home);
  while (within(root, current)) {
    try {
      const info = await lstat(current);
      if (
        info.isSymbolicLink() ||
        !info.isDirectory() ||
        (process.getuid && info.uid !== process.getuid())
      ) {
        throw new Error(`Refusing unsafe or foreign-owned migration fixture parent: ${current}`);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw error;
      }
    }
    if (current === root) {
      return;
    }
    current = dirname(current);
  }
  throw new Error(`Migration fixture path is outside the runner home: ${path}`);
}

async function unusedPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolveListen, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolveListen);
  });
  const port = (server.address() as { port: number }).port;
  await new Promise<void>((resolveClose, reject) =>
    server.close((error) => (error ? reject(error) : resolveClose()))
  );
  return port;
}

async function host(command: string, args: string[], timeout = 15_000): Promise<string> {
  const result = await exec(command, args, { timeout, maxBuffer: 1024 * 1024 });
  return result.stdout.trim();
}

async function validateRunner(): Promise<{ home: string; workspace: string; runnerTemp: string }> {
  if (
    process.env.CI !== 'true' ||
    process.env.GITHUB_ACTIONS !== 'true' ||
    !process.env.GITHUB_WORKSPACE ||
    !process.env.RUNNER_TEMP
  ) {
    throw new Error(
      'Browser migration E2E is restricted to an explicitly enabled GitHub Actions runner'
    );
  }
  const home = await realpath(homedir());
  const workspace = await realpath(process.env.GITHUB_WORKSPACE);
  const runnerTemp = await realpath(process.env.RUNNER_TEMP);
  const runnerRoot = resolve(home, 'work');
  if (!within(runnerRoot, workspace) || !within(runnerRoot, runnerTemp)) {
    throw new Error(
      'Refusing host-service migration outside the disposable GitHub Actions workspace'
    );
  }
  if (process.platform !== 'linux' && process.platform !== 'darwin') {
    throw new Error(`Unsupported migration E2E platform: ${process.platform}`);
  }
  if (!process.env.DISCLAUDE_E2E_CHROMIUM || !process.env.DISCLAUDE_E2E_BROWSER_PYTHON) {
    throw new Error('Set the real Chromium binary and pinned browser-use Python interpreter');
  }
  await host(process.env.DISCLAUDE_E2E_CHROMIUM, ['--version']);
  await host(process.env.DISCLAUDE_E2E_BROWSER_PYTHON, [
    '-c',
    'import browser_use, browser_harness',
  ]);
  if (process.platform === 'linux') {
    await host('systemctl', ['--user', 'show-environment']);
  } else {
    await host('launchctl', ['print', `gui/${process.getuid?.() ?? 0}`]);
  }
  return { home, workspace, runnerTemp };
}

function plistString(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');
}

function launchManaged(
  command: string,
  args: string[],
  cwd: string,
  env: NodeJS.ProcessEnv
): ManagedProcess {
  const child = spawn(command, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  child.stdout?.on('data', (chunk) => {
    output = (output + chunk.toString()).slice(-20_000);
  });
  child.stderr?.on('data', (chunk) => {
    output = (output + chunk.toString()).slice(-20_000);
  });
  const closed = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
    (resolveClose) => {
      child.once('close', (code, signal) => resolveClose({ code, signal }));
    }
  );
  return { child, output: () => output, closed };
}

async function waitForOutput(
  proc: ManagedProcess,
  marker: string,
  timeoutMs: number
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (proc.output().includes(marker)) {
      return;
    }
    if (proc.child.exitCode !== null || proc.child.signalCode !== null) {
      throw new Error(`Disclaude exited before readiness: ${proc.output()}`);
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 100));
  }
  throw new Error(`Timed out waiting for ${JSON.stringify(marker)}: ${proc.output()}`);
}

async function waitForPathToDisappear(
  path: string,
  proc: ManagedProcess,
  timeoutMs: number
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (await pathEntryExists(path)) {
    if (proc.child.exitCode !== null || proc.child.signalCode !== null) {
      throw new Error(`Disclaude exited before migration commit: ${proc.output()}`);
    }
    if (Date.now() >= deadline) {
      throw new Error(`Timed out waiting for migration commit to remove ${path}`);
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 100));
  }
}

async function startCandidate(
  root: string,
  config: string,
  apiPort: number,
  home: string
): Promise<ManagedProcess> {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    HOME: home,
    LOG_DIR: join(root, 'logs'),
    LOCKFILE_PATH: join(root, 'disclaude.pid'),
  };
  for (const key of [
    ...IMPORTED_KEYS,
    'DISCLAUDE_CHROMIUM_BINARY',
    'DISCLAUDE_CHROMIUM_PROFILE',
    'DISCLAUDE_CHROMIUM_HEADLESS',
    'DISCLAUDE_BROWSER_MIGRATION',
    'DISCLAUDE_BROWSER_BIN',
  ]) {
    delete env[key];
  }
  return launchManaged(
    process.execPath,
    [resolve('bin/disclaude.js'), 'start', '--config', config, '--api-port', String(apiPort)],
    root,
    env
  );
}

async function waitForBroker(socket: string): Promise<{ state?: string; queued?: number }> {
  const deadline = Date.now() + 45_000;
  let lastError: unknown;
  while (Date.now() < deadline) {
    let client: Awaited<ReturnType<typeof connectBrowser>> | undefined;
    try {
      client = await connectBrowser(socket);
      return await withTimeout(client.request('status'), 3000, 'Browser IPC status timed out');
    } catch (error) {
      lastError = error;
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 250));
    } finally {
      client?.close();
    }
  }
  throw new Error(`Browser IPC did not become ready: ${String(lastError)}`);
}

async function brokerPid(socket: string): Promise<number> {
  const lock = JSON.parse(await readFile(`${socket}.lock`, 'utf8')) as { pid?: number };
  if (!Number.isSafeInteger(lock.pid) || !lock.pid || lock.pid < 2) {
    throw new Error('Browser IPC lock does not contain an owned process ID');
  }
  return lock.pid;
}

async function expectLegacyManagerUnloaded(): Promise<void> {
  if (process.platform === 'linux') {
    const loadState = await host('systemctl', [
      '--user',
      'show',
      LEGACY_UNIT,
      '--property=LoadState',
      '--value',
    ]);
    expect(loadState).toBe('not-found');
    await expect(host('systemctl', ['--user', 'is-enabled', LEGACY_UNIT])).rejects.toThrow();
  } else {
    await expect(host('launchctl', ['list', LEGACY_LABEL])).rejects.toThrow();
  }
}

async function expectLegacyManagerEnabled(): Promise<void> {
  if (process.platform === 'linux') {
    expect(await host('systemctl', ['--user', 'is-enabled', LEGACY_UNIT])).toBe('enabled');
  } else {
    expect(await host('launchctl', ['list', LEGACY_LABEL])).toContain(LEGACY_LABEL);
  }
}

async function executeIpc(socket: string, cwd: string, script: string): Promise<string> {
  const client = await connectBrowser(socket);
  try {
    let result:
      | {
          code: number;
          stdout: string;
          stderr: string;
        }
      | undefined;
    await withBrowserLease(client, async () => {
      result = (await client.request('execute', { script, cwd })) as {
        code: number;
        stdout: string;
        stderr: string;
      };
    });
    if (!result) {
      throw new Error('Browser IPC lease completed without an execution result');
    }
    expect(result.code, result.stderr).toBe(0);
    return result.stdout;
  } finally {
    client.close();
  }
}

async function runProductBrowser(
  socket: string,
  workspace: string,
  script: string
): Promise<string> {
  const launcher = join(dirname(socket), 'bin', 'browser-use');
  const bin = join(dirname(socket), 'bin');
  const env = browserAgentEnv({
    ...process.env,
    PATH: process.env.PATH,
    [IMPORTED_KEYS[0].replace('_MODE', '_BIN')]: bin,
    [IMPORTED_KEYS[6]]: 'http://stale.invalid:9223',
    DISCLAUDE_BROWSER_MODE: 'coordinated',
    DISCLAUDE_BROWSER_SOCKET: socket,
  });
  expect(env[IMPORTED_KEYS[6]]).toBeUndefined();
  expect(env.PATH?.split(delimiter)[0]).toBe(bin);
  const child = spawn(process.execPath, [launcher], {
    cwd: workspace,
    env,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let stdout = '',
    stderr = '';
  child.stdout?.on('data', (chunk) => {
    stdout += chunk.toString();
  });
  child.stderr?.on('data', (chunk) => {
    stderr += chunk.toString();
  });
  child.stdin?.end(script);
  const outcome = await withTimeout(
    new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolveClose) => {
      child.once('close', (code, signal) => resolveClose({ code, signal }));
    }),
    120_000,
    'browser-use timed out'
  ).catch(async (error) => {
    child.kill('SIGTERM');
    throw new Error(`${String(error)}; stderr=${stderr}`);
  });
  expect(outcome.code, stderr).toBe(0);
  return stdout;
}

async function waitForCdp(
  profile: string,
  child: ChildProcess,
  output: () => string
): Promise<string> {
  const activeFile = join(profile, 'DevToolsActivePort');
  const deadline = Date.now() + 45_000;
  let lastError = 'DevToolsActivePort was not created';
  while (Date.now() < deadline) {
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error(
        `Disposable Chromium exited before CDP readiness (code=${child.exitCode}, signal=${child.signalCode}): ${output() || 'no browser diagnostics'}`
      );
    }
    try {
      const [port, browserPath] = (await readFile(activeFile, 'utf8')).trim().split('\n');
      if (!/^\d+$/.test(port) || +port < 1 || +port > 65535 || !browserPath) {
        throw new Error('DevToolsActivePort contains an invalid endpoint');
      }
      const endpoint = `http://127.0.0.1:${port}`;
      const response = await fetch(`${endpoint}/json/version`, {
        signal: AbortSignal.timeout(1000),
      });
      const info = (await response.json()) as { webSocketDebuggerUrl?: string };
      if (response.ok && info.webSocketDebuggerUrl) {
        if (new URL(info.webSocketDebuggerUrl).pathname === browserPath) {
          return endpoint;
        }
        throw new Error('DevToolsActivePort does not match the live browser endpoint');
      }
    } catch (error) {
      lastError = String(error);
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 200));
  }
  throw new Error(
    `Disposable Chromium CDP endpoint did not become ready: ${lastError}; ${output() || 'no browser diagnostics'}`
  );
}

async function waitForCdpDown(endpoint: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${endpoint}/json/version`, {
        signal: AbortSignal.timeout(500),
      });
      if (!response.ok) {
        return;
      }
    } catch {
      return;
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 100));
  }
  throw new Error('Disposable Chromium CDP is still reachable after process-group shutdown');
}

async function stopCandidate(proc: ManagedProcess | undefined, socket: string): Promise<void> {
  if (!proc || proc.child.exitCode !== null || proc.child.signalCode !== null) {
    return;
  }
  proc.child.kill('SIGTERM');
  try {
    const outcome = await withTimeout(proc.closed, 30_000, 'Disclaude shutdown timed out');
    expect(outcome.code, proc.output()).toBe(0);
    return;
  } catch (error) {
    if (!(error instanceof Error) || error.message !== 'Disclaude shutdown timed out') {
      throw error;
    }
  }
  // The browser child is intentionally detached. If the parent misses graceful
  // shutdown, kill only the broker PID recorded beside this unique test socket.
  try {
    const lock = JSON.parse(await readFile(`${socket}.lock`, 'utf8')) as { pid?: number };
    if (Number.isSafeInteger(lock.pid) && lock.pid! > 1) {
      const command = await host('ps', ['-p', String(lock.pid), '-o', 'command=']);
      if (command.includes('/packages/service/dist/browser-control/service.mjs')) {
        process.kill(-lock.pid!, 'SIGKILL');
      }
    }
  } catch {
    /* No broker lock means startup never reached the owned child. */
  }
  proc.child.kill('SIGKILL');
  await Promise.race([proc.closed, new Promise((resolveDelay) => setTimeout(resolveDelay, 5000))]);
  throw new Error(`Disclaude required forced cleanup after shutdown timeout: ${proc.output()}`);
}

describe('real browser IPC migration from the legacy OS service manager', () => {
  it.skipIf(!enabled)(
    'rolls back a failed startup, migrates the live broker, and preserves browser state across restart',
    async () => {
      const { home, runnerTemp } = await validateRunner();
      nock.enableNetConnect(/^(?:127\.0\.0\.1|localhost)(?::\d+)?$/u);
      const id = randomUUID().slice(0, 8);
      const root = join(runnerTemp, `disclaude-browser-migration-${id}`);
      const workspace = join(root, 'workspace');
      const profile = join(root, 'chrome-profile');
      const config = join(root, 'disclaude.json');
      const browserEnvHome = join(root, 'browser-harness-home');
      const stateRoot = join(home, '.local/state/disclaude/browser-ipc');
      const stateRunDir = join(stateRoot, `migration-${id}`);
      const socket = join(stateRunDir, 'browser.sock');
      const events = join(root, 'browser-events.ndjson');
      const workspaceMarker = join(workspace, 'preserve-during-migration.txt');
      const releaseDir = join(home, `.local/share/disclaude/browser-ipc/releases/${id}`);
      const legacyEntry = join(releaseDir, 'service.mjs');
      const migratedSettings = join(home, '.disclaude/browser-ipc.json');
      const managerDir =
        process.platform === 'darwin'
          ? join(home, 'Library/LaunchAgents')
          : join(resolve(process.env.XDG_CONFIG_HOME || join(home, '.config')), 'systemd/user');
      const definition = join(
        managerDir,
        process.platform === 'darwin' ? `${LEGACY_LABEL}.plist` : LEGACY_UNIT
      );
      const enableLink = join(managerDir, 'default.target.wants', LEGACY_UNIT);
      const workspacePath = await realpath(process.env.GITHUB_WORKSPACE!);
      const runnerTempPath = await realpath(runnerTemp);
      if (
        !within(resolve(home, 'work'), workspacePath) ||
        !within(resolve(home, 'work'), runnerTempPath)
      ) {
        throw new Error('Refusing to create migration fixtures outside the disposable runner');
      }
      if (Buffer.byteLength(socket) > 95) {
        throw new Error(`Test socket exceeds Unix path limit: ${socket}`);
      }
      for (const path of [definition, migratedSettings, stateRunDir, releaseDir, legacyEntry]) {
        if (await pathEntryExists(path)) {
          throw new Error(`Refusing to overwrite pre-existing migration fixture: ${path}`);
        }
      }
      if (process.platform === 'linux' && (await pathEntryExists(enableLink))) {
        throw new Error(`Refusing to overwrite pre-existing systemd enable link: ${enableLink}`);
      }
      if (await pathEntryExists(root)) {
        throw new Error(`Refusing to reuse pre-existing test directory: ${root}`);
      }
      for (const path of [
        stateRoot,
        stateRunDir,
        join(stateRunDir, 'bin'),
        releaseDir,
        dirname(migratedSettings),
        managerDir,
        join(managerDir, 'default.target.wants'),
      ]) {
        await assertSafeParents(path, home);
      }
      if (process.platform === 'linux') {
        const loadState = await host('systemctl', [
          '--user',
          'show',
          LEGACY_UNIT,
          '--property=LoadState',
          '--value',
        ]);
        if (loadState !== 'not-found') {
          throw new Error(`Refusing to replace an existing systemd unit (LoadState=${loadState})`);
        }
      } else {
        try {
          await host('launchctl', ['list', LEGACY_LABEL]);
          throw new Error(`Refusing to replace a loaded launchd job: ${LEGACY_LABEL}`);
        } catch (error) {
          if (String(error).includes('Refusing to replace')) {
            throw error;
          }
        }
      }

      const browserBinary = process.env.DISCLAUDE_E2E_CHROMIUM!;
      const python = process.env.DISCLAUDE_E2E_BROWSER_PYTHON!;
      await mkdir(root, { mode: 0o700 });
      await mkdir(profile, { mode: 0o700 });
      let endpoint = '';
      let browserOutput = '';
      let browserStartupError = '';
      const browser = spawn(
        browserBinary,
        [
          '--remote-debugging-port=0',
          `--user-data-dir=${profile}`,
          '--no-first-run',
          '--no-default-browser-check',
          '--headless=new',
          '--disable-gpu',
          ...(process.platform === 'linux' ? ['--disable-dev-shm-usage'] : []),
          ...(process.getuid?.() === 0 ? ['--no-sandbox'] : []),
          'about:blank',
        ],
        { detached: true, stdio: ['ignore', 'ignore', 'pipe'] }
      );
      browser.stderr?.on('data', (chunk) => {
        browserOutput = (browserOutput + chunk.toString()).slice(-4000);
      });
      browser.on('error', (error) => {
        browserStartupError = String(error);
      });
      browser.unref();
      let legacyStarted = false;
      let browserStopped = false;
      let definitionContents = '';
      let candidate: ManagedProcess | undefined;
      const createdDirs = new Set<string>();
      const recordMissingDirs = async (path: string): Promise<void> => {
        let current = resolve(path);
        while (current !== dirname(current) && !(await exists(current))) {
          createdDirs.add(current);
          current = dirname(current);
        }
      };
      const rememberAndMakeDir = async (path: string): Promise<void> => {
        await recordMissingDirs(path);
        await mkdir(path, { recursive: true, mode: 0o700 });
      };
      const startLegacy = async (): Promise<void> => {
        if (process.platform === 'linux') {
          await host('systemctl', ['--user', 'daemon-reload']);
          await host('systemctl', ['--user', 'enable', '--now', LEGACY_UNIT]);
        } else {
          await host('launchctl', ['bootstrap', `gui/${process.getuid?.() ?? 0}`, definition]);
        }
        legacyStarted = true;
      };
      const managerCleanup = async (): Promise<void> => {
        if (await pathEntryExists(definition)) {
          const current = await readFile(definition, 'utf8');
          if (current !== definitionContents) {
            throw new Error(
              'Legacy manager definition changed during E2E; preserved it for inspection'
            );
          }
        }
        if (process.platform === 'linux') {
          const loadState = await host('systemctl', [
            '--user',
            'show',
            LEGACY_UNIT,
            '--property=LoadState',
            '--value',
          ]);
          if (loadState !== 'not-found') {
            await host('systemctl', ['--user', 'disable', '--now', LEGACY_UNIT]);
          }
          if (await pathEntryExists(definition)) {
            await rm(definition);
          }
          await host('systemctl', ['--user', 'daemon-reload']);
        } else {
          try {
            await host('launchctl', ['list', LEGACY_LABEL]);
          } catch {
            if (await pathEntryExists(definition)) {
              await rm(definition);
            }
            return;
          }
          if (!(await pathEntryExists(definition))) {
            throw new Error(
              'Legacy launchd job remains loaded after its definition disappeared; inspect runner state'
            );
          }
          await host('launchctl', ['bootout', `gui/${process.getuid?.() ?? 0}`, definition]);
          await rm(definition);
        }
      };
      try {
        await recordMissingDirs(stateRoot);
        await recordMissingDirs(stateRunDir);
        await recordMissingDirs(join(stateRunDir, 'bin'));
        await recordMissingDirs(dirname(migratedSettings));
        if (process.platform === 'linux') {
          await recordMissingDirs(join(managerDir, 'default.target.wants'));
        }
        await rememberAndMakeDir(workspace);
        await rememberAndMakeDir(browserEnvHome);
        await rememberAndMakeDir(releaseDir);
        await rememberAndMakeDir(managerDir);
        await writeFile(workspaceMarker, id, { flag: 'wx' });
        endpoint = await waitForCdp(profile, browser, () => browserStartupError || browserOutput);
        const targets = (await (await fetch(`${endpoint}/json/list`)).json()) as Array<{
          type?: string;
          id?: string;
        }>;
        const target = targets.find((item) => item.type === 'page' && item.id)?.id;
        expect(target).toBeTruthy();
        await writeFile(join(profile, 'migration-profile-marker'), id, { flag: 'wx' });

        const imported: Record<string, string> = {
          DISCLAUDE_BROWSER_MODE: 'coordinated',
          DISCLAUDE_BROWSER_SOCKET: socket,
          DISCLAUDE_BROWSER_PYTHON: python,
          DISCLAUDE_BROWSER_WORKSPACE: workspace,
          DISCLAUDE_BROWSER_EVENTS: events,
          DISCLAUDE_BROWSER_TARGET: target!,
          BU_CDP_URL: endpoint,
          BH_HOME: browserEnvHome,
        };
        const legacyEnvironment = { ...imported };
        if (process.platform === 'linux') {
          const entries = Object.entries(legacyEnvironment)
            .map(([key, value]) => `Environment="${key}=${value}"`)
            .join('\n');
          definitionContents = [
            '[Unit]',
            'Description=Disclaude browser IPC migration E2E fixture',
            '[Service]',
            'Type=simple',
            `ExecStart=${process.execPath} ${legacyEntry}`,
            entries,
            'Restart=no',
            'KillMode=control-group',
            '[Install]',
            'WantedBy=default.target',
            '',
          ].join('\n');
        } else {
          const environment = Object.entries(legacyEnvironment)
            .map(
              ([key, value]) =>
                `<key>${plistString(key)}</key><string>${plistString(value)}</string>`
            )
            .join('');
          definitionContents = [
            '<?xml version="1.0" encoding="UTF-8"?>',
            '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
            '<plist version="1.0"><dict>',
            `<key>Label</key><string>${LEGACY_LABEL}</string>`,
            '<key>ProgramArguments</key><array>',
            `<string>${plistString(process.execPath)}</string>`,
            `<string>${plistString(legacyEntry)}</string>`,
            '</array>',
            `<key>EnvironmentVariables</key><dict>${environment}</dict>`,
            '<key>RunAtLoad</key><true/>',
            '<key>KeepAlive</key><false/>',
            `<key>StandardOutPath</key><string>${plistString(join(root, 'legacy.stdout'))}</string>`,
            `<key>StandardErrorPath</key><string>${plistString(join(root, 'legacy.stderr'))}</string>`,
            '</dict></plist>',
            '',
          ].join('\n');
        }
        const serviceEntry = resolve('packages/service/dist/browser-control/service.mjs');
        await writeFile(
          legacyEntry,
          `process.env.DISCLAUDE_BROWSER_SUPERVISED = '1';\nawait import(${JSON.stringify(pathToFileURL(serviceEntry).href)});\n`,
          { mode: 0o700, flag: 'wx' }
        );
        await writeFile(definition, definitionContents, { mode: 0o600, flag: 'wx' });
        await writeFile(
          config,
          JSON.stringify({
            agent: { agentBackend: 'claude', provider: 'anthropic', model: 'claude-sonnet-4' },
            anthropic: { apiKey: 'offline-migration-e2e-placeholder' },
            workspace: { dir: workspace },
            channels: {
              rest: {
                host: '127.0.0.1',
                port: await unusedPort(),
                fileStorageDir: join(root, 'files'),
              },
            },
            logging: { level: 'info' },
          }),
          { mode: 0o600, flag: 'wx' }
        );

        await startLegacy();
        expect(await waitForBroker(socket)).toMatchObject({ state: 'idle', queued: 0 });
        const initialLegacyPid = await brokerPid(socket);
        if (process.platform === 'linux') {
          const managerPid = Number(
            await host('systemctl', [
              '--user',
              'show',
              LEGACY_UNIT,
              '--property=MainPID',
              '--value',
            ])
          );
          if (managerPid !== initialLegacyPid) {
            const describePid = async (pid: number): Promise<string> =>
              host('ps', ['-ww', '-p', String(pid), '-o', 'pid=,ppid=,args=']).catch(
                () => 'process not found'
              );
            throw new Error(
              `Disposable systemd fixture is not a directly owned broker: MainPID=${managerPid} (${await describePid(managerPid)}), lock PID=${initialLegacyPid} (${await describePid(initialLegacyPid)})`
            );
          }
        }
        const firstValue = `before-rollback-${id}`;
        const firstUse = await executeIpc(
          socket,
          workspace,
          `goto_url('data:text/html,%3Cinput%20id%3Dvalue%20value%3D${firstValue}%3E')\nassert wait_for_element('#value')\nprint(js("document.querySelector('#value').value"))\n`
        );
        expect(firstUse).toContain(firstValue);

        // Force failure after migration has stopped the old manager but before
        // startup commits. Rollback must restore its unit, broker and settings.
        const occupied = createServer();
        await new Promise<void>((resolveListen, reject) => {
          occupied.once('error', reject);
          occupied.listen(0, '127.0.0.1', resolveListen);
        });
        const occupiedPort = (occupied.address() as { port: number }).port;
        const rollbackCandidate = await startCandidate(root, config, occupiedPort, home);
        candidate = rollbackCandidate;
        let rollbackExit: { code: number | null; signal: NodeJS.Signals | null };
        try {
          rollbackExit = await withTimeout(
            rollbackCandidate.closed,
            90_000,
            'Expected startup failure timed out'
          );
        } finally {
          await new Promise<void>((resolveClose) => occupied.close(() => resolveClose()));
        }
        candidate = undefined;
        expect(rollbackExit.code, rollbackCandidate.output()).toBe(1);
        expect(rollbackCandidate.output()).toMatch(/port.*use|already in use/i);
        expect(await exists(definition)).toBe(true);
        expect(await exists(migratedSettings)).toBe(false);
        expect(await waitForBroker(socket)).toMatchObject({ state: 'idle', queued: 0 });
        await expectLegacyManagerEnabled();
        expect(await brokerPid(socket)).not.toBe(initialLegacyPid);
        expect(await readFile(workspaceMarker, 'utf8')).toBe(id);
        const afterRollback = await executeIpc(
          socket,
          workspace,
          `print(js("document.querySelector('#value').value"))\n`
        );
        expect(afterRollback).toContain(firstValue);

        const retiringLegacyPid = await brokerPid(socket);
        candidate = await startCandidate(root, config, 0, home);
        await waitForOutput(candidate, 'HTTP API server started on', 90_000);
        await waitForPathToDisappear(definition, candidate, 15_000);
        expect(await exists(definition)).toBe(false);
        expect(pidIsAlive(retiringLegacyPid)).toBe(false);
        await expectLegacyManagerUnloaded();
        expect(await readFile(workspaceMarker, 'utf8')).toBe(id);
        const settingsStat = await stat(migratedSettings);
        expect(settingsStat.mode & 0o077).toBe(0);
        const settings = JSON.parse(await readFile(migratedSettings, 'utf8')) as {
          version: number;
          environment: Record<string, string>;
        };
        expect(settings.version).toBe(1);
        expect(settings.environment.DISCLAUDE_BROWSER_SOCKET).toBe(socket);
        expect(settings.environment.DISCLAUDE_BROWSER_WORKSPACE).toBe(workspace);
        expect(settings.environment.DISCLAUDE_BROWSER_TARGET).toBe(target);
        expect(settings.environment.BU_CDP_URL).toBe(endpoint);
        expect(await waitForBroker(socket)).toMatchObject({ state: 'idle', queued: 0 });

        const postMigrationValue = `migrated-${id}`;
        const productUse = await runProductBrowser(
          socket,
          workspace,
          `fill_input('#value','${postMigrationValue}')\nprint(js("document.querySelector('#value').value"))\n`
        );
        expect(productUse).toContain(postMigrationValue);
        const marker = await readFile(join(profile, 'migration-profile-marker'), 'utf8');
        expect(marker).toBe(id);
        expect(
          (await fetch(`${endpoint}/json/version`, { signal: AbortSignal.timeout(3000) })).ok
        ).toBe(true);

        await stopCandidate(candidate, socket);
        candidate = undefined;
        expect(await exists(socket)).toBe(false);
        expect(await exists(`${socket}.lock`)).toBe(false);
        expect(
          (await fetch(`${endpoint}/json/version`, { signal: AbortSignal.timeout(3000) })).ok
        ).toBe(true);

        // The migrated private settings, not the parent process environment,
        // must restore the browser configuration on a clean service restart.
        candidate = await startCandidate(root, config, 0, home);
        await waitForOutput(candidate, 'HTTP API server started on', 90_000);
        expect(await waitForBroker(socket)).toMatchObject({ state: 'idle', queued: 0 });
        const afterRestart = await runProductBrowser(
          socket,
          workspace,
          `print(js("document.querySelector('#value').value"))\n`
        );
        expect(afterRestart).toContain(postMigrationValue);
        await stopCandidate(candidate, socket);
        candidate = undefined;
        expect(await exists(socket)).toBe(false);
        expect(await exists(`${socket}.lock`)).toBe(false);
        expect(await readFile(join(profile, 'migration-profile-marker'), 'utf8')).toBe(id);
        expect(await readFile(workspaceMarker, 'utf8')).toBe(id);
        console.info(
          'BROWSER_IPC_MIGRATION_ACCEPTANCE',
          JSON.stringify({
            platform: process.platform,
            rollbackRestoredLegacyManager: true,
            migrationRemovedLegacyManager: true,
            realBrowserUseAfterMigration: true,
            settingsSurviveServiceRestart: true,
            externalCdpAndProfilePreserved: true,
            userWorkspacePreserved: true,
          })
        );
      } finally {
        let cleanupFailure: unknown;
        if (!endpoint) {
          try {
            const [port] = (await readFile(join(profile, 'DevToolsActivePort'), 'utf8'))
              .trim()
              .split('\n');
            if (/^\d+$/.test(port) && +port > 0 && +port < 65536) {
              endpoint = `http://127.0.0.1:${port}`;
            }
          } catch {
            /* Chromium may have failed before publishing a debugging port. */
          }
        }
        try {
          await stopCandidate(candidate, socket);
        } catch (error) {
          cleanupFailure = error;
        }
        try {
          await managerCleanup();
        } catch (error) {
          cleanupFailure ??= error;
        }
        if (browser.pid && browser.exitCode === null && browser.signalCode === null) {
          try {
            process.kill(-browser.pid, 'SIGTERM');
          } catch {
            /* Already exited. */
          }
          try {
            await withTimeout(
              new Promise<void>((resolveExit) => browser.once('close', () => resolveExit())),
              10_000,
              'Disposable Chromium did not exit after SIGTERM'
            );
            await waitForCdpDown(endpoint, 5000);
          } catch {
            try {
              process.kill(-browser.pid, 'SIGKILL');
            } catch {
              /* Already exited. */
            }
            try {
              await waitForCdpDown(endpoint, 5000);
            } catch {
              cleanupFailure ??= new Error(
                'Disposable Chromium process group did not stop; preserved its profile'
              );
            }
          }
        }
        browserStopped =
          (browser.exitCode !== null || browser.signalCode !== null) &&
          (await waitForCdpDown(endpoint, 1000).then(
            () => true,
            () => false
          ));
        if (legacyStarted && (await pathEntryExists(definition))) {
          cleanupFailure ??= new Error('Legacy service definition remains after manager cleanup');
        }
        let brokerAlive = false;
        if (await exists(`${socket}.lock`)) {
          try {
            const lock = JSON.parse(await readFile(`${socket}.lock`, 'utf8')) as { pid?: number };
            brokerAlive = Boolean(lock.pid && pidIsAlive(lock.pid));
          } catch {
            cleanupFailure ??= new Error(
              'Browser broker lock changed or became unreadable; preserved it'
            );
          }
        }
        if (brokerAlive) {
          cleanupFailure ??= new Error(
            'Browser broker is still alive; preserved its IPC artifacts'
          );
        }
        if ((await exists(migratedSettings)) && !cleanupFailure) {
          const settings = JSON.parse(await readFile(migratedSettings, 'utf8')) as {
            environment?: Record<string, string>;
          };
          if (
            settings.environment?.DISCLAUDE_BROWSER_SOCKET === socket &&
            settings.environment?.DISCLAUDE_BROWSER_WORKSPACE === workspace
          ) {
            await rm(migratedSettings);
          } else {
            cleanupFailure ??= new Error(
              'Migrated settings changed; preserved them for inspection'
            );
          }
        }
        if ((await exists(socket)) && !brokerAlive && !cleanupFailure) {
          const socketStat = await lstat(socket);
          if (socketStat.isSocket()) {
            await rm(socket);
          } else {
            cleanupFailure ??= new Error(
              'Migration socket path changed to a non-socket; preserved it'
            );
          }
        }
        if ((await exists(`${socket}.lock`)) && !brokerAlive && !cleanupFailure) {
          await rm(`${socket}.lock`);
        }
        const launcher = join(dirname(socket), 'bin', 'browser-use');
        if ((await exists(launcher)) && !cleanupFailure) {
          const launcherText = await readFile(launcher, 'utf8');
          if (!launcherText.includes('/packages/service/dist/browser-control/client.mjs')) {
            cleanupFailure ??= new Error('Browser launcher changed; preserved it');
          } else {
            await rm(launcher);
          }
        }
        if ((await exists(legacyEntry)) && !cleanupFailure) {
          await rm(legacyEntry);
        }
        if ((await exists(releaseDir)) && !cleanupFailure) {
          await rm(releaseDir, { recursive: true });
        }
        if (
          (await exists(root)) &&
          browserStopped &&
          !cleanupFailure &&
          !(await pathEntryExists(definition))
        ) {
          await rm(root, { recursive: true });
        }
        for (const path of [...createdDirs].sort((a, b) => b.length - a.length)) {
          try {
            if ((await readdir(path)).length === 0) {
              await rm(path, { recursive: false });
            }
          } catch {
            /* Keep non-empty or concurrently used directories. */
          }
        }
        if (cleanupFailure) {
          throw cleanupFailure;
        }
      }
    },
    300_000
  );
});
