/**
 * Test helpers for RFC #3329 integration tests.
 *
 * @see Issue #3662
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

/**
 * Create an isolated temp workspace directory for testing.
 * Returns the path and a cleanup function.
 */
export function createTestWorkspace(prefix = 'rfc3329-test-'): {
  workspaceDir: string;
  cleanup: () => void;
} {
  const workspaceDir = mkdtempSync(join(tmpdir(), prefix));
  return {
    workspaceDir,
    cleanup: () => {
      rmSync(workspaceDir, { recursive: true, force: true });
    },
  };
}
