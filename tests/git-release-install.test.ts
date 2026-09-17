import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { describe, it } from 'vitest';

describe('Distribution packaging', () => {
  it('validates import rewriting and distribution generation', () => {
    execFileSync(process.execPath, ['--test', 'scripts/build-git-release.test.mjs'], {
      cwd: resolve('.'),
    });
  });
});
