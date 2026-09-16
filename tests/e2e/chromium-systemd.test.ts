import { describe, it, expect } from 'vitest';
import nock from 'nock';
import { verifyNativeBrowserPage } from './helpers/native-browser-page.js';
import { seedNativeBrowserCookie, hasNativeBrowserCookie } from './helpers/native-browser-cookie.js';
import { connect } from '../../packages/service/src/browser-control/cdp.mjs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir, homedir } from 'node:os';
import { join, resolve } from 'node:path';

const exec = promisify(execFile);
async function unusedPort() {
  const server = createServer();
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  return port;
}

describe('Chromium native Linux user-service installation and recovery', () => {
  it.skipIf(process.platform !== 'linux' || process.env.DISCLAUDE_E2E_CHROMIUM_SYSTEMD !== '1' || !process.env.DISCLAUDE_E2E_CHROMIUM)(
    'starts a real isolated service, preserves configuration on conflict, and recovers from failed replacement', async () => {
      const root = await mkdtemp(join(tmpdir(), 'dc-chromium-systemd-'));
      const label = `disclaude-test-chromium-${process.pid}-${Date.now()}.service`;
      const port = await unusedPort();
      nock.enableNetConnect(host => host === `127.0.0.1:${port}`);
      const config = join(root, 'chromium.json');
      const profile = join(root, 'profile');
      const plist = join(process.env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'systemd/user', label);
      const binary = process.env.DISCLAUDE_E2E_CHROMIUM!;
      const headed = process.env.DISCLAUDE_E2E_BROWSER_HEADED === '1';
      const env = { ...process.env, DISCLAUDE_SYSTEMD_ISOLATED: '1',
        DISCLAUDE_SYSTEMD_UNIT: label, DISCLAUDE_SYSTEMD_STATE_DIR: root,
        DISCLAUDE_CHROMIUM_CONFIG: config, CHROMIUM_CDP_BINARY: binary,
        CHROMIUM_CDP_PROFILE_DIR: profile, CHROMIUM_CDP_PORT: String(port),
        CHROMIUM_CDP_ADDRESS: '127.0.0.1', CHROMIUM_CDP_HEADED: headed ? '1' : '0' };
      const command = (name: string, overrides = {}) => exec(process.execPath,
        [resolve('scripts/chromium-systemd.mjs'), 'chromium-isolated', name],
        { env: { ...env, ...overrides }, timeout: 115_000, maxBuffer: 1024 * 1024 });
      const marker = join(profile, 'acceptance-marker');
      const clients: Array<Awaited<ReturnType<typeof connect>>> = [];
      const open = async (url: string) => { const client = await connect(url); clients.push(client); return client; };
        const failing = join(root, 'browser-fails-in-service');
        const quoted = `'${binary.replace(/'/g, "'\\''")}'`;
        await writeFile(failing, `#!/bin/sh\nfor arg in "$@"; do\n if [ "$arg" = "--remote-debugging-port=0" ]; then exec ${quoted} "$@"; fi\ndone\nexit 7\n`, { mode: 0o700 });
      try {
        await expect(command('install', { DBUS_SESSION_BUS_ADDRESS: `unix:path=${root}/absent-user-bus`, XDG_RUNTIME_DIR: join(root, 'absent-user-runtime') }))
          .rejects.toThrow('User-level systemd or lsof is unavailable');
        await expect(readFile(config, 'utf8')).rejects.toThrow();
        await expect(readFile(plist, 'utf8')).rejects.toThrow();
        await expect(command('install', { CHROMIUM_CDP_HEADED: '1', DISPLAY: '', WAYLAND_DISPLAY: '' }))
          .rejects.toThrow('Headed browser requires a desktop display');
        await expect(readFile(config, 'utf8')).rejects.toThrow();
        await expect(readFile(plist, 'utf8')).rejects.toThrow();
        let initialFailure = '';
        try { await command('install', { CHROMIUM_CDP_BINARY: failing }); }
        catch (error) { initialFailure = String((error as { stderr?: string }).stderr ?? error); }
        expect(initialFailure).toContain('previous configuration preserved');
        await expect(readFile(config, 'utf8')).rejects.toThrow();
        await expect(readFile(plist, 'utf8')).rejects.toThrow();
        const initialState = await command('status');
        expect(JSON.parse(initialState.stdout).loaded).toBe(false);
        const installed = await command('install');
        expect(JSON.parse(installed.stdout).cdpReady).toBe(true);
        expect((await exec('systemctl', ['--user', 'is-enabled', label])).stdout.trim()).toBe('enabled');
        await exec('systemd-analyze', ['--user', 'verify', plist]);
        await writeFile(marker, 'preserve user profile data');
        const beforeConfig = await readFile(config, 'utf8');
        const beforePlist = await readFile(plist, 'utf8');
        expect(beforePlist.includes('--headless=new')).toBe(!headed);
        if (headed) expect(beforePlist).toContain('Environment="DISPLAY=');
        const version = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json();
        expect(version.webSocketDebuggerUrl).toMatch(/^ws:/);
        const initialClient = await open(version.webSocketDebuggerUrl);
        const initialPid = await verifyNativeBrowserPage(initialClient, profile, port);
        const cookieMarker = await seedNativeBrowserCookie(initialClient);
        await expect(command('start')).rejects.toThrow();
        await expect(command('restart', { CHROMIUM_CDP_BINARY: join(root, 'missing') })).rejects.toThrow();
        expect(await readFile(config, 'utf8')).toBe(beforeConfig);
        expect(await readFile(plist, 'utf8')).toBe(beforePlist);
        const conflict = createServer();
        await new Promise<void>(resolve => conflict.listen(0, '127.0.0.1', resolve));
        try {
          await expect(command('restart', { CHROMIUM_CDP_PORT: String((conflict.address() as { port: number }).port) })).rejects.toThrow();
        } finally { await new Promise<void>(resolve => conflict.close(() => resolve())); }
        expect(await readFile(config, 'utf8')).toBe(beforeConfig);
        expect(JSON.parse((await command('restart')).stdout).cdpReady).toBe(true);
        expect(initialClient.ws.readyState).toBe(initialClient.ws.CLOSED);
        await expect(initialClient.call('Browser.getVersion')).rejects.toThrow();
        await expect(open(version.webSocketDebuggerUrl)).rejects.toThrow();
        const restarted = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json();
        expect(restarted.webSocketDebuggerUrl).not.toBe(version.webSocketDebuggerUrl);
        const restartedClient = await open(restarted.webSocketDebuggerUrl);
        const restartedPid = await verifyNativeBrowserPage(restartedClient, profile, port);
        expect(restartedPid).not.toBe(initialPid);
        const cookieAfterRestart = await hasNativeBrowserCookie(restartedClient, cookieMarker);
        expect(cookieAfterRestart, 'Linux service profile must retain its persistent cookie after restart').toBe(true);
        // The real browser passes the disposable-profile preflight, but the
        // selected executable exits when systemd uses the persistent port.
        let failure = '';
        try { await command('restart', { CHROMIUM_CDP_BINARY: failing }); }
        catch (error) { failure = String((error as { stderr?: string }).stderr ?? error); }
        expect(failure).toContain('previous service restored and verified');
        expect(await readFile(config, 'utf8')).toBe(beforeConfig);
        expect(await readFile(plist, 'utf8')).toBe(beforePlist);
        expect(await readFile(marker, 'utf8')).toBe('preserve user profile data');
        const recovered = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json();
        expect(recovered.Browser).toBe(version.Browser);
        expect(recovered.webSocketDebuggerUrl).not.toBe(version.webSocketDebuggerUrl);
        const client = await open(recovered.webSocketDebuggerUrl);
        await verifyNativeBrowserPage(client, profile, port);
        const cookieAfterRecovery = await hasNativeBrowserCookie(client, cookieMarker);
        expect(cookieAfterRecovery, 'Linux service profile must retain its persistent cookie after recovery').toBe(true);
        console.info('NATIVE_SERVICE_COOKIE_PERSISTENCE', JSON.stringify({ platform: process.platform,
          arch: process.arch, browser: recovered.Browser, profile: 'owned-systemd-service', headed,
          inSession: true, afterRestart: cookieAfterRestart, afterFailedReplacementRecovery: cookieAfterRecovery,
          syntheticCookie: true, realAccountLoginVerified: false }));
        expect(JSON.parse((await command('status')).stdout).cdpReady).toBe(true);
        await command('stop');
        expect(JSON.parse((await command('status')).stdout).loaded).toBe(false);
        expect(await readFile(marker, 'utf8')).toBe('preserve user profile data');
        expect(JSON.parse((await command('start')).stdout).cdpReady).toBe(true);
        console.info('CHROMIUM_SYSTEMD_ACCEPTANCE', JSON.stringify({ browser: recovered.Browser,
          platform: process.platform, arch: process.arch, mode: headed ? 'headed' : 'headless', display: headed ? process.env.DISPLAY : null, unavailableManagerRejected: true, missingDisplayRejected: true, install: true, restart: true, oldConnectionRejected: true, oldEndpointRejected: true, freshPageVerified: true, processProfileMatched: true, targetCleanup: true,
          invalidPathPreserved: true, portConflictPreserved: true, failedActivationRecovered: true, profilePreserved: true, recoveredInput: true, recoveredScreenshot: true, firstInstallFailureCleaned: true, stopStart: true, status: true }));
      } finally {
        await Promise.allSettled(clients.map(client => client.close()));
        // Unload only the unique label before removing its files/profile.
        try {
          await command('uninstall');
          await expect(exec('systemctl', ['--user', 'is-active', label])).rejects.toThrow();
          await expect(readFile(plist, 'utf8')).rejects.toThrow();
          await rm(root, { recursive: true, force: true });
        } finally { nock.enableNetConnect('localhost'); }
      }
    }, 240_000);
});
