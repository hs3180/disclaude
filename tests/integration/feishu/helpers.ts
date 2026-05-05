/**
 * Shared helpers for Feishu integration tests.
 *
 * All tests using these helpers are **skipped by default**.
 * Run with: FEISHU_INTEGRATION_TEST=true npx vitest --run tests/integration/feishu
 *
 * These tests use mock IPC handlers — no real Feishu credentials needed.
 *
 * @see Issue #1626
 */

import { describe } from 'vitest';
import { tmpdir } from 'os';
import { join } from 'path';
import { unlinkSync, existsSync } from 'fs';

/** Whether Feishu integration tests are enabled. */
export const FEISHU_INTEGRATION = process.env.FEISHU_INTEGRATION_TEST === 'true';

/**
 * A describe block that only runs when FEISHU_INTEGRATION_TEST=true.
 * Otherwise it is marked as `.skip` and vitest reports it as skipped.
 */
export const describeIfFeishu = FEISHU_INTEGRATION ? describe : describe.skip;

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

/**
 * Get the test Feishu chat ID from the environment.
 *
 * Required for real Feishu API tests (not needed for mock IPC tests).
 * Set FEISHU_TEST_CHAT_ID env var to run tests against real Feishu API.
 *
 * @throws Error if FEISHU_TEST_CHAT_ID is not set
 */
export function getTestChatId(): string {
  const chatId = process.env.FEISHU_TEST_CHAT_ID;
  if (!chatId) throw new Error('FEISHU_TEST_CHAT_ID env var required for real API tests');
  return chatId;
}
