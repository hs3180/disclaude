/**
 * Shared helpers for Feishu integration tests.
 *
 * These tests are optional and skipped by default.
 * Set FEISHU_INTEGRATION_TEST=true to enable Tier 1 tests.
 * Set additional env vars for Tier 2 tests (real Feishu API calls).
 *
 * Two tiers:
 * - Tier 1 (FEISHU_INTEGRATION_TEST=true): IPC flow, InteractiveContextStore tests
 * - Tier 2 (+ FEISHU_APP_ID/SECRET/CHAT_ID): Real Feishu API tests
 *
 * @module __tests__/integration/feishu/helpers
 * @see Issue #1626 - Optional Feishu integration tests
 */

import { describe } from 'vitest';
import nock from 'nock';

/**
 * Whether Feishu integration tests are enabled.
 * Set FEISHU_INTEGRATION_TEST=true to enable.
 */
export const FEISHU_INTEGRATION = process.env.FEISHU_INTEGRATION_TEST === 'true';

/**
 * Whether Feishu API credentials are available for Tier 2 tests.
 */
export const FEISHU_CREDENTIALS_AVAILABLE = !!(
  process.env.FEISHU_APP_ID &&
  process.env.FEISHU_APP_SECRET &&
  process.env.FEISHU_TEST_CHAT_ID
);

/**
 * Conditional describe that skips when FEISHU_INTEGRATION_TEST is not set.
 * Use this for Tier 1 tests that don't require Feishu API credentials.
 */
export const describeIfFeishu = FEISHU_INTEGRATION ? describe : describe.skip;

/**
 * Conditional describe for Tier 2 tests that require Feishu credentials.
 */
export const describeIfFeishuWithCredentials =
  FEISHU_INTEGRATION && FEISHU_CREDENTIALS_AVAILABLE
    ? describe
    : describe.skip;

/**
 * Get the test chat ID from environment.
 * @throws Error if FEISHU_TEST_CHAT_ID is not set
 */
export function getTestChatId(): string {
  const chatId = process.env.FEISHU_TEST_CHAT_ID;
  if (!chatId) {
    throw new Error('FEISHU_TEST_CHAT_ID env var is required for this test');
  }
  return chatId;
}

/**
 * Get Feishu credentials from environment.
 * @throws Error if credentials are not set
 */
export function getFeishuCredentials(): { appId: string; appSecret: string } {
  const appId = process.env.FEISHU_APP_ID;
  const appSecret = process.env.FEISHU_APP_SECRET;
  if (!appId || !appSecret) {
    throw new Error('FEISHU_APP_ID and FEISHU_APP_SECRET env vars are required');
  }
  return { appId, appSecret };
}

/**
 * Enable network access to Feishu API domains.
 * Required for Tier 2 tests that make real API calls.
 *
 * This is needed because tests/setup.ts blocks all external network by default.
 * For integration tests that need real Feishu API access, call this in beforeAll.
 */
export function allowFeishuNetwork(): void {
  const domains = [
    'open.feishu.cn',
    'open.larksuite.com',
    'internal-api.feishu.cn',
    'webhook.feishu.cn',
    'feishu.cn',
    'larksuite.com',
  ];
  for (const domain of domains) {
    nock.enableNetConnect(domain);
  }
}

/**
 * Generate a unique test marker to avoid test collisions.
 */
export function generateTestMarker(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}
