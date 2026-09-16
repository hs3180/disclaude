import { describe, it, expect } from 'vitest';
import nock from 'nock';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID, createHash } from 'node:crypto';
import { mkdtemp, mkdir, writeFile, readFile, rm, rename, readdir, lstat, readlink, access } from 'node:fs/promises';
import { tmpdir, homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { createServer } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';
import { seedNativeBrowserCookie, hasNativeBrowserCookie } from './helpers/native-browser-cookie.js';

// The runtime modules are plain JavaScript; describe only the API this case uses.
interface BrowserClient {
  ws: { close(): void };
  call(method: string, params?: Record<string, unknown>, sessionId?: string): Promise<unknown>;
}
const cdpModule = resolve('packages/service/src/browser-control/cdp.mjs');
const { connect } = await import(cdpModule) as { connect(url: string): Promise<BrowserClient> };
const systemdModule = resolve('scripts/chromium-systemd.mjs');
const { systemdQuote } = await import(systemdModule) as { systemdQuote(value: string, command?: boolean): string };

const exec = promisify(execFile);
const ctl = async (...args: string[]) => (await exec('systemctl', ['--user', ...args], { timeout: 15000 })).stdout.trim();
async function verifyNativeBrowserPage(client: BrowserClient, profile: string, port: number) {
  const processes = await client.call('SystemInfo.getProcessInfo') as { processInfo: Array<{ type: string; id: number }> };
  const pid = processes.processInfo.find(process => process.type === 'browser')?.id;
  expect(pid).toBeGreaterThan(0);
  const command = (await exec('ps', ['-ww', '-p', String(pid), '-o', 'args='])).stdout;
  expect(command).toContain(`--user-data-dir=${profile}`);
  expect(command).toContain(`--remote-debugging-port=${port}`);
  const { targetId } = await client.call('Target.createTarget', { url: 'about:blank' }) as { targetId: string };
  try {
    const { sessionId } = await client.call('Target.attachToTarget', { targetId, flatten: true }) as { sessionId: string };
    const result = await client.call('Runtime.evaluate', {
      expression: "document.body.innerHTML='<input id=check>'; document.querySelector('#check').value='migration verified'; document.querySelector('#check').value",
      returnByValue: true,
    }, sessionId) as { result: { value: string } };
    expect(result.result.value).toBe('migration verified');
    const screenshot = await client.call('Page.captureScreenshot', { format: 'png' }, sessionId) as { data: string };
    expect(Buffer.from(screenshot.data, 'base64').subarray(0, 8).toString('hex')).toBe('89504e470d0a1a0a');
  } finally { await client.call('Target.closeTarget', { targetId }); }
}
async function digestTree(root: string): Promise<string> {
  const hash = createHash('sha256');
  async function visit(directory: string) {
    for (const name of (await readdir(directory)).sort()) {
      const file = join(directory, name), entry = await lstat(file);
      hash.update(file.slice(root.length));
      if (entry.isDirectory()) { await visit(file); }
      else if (entry.isSymbolicLink()) { hash.update(await readlink(file)); }
      else { hash.update(await readFile(file)); }
    }
  }
  await visit(root); return hash.digest('hex');
}

describe('operator-assisted manual browser migration', () => {
  it.skipIf(process.platform !== 'linux' || process.env.DISCLAUDE_E2E_CHROMIUM_SYSTEMD !== '1' || !process.env.DISCLAUDE_E2E_CHROMIUM)(
    'preserves an old deployment, restores it after candidate failure, then migrates a copied profile', async () => {
      const root = await mkdtemp(join(tmpdir(), 'dc-browser-migration-'));
      const unit = `disclaude-test-migration-${randomUUID()}.service`;
      const runtimeDir = join(process.env.XDG_RUNTIME_DIR!, 'systemd/user');
      const oldUnit = join(runtimeDir, unit), archivedUnit = join(root, 'old-unit.saved');
      const candidateUnit = join(process.env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'systemd/user', unit);
      const oldProfile = join(root, 'old-profile'), newProfile = join(root, 'new-profile');
      const oldConfig = join(root, 'old.env'), newConfig = join(root, 'candidate.json');
      const binary = process.env.DISCLAUDE_E2E_CHROMIUM!;
      const headed = process.env.DISCLAUDE_E2E_BROWSER_HEADED === '1';
      const listener = createServer();
      await new Promise<void>(resolve => listener.listen(0, '127.0.0.1', resolve));
      const {port} = (listener.address() as { port: number });
      await new Promise<void>(resolve => listener.close(() => resolve()));
      nock.enableNetConnect(host => host === `127.0.0.1:${port}`);
      const args = [binary, `--user-data-dir=${oldProfile}`, `--remote-debugging-port=${port}`, '--remote-debugging-address=127.0.0.1', '--no-first-run', '--no-default-browser-check', ...(headed ? [] : ['--headless=new']), 'about:blank'];
      const display = ['DISPLAY', 'WAYLAND_DISPLAY', 'XAUTHORITY', 'XDG_RUNTIME_DIR'].filter(key => process.env[key])
        .map(key => `Environment=${systemdQuote(`${key}=${process.env[key]}`)}`).join('\n');
      // An actual unmarked user-maintained unit, outside the CLI definition path.
      const definition = `[Unit]\nDescription=Owned manual migration fixture\n[Service]\nType=exec\nExecStart=${args.map(arg => systemdQuote(arg, true)).join(' ')}\nRestart=on-failure\nKillMode=control-group\n${display}\n`;
      const configBytes = `CHROMIUM_CDP_BINARY='${binary}'\nCHROMIUM_CDP_PROFILE_DIR='${oldProfile}'\nCHROMIUM_CDP_PORT=${port}\nCHROMIUM_CDP_HEADED=${headed ? '1' : '0'}\nCHROMIUM_CDP_AUTOSTART=0\n`;
      const env = { ...process.env,
        ['DISCLAUDE_SYSTEMD_ISOLATED']: '1', ['DISCLAUDE_SYSTEMD_UNIT']: unit,
        ['DISCLAUDE_SYSTEMD_STATE_DIR']: root, ['DISCLAUDE_CHROMIUM_CONFIG']: newConfig,
        CHROMIUM_CDP_PROFILE_DIR: newProfile, CHROMIUM_CDP_PORT: String(port) };
      const setupArgs = [resolve('bin/disclaude.js'), 'chromium-cdp', 'setup', '--isolated', '--import-config', oldConfig, '--profile', newProfile, '--no-autostart'];
      const setup = (extra: string[]) => exec(process.execPath, [...setupArgs, ...extra], { env, timeout: 115000, maxBuffer: 1024 * 1024 });
      const clients: Array<Awaited<ReturnType<typeof connect>>> = [];
      const open = async () => {
        for (let i = 0; i < 100; i++) {
          try {
            const response = await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(1000) });
            const version = await response.json() as { webSocketDebuggerUrl: string };
            const client = await connect(version.webSocketDebuggerUrl); clients.push(client); return client;
          } catch { await delay(100); }
        }
        throw new Error('Owned browser did not become ready');
      };
      const retireOld = async (client: Awaited<ReturnType<typeof connect>>) => {
        // A successful Browser.close flushes the old profile before retiring its manager.
        await client.call('Browser.close').catch(() => undefined);
        for (let i = 0; i < 100 && await ctl('show', unit, '--property=MainPID', '--value') !== '0'; i++) { await delay(100); }
        expect(await ctl('show', unit, '--property=MainPID', '--value')).toBe('0');
        await ctl('stop', unit);
        await rename(oldUnit, archivedUnit);
        await ctl('daemon-reload');
      };
      try {
        await mkdir(runtimeDir, { recursive: true }); await mkdir(oldProfile);
        await writeFile(oldUnit, definition, { flag: 'wx' }); await writeFile(oldConfig, configBytes, { mode: 0o600 });
        await ctl('daemon-reload'); await ctl('start', unit);
        const original = await open();
        await verifyNativeBrowserPage(original, oldProfile, port);
        const cookie = await seedNativeBrowserCookie(original);
        await writeFile(join(oldProfile, 'migration-sentinel'), 'original data');
        // The operator must retire the original manager; setup cannot take it over.
        await expect(setup(['--yes'])).rejects.toThrow('not managed by this CLI');
        expect(await hasNativeBrowserCookie(original, cookie)).toBe(true);
        await expect(access(newConfig)).rejects.toThrow();
        await retireOld(original);
        const beforeFailure = await digestTree(oldProfile);
        const failing = join(root, 'fails-only-in-service');
        const shellBinary = `'${binary.replace(/'/g, "'\\''")}'`;
        await writeFile(failing, `#!/bin/sh\nfor arg in "$@"; do\n if [ "$arg" = "--version" ] || [ "$arg" = "--remote-debugging-port=0" ]; then exec ${shellBinary} "$@"; fi\ndone\nexit 7\n`, { mode: 0o700 });
        await expect(setup(['--binary', failing, '--copy-profile-from', oldProfile, '--yes'])).rejects.toThrow('previous configuration preserved');
        expect(await digestTree(oldProfile)).toBe(beforeFailure);
        expect(await readFile(oldConfig, 'utf8')).toBe(configBytes);
        expect(await readFile(archivedUnit, 'utf8')).toBe(definition);
        expect(await readFile(join(newProfile, 'migration-sentinel'), 'utf8')).toBe('original data');
        await expect(access(newConfig)).rejects.toThrow(); await expect(access(candidateUnit)).rejects.toThrow();
        // Explicit operator rollback uses the original definition and original profile.
        await rename(archivedUnit, oldUnit); await ctl('daemon-reload'); await ctl('reset-failed', unit); await ctl('start', unit);
        const recovered = await open(); await verifyNativeBrowserPage(recovered, oldProfile, port);
        expect(await hasNativeBrowserCookie(recovered, cookie)).toBe(true);
        await retireOld(recovered);
        const beforeSuccess = await digestTree(oldProfile);
        // The copy is deliberately retained after failed activation; do not copy over it.
        await setup(['--yes']);
        const migrated = await open(); await verifyNativeBrowserPage(migrated, newProfile, port);
        expect(await hasNativeBrowserCookie(migrated, cookie)).toBe(true);
        expect(await digestTree(oldProfile)).toBe(beforeSuccess);
        expect(await readFile(oldConfig, 'utf8')).toBe(configBytes);
        expect(await readFile(archivedUnit, 'utf8')).toBe(definition);
        expect(await ctl('show', unit, '--property=FragmentPath', '--value')).toBe(candidateUnit);
        console.info('MANUAL_BROWSER_MIGRATION_ACCEPTANCE', JSON.stringify({ platform: process.platform, arch: process.arch, headed,
          externalTakeoverRefused: true, operatorRetiredOldManager: true, failedCandidatePreservedSource: true,
          operatorRollbackHealthy: true, copiedProfileActive: true, syntheticCookieRetained: true,
          oldDefinitionAndConfigPreserved: true, oldProfileDigestPreserved: true, realAccountLogin: false }));
      } finally {
        for (const client of clients) { client.ws.close(); }
        try { await ctl('stop', unit); } catch (error) {
          if (await ctl('show', unit, '--property=LoadState', '--value') !== 'not-found') { throw error; }
        }
        await rm(oldUnit, { force: true }); await rm(candidateUnit, { force: true });
        await ctl('daemon-reload'); await rm(root, { recursive: true, force: true });
        nock.enableNetConnect('localhost');
        console.info('MANUAL_BROWSER_MIGRATION_CLEANUP_OK');
      }
    }, 240000);
});
