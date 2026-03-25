/**
 * Shared helpers for Feishu integration tests.
 *
 * These tests are **skipped by default** and only run when
 * `FEISHU_INTEGRATION_TEST=true` is set in the environment.
 *
 * @see Issue #1626 - Optional Feishu integration tests
 */

import { describe } from 'vitest';
import nock from 'nock';

/**
 * Whether Feishu integration tests are enabled.
 * Requires `FEISHU_INTEGRATION_TEST=true` environment variable.
 */
export const FEISHU_INTEGRATION = process.env.FEISHU_INTEGRATION_TEST === 'true';

/**
 * A `describe` that only runs when Feishu integration tests are enabled.
 * In normal `npm test` runs, all tests within this describe block are skipped.
 *
 * @example
 * ```typescript
 * import { describeIfFeishu } from './helpers.js';
 *
 * describeIfFeishu('sendInteractive end-to-end', () => {
 *   it('should send a card and register action prompts', async () => {
 *     // ...
 *   });
 * });
 * ```
 */
export const describeIfFeishu: typeof describe = FEISHU_INTEGRATION
  ? (describe as typeof describe)
  : (describe.skip as unknown as typeof describe);

/**
 * Get the test chat ID from environment variables.
 *
 * @throws {Error} If `FEISHU_TEST_CHAT_ID` is not set
 * @returns The chat ID to use for integration tests
 */
export function getTestChatId(): string {
  const chatId = process.env.FEISHU_TEST_CHAT_ID;
  if (!chatId) {
    throw new Error(
      'FEISHU_TEST_CHAT_ID environment variable is required for Feishu integration tests. ' +
        'Set it to a valid Feishu group chat ID.'
    );
  }
  return chatId;
}

/**
 * Wait for a specified duration (useful for polling async operations).
 *
 * @param ms - Milliseconds to wait
 */
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Default timeout for integration test operations (30 seconds).
 * Integration tests may need longer timeouts than unit tests
 * due to network latency and async Feishu API calls.
 */
export const INTEGRATION_TIMEOUT = 30_000;

/**
 * Feishu API hosts that need to be allowed for integration tests.
 */
const FEISHU_API_HOSTS = [
  'open.feishu.cn',
  'open.larksuite.com',
  'webhook.feishu.cn',
  'open.feastlark.com',
];

/**
 * Allow Feishu API hosts for network requests.
 *
 * This bypasses the nock network isolation set up in `tests/setup.ts`
 * so that integration tests can make real API calls.
 */
export function allowFeishuHosts(): void {
  for (const host of FEISHU_API_HOSTS) {
    nock.enableNetConnect(host);
  }
}

/**
 * Create a standardized beforeAll hook for Feishu integration tests.
 * Handles host allowlisting and chat ID validation.
 *
 * @returns The test chat ID
 */
export function setupFeishuIntegration(): string {
  const chatId = getTestChatId();
  allowFeishuHosts();
  return chatId;
}
