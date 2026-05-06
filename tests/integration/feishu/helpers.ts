/**
 * Shared helpers for Feishu IPC integration tests.
 *
 * These tests use mock IPC handlers — no real Feishu credentials needed.
 * They run as part of the standard test suite via `npm test`.
 *
 * @see Issue #1626
 */

import { tmpdir } from 'os';
import { join } from 'path';
import { unlinkSync, existsSync } from 'fs';

/**
 * Generate a unique Unix socket path for IPC tests.
 */
export function generateSocketPath(): string {
  return join(tmpdir(), `feishu-integ-${Date.now()}-${Math.random().toString(36).slice(2)}.sock`);
}

/**
 * Clean up a socket file if it exists.
 */
export function cleanupSocket(socketPath: string): void {
  if (existsSync(socketPath)) {
    try {
      unlinkSync(socketPath);
    } catch {
      // Ignore cleanup errors
    }
  }
}
