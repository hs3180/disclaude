/**
 * Shared helpers for optional Feishu integration tests.
 *
 * These tests are **skipped by default** and only run when:
 * - `FEISHU_INTEGRATION_TEST=true` is set
 * - `DISCLAUDE_IPC_SOCKET_PATH` points to a running Primary Node IPC socket
 * - `FEISHU_TEST_CHAT_ID` contains a valid Feishu chat ID for sending test messages
 *
 * Usage:
 *   FEISHU_INTEGRATION_TEST=true \
 *   DISCLAUDE_IPC_SOCKET_PATH=/tmp/disclaude-interactive.ipc \
 *   FEISHU_TEST_CHAT_ID=oc_xxxxxxxx \
 *   npm run test:feishu
 *
 * @see Issue #1626 - Optional Feishu integration tests (default skip)
 */

import { describe } from 'vitest';
import { UnixSocketIpcClient } from '@disclaude/core';
import { existsSync } from 'fs';

// =============================================================================
// Environment Gates
// =============================================================================

/** Whether Feishu integration tests are enabled */
export const FEISHU_INTEGRATION_ENABLED = process.env.FEISHU_INTEGRATION_TEST === 'true';

/**
 * `describe` when Feishu integration is enabled, otherwise `describe.skip`.
 *
 * Use this as a drop-in replacement for `describe` in Feishu integration test files:
 * ```ts
 * const describeIfFeishu = ...;
 * describeIfFeishu('sendInteractive E2E', () => { ... });
 * ```
 */
export const describeIfFeishu = FEISHU_INTEGRATION_ENABLED
  ? describe
  : (...args: Parameters<typeof describe>) => describe.skip(...args);

// =============================================================================
// Environment Variable Helpers
// =============================================================================

/**
 * Get the IPC socket path for connecting to the Primary Node.
 *
 * Priority:
 * 1. `DISCLAUDE_IPC_SOCKET_PATH` env var (explicit override)
 * 2. `DISCLAUDE_WORKER_IPC_SOCKET` env var (set by Worker Node)
 * 3. `/tmp/disclaude-interactive.ipc` (default)
 */
export function getIpcSocketPath(): string {
  return (
    process.env.DISCLAUDE_IPC_SOCKET_PATH ||
    process.env.DISCLAUDE_WORKER_IPC_SOCKET ||
    '/tmp/disclaude-interactive.ipc'
  );
}

/**
 * Get the test chat ID for sending test messages.
 *
 * @throws {Error} If `FEISHU_TEST_CHAT_ID` is not set
 */
export function getTestChatId(): string {
  const chatId = process.env.FEISHU_TEST_CHAT_ID;
  if (!chatId) {
    throw new Error(
      'FEISHU_TEST_CHAT_ID env var is required. ' +
        'Set it to a valid Feishu chat ID (e.g., oc_xxxxxxxx).'
    );
  }
  return chatId;
}

/**
 * Validate that the IPC socket exists and is accessible.
 *
 * @returns `true` if the socket file exists, `false` otherwise
 */
export function isIpcSocketAvailable(): boolean {
  const socketPath = getIpcSocketPath();
  return existsSync(socketPath);
}

// =============================================================================
// IPC Client Factory
// =============================================================================

/** Shared IPC client instance for the test session */
let clientInstance: UnixSocketIpcClient | null = null;

/**
 * Create or return a shared IPC client connected to the Primary Node.
 *
 * The client is configured with a longer timeout for integration tests.
 * Call {@link disconnectIpcClient} in `afterAll` to clean up.
 */
export function getIpcClient(): UnixSocketIpcClient {
  if (!clientInstance) {
    const socketPath = getIpcSocketPath();
    clientInstance = new UnixSocketIpcClient({
      socketPath,
      timeout: 15_000, // 15s timeout for integration tests
      maxRetries: 1,
    });
  }
  return clientInstance;
}

/**
 * Disconnect and reset the shared IPC client.
 *
 * Call this in `afterAll` to clean up the connection.
 */
export async function disconnectIpcClient(): Promise<void> {
  if (clientInstance) {
    try {
      await clientInstance.disconnect();
    } catch {
      // Ignore disconnect errors in cleanup
    }
    clientInstance = null;
  }
}

// =============================================================================
// Test Fixture Helpers
// =============================================================================

/** Generate a unique test marker to identify test messages in chat */
export function generateTestMarker(): string {
  const timestamp = Date.now();
  const random = Math.random().toString(36).slice(2, 8);
  return `[integration-test-${timestamp}-${random}]`;
}

/**
 * Create test options for sendInteractive with unique values.
 *
 * Each call generates unique option values to avoid collisions
 * with previous test runs or concurrent tests.
 */
export function createTestOptions(marker: string) {
  return [
    {
      text: `${marker} Option A`,
      value: `${marker}_option_a`,
      type: 'primary' as const,
    },
    {
      text: `${marker} Option B`,
      value: `${marker}_option_b`,
      type: 'default' as const,
    },
    {
      text: `${marker} Option C`,
      value: `${marker}_option_c`,
      type: 'danger' as const,
    },
  ];
}

/**
 * Create test action prompts matching the test options.
 *
 * The prompts follow the `[用户操作] 用户选择了「...」` pattern
 * used by the production codebase.
 */
export function createTestActionPrompts(marker: string) {
  return {
    [`${marker}_option_a`]: `[用户操作] 用户选择了「${marker} Option A」`,
    [`${marker}_option_b`]: `[用户操作] 用户选择了「${marker} Option B」`,
    [`${marker}_option_c`]: `[用户操作] 用户选择了「${marker} Option C」`,
  };
}
