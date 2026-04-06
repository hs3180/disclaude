/**
 * Feishu Integration Test Helpers.
 *
 * Provides conditional test execution utilities for Feishu integration tests.
 * Tests are skipped by default and only run when FEISHU_INTEGRATION_TEST=true.
 *
 * Issue #1626: Optional Feishu integration test framework.
 *
 * @module tests/integration/feishu/helpers
 */

import { describe, it } from 'vitest';

/**
 * Whether Feishu integration tests are enabled.
 *
 * Controlled by the FEISHU_INTEGRATION_TEST environment variable.
 * When not set or set to anything other than 'true', all integration
 * tests are skipped.
 */
export const FEISHU_INTEGRATION = process.env.FEISHU_INTEGRATION_TEST === 'true';

/**
 * Conditional describe that skips when Feishu integration is disabled.
 *
 * @example
 * ```typescript
 * import { describeIfFeishu } from './helpers.js';
 *
 * describeIfFeishu('IPC sendInteractive flow', () => {
 *   it('should send interactive card and register action prompts', async () => {
 *     // ... integration test logic
 *   });
 * });
 * ```
 */
export const describeIfFeishu = FEISHU_INTEGRATION ? describe : describe.skip;

/**
 * Conditional it that skips when Feishu integration is disabled.
 *
 * Use within a regular describe block when only individual tests need gating.
 */
export const itIfFeishu = FEISHU_INTEGRATION ? it : it.skip;

/**
 * Required environment variables for Feishu integration tests.
 */
const REQUIRED_ENV_VARS = [
  'FEISHU_APP_ID',
  'FEISHU_APP_SECRET',
  'FEISHU_TEST_CHAT_ID',
] as const;

/**
 * Get Feishu credentials from environment variables.
 *
 * @returns Object with appId and appSecret
 * @throws Error if credentials are not configured
 */
export function getFeishuCredentials(): { appId: string; appSecret: string } {
  const appId = process.env.FEISHU_APP_ID;
  const appSecret = process.env.FEISHU_APP_SECRET;

  if (!appId || !appSecret) {
    throw new Error(
      'Feishu credentials not configured. ' +
        'Set FEISHU_APP_ID and FEISHU_APP_SECRET environment variables.'
    );
  }

  return { appId, appSecret };
}

/**
 * Get the test chat ID from environment variables.
 *
 * @returns The chat ID for sending test messages
 * @throws Error if chat ID is not configured
 */
export function getTestChatId(): string {
  const chatId = process.env.FEISHU_TEST_CHAT_ID;
  if (!chatId) {
    throw new Error(
      'Feishu test chat ID not configured. ' +
        'Set FEISHU_TEST_CHAT_ID environment variable.'
    );
  }
  return chatId;
}

/**
 * Check if all required environment variables are set.
 *
 * @returns true if all required variables are present
 */
export function hasRequiredEnvVars(): boolean {
  return REQUIRED_ENV_VARS.every((key) => !!process.env[key]);
}

/**
 * Get missing environment variable names.
 *
 * @returns Array of missing variable names
 */
export function getMissingEnvVars(): string[] {
  return REQUIRED_ENV_VARS.filter((key) => !process.env[key]);
}

/**
 * Generate a unique test marker to identify test messages.
 *
 * Uses a combination of timestamp and random suffix to ensure uniqueness
 * across test runs, making it easy to identify and clean up test messages.
 *
 * @param prefix - Optional prefix for the marker (default: 'test')
 * @returns A unique marker string like 'test-20260406-abc123'
 */
export function generateTestMarker(prefix = 'test'): string {
  const timestamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
  const random = Math.random().toString(36).slice(2, 8);
  return `${prefix}-${timestamp}-${random}`;
}

/**
 * Sleep for a specified duration.
 *
 * Useful for waiting between send and receive operations in integration tests.
 *
 * @param ms - Milliseconds to sleep
 */
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
