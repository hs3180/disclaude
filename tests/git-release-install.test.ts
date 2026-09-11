import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const execFileAsync = promisify(execFile);

describe('Git distribution release gate (#4922)', () => {
  it('validates import rewriting and candidate/source consistency', () => {
    execFileSync(process.execPath, ['--test', 'scripts/build-git-release.test.mjs'], {
      cwd: resolve('.'),
    });
    execFileSync(process.execPath, ['scripts/verify-git-candidate.mjs'], { cwd: resolve('.') });
  });

  // Existing CI already runs npm test; this is an active Git installation gate,
  // not dependent on installing an additional workflow. Opt in locally as well.
  it.skipIf(
    process.env.GITHUB_ACTIONS !== 'true' && process.env.DISCLAUDE_TEST_GIT_INSTALL !== '1'
  )(
    'installs the remote candidate and starts the installed runtime offline',
    async () => {
      const candidate = JSON.parse(
        readFileSync('tests/fixtures/git-release-candidate.json', 'utf8')
      );
      const ref = candidate.tag ?? candidate.commit;
      if (candidate.tag) {
        const { stdout: refs } = await execFileAsync('git', [
          'ls-remote', 'https://github.com/hs3180/disclaude.git',
          `refs/tags/${candidate.tag}`, `refs/tags/${candidate.tag}^{}`,
        ], { encoding: 'utf8', timeout: 30_000 });
        const rows = refs.trim().split('\n').filter(Boolean).map((line) => line.split(/\s+/));
        const resolved = rows.find((row) => row[1].endsWith('^{}')) ?? rows[0];
        expect(resolved?.[0], 'Release tag must resolve to the reviewed distribution').toBe(candidate.commit);
      }
      // Keep the Vitest worker event loop responsive during npm's network work.
      const { stdout: output } = await execFileAsync(
        process.execPath,
        [
          'scripts/test-package-install.mjs',
          `github:hs3180/disclaude#${ref}`,
          candidate.sourceFingerprint,
        ],
        { cwd: resolve('.'), encoding: 'utf8', timeout: 240_000 }
      );
      expect(output).toContain(`PACKAGE_INSTALL_OK ${candidate.version}`);
      console.info(output.trim());
      if (process.env.GITHUB_ACTIONS === 'true') {
        const { stdout: node22Output } = await execFileAsync(
          process.execPath,
          [
            'scripts/test-git-node22.mjs',
            `github:hs3180/disclaude#${ref}`,
            candidate.sourceFingerprint,
          ],
          { cwd: resolve('.'), encoding: 'utf8', timeout: 960_000 }
        );
        expect(node22Output).toContain('Runtime: v22.23.2; npm: 11.6.0');
        expect(node22Output).toContain('Runtime: v22.23.2; npm: 10.9.9');
        expect(node22Output.match(/CLI_START_STOP_RESTART_OK/g)).toHaveLength(3);
        expect(node22Output).toContain(`PACKAGE_INSTALL_OK ${candidate.version}`);
        console.info(node22Output.trim());
      }
    },
    1_250_000
  );
});
