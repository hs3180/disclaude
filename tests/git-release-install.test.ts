import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const execFileAsync = promisify(execFile);

describe('Distribution packaging', () => {
  it('validates import rewriting and distribution generation', () => {
    execFileSync(process.execPath, ['--test', 'scripts/build-git-release.test.mjs'], {
      cwd: resolve('.'),
    });
  });

  it.skipIf(
    process.env.GITHUB_ACTIONS !== 'true' && process.env.DISCLAUDE_TEST_PACKAGE_INSTALL !== '1'
  )('installs a distribution built from this checkout and starts it offline', async () => {
    const temp = mkdtempSync(join(tmpdir(), 'disclaude-checkout-install-'));
    const distribution = join(temp, 'distribution');
    const run = (args: string[], cwd = resolve('.'), timeout = 240_000) =>
      execFileAsync(process.execPath, args, { cwd, encoding: 'utf8', timeout });
    try {
      // npm test builds the current checkout first. No published candidate or write access needed.
      await run(['scripts/build-git-release.mjs', distribution]);
      const provenance = JSON.parse(readFileSync(join(distribution, 'release-source.json'), 'utf8'));
      const { stdout: packed } = await execFileAsync('npm', ['pack', '--json', '--ignore-scripts'], {
        cwd: distribution, encoding: 'utf8', timeout: 60_000,
      });
      const archive = join(distribution, JSON.parse(packed)[0].filename);
      const { stdout } = await run(['scripts/test-package-install.mjs', archive, provenance.sourceFingerprint]);
      expect(stdout).toContain(`PACKAGE_INSTALL_OK ${provenance.version}`);
      expect(stdout).toContain('CLI_START_STOP_RESTART_OK');
      console.info(stdout.trim());
      if (process.env.GITHUB_ACTIONS === 'true') {
        const { stdout: matrix } = await run(
          ['scripts/test-git-node22.mjs', archive, provenance.sourceFingerprint], resolve('.'), 960_000
        );
        expect(matrix).toContain('Runtime: v22.23.2; npm: 11.6.0');
        expect(matrix).toContain('Runtime: v22.23.2; npm: 10.9.9');
        expect(matrix.match(/CLI_START_STOP_RESTART_OK/g)).toHaveLength(3);
        expect(matrix).toContain(`PACKAGE_INSTALL_OK ${provenance.version}`);
        console.info(matrix.trim());
      }
    } finally {
      rmSync(temp, { recursive: true, force: true });
    }
  }, 1_250_000);
});
