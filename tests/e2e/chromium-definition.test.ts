import { describe, it, expect } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, writeFile, readFile, rm, access } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
const exec = promisify(execFile);
async function unusedPort() {
  const server = createServer();
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as { port: number };
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  return port;
}

describe('Chromium launchd definition ownership', () => {
  it.skipIf(process.platform !== 'darwin')('preserves an unmanaged definition and accepts the previous generated format', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dc-unmanaged-plist-'));
    const label = `com.disclaude.test.unmanaged.${process.pid}.${Date.now()}`;
    const plist = join(root, `LaunchAgents/${label}.plist`);
    const config = join(root, 'browser.json');
    const profile = join(root, 'profile');
    const env = { ...process.env,
      DISCLAUDE_LAUNCHD_ISOLATED: '1', DISCLAUDE_LAUNCHD_LABEL: label,
      DISCLAUDE_LAUNCHD_STATE_DIR: root, DISCLAUDE_LAUNCHD_CONFIG_PATH: join(root, 'unused.yaml'),
      DISCLAUDE_CHROMIUM_CONFIG: config, CHROMIUM_CDP_BINARY: '/usr/bin/true',
      CHROMIUM_CDP_PROFILE_DIR: profile, CHROMIUM_CDP_PORT: String(await unusedPort()),
      CHROMIUM_CDP_ADDRESS: '127.0.0.1', CHROMIUM_CDP_HEADED: '0', CHROMIUM_CDP_AUTOSTART: '1' };
    const command = (name: string) => exec(process.execPath,
      [resolve('scripts/launchd.mjs'), 'chromium-isolated', name], { env, timeout: 15_000 });
    const original = `<?xml version="1.0"?><plist version="1.0"><dict><key>Label</key><string>${label}</string><key>ProgramArguments</key><array><string>/usr/bin/true</string></array><key>EnvironmentVariables</key><dict><key>MANUAL_DEPLOYMENT_MARKER</key><string>preserve</string></dict></dict></plist>`;
    try {
      await mkdir(join(root, 'LaunchAgents'));
      await writeFile(plist, original);
      for (const name of ['generate', 'install', 'start', 'restart', 'stop', 'uninstall']) {
        await expect(command(name)).rejects.toThrow('not managed by this CLI');
        expect(await readFile(plist, 'utf8')).toBe(original);
        await expect(access(config)).rejects.toThrow();
        await expect(access(profile)).rejects.toThrow();
      }
      await rm(plist);
      await command('generate');
      const marker = '<!-- disclaude-managed-chromium-v1 -->';
      const generated = await readFile(plist, 'utf8');
      expect(generated).toContain(marker);
      const legacy = generated.replace(`${marker}\n`, '');
      const customized = legacy.replace('about:blank', 'https://manual-deployment.invalid');
      await writeFile(plist, customized);
      await expect(command('generate')).rejects.toThrow('not managed by this CLI');
      expect(await readFile(plist, 'utf8')).toBe(customized);
      // This never loads a service; it verifies compatibility using a real
      // generated plist parsed by the native plutil process.
      await writeFile(plist, legacy);
      await command('generate');
      expect(await readFile(plist, 'utf8')).toBe(generated);
      console.info('CHROMIUM_DEFINITION_OWNERSHIP_OK unmanagedPreserved legacyGeneratedAccepted');
    } finally {
      await rm(root, { recursive: true, force: true });
      console.info('CHROMIUM_DEFINITION_OWNERSHIP_CLEANUP_OK');
    }
  });

});
