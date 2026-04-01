/**
 * Feishu Integration Test Helpers.
 *
 * Provides conditional execution utilities for Feishu integration tests.
 * Tests are skipped by default and only run when `FEISHU_INTEGRATION_TEST=true`.
 *
 * @module integration/feishu/helpers
 * @see Issue #1626 - Optional Feishu integration tests
 */

import { describe } from 'vitest';
import nock from 'nock';

/**
 * Whether Feishu integration tests are enabled.
 *
 * Set via environment variable: `FEISHU_INTEGRATION_TEST=true`
 */
export const FEISHU_INTEGRATION = process.env.FEISHU_INTEGRATION_TEST === 'true';

/**
 * Conditional describe block that skips when Feishu integration is disabled.
 *
 * Uses a function wrapper to avoid TypeScript type inference issues with
 * exported conditional values.
 *
 * @param name - Test suite name
 * @param fn - Test suite function
 *
 * @example
 * ```typescript
 * import { describeIfFeishu } from './helpers.js';
 *
 * describeIfFeishu('IPC sendInteractive', () => {
 *   it('should send a card and receive messageId', async () => {
 *     // ... test code
 *   });
 * });
 * ```
 */
export function describeIfFeishu(
  name: string,
  fn: () => void
): void {
  if (FEISHU_INTEGRATION) {
    describe(name, fn);
  } else {
    describe.skip(name, fn);
  }
}

/**
 * Get the test chat ID from environment variable.
 *
 * @throws {Error} If `FEISHU_TEST_CHAT_ID` is not set
 * @returns The Feishu chat ID for testing
 */
export function getTestChatId(): string {
  const chatId = process.env.FEISHU_TEST_CHAT_ID;
  if (!chatId) {
    throw new Error(
      'FEISHU_TEST_CHAT_ID environment variable is required. ' +
        'Set it to a valid Feishu group chat ID for testing.'
    );
  }
  return chatId;
}

/**
 * Get the IPC socket path for connecting to the Primary Node.
 *
 * Falls back to the default path if not specified.
 *
 * @returns The IPC socket path
 */
export function getIpcSocketPath(): string {
  return process.env.DISCLADE_IPC_SOCKET || '/tmp/disclaude-interactive.ipc';
}

/**
 * Feishu API hosts that need to be allowed for integration tests.
 */
export const FEISHU_API_HOSTS = [
  'open.feishu.cn',
  'open.larksuite.com',
  'www.feishu.cn',
  'internal-api.feishu.cn',
];

/**
 * Allow Feishu API hosts for network requests.
 *
 * Uses nock.enableNetConnect() directly to bypass the network isolation
 * set up in tests/setup.ts. Call this in `beforeAll` to enable real
 * Feishu API calls during integration tests.
 *
 * @example
 * ```typescript
 * import { enableFeishuNetwork } from './helpers.js';
 *
 * beforeAll(() => {
 *   enableFeishuNetwork();
 * });
 * ```
 */
export function enableFeishuNetwork(): void {
  for (const host of FEISHU_API_HOSTS) {
    nock.enableNetConnect(host);
  }
}

/**
 * Configuration for integration test timeouts.
 * Feishu API calls may be slow, so we use longer timeouts.
 */
export const INTEGRATION_TEST_TIMEOUT = 30_000; // 30 seconds

/**
 * Create a standard action prompts map for testing.
 *
 * @param prefix - Optional prefix for prompt templates
 * @returns Action prompts map with standard entries
 */
export function createTestActionPrompts(
  prefix = ''
): Record<string, string> {
  const p = prefix ? `[${prefix}] ` : '';
  return {
    confirm: `${p}[用户操作] 用户选择了「{{actionText}}」`,
    cancel: `${p}[用户操作] 用户选择了「{{actionText}}」`,
    more_info: `${p}[用户操作] 用户选择了「{{actionText}}」`,
  };
}
