import { describe, it, expect } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, readFile, writeFile, readdir, rm, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createServer } from 'node:net';

const exec = promisify(execFile);
describe('official Chromium download through product setup', () => {
  it.skipIf(process.platform !== 'linux' || process.env.DISCLAUDE_E2E_CHROMIUM_DOWNLOAD !== '1')(
    'downloads and verifies a real snapshot, starts it, reuses it and rejects a changed candidate', async () => {
      const root = await mkdtemp(join(tmpdir(), 'dc-snapshot-setup-'));
      const server = createServer();
      await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
      const port = String((server.address() as { port: number }).port);
      await new Promise<void>(resolve => server.close(() => resolve()));
      const revision = process.env.DISCLAUDE_E2E_CHROMIUM_REVISION || '1698254';
      const browsers = join(root, 'downloaded browsers'), profile = join(root, 'profile with spaces'), config = join(root, 'browser.json');
      const unit = `disclaude-test-download-${process.pid}-${Date.now()}.service`;
      const env = { ...process.env, ['DISCLAUDE_SYSTEMD_ISOLATED']: '1', ['DISCLAUDE_SYSTEMD_UNIT']: unit,
        ['DISCLAUDE_SYSTEMD_STATE_DIR']: root, ['DISCLAUDE_CHROMIUM_CONFIG']: config,
        CHROMIUM_CDP_PROFILE_DIR: profile, CHROMIUM_CDP_PORT: port, CHROMIUM_CDP_ADDRESS: '127.0.0.1', CHROMIUM_CDP_HEADED: '0' };
      const args = [resolve('bin/disclaude.js'), 'chromium-cdp', 'setup', '--isolated', '--download', '--revision', revision,
        '--browser-dir', browsers, '--profile', profile, '--port', port, '--headless', '--no-autostart'];
      let attempted = false;
      try {
        const preview = JSON.parse((await exec(process.execPath, [...args, '--dry-run'], { env, timeout: 30_000 })).stdout);
        expect(preview.installed).toBe(false);
        expect(preview.downloadPlan.source).toContain(`/Linux_x64/${revision}/chrome-linux.zip`);
        await expect(access(browsers)).rejects.toThrow();
        await expect(access(profile)).rejects.toThrow();
        attempted = true;
        if (process.env.DISCLAUDE_E2E_EXPECT_SANDBOX_REFUSAL === '1') {
          // This is a separate refusal contract, not a successful browser installation.
          expect((await readFile('/proc/sys/kernel/apparmor_restrict_unprivileged_userns', 'utf8')).trim()).toBe('1');
          await expect(exec(process.execPath, [...args, '--yes'], { env, timeout: 420_000, maxBuffer: 1024 * 1024 }))
            .rejects.toThrow('cannot establish its Linux sandbox');
          await expect(access(config)).rejects.toThrow();
          await expect(access(profile)).rejects.toThrow();
          expect(await readdir(browsers)).toEqual([]);
          console.info('CHROMIUM_DOWNLOAD_REFUSAL', JSON.stringify({ revision, platform: process.platform,
            sandboxRestricted: true, candidateCleaned: true, serviceCreated: false, installed: false }));
          return;
        }
        const installed = await exec(process.execPath, [...args, '--yes'], { env, timeout: 420_000, maxBuffer: 1024 * 1024 });
        expect(installed.stdout).toContain('"cdpReady":true');
        const destination = join(browsers, `Linux_x64-${revision}`);
        const record = JSON.parse(await readFile(join(destination, 'verification.json'), 'utf8'));
        expect(record.usable).toBe(true);
        expect(record.archiveSha256).toMatch(/^[a-f0-9]{64}$/);
        expect(record.treeSha256).toMatch(/^[a-f0-9]{64}$/);
        expect(record.signature.status).toBe('not-applicable');
        const saved = JSON.parse(await readFile(config, 'utf8')).environment;
        expect(saved.CHROMIUM_CDP_BINARY).toBe(join(destination, 'payload/chrome-linux/chrome'));
        expect(saved.CHROMIUM_CDP_AUTOSTART).toBe('0');
        const status = JSON.parse((await exec(process.execPath, [resolve('scripts/chromium-systemd.mjs'), 'chromium-isolated', 'status'], { env })).stdout);
        expect(status.cdpReady).toBe(true);
        expect(status.configured.executable.source.kind).toBe('chromium-snapshot');
        expect(status.configured.executable.source.revision).toBe(revision);
        expect(status.configured.executable.source.payloadRevalidatedByStatus).toBe(false);

        await writeFile(join(profile, 'keep'), 'persistent profile');
        const reused = await exec(process.execPath, [...args, '--yes'], { env, timeout: 115_000, maxBuffer: 1024 * 1024 });
        expect(reused.stdout).toContain('"reused": true');
        expect(reused.stdout).toContain('"cdpReady":true');
        expect(await readFile(join(profile, 'keep'), 'utf8')).toBe('persistent profile');
        const before = (await exec('systemctl', ['--user', 'show', unit, '--property=MainPID', '--value'])).stdout;
        const extra = join(destination, 'payload', 'unexpected-file'); await writeFile(extra, 'changed');
        await expect(exec(process.execPath, [...args, '--yes'], { env, timeout: 115_000, maxBuffer: 1024 * 1024 })).rejects.toThrow('candidate is not verified or has changed');
        expect((await exec('systemctl', ['--user', 'show', unit, '--property=MainPID', '--value'])).stdout).toBe(before);
        expect(await readdir(browsers)).toEqual([`Linux_x64-${revision}`]);
        await rm(extra);
        console.info('CHROMIUM_DOWNLOAD_ACCEPTANCE', JSON.stringify({ revision, browser: record.browserVersion,
          archiveSha256: record.archiveSha256, size: record.size, md5: record.md5, generation: record.generation,
          source: record.url, platform: process.platform, arch: process.arch,
          verifiedDownload: true, realService: true, reused: true, changedCandidateRejected: true, profilePreserved: true }));
      } finally {
        if (attempted) {
          await exec(process.execPath, [resolve('scripts/chromium-systemd.mjs'), 'chromium-isolated', 'uninstall'], { env, timeout: 30_000 });
          await expect(exec('systemctl', ['--user', 'is-active', unit])).rejects.toThrow();
        }
        await rm(root, { recursive: true, force: true });
      }
    }, 650_000);
});
