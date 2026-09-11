import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

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
    () => {
      const candidate = JSON.parse(
        readFileSync('tests/fixtures/git-release-candidate.json', 'utf8')
      );
      const output = execFileSync(
        process.execPath,
        [
          'scripts/test-package-install.mjs',
          `github:hs3180/disclaude#${candidate.commit}`,
          candidate.sourceFingerprint,
        ],
        { cwd: resolve('.'), encoding: 'utf8', timeout: 240_000 }
      );
      expect(output).toContain('PACKAGE_INSTALL_OK 0.5.1');
    },
    250_000
  );
});
