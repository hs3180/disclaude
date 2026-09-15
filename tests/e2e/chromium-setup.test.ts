import { describe, it, expect } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, readFile, writeFile, rm, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createServer } from 'node:net';

const exec = promisify(execFile);
describe('browser setup product CLI', () => {
  it.skipIf(process.env.DISCLAUDE_E2E_BROWSER_SETUP !== '1' || !process.env.DISCLAUDE_E2E_CHROMIUM)(
    'previews without writes, applies the selection and repeats setup with its persistent profile', async () => {
      const root = await mkdtemp(join(tmpdir(), 'dc-browser-setup-'));
      const listener = createServer();
      await new Promise<void>(resolve => listener.listen(0, '127.0.0.1', resolve));
      const port = String((listener.address() as { port: number }).port);
      await new Promise<void>(resolve => listener.close(() => resolve()));
      const profile = join(root, 'profile');
      const config = join(root, 'browser.json');
      const label = process.platform === 'darwin' ? `com.disclaude.test.setup.${process.pid}.${Date.now()}`
        : `disclaude-test-setup-${process.pid}-${Date.now()}.service`;
      const env = { ...process.env, CHROMIUM_CDP_BINARY: process.env.DISCLAUDE_E2E_CHROMIUM!,
        CHROMIUM_CDP_PROFILE_DIR: profile, CHROMIUM_CDP_PORT: port, CHROMIUM_CDP_ADDRESS: '127.0.0.1', CHROMIUM_CDP_HEADED: '0',
      };
      Object.assign(env, { ['DISCLAUDE_CHROMIUM_CONFIG']: config }, process.platform === 'darwin' ? {
        ['DISCLAUDE_LAUNCHD_ISOLATED']: '1', ['DISCLAUDE_LAUNCHD_LABEL']: label,
        ['DISCLAUDE_LAUNCHD_STATE_DIR']: root, ['DISCLAUDE_LAUNCHD_CONFIG_PATH']: join(root, 'unused-app.yaml'),
      } : { ['DISCLAUDE_SYSTEMD_ISOLATED']: '1', ['DISCLAUDE_SYSTEMD_UNIT']: label, ['DISCLAUDE_SYSTEMD_STATE_DIR']: root });
      const args = [resolve('bin/disclaude.js'), 'chromium-cdp', 'setup', '--isolated', '--binary', env.CHROMIUM_CDP_BINARY,
        '--profile', profile, '--port', port, '--headless'];
      let applied = false;
      try {
        const preview = await exec(process.execPath, [...args, '--dry-run'], { env });
        expect(JSON.parse(preview.stdout).endpoint).toBe(`http://127.0.0.1:${port}`);
        await expect(access(profile)).rejects.toThrow();
        await expect(access(config)).rejects.toThrow();
        await expect(exec(process.execPath, args, { env, timeout: 2000 })).rejects.toThrow('Setup needs a terminal');
        applied = true;
        const installed = await exec(process.execPath, [...args, '--yes'], { env, timeout: 115_000 });
        expect(installed.stdout).toMatch(/CDP ready:|"cdpReady":true/);
        const saved = JSON.parse(await readFile(config, 'utf8')).environment;
        expect(saved.CHROMIUM_CDP_PROFILE_DIR).toBe(profile);
        expect(saved.CHROMIUM_CDP_PORT).toBe(port);
        const statusArgs = [resolve('scripts', process.platform === 'darwin' ? 'launchd.mjs' : 'chromium-systemd.mjs'), 'chromium-isolated', 'status'];
        const status = JSON.parse((await exec(process.execPath, statusArgs, { env, timeout: 15_000 })).stdout);
        expect(status.loaded).toBe(true);
        expect(status.cdpReady).toBe(true);
        expect(status.endpoint).toBe(`http://127.0.0.1:${port}`);
        expect(status.configured.executable.path).toBe(saved.CHROMIUM_CDP_BINARY);
        expect(status.configured.executable.available).toBe(true);
        expect(status.configured.profile.path).toBe(profile);
        expect(status.configured.mode).toBe('headless');
        // Explicit candidate overrides do not relabel the saved selection in status.
        const overridden = JSON.parse((await exec(process.execPath, statusArgs, {
          env: { ...env, CHROMIUM_CDP_BINARY: join(root, 'missing-candidate') }, timeout: 15_000,
        })).stdout);
        expect(overridden.configured.executable.path).toBe(saved.CHROMIUM_CDP_BINARY);
        expect(overridden.cdpReady).toBe(true);

        await writeFile(join(profile, 'setup-marker'), 'keep');
        const repeated = await exec(process.execPath, [...args, '--yes'], { env, timeout: 115_000 });
        expect(repeated.stdout).toMatch(/CDP ready:|"cdpReady":true/);
        expect(await readFile(join(profile, 'setup-marker'), 'utf8')).toBe('keep');
        const automatic = process.platform === 'darwin' ? join(root, `LaunchAgents/${label}.plist`) : undefined;
        const manual = process.platform === 'darwin' ? join(root, `ManualServices/${label}.plist`) : undefined;
        const failing = join(root, 'fails-in-service');
        const quoted = `'${env.CHROMIUM_CDP_BINARY.replace(/'/g, "'\\''")}'`;
        await writeFile(failing, `#!/bin/sh\nfor arg in "$@"; do\n if [ "$arg" = "--version" ] || [ "$arg" = "--remote-debugging-port=0" ]; then exec ${quoted} "$@"; fi\ndone\nexit 7\n`, { mode: 0o700 });
        const failedArgs = [...args];
        failedArgs[failedArgs.indexOf('--binary') + 1] = failing;
        let failure = '';
        try { await exec(process.execPath, [...failedArgs, '--yes', '--no-autostart'], { env, timeout: 115_000 }); }
        catch (error) { failure = String((error as { stderr?: string }).stderr ?? error); }
        expect(failure).toContain('previous service restored and verified');
        expect(JSON.parse(await readFile(config, 'utf8')).environment.CHROMIUM_CDP_AUTOSTART).toBe('1');
        if (automatic && manual) { await access(automatic); await expect(access(manual)).rejects.toThrow(); }
        else expect((await exec('systemctl', ['--user', 'is-enabled', label])).stdout.trim()).toBe('enabled');
        await exec(process.execPath, [...args, '--yes', '--no-autostart'], { env, timeout: 115_000 });
        expect(JSON.parse(await readFile(config, 'utf8')).environment.CHROMIUM_CDP_AUTOSTART).toBe('0');
        if (automatic && manual) { await access(manual); await expect(access(automatic)).rejects.toThrow(); }
        else await expect(exec('systemctl', ['--user', 'is-enabled', label])).rejects.toMatchObject({ stdout: 'disabled\n' });
        await exec(process.execPath, [...args, '--yes'], { env, timeout: 115_000 });
        expect(JSON.parse(await readFile(config, 'utf8')).environment.CHROMIUM_CDP_AUTOSTART).toBe('0');
        await exec(process.execPath, [...args, '--yes', '--autostart'], { env, timeout: 115_000 });
        expect(JSON.parse(await readFile(config, 'utf8')).environment.CHROMIUM_CDP_AUTOSTART).toBe('1');
        if (automatic && manual) { await access(automatic); await expect(access(manual)).rejects.toThrow(); }
        else expect((await exec('systemctl', ['--user', 'is-enabled', label])).stdout.trim()).toBe('enabled');
        expect(await readFile(join(profile, 'setup-marker'), 'utf8')).toBe('keep');
        console.info('BROWSER_SETUP_ACCEPTANCE', JSON.stringify({ platform: process.platform, arch: process.arch,
          preview: true, nonInteractiveMissingConfirmationRejected: true, applied: true, repeated: true, profilePreserved: true, autostartToggle: true, failedToggleRecovered: true, statusMetadata: true, statusIgnoresCandidateOverride: true }));
      } finally {
        if (applied) {
          await exec(process.execPath, [resolve('scripts', process.platform === 'darwin' ? 'launchd.mjs' : 'chromium-systemd.mjs'), 'chromium-isolated', 'uninstall'], { env, timeout: 30_000 });
          if (process.platform === 'darwin') await expect(exec('launchctl', ['list', label])).rejects.toThrow();
          else await expect(exec('systemctl', ['--user', 'is-active', label])).rejects.toThrow();
        }
        await rm(root, { recursive: true, force: true });
      }
    }, 240_000);
});
