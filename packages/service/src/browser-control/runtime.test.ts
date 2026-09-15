import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
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
  it('does not start a coordinator unless configured', async () => {
    expect(await startBrowserRuntime({})).toBeUndefined();
  });
  it('validates ambiguous browser ownership before launching a process', async () => {
    await expect(startBrowserRuntime({ DISCLAUDE_BROWSER_MODE: 'coordinated', DISCLAUDE_BROWSER_SOCKET: '/tmp/b.sock',
      BU_CDP_URL: 'http://127.0.0.1:1', DISCLAUDE_CHROMIUM_BINARY: '/browser' })).rejects.toThrow('either');
  });
  it('publishes the installed client only after matching readiness and stops the owned process', async () => {
    const { root, env, entry } = fixture('process.send({ready:true,socket:process.env.DISCLAUDE_BROWSER_SOCKET}); setInterval(()=>{},1000);');
    const pending = startBrowserRuntime(env, undefined, entry);
    expect(env.DISCLAUDE_BROWSER_BIN).toBeUndefined();
    const runtime = (await pending)!; runtimes.push(runtime);
    expect(env.DISCLAUDE_BROWSER_BIN).toBe(join(root, 'bin'));
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
  it('reports a crashed ready coordinator without silently restarting or restoring CDP access', async () => {
    const { env, entry } = fixture('process.send({ready:true,socket:process.env.DISCLAUDE_BROWSER_SOCKET}); setTimeout(()=>process.exit(2),150);');
    let unavailable = '';
    const runtime = (await startBrowserRuntime(env, message => { unavailable = message; }, entry))!;
    runtimes.push(runtime);
    await new Promise(resolve => setTimeout(resolve, 300));
    expect(unavailable).toContain('coordinator exited');
    expect(env.DISCLAUDE_BROWSER_BIN).toBeDefined();
  });
});
