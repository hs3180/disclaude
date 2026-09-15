import { describe, it, expect } from 'vitest';
import nock from 'nock';
import { verifyNativeBrowserPage } from './helpers/native-browser-page.js';
import { connect } from '../../packages/service/src/browser-control/cdp.mjs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const exec = promisify(execFile);
async function unusedPort() {
  const server = createServer();
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  return port;
}

describe('Chromium launchd installation and recovery', () => {
  it.skipIf(process.platform !== 'darwin' || process.env.DISCLAUDE_E2E_CHROMIUM_LAUNCHD !== '1' || !process.env.DISCLAUDE_E2E_CHROMIUM)(
    'starts a real isolated service, preserves configuration on conflict, and recovers from failed replacement', async () => {
      const root = await mkdtemp(join(tmpdir(), 'dc-chromium-launchd-'));
      const label = `com.disclaude.test.chromium.${process.pid}.${Date.now()}`;
      const port = await unusedPort();
      nock.enableNetConnect(host => host === `127.0.0.1:${port}`);
      const config = join(root, 'chromium.json');
      const profile = join(root, 'profile');
      const plist = join(root, `LaunchAgents/${label}.plist`);
      const binary = process.env.DISCLAUDE_E2E_CHROMIUM!;
      const env = { ...process.env, DISCLAUDE_LAUNCHD_ISOLATED: '1',
        DISCLAUDE_LAUNCHD_LABEL: label, DISCLAUDE_LAUNCHD_STATE_DIR: root,
        DISCLAUDE_LAUNCHD_CONFIG_PATH: join(root, 'unused-service.yaml'),
        DISCLAUDE_CHROMIUM_CONFIG: config, CHROMIUM_CDP_BINARY: binary,
        CHROMIUM_CDP_PROFILE_DIR: profile, CHROMIUM_CDP_PORT: String(port),
        CHROMIUM_CDP_ADDRESS: '127.0.0.1', CHROMIUM_CDP_HEADED: '0' };
      const command = (name: string, overrides = {}) => exec(process.execPath,
        [resolve('scripts/launchd.mjs'), 'chromium-isolated', name],
        { env: { ...env, ...overrides }, timeout: 115_000, maxBuffer: 1024 * 1024 });
      const marker = join(profile, 'acceptance-marker');
      const clients: Array<Awaited<ReturnType<typeof connect>>> = [];
      const open = async (url: string) => { const client = await connect(url); clients.push(client); return client; };
      try {
        const installed = await command('install');
        expect(installed.stdout).toContain('CDP ready:');
        await writeFile(marker, 'preserve user profile data');
        const beforeConfig = await readFile(config, 'utf8');
        const beforePlist = await readFile(plist, 'utf8');
        const version = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json();
        expect(version.webSocketDebuggerUrl).toMatch(/^ws:/);
        const initialClient = await open(version.webSocketDebuggerUrl);
        const initialPid = await verifyNativeBrowserPage(initialClient, profile, port);
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
        expect((await command('restart')).stdout).toContain('CDP ready:');
        expect(initialClient.ws.readyState).toBe(initialClient.ws.CLOSED);
        await expect(initialClient.call('Browser.getVersion')).rejects.toThrow();
        await expect(open(version.webSocketDebuggerUrl)).rejects.toThrow();
        const restarted = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json();
        expect(restarted.webSocketDebuggerUrl).not.toBe(version.webSocketDebuggerUrl);
        const restartedClient = await open(restarted.webSocketDebuggerUrl);
        const restartedPid = await verifyNativeBrowserPage(restartedClient, profile, port);
        expect(restartedPid).not.toBe(initialPid);
        // The real browser passes the disposable-profile preflight, but the
        // selected executable exits when launchd uses the persistent port.
        const failing = join(root, 'browser-fails-in-service');
        const quoted = `'${binary.replace(/'/g, "'\\''")}'`;
        await writeFile(failing, `#!/bin/sh\nfor arg in "$@"; do\n if [ "$arg" = "--remote-debugging-port=0" ]; then exec ${quoted} "$@"; fi\ndone\nexit 7\n`, { mode: 0o700 });
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
        console.info('CHROMIUM_LAUNCHD_ACCEPTANCE', JSON.stringify({ browser: recovered.Browser,
          platform: process.platform, arch: process.arch, install: true, restart: true, oldConnectionRejected: true, oldEndpointRejected: true, freshPageVerified: true, processProfileMatched: true, targetCleanup: true,
          invalidPathPreserved: true, portConflictPreserved: true, failedActivationRecovered: true, profilePreserved: true, recoveredInput: true, recoveredScreenshot: true }));
      } finally {
        await Promise.allSettled(clients.map(client => client.close()));
        // Unload only the unique label before removing its files/profile.
        try {
          await command('uninstall');
          await expect(exec('launchctl', ['list', label])).rejects.toThrow();
          await rm(root, { recursive: true, force: true });
        } finally { nock.enableNetConnect('localhost'); }
      }
    }, 240_000);
});
