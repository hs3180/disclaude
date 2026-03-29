/**
 * Shared test helpers for Feishu integration tests.
 *
 * All tests using these helpers are skipped by default.
 * To run them, set:
 *   FEISHU_INTEGRATION_TEST=true
 *   FEISHU_TEST_CHAT_ID=<your_test_chat_id>
 *
 * @module feishu-integration-helpers
 * Related: #1626
 */

import { describe } from 'vitest';

/** Whether Feishu integration tests are enabled via environment variable */
export const FEISHU_INTEGRATION_ENABLED = process.env.FEISHU_INTEGRATION_TEST === 'true';

/**
 * Conditional describe that skips all tests when Feishu integration is disabled.
 *
 * Usage:
 *   describeIfFeishu('sendInteractive', () => { ... })
 */
export const describeIfFeishu = FEISHU_INTEGRATION_ENABLED
  ? describe
  : (...args: Parameters<typeof describe.skip>) => describe.skip(...args);

/**
 * Get the test chat ID from environment variables.
 *
 * @throws Error if FEISHU_TEST_CHAT_ID is not set (only when tests are enabled)
 * @returns The chat ID for integration testing
 */
export function getTestChatId(): string {
  const chatId = process.env.FEISHU_TEST_CHAT_ID;
  if (!chatId) {
    throw new Error(
      'FEISHU_TEST_CHAT_ID environment variable is required for Feishu integration tests. ' +
        'Set it to a valid Feishu group chat ID where the bot is a member.'
    );
  }
  return chatId;
}

/**
 * Log a skipped notice for Feishu integration tests.
 * Called once at the top level to inform developers why tests are skipped.
 */
export function logSkipNotice(): void {
  if (!FEISHU_INTEGRATION_ENABLED) {
    // eslint-disable-next-line no-console
    console.log(
      '\n⏭️  Feishu integration tests are skipped. ' +
        'To enable, set FEISHU_INTEGRATION_TEST=true and FEISHU_TEST_CHAT_ID=<chat_id>\n'
    );
  }
}

// Log skip notice on import
logSkipNotice();

/** Timeout for Feishu API calls (longer than unit tests) */
export const FEISHU_API_TIMEOUT = 30_000;

/** Timeout for IPC operations */
export const IPC_TIMEOUT = 10_000;
