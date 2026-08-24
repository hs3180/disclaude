/**
 * CI wrapper for the bash source-level quota-exhaustion tests.
 *
 * Issue #4552: account-level quota exhaustion (GLM code 1308,「已达到 5 小时
 * 的使用上限」) must abort the integration runner's retry chains instead of
 * burning them against a quota that resets hours later. The logic under test
 * is bash (common.sh + run-all-tests.sh), so the regression test is
 * tests/integration/test-quota-exhaustion.sh (same convention as
 * test-common-retry.sh). This wrapper runs it under vitest so `npm test`
 * (and CI) covers it; the bash script itself prints per-case PASS/FAIL lines
 * and exits non-zero on any failure.
 *
 * @module integration/quota-exhaustion.test
 */

import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));

describe('integration harness quota-exhaustion detection (#4552)', () => {
  it('bash source-level suite passes (is_quota_exhausted_failure + detect_quota_exhaustion)', () => {
    const output = execFileSync('bash', [
      path.join(here, 'test-quota-exhaustion.sh'),
    ], {
      encoding: 'utf8',
      timeout: 60_000,
      // Source-level test only: common.sh is sourced with stubs, no server
      // is started and no API key is needed.
      env: { ...process.env, SERVER_LOG: '' },
    });

    expect(output).toContain('RESULT:');
    expect(output).not.toContain('FAIL:');
  }, 90_000);

  it('modified shell scripts stay parseable (bash -n)', () => {
    for (const script of ['common.sh', 'run-all-tests.sh', 'test-quota-exhaustion.sh']) {
      expect(() =>
        execFileSync('bash', ['-n', path.join(here, script)], { timeout: 10_000 }),
      ).not.toThrow();
    }
  });
});
