import { afterEach, describe, expect, it, vi } from 'vitest';
import { spawn } from 'node:child_process';
import { accessSync, existsSync, mkdtempSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { browserAgentEnv, resolveBrowserRuntimePath } from '@disclaude/core/browser-runtime';
import { browserStatus, prepareBrowserCommands, resolveBrowserUse, resolveCdpEndpoint } from './service.mjs';

const roots = new Set<string>();
const children = new Set<ReturnType<typeof spawn>>();
const services = new Set<{ stop(): Promise<void> }>();
const ambientRuntimeRestores: Array<() => void> = [];
afterEach(async () => {
  await Promise.all([...children].map(child => new Promise<void>(done => {
    child.once('close', () => done());
    if (child.exitCode === null && child.signalCode === null) { child.kill('SIGTERM'); }
  })));
  children.clear();
  await Promise.all([...services].map(service => service.stop()));
  services.clear();
  for (const root of roots) { rmSync(root, { recursive: true, force: true }); }
  roots.clear();
  for (const restore of ambientRuntimeRestores.splice(0)) { restore(); }
});

async function fixture() {
  // An agent session exports DISCLAUDE_BROWSER_RUNTIME into this process and
  // browserAgentEnv lets the ambient manifest win over the fixture's XDG root,
  // sending these launchers at the session's real identity directory. Strip it
  // so the suite stays hermetic when run inside the service.
  if (process.env.DISCLAUDE_BROWSER_RUNTIME) {
    const ambient = process.env.DISCLAUDE_BROWSER_RUNTIME;
    delete process.env.DISCLAUDE_BROWSER_RUNTIME;
    ambientRuntimeRestores.push(() => { process.env.DISCLAUDE_BROWSER_RUNTIME = ambient; });
  }
  const root = mkdtempSync(join(tmpdir(), 'dc-cli-lock-')); roots.add(root);
  const bin = join(root, 'upstream'); mkdirSync(bin);
  const executable = join(bin, 'browser-use');
  writeFileSync(executable, `#!${process.execPath}
import { readFileSync, writeFileSync, appendFileSync } from 'node:fs';
if (process.argv[2] === '--reload') process.exit(0);
const input = readFileSync(0, 'utf8');
const op = JSON.parse(input);
if (op.pidFile) writeFileSync(op.pidFile, String(process.pid));
if (op.events) appendFileSync(op.events, op.name + ':start\\n');
if (op.inspect) console.log(JSON.stringify({args: process.argv.slice(2), input, cwd: process.cwd(), endpoint: process.env.BU_CDP_WS, runtime: process.env.BH_RUNTIME_DIR}));
setTimeout(() => {
  if (op.events) appendFileSync(op.events, op.name + ':end\\n');
  process.stdout.write(op.stdout || ''); process.stderr.write(op.stderr || '');
  process.exit(op.code || 0);
}, op.ms || 0);
`, { mode: 0o700 });
  const env = { ...process.env, PATH: `${bin}:/usr/bin:/bin`, XDG_RUNTIME_DIR: root,
    BU_CDP_URL: 'http://127.0.0.1:9999',
    DISCLAUDE_CONFIG_PATH: join(root, 'config.json'), DISCLAUDE_CHROMIUM_CONFIG: join(root, 'missing.json') };
  const browserId = randomUUID();
  const fetchImpl = vi.fn(() => Promise.resolve(new Response(JSON.stringify({ webSocketDebuggerUrl: `ws://127.0.0.1:9999/devtools/browser/${browserId}` }))));
  const start = async (values = env) => {
    const service = await prepareBrowserCommands({ env: values, fetchImpl });
    services.add(service);
    const path = resolveBrowserRuntimePath(values);
    const data = JSON.parse(readFileSync(path, 'utf8'));
    roots.add(data.directory);
    return { service, path, data, taskEnv: browserAgentEnv(values) };
  };
  const initial = await start();
  const run = (op: Record<string, unknown>, args: string[] = [], taskEnv = initial.taskEnv) => {
    const child = spawn(join(dirname(taskEnv.DISCLAUDE_BROWSER_RUNTIME!), 'bin/browser-use'), args,
      { cwd: root, env: taskEnv, stdio: ['pipe', 'pipe', 'pipe'] });
    children.add(child);
    let stdout = '', stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; }); child.stderr.on('data', chunk => { stderr += chunk; });
    const result = new Promise<{code: number | null; signal: string | null; stdout: string; stderr: string}>((done, reject) => {
      child.once('error', reject);
      child.once('close', (code, signal) => { children.delete(child); done({ code, signal, stdout, stderr }); });
    });
    child.stdin.on('error', () => {});
    child.stdin.end(JSON.stringify(op));
    return { child, result };
  };
  return { root, env, start, run, executable, ...initial };
}

describe('transparent browser-use command coordination', () => {
  it('recovers a reused legacy PID while preserving a live legacy owner', async () => {
    const f = await fixture();
    await f.service.stop();
    const legacy = { ...f.data };
    delete legacy.ownerLock;
    writeFileSync(f.path, JSON.stringify(legacy));
    await expect(f.start()).rejects.toThrow(/already belong/);
    const previousIncarnation = new Date(Date.now() - (process.uptime() + 60) * 1000);
    utimesSync(f.path, previousIncarnation, previousIncarnation);
    expect(() => browserStatus(f.path)).toThrow(/unavailable/);
    const recovered = await f.start();
    expect(recovered.data.pid).toBe(process.pid);
    expect(recovered.data.instance).not.toBe(legacy.instance);
    expect(browserStatus(f.path).state).toBe('idle');
  });

  it('fences a live owner and reclaims its abandoned lock after SIGKILL and PID reuse', async () => {
    const f = await fixture();
    await f.service.stop();
    const module = new URL('./service.mjs', import.meta.url).href;
    const script = `import { prepareBrowserCommands } from ${JSON.stringify(module)};
      await prepareBrowserCommands({ fetchImpl: async () => new Response(JSON.stringify({
        webSocketDebuggerUrl: ${JSON.stringify(f.data.browserEnv.BU_CDP_WS)}
      })) });
      setInterval(() => {}, 1000);`;
    const owner = spawn(process.execPath, ['--input-type=module', '-e', script], { env: f.env, stdio: 'ignore' });
    children.add(owner);
    const closed = new Promise<void>(resolve => owner.once('close', () => { children.delete(owner); resolve(); }));
    await vi.waitFor(() => expect(JSON.parse(readFileSync(f.path, 'utf8')).pid).toBe(owner.pid));
    await expect(f.start()).rejects.toThrow(/already belong/);
    owner.kill('SIGKILL');
    await closed;
    const abandoned = JSON.parse(readFileSync(f.path, 'utf8'));
    writeFileSync(f.path, JSON.stringify({ ...abandoned, pid: process.pid }));
    expect(() => browserStatus(f.path)).toThrow(/unavailable/);
    const recovered = await f.start();
    expect(recovered.data.instance).not.toBe(abandoned.instance);
    expect(browserStatus(f.path).state).toBe('idle');
  });

  it('keeps validating a live owner after its service.lock object is replaced (#5474)', async () => {
    const f = await fixture();
    const lock = join(dirname(f.path), 'service.lock');
    expect(f.data.ownerLockInode).toBe(statSync(lock).ino);
    // A tmp cleaner moved the locked object away and left a fresh unlocked file
    // at the path; the owner still holds its kernel lock on the moved object.
    renameSync(lock, `${lock}.moved`);
    writeFileSync(lock, '', { mode: 0o600 });
    expect(browserStatus(f.path).state).toBe('idle');
    // Pre-inode manifests (deployed before #5474) heal through the same fallback.
    const healed = JSON.parse(readFileSync(f.path, 'utf8'));
    delete healed.ownerLockInode;
    writeFileSync(f.path, JSON.stringify(healed));
    expect(browserStatus(f.path).state).toBe('idle');
    await f.service.stop();
    expect(() => browserStatus(f.path)).toThrow(/unavailable/);
  });

  it('still retires a PID-reused owner whose service.lock object was replaced (#5474)', async () => {
    const f = await fixture();
    const lock = join(dirname(f.path), 'service.lock');
    renameSync(lock, `${lock}.moved`);
    writeFileSync(lock, '', { mode: 0o600 });
    // The manifest predates this PID's incarnation: reuse, not ownership.
    const previousIncarnation = new Date(Date.now() - (process.uptime() + 60) * 1000);
    utimesSync(f.path, previousIncarnation, previousIncarnation);
    expect(() => browserStatus(f.path)).toThrow(/unavailable/);
    const recovered = await f.start();
    expect(recovered.data.instance).not.toBe(f.data.instance);
    expect(browserStatus(recovered.path).state).toBe('idle');
  });

  it('releases service ownership when a startup write fails', async () => {
    const f = await fixture();
    await f.service.stop();
    const launcher = join(dirname(f.path), 'bin', 'browser-use');
    mkdirSync(launcher);
    await expect(f.start()).rejects.toThrow(/EISDIR/);
    rmSync(launcher, { recursive: true });
    const recovered = await f.start();
    expect(browserStatus(recovered.path).state).toBe('idle');
  });

  it('passes arguments, stdin, cwd, output and exit code to the installed CLI', async () => {
    const f = await fixture();
    const op = { inspect: true, stderr: 'upstream stderr', code: 7 };
    const result = await f.run(op, ['argument with spaces', '--flag']).result;
    expect(result.code).toBe(7);
    expect(result.stderr).toContain('upstream stderr');
    expect(result.stderr).toContain('"stage":"unknown"');
    expect(JSON.parse(result.stdout)).toMatchObject({ args: ['argument with spaces', '--flag'], input: JSON.stringify(op), cwd: realpathSync(f.root),
      endpoint: f.data.browserEnv.BU_CDP_WS, runtime: f.data.directory });
    expect(browserStatus(f.path).state).toBe('interrupted');
    const blocked = await f.run({ stdout: 'must-not-run' }).result;
    expect(blocked.stdout).toBe(''); expect(blocked.stderr).toContain('outcome may be unknown');
    expect((await f.run({}, ['--reload']).result).code).toBe(0);
    expect((await f.run({ stdout: 'recovered' }).result).stdout).toBe('recovered');
  });

  it('serializes the whole invocation across projects and service configurations', async () => {
    const f = await fixture();
    const second = await f.start({ ...f.env, DISCLAUDE_CONFIG_PATH: join(f.root, 'other.json') });
    expect(second.data.directory).toBe(f.data.directory);
    const events = join(f.root, 'events'), pidFile = join(f.root, 'pid');
    const first = f.run({ name: 'a', ms: 300, events, pidFile });
    await vi.waitFor(() => accessSync(pidFile));
    expect(browserStatus(f.path).state).toBe('busy');
    const next = f.run({ name: 'b', events }, [], second.taskEnv);
    expect((await first.result).code).toBe(0); expect((await next.result).code).toBe(0);
    expect(readFileSync(events, 'utf8')).toBe('a:start\na:end\nb:start\nb:end\n');
    expect(browserStatus(f.path).state).toBe('idle');
  });

  it('keeps the lock in the actual CLI after SIGKILL of its wrapper', async () => {
    const f = await fixture();
    const pidFile = join(f.root, 'actual.pid'), events = join(f.root, 'events');
    const first = f.run({ name: 'a', ms: 700, pidFile, events });
    await vi.waitFor(() => accessSync(pidFile));
    first.child.kill('SIGKILL');
    await delay(50);
    expect(browserStatus(f.path).state).toBe('busy');
    const next = f.run({ name: 'b', events });
    expect((await first.result).signal).toBe('SIGKILL');
    const result = await next.result;
    expect(result.code).not.toBe(0); expect(result.stderr).toContain('outcome may be unknown');
    expect(readFileSync(events, 'utf8')).toBe('a:start\na:end\n');
    expect((await f.run({}, ['--reload']).result).code).toBe(0);
    expect((await f.run({ name: 'c', events }).result).code).toBe(0);
  });

  it('cancels a waiting invocation without executing it or disturbing the holder', async () => {
    const f = await fixture();
    const pidFile = join(f.root, 'pid'), events = join(f.root, 'events');
    const holder = f.run({ name: 'a', ms: 500, pidFile, events });
    await vi.waitFor(() => accessSync(pidFile));
    const waiter = f.run({ name: 'b', events });
    await delay(100); waiter.child.kill('SIGTERM');
    expect((await waiter.result).code).not.toBe(0);
    expect((await holder.result).code).toBe(0);
    expect(readFileSync(events, 'utf8')).toBe('a:start\na:end\n');
    expect(browserStatus(f.path).state).toBe('idle');
  });

  it('withdraws availability and cancels an active command on service stop', async () => {
    const f = await fixture();
    const pidFile = join(f.root, 'pid'), events = join(f.root, 'events');
    const active = f.run({ name: 'a', ms: 3000, pidFile, events });
    await vi.waitFor(() => accessSync(pidFile));
    await f.service.stop();
    expect((await active.result).signal).toBe('SIGTERM');
    expect(readFileSync(events, 'utf8')).toBe('a:start\n');
    expect(() => browserStatus(f.path)).toThrow(/unavailable/);
    expect(existsSync(join(f.data.directory, 'command.lock'))).toBe(true);
    expect(existsSync(join(f.data.directory, 'interrupted.json'))).toBe(true);
  });

  it('does not unblock after reload reports success but the recorded daemon remains alive', async () => {
    const f = await fixture();
    writeFileSync(join(f.data.directory, 'bu.pid'), JSON.stringify({ pid: process.pid }));
    const reload = await f.run({}, ['--reload']).result;
    expect(reload.code).not.toBe(0);
    expect(reload.stderr).toContain('termination is unconfirmed');
    expect(browserStatus(f.path).state).toBe('interrupted');
    expect((await f.run({ stdout: 'must-not-run' }).result).stdout).toBe('');
  });

  it('ignores the generated wrapper during upstream discovery and never guesses Python', async () => {
    const f = await fixture();
    expect(resolveBrowserUse(f.taskEnv, '/other/bin')).toBe(f.executable);
    expect(() => resolveBrowserUse({ PATH: '/definitely-not-installed' }, '')).toThrow(/browser-use CLI/);
  });

  it('prefers installed CDP config and does not hide invalid config behind a fallback', async () => {
    const f = await fixture();
    writeFileSync(f.env.DISCLAUDE_CHROMIUM_CONFIG, JSON.stringify({ version: 1, environment: { CHROMIUM_CDP_PORT: '4567' } }));
    expect(resolveCdpEndpoint(f.env)).toBe('http://127.0.0.1:4567');
    writeFileSync(f.env.DISCLAUDE_CHROMIUM_CONFIG, '{}');
    expect(() => resolveCdpEndpoint(f.env)).toThrow(/invalid/);
  });

  it('fails before executing anything when its runtime manifest is unavailable', async () => {
    const f = await fixture();
    const result = await f.run({ stdout: 'must-not-run' }, [], { ...f.taskEnv, DISCLAUDE_BROWSER_RUNTIME: join(f.root, 'missing', 'runtime.json') }).result.catch(error => ({ code: 1, stdout: '', stderr: error.message }));
    expect(result.code).not.toBe(0); expect(result.stdout).toBe('');
  });
});
