/**
 * Shared helpers for Feishu integration tests.
 *
 * These tests require real Feishu API credentials and are skipped by default.
 * Enable with: FEISHU_INTEGRATION_TEST=true FEISHU_TEST_APP_ID=xxx FEISHU_TEST_APP_SECRET=xxx FEISHU_TEST_CHAT_ID=oc_xxx npm run test:feishu
 *
 * @module integration/feishu/helpers
 * @see Issue #1626 - Optional Feishu integration tests
 */

import { describe } from 'vitest';
import * as lark from '@larksuiteoapi/node-sdk';
import { createFeishuClient } from '@disclaude/primary-node';

// =============================================================================
// Environment Gate
// =============================================================================

/**
 * Whether Feishu integration tests are enabled.
 */
export const FEISHU_INTEGRATION_ENABLED = process.env.FEISHU_INTEGRATION_TEST === 'true';

/**
 * Conditional describe: runs tests only when FEISHU_INTEGRATION_TEST=true.
 *
 * @example
 * ```typescript
 * import { describeIfFeishu } from './helpers.js';
 *
 * describeIfFeishu('Send text message', () => {
 *   it('should send a text message to Feishu chat', async () => {
 *     // ... real API call
 *   });
 * });
 * ```
 */
export const describeIfFeishu = FEISHU_INTEGRATION_ENABLED ? describe : describe.skip;

// =============================================================================
// Environment Variable Helpers
// =============================================================================

/**
 * Get the Feishu App ID from environment variables.
 * @throws Error if FEISHU_TEST_APP_ID is not set
 */
export function getAppId(): string {
  const appId = process.env.FEISHU_TEST_APP_ID;
  if (!appId) {
    throw new Error(
      'FEISHU_TEST_APP_ID environment variable is required for Feishu integration tests. ' +
      'Set it to your Feishu App ID.'
    );
  }
  return appId;
}

/**
 * Get the Feishu App Secret from environment variables.
 * @throws Error if FEISHU_TEST_APP_SECRET is not set
 */
export function getAppSecret(): string {
  const appSecret = process.env.FEISHU_TEST_APP_SECRET;
  if (!appSecret) {
    throw new Error(
      'FEISHU_TEST_APP_SECRET environment variable is required for Feishu integration tests. ' +
      'Set it to your Feishu App Secret.'
    );
  }
  return appSecret;
}

/**
 * Get the test chat ID from environment variables.
 * @throws Error if FEISHU_TEST_CHAT_ID is not set
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

// =============================================================================
// Client Factory
// =============================================================================

/** Cached Feishu client instance */
let cachedClient: lark.Client | null = null;

/**
 * Create or return a cached Feishu client for integration tests.
 *
 * Uses FEISHU_TEST_APP_ID and FEISHU_TEST_APP_SECRET environment variables.
 *
 * @returns Configured Lark Client instance
 */
export function createTestClient(): lark.Client {
  if (cachedClient) {
    return cachedClient;
  }

  cachedClient = createFeishuClient(getAppId(), getAppSecret());
  return cachedClient;
}

/**
 * Reset the cached client (useful for testing with different credentials).
 */
export function resetTestClient(): void {
  cachedClient = null;
}

// =============================================================================
// Test Utilities
// =============================================================================

/**
 * Generate a unique test marker to identify messages sent during a test run.
 * Format: [test-{timestamp}-{random}]
 */
export function generateTestMarker(): string {
  const timestamp = Date.now().toString(36);
  const random = Math.random().toString(36).slice(2, 6);
  return `[test-${timestamp}-${random}]`;
}

/**
 * Delay for a specified number of milliseconds.
 * Useful for waiting for Feishu API propagation.
 */
export function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Default timeout for Feishu API calls in integration tests (30 seconds).
 */
export const FEISHU_TEST_TIMEOUT = 30_000;
