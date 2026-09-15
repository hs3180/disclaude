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
        await writeFile(join(profile, 'setup-marker'), 'keep');
        const repeated = await exec(process.execPath, [...args, '--yes'], { env, timeout: 115_000 });
        expect(repeated.stdout).toMatch(/CDP ready:|"cdpReady":true/);
        expect(await readFile(join(profile, 'setup-marker'), 'utf8')).toBe('keep');
        console.info('BROWSER_SETUP_ACCEPTANCE', JSON.stringify({ platform: process.platform, arch: process.arch,
          preview: true, nonInteractiveMissingConfirmationRejected: true, applied: true, repeated: true, profilePreserved: true }));
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
