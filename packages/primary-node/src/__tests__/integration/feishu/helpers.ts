/**
 * Shared helpers for Feishu integration tests.
 *
 * These tests are gated behind `FEISHU_INTEGRATION_TEST=true` and
 * require a running disclaude instance with valid Feishu credentials.
 * They are **skipped by default** and do not affect CI or regular `npm test`.
 *
 * Related: Issue #1626 — Optional Feishu integration tests (default skip).
 *
 * @module integration/feishu/helpers
 */

import { describe } from 'vitest';
import type { IChannel } from '@disclaude/core';

// ============================================================================
// Feature flag
// ============================================================================

/**
 * Whether Feishu integration tests are enabled.
 * Set via `FEISHU_INTEGRATION_TEST=true` environment variable.
 */
export const FEISHU_INTEGRATION = process.env.FEISHU_INTEGRATION_TEST === 'true';

// ============================================================================
// Conditional describe
// ============================================================================

/**
 * `describe` wrapper that only runs when `FEISHU_INTEGRATION_TEST=true`.
 * Falls back to `describe.skip` when integration tests are disabled.
 *
 * @example
 * ```typescript
 * import { describeIfFeishu } from './helpers.js';
 * describeIfFeishu('sendInteractive e2e', () => {
 *   it('should send a card and register action prompts', async () => {
 *     // ... test with real Feishu API
 *   });
 * });
 * ```
 */
// eslint-disable-next-line @typescript-eslint/no-require-imports
export const describeIfFeishu: typeof describe.skip = FEISHU_INTEGRATION
  ? describe
  : describe.skip;

// ============================================================================
// Environment variables
// ============================================================================

/**
 * Get the test chat ID from environment.
 * Throws if not set when integration tests are enabled.
 */
export function getTestChatId(): string {
  const chatId = process.env.FEISHU_TEST_CHAT_ID;
  if (!chatId) {
    throw new Error(
      'FEISHU_TEST_CHAT_ID environment variable is required when running Feishu integration tests.\n' +
      'Set it to a Feishu group/chat ID that the bot has access to.'
    );
  }
  return chatId;
}

/**
 * Get the IPC socket path from environment.
 * Defaults to the standard disclaude IPC socket path.
 */
export function getIpcSocketPath(): string {
  return process.env.DISCLAUDE_IPC_SOCKET || '/tmp/disclaude-ipc.sock';
}

// ============================================================================
// Timing helpers
// ============================================================================

/**
 * Wait for a specified number of milliseconds.
 *
 * @param ms - Milliseconds to wait
 */
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Retry an async operation with exponential backoff.
 *
 * @param fn - Async function to retry
 * @param options - Retry configuration
 * @returns The result of the first successful call
 */
export async function withRetry<T>(
  fn: () => Promise<T>,
  options: {
    maxAttempts?: number;
    baseDelay?: number;
    maxDelay?: number;
    label?: string;
  } = {}
): Promise<T> {
  const { maxAttempts = 3, baseDelay = 1000, maxDelay = 10000, label = 'operation' } = options;

  let lastError: Error | undefined;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));

      if (attempt < maxAttempts) {
        const delay = Math.min(baseDelay * 2 ** (attempt - 1), maxDelay);
        console.warn(
          `[feishu-integration] ${label} failed (attempt ${attempt}/${maxAttempts}), ` +
          `retrying in ${delay}ms: ${lastError.message}`
        );
        await sleep(delay);
      }
    }
  }

  throw new Error(
    `[feishu-integration] ${label} failed after ${maxAttempts} attempts: ${lastError?.message}`
  );
}

// ============================================================================
// Mock factories
// ============================================================================

/**
 * Create a mock IChannel for testing handler logic without real Feishu API.
 */
export function createMockChannel(overrides?: Partial<IChannel>): IChannel {
  const sentMessages: Array<{
    chatId: string;
    type: string;
    text?: string;
    card?: unknown;
    filePath?: string;
    threadId?: string;
  }> = [];

  return {
    id: 'mock-feishu-channel',
    name: 'Mock Feishu Channel',
    status: 'running',
    sendMessage: async (msg: Record<string, unknown>) => {
      sentMessages.push(msg as typeof sentMessages[number]);
    },
    onMessage: (() => {}) as any,
    onControl: (() => {}) as any,
    start: async () => {},
    stop: async () => {},
    getCapabilities: () => ({
      supportsCard: true,
      supportsThread: true,
      supportsFile: true,
      supportsMarkdown: true,
      supportsMention: true,
      supportsUpdate: false,
    }),
    ...overrides,
    // Attach sent messages array for test assertions
    _sentMessages: sentMessages,
  } as unknown as IChannel;
}

/**
 * Get messages sent to the mock channel.
 * Useful for assertions after test operations.
 */
export function getSentMessages(channel: IChannel): Array<Record<string, unknown>> {
  return (channel as any)._sentMessages || [];
}
