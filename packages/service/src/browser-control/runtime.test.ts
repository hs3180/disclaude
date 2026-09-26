import { afterEach, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { startBrowserRuntime, type BrowserRuntime } from './runtime.js';

const roots: string[] = [];
const runtimes: BrowserRuntime[] = [];
afterEach(async () => {
  for (const runtime of runtimes.splice(0)) { await runtime.stop(); }
  for (const root of roots.splice(0)) { rmSync(root, { recursive: true, force: true }); }
});
function fixture(code: string) {
  const root = mkdtempSync(join(tmpdir(), 'browser-runtime-'));
  roots.push(root);
  const file = join(root, 'broker.mjs');
  writeFileSync(file, code);
  const env: NodeJS.ProcessEnv = { ...process.env, BU_CDP_URL: 'http://127.0.0.1:1',
    DISCLAUDE_CHROMIUM_BINARY: '', DISCLAUDE_BROWSER_MODE: 'coordinated',
    DISCLAUDE_BROWSER_SOCKET: join(root, 'browser.sock') };
  delete env.DISCLAUDE_BROWSER_BIN;
  return { root, env, entry: pathToFileURL(file) };
}
describe('managed browser lifecycle', () => {
  it('rejects direct standalone broker startup before creating IPC state', () => {
    const root = mkdtempSync(join(tmpdir(), 'browser-runtime-standalone-'));
    roots.push(root);
    const socket = join(root, 'browser.sock');
    const entry = fileURLToPath(new URL('./service.mjs', import.meta.url));
    const result = spawnSync(process.execPath, [entry], {
      env: { ...process.env, DISCLAUDE_BROWSER_SOCKET: socket },
      encoding: 'utf8',
    });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('must be launched by disclaude start');
    expect(existsSync(socket)).toBe(false);
    expect(existsSync(`${socket}.lock`)).toBe(false);
  });

  it('does not start a coordinator unless configured', async () => {
    expect(await startBrowserRuntime({})).toBeUndefined();
  });
  it('validates ambiguous browser ownership before launching a process', async () => {
    await expect(startBrowserRuntime({ DISCLAUDE_BROWSER_MODE: 'coordinated', DISCLAUDE_BROWSER_SOCKET: '/tmp/b.sock',
      BU_CDP_URL: 'http://127.0.0.1:1', DISCLAUDE_CHROMIUM_BINARY: '/browser' })).rejects.toThrow('either');
  });
  it('creates the socket-relative client only after matching readiness and stops the owned process', async () => {
    const { root, env, entry } = fixture('process.send({ready:true,socket:process.env.DISCLAUDE_BROWSER_SOCKET}); setInterval(()=>{},1000);');
    const pending = startBrowserRuntime(env, undefined, entry);
    expect(existsSync(join(root, 'bin/browser-use'))).toBe(false);
    expect(env.DISCLAUDE_BROWSER_BIN).toBeUndefined();
    const runtime = (await pending)!; runtimes.push(runtime);
    expect(env.DISCLAUDE_BROWSER_BIN).toBeUndefined();
    expect(existsSync(join(root, 'bin/browser-use'))).toBe(true);
    const launcher = readFileSync(join(root, 'bin/browser-use'), 'utf8');
    expect(launcher).toContain('/browser-control/client.mjs');
    expect(launcher).not.toContain('/experiments/');
    await runtime.stop();
    expect(() => process.kill(runtime.pid!, 0)).toThrow();
  });
  it('rejects pre-readiness failure without publishing an agent launcher', async () => {
    const { env, entry } = fixture("console.error('profile already owned'); process.exit(2);");
    await expect(startBrowserRuntime(env, undefined, entry)).rejects.toThrow('profile already owned');
    expect(env.DISCLAUDE_BROWSER_BIN).toBeUndefined();
  });
  it('reclaims only the crashed broker process group and its matching IPC ownership', async () => {
    const { root, env, entry } = fixture(`
      import { spawn } from 'node:child_process';
      import { writeFileSync } from 'node:fs';
      import { createServer } from 'node:net';
      const socket = process.env.DISCLAUDE_BROWSER_SOCKET;
      const browser = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], {stdio:'ignore'});
      writeFileSync(socket + '.child', String(browser.pid));
      writeFileSync(socket + '.lock', JSON.stringify({pid:process.pid,instance:process.env.DISCLAUDE_BROWSER_INSTANCE}));
      createServer().listen(socket, () => process.send({ready:true,socket}));
    `);
    let unavailable = '';
    const runtime = (await startBrowserRuntime(env, message => { unavailable = message; }, entry))!;
    runtimes.push(runtime);
    const descendant = Number(readFileSync(join(root, 'browser.sock.child'), 'utf8'));
    const alive = (): boolean => { try { process.kill(descendant, 0); return true; } catch { return false; } };
    try {
      process.kill(runtime.pid!, 'SIGKILL');
      for (let i = 0; i < 100 && (alive() || !unavailable); i++) { await new Promise(resolve => setTimeout(resolve, 20)); }
      expect(alive()).toBe(false);
      expect(unavailable).toContain('coordinator exited');
      expect(existsSync(env.DISCLAUDE_BROWSER_SOCKET!)).toBe(false);
      expect(existsSync(`${env.DISCLAUDE_BROWSER_SOCKET!  }.lock`)).toBe(false);
    } finally { if (alive()) { process.kill(descendant, 'SIGKILL'); } }
  });
  it('preserves socket and lock files with a different instance identity', async () => {
    const { env, entry } = fixture(`
      import { writeFileSync } from 'node:fs';
      import { createServer } from 'node:net';
      const socket = process.env.DISCLAUDE_BROWSER_SOCKET;
      writeFileSync(socket + '.lock', JSON.stringify({pid:process.pid,instance:'another-instance'}));
      createServer().listen(socket, () => process.send({ready:true,socket}));
    `);
    const runtime = (await startBrowserRuntime(env, undefined, entry))!;
    runtimes.push(runtime);
    await runtime.stop();
    expect(existsSync(env.DISCLAUDE_BROWSER_SOCKET!)).toBe(true);
    expect(JSON.parse(readFileSync(`${env.DISCLAUDE_BROWSER_SOCKET!  }.lock`, 'utf8')).instance).toBe('another-instance');
  });
  it('reports a crashed ready coordinator without silently restarting or restoring CDP access', async () => {
    const { env, entry } = fixture('process.send({ready:true,socket:process.env.DISCLAUDE_BROWSER_SOCKET}); setTimeout(()=>{console.error("fixture broker failure");process.exit(2);},150);');
    let unavailable = '';
    const runtime = (await startBrowserRuntime(env, message => { unavailable = message; }, entry))!;
    runtimes.push(runtime);
    await new Promise(resolve => setTimeout(resolve, 300));
    expect(unavailable).toContain('coordinator exited');
    expect(unavailable).toContain('"code":2');
    expect(unavailable).toContain('fixture broker failure');
    expect(env.DISCLAUDE_BROWSER_BIN).toBeUndefined();
  });
});
