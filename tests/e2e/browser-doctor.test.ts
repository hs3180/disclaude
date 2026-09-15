import { describe, expect, it } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const exec = promisify(execFile);

describe('browser installation preflight', () => {
  it.skipIf(!process.env.DISCLAUDE_E2E_CHROMIUM)('uses the product CLI to report actual browser capabilities and removes disposable state', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dc-doctor-e2e-'));
    const sentinel = join(root, 'existing-profile-marker');
    await writeFile(sentinel, 'keep');
    try {
      const { stdout } = await exec(process.execPath, [resolve('bin/disclaude.js'), 'browser', 'doctor',
        '--binary', process.env.DISCLAUDE_E2E_CHROMIUM!, '--headless',
        ...(process.platform === 'linux' ? ['--require-persistence'] : [])],
      { env: { ...process.env, TMPDIR: root, TMP: root, TEMP: root }, timeout: 90_000 });
      const report = JSON.parse(stdout);
      expect(report.usable).toBe(true);
      expect(report.mode).toBe('headless');
      expect(report.profile).toBe('temporary');
      expect(['retained', 'not-retained']).toContain(report.cookiePersistence);
      expect(report.cycles).toHaveLength(2);
      expect(report.cycles.every((cycle: { navigation: boolean; input: boolean; screenshot: boolean }) =>
        cycle.navigation && cycle.input && cycle.screenshot)).toBe(true);
      expect(report.cycles[0].runningCookie).toBe(true);
      expect(await readFile(sentinel, 'utf8')).toBe('keep');
      expect((await readdir(root)).filter(name => name.startsWith('disclaude-browser-doctor-'))).toEqual([]);
      console.info('BROWSER_DOCTOR_ACCEPTANCE', JSON.stringify({ ...report, executable: '<selected-browser>' }));
    } finally { await rm(root, { recursive: true, force: true }); }
  }, 100_000);
});
