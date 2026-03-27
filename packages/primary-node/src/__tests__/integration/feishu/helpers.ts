/**
 * Shared test helpers for Feishu integration tests.
 *
 * These tests are **opt-in** and **skipped by default** to avoid requiring
 * Feishu API credentials in CI or normal development workflows.
 *
 * ## How to run
 *
 * ```bash
 * # Set required environment variables, then:
 * FEISHU_INTEGRATION_TEST=true \
 *   FEISHU_APP_ID=cli_xxx \
 *   FEISHU_APP_SECRET=xxx \
 *   FEISHU_TEST_CHAT_ID=oc_xxx \
 *   npm run test:feishu
 * ```
 *
 * ## How it works
 *
 * When `FEISHU_INTEGRATION_TEST` is not set (the default), all tests in this
 * directory use `describe.skip` via `describeIfFeishu`, so they appear as
 * skipped in test output but never execute.
 *
 * @see Issue #1626 - Optional Feishu integration tests
 */

import { describe } from 'vitest';
import nock from 'nock';

// ---------------------------------------------------------------------------
// Environment gating
// ---------------------------------------------------------------------------

/**
 * Whether Feishu integration tests should run.
 *
 * Controlled by `FEISHU_INTEGRATION_TEST=true` environment variable.
 */
export const FEISHU_INTEGRATION = process.env.FEISHU_INTEGRATION_TEST === 'true';

/**
 * Conditional `describe` that skips all Feishu tests when credentials are
 * not available.
 *
 * @example
 * ```typescript
 * describeIfFeishu('sendInteractive', () => {
 *   it('should send a card via real Feishu API', async () => { ... });
 * });
 * ```
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const describeIfFeishu: any = FEISHU_INTEGRATION
  ? describe
  : describe.skip;

// ---------------------------------------------------------------------------
// Credential helpers
// ---------------------------------------------------------------------------

/**
 * Get the Feishu App ID from environment.
 *
 * @throws Error if `FEISHU_APP_ID` is not set (only when integration is enabled)
 */
export function getFeishuAppId(): string {
  const appId = process.env.FEISHU_APP_ID;
  if (!appId) {
    throw new Error(
      'FEISHU_APP_ID environment variable is required for Feishu integration tests. ' +
        'Set it to your Feishu App ID (e.g., cli_xxxxxxxx).'
    );
  }
  return appId;
}

/**
 * Get the Feishu App Secret from environment.
 *
 * @throws Error if `FEISHU_APP_SECRET` is not set (only when integration is enabled)
 */
export function getFeishuAppSecret(): string {
  const appSecret = process.env.FEISHU_APP_SECRET;
  if (!appSecret) {
    throw new Error(
      'FEISHU_APP_SECRET environment variable is required for Feishu integration tests. ' +
        'Set it to your Feishu App Secret.'
    );
  }
  return appSecret;
}

/**
 * Get the test chat ID from environment.
 *
 * This is the Feishu group chat where test messages will be sent.
 *
 * @throws Error if `FEISHU_TEST_CHAT_ID` is not set (only when integration is enabled)
 */
export function getTestChatId(): string {
  const chatId = process.env.FEISHU_TEST_CHAT_ID;
  if (!chatId) {
    throw new Error(
      'FEISHU_TEST_CHAT_ID environment variable is required for Feishu integration tests. ' +
        'Set it to a Feishu group chat ID (e.g., oc_xxxxxxxx) where test messages can be sent.'
    );
  }
  return chatId;
}

// ---------------------------------------------------------------------------
// Network access helpers
// ---------------------------------------------------------------------------

/**
 * Feishu API hosts that need to be whitelisted for integration tests.
 *
 * The default `tests/setup.ts` blocks all external network via nock.
 * Integration tests must explicitly allow Feishu API hosts.
 */
const FEISHU_HOSTS = [
  'open.feishu.cn',
  'open.larksuite.com',
  'open.lark.com',
];

/**
 * Allow Feishu API network access for integration tests.
 *
 * Must be called in `beforeAll` to bypass the nock network isolation
 * established by `tests/setup.ts`.
 *
 * @example
 * ```typescript
 * import { allowFeishuNetwork, blockFeishuNetwork } from './helpers.js';
 *
 * beforeAll(() => { allowFeishuNetwork(); });
 * afterAll(() => { blockFeishuNetwork(); });
 * ```
 */
export function allowFeishuNetwork(): void {
  for (const host of FEISHU_HOSTS) {
    nock.enableNetConnect(host);
  }
}

/**
 * Re-block Feishu API network access after integration tests.
 *
 * This is a no-op because `nock.disableNetConnect()` does not accept host
 * arguments. Network isolation is restored by `nock.restore()` in
 * `tests/setup.ts` afterAll hook.
 *
 * Kept as a semantic placeholder for test cleanup symmetry.
 */
export function blockFeishuNetwork(): void {
  // nock.disableNetConnect() blocks ALL connections (no host arg supported).
  // Network isolation is restored globally by tests/setup.ts afterAll.
  // This function is a no-op kept for API symmetry.
}

// ---------------------------------------------------------------------------
// Test data generators
// ---------------------------------------------------------------------------

/**
 * Generate a unique test marker to identify test messages in the chat.
 *
 * Each call produces a unique prefix so test messages are distinguishable.
 */
export function generateTestMarker(): string {
  return `[integration-test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}]`;
}

/**
 * Generate a test message text with a unique marker.
 */
export function generateTestMessage(marker?: string): string {
  const m = marker ?? generateTestMarker();
  return `${m} Feishu integration test message — safe to ignore`;
}
