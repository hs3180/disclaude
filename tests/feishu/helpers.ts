/**
 * Shared test utilities for Feishu integration tests.
 *
 * These tests require a running Primary Node with Feishu handlers and are
 * skipped by default. Set FEISHU_INTEGRATION_TEST=true to enable.
 *
 * Environment variables:
 * - FEISHU_INTEGRATION_TEST: Set to 'true' to enable tests
 * - FEISHU_TEST_CHAT_ID: Target chat ID for test messages (required when enabled)
 * - DISCLAUDE_IPC_SOCKET_PATH: IPC socket path (defaults to /tmp/disclaude-interactive.ipc)
 *
 * @see Issue #1626 - Optional Feishu integration tests
 */

import { describe, it } from 'vitest';

// ============================================================================
// Feature flag
// ============================================================================

/**
 * Whether Feishu integration tests are enabled.
 */
export const FEISHU_INTEGRATION = process.env.FEISHU_INTEGRATION_TEST === 'true';

// ============================================================================
// Conditional test wrappers
// ============================================================================

/**
 * Conditional describe block - runs only when FEISHU_INTEGRATION_TEST=true.
 *
 * @example
 * ```typescript
 * describeIfFeishu('sendInteractive', () => {
 *   it('should send an interactive card', async () => { ... });
 * });
 * ```
 */
export const describeIfFeishu = FEISHU_INTEGRATION ? describe : describe.skip;

/**
 * Conditional it block - runs only when FEISHU_INTEGRATION_TEST=true.
 *
 * @example
 * ```typescript
 * describe('some test', () => {
 *   itIfFeishu('should connect to Feishu', async () => { ... });
 * });
 * ```
 */
export const itIfFeishu = FEISHU_INTEGRATION ? it : it.skip;

// ============================================================================
// Environment helpers
// ============================================================================

/**
 * Get the test chat ID from environment variables.
 *
 * @throws Error if FEISHU_TEST_CHAT_ID is not set (only when tests are enabled)
 */
export function getTestChatId(): string {
  const chatId = process.env.FEISHU_TEST_CHAT_ID;
  if (!chatId) {
    throw new Error(
      'FEISHU_TEST_CHAT_ID environment variable is required for Feishu integration tests. ' +
      'Set it to a valid Feishu group/chat ID where the bot has access.'
    );
  }
  return chatId;
}

/**
 * Get the IPC socket path from environment variables.
 */
export function getIpcSocketPath(): string {
  return (
    process.env.DISCLAUDE_WORKER_IPC_SOCKET ||
    process.env.DISCLAUDE_IPC_SOCKET_PATH ||
    '/tmp/disclaude-interactive.ipc'
  );
}

// ============================================================================
// Test data builders
// ============================================================================

/**
 * Create a test interactive card request payload.
 */
export function createTestInteractiveParams(overrides?: {
  question?: string;
  options?: Array<{ text: string; value: string; type?: 'primary' | 'default' | 'danger' }>;
  title?: string;
  context?: string;
  actionPrompts?: Record<string, string>;
}) {
  const timestamp = Date.now();
  return {
    question: `🧪 [Integration Test] Test question at ${timestamp}`,
    options: [
      { text: 'Option A', value: 'option_a', type: 'primary' as const },
      { text: 'Option B', value: 'option_b' },
      { text: 'Option C', value: 'option_c', type: 'danger' as const },
    ],
    title: '🧪 Integration Test Card',
    context: 'This card was sent by an automated integration test. Please ignore.',
    actionPrompts: {
      option_a: '[Integration Test] User selected Option A',
      option_b: '[Integration Test] User selected Option B',
      option_c: '[Integration Test] User selected Option C',
    },
    ...overrides,
  };
}

/**
 * Create a test text message.
 */
export function createTestMessage(overrides?: { text?: string }) {
  const timestamp = Date.now();
  return {
    text: `🧪 [Integration Test] Hello at ${timestamp}`,
    ...overrides,
  };
}
