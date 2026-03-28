/**
 * Shared helpers for Feishu integration tests.
 *
 * Provides conditional test execution based on environment variables,
 * ensuring tests are skipped by default (no Feishu API credentials required).
 *
 * Usage:
 *   FEISHU_INTEGRATION_TEST=true \
 *   FEISHU_TEST_CHAT_ID=oc_xxx \
 *   DISCLAUDE_IPC_SOCKET_PATH=/tmp/xxx.sock \
 *   npm run test:feishu
 *
 * @module __tests__/integration/feishu/helpers
 */

import { describe } from 'vitest';

// =============================================================================
// Environment Variable Controls
// =============================================================================

/**
 * Whether Feishu integration tests are enabled.
 *
 * Set `FEISHU_INTEGRATION_TEST=true` to enable.
 * When disabled, all Feishu integration tests are skipped via `describe.skip`.
 */
export const FEISHU_INTEGRATION = process.env.FEISHU_INTEGRATION_TEST === 'true';

/**
 * Conditional describe that skips all tests when Feishu integration is disabled.
 *
 * @example
 * ```typescript
 * describeIfFeishu('sendInteractive E2E', () => {
 *   it('should send an interactive card', async () => { ... });
 * });
 * ```
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const describeIfFeishu: any = FEISHU_INTEGRATION
  ? describe
  : describe.skip;

// =============================================================================
// Environment Variable Helpers
// =============================================================================

/**
 * Get the Feishu test chat ID from environment variables.
 *
 * Requires `FEISHU_TEST_CHAT_ID` to be set.
 *
 * @returns The chat ID for sending test messages
 * @throws Error if the environment variable is not set
 */
export function getTestChatId(): string {
  const chatId = process.env.FEISHU_TEST_CHAT_ID;
  if (!chatId) {
    throw new Error(
      'FEISHU_TEST_CHAT_ID environment variable is required for Feishu integration tests. ' +
        'Set it to a valid Feishu group chat ID (e.g., oc_xxxxxxxxxxxxxxxx).'
    );
  }
  return chatId;
}

/**
 * Get the IPC socket path for connecting to the running Primary Node.
 *
 * Requires `DISCLAUDE_IPC_SOCKET_PATH` to be set to the Unix socket path
 * of the running Primary Node instance.
 *
 * @returns The Unix socket path
 * @throws Error if the environment variable is not set
 */
export function getIpcSocketPath(): string {
  const socketPath = process.env.DISCLAUDE_IPC_SOCKET_PATH;
  if (!socketPath) {
    throw new Error(
      'DISCLAUDE_IPC_SOCKET_PATH environment variable is required. ' +
        'Set it to the IPC socket path of the running Primary Node.'
    );
  }
  return socketPath;
}

/**
 * Get the Feishu App ID from environment variables (optional, for diagnostics).
 *
 * @returns The Feishu App ID, or undefined if not set
 */
export function getFeishuAppId(): string | undefined {
  return process.env.FEISHU_APP_ID;
}

/**
 * Get the Feishu App Secret from environment variables (optional, for diagnostics).
 *
 * @returns The Feishu App Secret, or undefined if not set
 */
export function getFeishuAppSecret(): string | undefined {
  return process.env.FEISHU_APP_SECRET;
}

// =============================================================================
// Test Data Helpers
// =============================================================================

/**
 * Generate a unique test identifier to avoid collisions between test runs.
 *
 * @returns A unique string combining timestamp and random suffix
 */
export function generateTestId(): string {
  return `test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * Standard test action prompts for interactive card tests.
 */
export const TEST_ACTION_PROMPTS = {
  confirm: '[用户操作] 用户确认了操作',
  cancel: '[用户操作] 用户取消了操作',
  retry: '[用户操作] 用户选择了重试',
} as const;

/**
 * Standard test options for interactive card tests.
 */
export const TEST_OPTIONS = [
  { text: '✅ 确认', value: 'confirm', type: 'primary' as const },
  { text: '❌ 取消', value: 'cancel', type: 'danger' as const },
  { text: '🔄 重试', value: 'retry', type: 'default' as const },
] as const;

/**
 * Delay helper for waiting between operations.
 *
 * @param ms - Milliseconds to wait
 */
export function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
