/**
 * Shared helpers for Feishu integration tests.
 *
 * These tests require real Feishu API credentials and a running Primary Node.
 * They are skipped by default and only run when:
 *
 *   FEISHU_INTEGRATION_TEST=true npm run test:feishu
 *
 * @module tests/integration/feishu/helpers
 */

import { describe } from 'vitest';

// =============================================================================
// Environment Gate
// =============================================================================

/**
 * Whether Feishu integration tests are enabled.
 * Controlled by the FEISHU_INTEGRATION_TEST environment variable.
 */
export const FEISHU_INTEGRATION_ENABLED = process.env.FEISHU_INTEGRATION_TEST === 'true';

/**
 * Conditional describe: runs tests when FEISHU_INTEGRATION_TEST=true, skips otherwise.
 *
 * @example
 * ```typescript
 * import { describeIfFeishu, getTestChatId } from './helpers.js';
 *
 * describeIfFeishu('sendInteractive E2E', () => {
 *   it('should send a card and register action prompts', async () => {
 *     const chatId = getTestChatId();
 *     // ... real API test
 *   });
 * });
 * ```
 */
export const describeIfFeishu = FEISHU_INTEGRATION_ENABLED
  ? describe
  : (...args: Parameters<typeof describe.skip>) => describe.skip(...args);

// =============================================================================
// Environment Variable Helpers
// =============================================================================

/**
 * Get the test chat ID from environment variables.
 *
 * @throws Error if FEISHU_TEST_CHAT_ID is not set
 * @returns The Feishu chat ID to use for testing
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
 * Get the IPC socket path for testing.
 *
 * Falls back to the default IPC socket path if not explicitly set.
 *
 * @returns The IPC socket path
 */
export function getTestSocketPath(): string {
  return process.env.FEISHU_TEST_SOCKET_PATH || '/tmp/disclaude-interactive.ipc';
}

// =============================================================================
// Assertion Helpers
// =============================================================================

/**
 * Assert that an IPC response is successful.
 *
 * @param response - The IPC response to check
 * @throws AssertionError with the error message from the response
 */
export function assertIpcSuccess<T extends { success: boolean; error?: string }>(
  response: T
): asserts response is T & { success: true } {
  if (!response.success) {
    throw new Error(`IPC call failed: ${response.error ?? 'unknown error'}`);
  }
}

/**
 * Retry an async operation with exponential backoff.
 *
 * Useful for waiting for async side effects (e.g., message delivery).
 *
 * @param fn - The async function to retry
 * @param options - Retry options
 * @returns The result of the function
 */
export async function withRetry<T>(
  fn: () => Promise<T>,
  options: {
    maxRetries?: number;
    baseDelay?: number;
    maxDelay?: number;
  } = {}
): Promise<T> {
  const { maxRetries = 3, baseDelay = 1000, maxDelay = 10000 } = options;

  let lastError: Error | undefined;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
      if (attempt < maxRetries) {
        const delay = Math.min(baseDelay * Math.pow(2, attempt), maxDelay);
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
    }
  }

  throw lastError;
}
