import { describe, it, expect } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, writeFile, readFile, rm, access } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { tmpdir, homedir } from 'node:os';
import { join, resolve } from 'node:path';

const exec = promisify(execFile);
const systemctl = async (...args: string[]) => (await exec('systemctl', ['--user', ...args], { timeout: 15000 })).stdout.trim();

describe('native systemd external definition preservation', () => {
  it.skipIf(process.platform !== 'linux' || process.env.DISCLAUDE_E2E_CHROMIUM_SYSTEMD !== '1')(
    'refuses mutations of runtime-loaded units and managed units with manual drop-ins', async () => {
      const root = await mkdtemp(join(tmpdir(), 'dc-systemd-ownership-'));
      const unit = `disclaude-test-ownership-${randomUUID()}.service`;
      const unitDir = join(process.env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'systemd/user');
      const file = join(unitDir, unit);
      const runtimeDir = join(process.env.XDG_RUNTIME_DIR!, 'systemd/user');
      const runtimeFile = join(runtimeDir, unit);
      const dropDir = `${file}.d`, dropFile = join(dropDir, 'override.conf');
      const config = join(root, 'browser.json'), profile = join(root, 'profile');
      const definition = '[Unit]\nDescription=Isolated ownership acceptance\n[Service]\nType=exec\nExecStart=/usr/bin/sleep 300\n';
      const env = { ...process.env,
        DISCLAUDE_SYSTEMD_ISOLATED: '1', DISCLAUDE_SYSTEMD_UNIT: unit,
        DISCLAUDE_SYSTEMD_STATE_DIR: root, DISCLAUDE_CHROMIUM_CONFIG: config,
        CHROMIUM_CDP_BINARY: '/usr/bin/true', CHROMIUM_CDP_PROFILE_DIR: profile,
        CHROMIUM_CDP_PORT: '19222', CHROMIUM_CDP_ADDRESS: '127.0.0.1', CHROMIUM_CDP_HEADED: '0' };
      const command = (name: string) => exec(process.execPath,
        [resolve('scripts/chromium-systemd.mjs'), 'chromium-isolated', name], { env, timeout: 15000 });
      let needsStop = false;
      try {
        await mkdir(runtimeDir, { recursive: true });
        await mkdir(unitDir, { recursive: true });
        await mkdir(profile);
        await writeFile(config, '{"preserve":"manual configuration"}');
        await writeFile(join(profile, 'sentinel'), 'manual profile');
        for (const kind of ['runtime', 'drop-in']) {
          if (kind === 'runtime') {await writeFile(runtimeFile, definition, { flag: 'wx' });}
          else {
            await writeFile(file, `# disclaude-managed-chromium-v1\n${definition}`, { flag: 'wx' });
            await mkdir(dropDir);
            await writeFile(dropFile, '[Service]\nEnvironment=MANUAL_DEPLOYMENT=preserve\n');
          }
          await systemctl('daemon-reload');
          needsStop = true;
          await systemctl('start', unit);
          const pid = await systemctl('show', unit, '--property=MainPID', '--value');
          expect(Number(pid)).toBeGreaterThan(0);
          const original = await readFile(kind === 'runtime' ? runtimeFile : file, 'utf8');
          for (const action of ['stop', 'uninstall', 'generate', 'install', 'start', 'restart']) {
            await expect(command(action)).rejects.toThrow('not managed by this CLI');
            expect(await systemctl('is-active', unit)).toBe('active');
            expect(await systemctl('show', unit, '--property=MainPID', '--value')).toBe(pid);
            expect(await readFile(kind === 'runtime' ? runtimeFile : file, 'utf8')).toBe(original);
            expect(await readFile(config, 'utf8')).toBe('{"preserve":"manual configuration"}');
            expect(await readFile(join(profile, 'sentinel'), 'utf8')).toBe('manual profile');
            if (kind === 'runtime') {await expect(access(file)).rejects.toThrow();}
            else {expect(await readFile(dropFile, 'utf8')).toContain('MANUAL_DEPLOYMENT=preserve');}
          }
          await systemctl('stop', unit);
          needsStop = false;
          await rm(runtimeFile, { force: true });
          await rm(file, { force: true });
          await rm(dropDir, { recursive: true, force: true });
          await systemctl('daemon-reload');
          console.info('SYSTEMD_EXTERNAL_OWNERSHIP_PRESERVED', kind);
        }
      } finally {
        // The unit name and every file are unique to this test; never disable
        // or remove another manager's service while recovering a failed test.
        if (needsStop) { await systemctl('stop', unit); }
        await rm(runtimeFile, { force: true });
        await rm(file, { force: true });
        await rm(dropDir, { recursive: true, force: true });
        await systemctl('daemon-reload');
        await rm(root, { recursive: true, force: true });
        console.info('SYSTEMD_EXTERNAL_OWNERSHIP_CLEANUP_OK');
      }
    }, 120000);
});
