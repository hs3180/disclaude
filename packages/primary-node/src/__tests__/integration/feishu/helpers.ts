/**
 * Shared helpers for optional Feishu integration tests.
 *
 * These tests are **skipped by default** and only run when:
 *   FEISHU_INTEGRATION_TEST=true
 *
 * They may also require Feishu credentials (FEISHU_TEST_CHAT_ID, etc.)
 * depending on the specific test scenario.
 *
 * @see Issue #1626 - Optional Feishu integration tests (default skip)
 * @module __tests__/integration/feishu/helpers
 */

/**
 * Whether Feishu integration tests are enabled.
 *
 * Controlled by the `FEISHU_INTEGRATION_TEST` environment variable.
 * When not set (or not 'true'), all Feishu integration tests are skipped.
 *
 * @example
 * ```bash
 * # Run Feishu integration tests
 * FEISHU_INTEGRATION_TEST=true npm run test:feishu
 *
 * # Run with a specific chat ID
 * FEISHU_INTEGRATION_TEST=true FEISHU_TEST_CHAT_ID=oc_xxx npm run test:feishu
 * ```
 */
export const FEISHU_INTEGRATION = process.env.FEISHU_INTEGRATION_TEST === 'true';

/**
 * Get the test chat ID from environment variables.
 *
 * @returns The test chat ID
 * @throws {Error} If `FEISHU_TEST_CHAT_ID` is not set
 */
export function requireTestChatId(): string {
  const chatId = process.env.FEISHU_TEST_CHAT_ID;
  if (!chatId) {
    throw new Error(
      'FEISHU_TEST_CHAT_ID env var is required for this test. ' +
        'Set it to a valid Feishu group chat ID to test against.'
    );
  }
  return chatId;
}

/**
 * Optional: Get the test chat ID, returning undefined if not set.
 *
 * Useful for tests that can run in a limited mode without a real chat ID.
 */
export function getTestChatId(): string | undefined {
  return process.env.FEISHU_TEST_CHAT_ID;
}

/**
 * Log a skip message explaining why tests were skipped.
 *
 * Call this at the top of a test file for visibility.
 */
export function logFeishuSkipReason(): void {
  if (!FEISHU_INTEGRATION) {
    // eslint-disable-next-line no-console
    console.log(
      '\n' +
        '  ⏭️  Feishu integration tests skipped.\n' +
        '      Set FEISHU_INTEGRATION_TEST=true to enable.\n' +
        '      Example: FEISHU_INTEGRATION_TEST=true npm run test:feishu\n'
    );
  }
}
