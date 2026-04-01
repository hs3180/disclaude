/**
 * Shared test helpers for optional Feishu integration tests.
 *
 * These tests are **skipped by default** and only run when the
 * `FEISHU_INTEGRATION_TEST` environment variable is set to `'true'`.
 *
 * @example
 * ```bash
 * # Skip all (default behavior)
 * npm run test:feishu
 *
 * # Actually run the tests
 * FEISHU_INTEGRATION_TEST=true FEISHU_TEST_CHAT_ID=oc_xxx npm run test:feishu
 * ```
 *
 * @see Issue #1626 - Optional Feishu integration test framework
 */

import { describe, it } from 'vitest';

// ---------------------------------------------------------------------------
// Feature flag
// ---------------------------------------------------------------------------

/**
 * Whether Feishu integration tests should actually execute.
 *
 * When `false`, all test blocks resolve to `.skip` and appear as
 * "skipped" in the Vitest output — zero network calls, zero side effects.
 */
export const FEISHU_INTEGRATION = process.env.FEISHU_INTEGRATION_TEST === 'true';

// ---------------------------------------------------------------------------
// Conditional wrappers
// ---------------------------------------------------------------------------

/**
 * `describe` that skips when `FEISHU_INTEGRATION_TEST` is not set.
 *
 * Uses explicit function declarations to avoid TS4023 with vitest's
 * overloaded `describe` / `describe.skip` types.
 *
 * Usage is identical to the normal `describe`:
 * ```ts
 * describeIfFeishu('sendInteractive E2E', () => { ... });
 * ```
 */
export function describeIfFeishu(
  name: string,
  fn: () => void
  // Return type uses `unknown` to avoid TS4023 with vitest's SuiteCollector type
  // while keeping the eslint no-explicit-any rule happy.
): unknown {
  return FEISHU_INTEGRATION ? describe(name, fn) : describe.skip(name, fn);
}

/**
 * `it` that skips when `FEISHU_INTEGRATION_TEST` is not set.
 *
 * Useful for top-level `it` tests or mixing enabled/disabled cases
 * within a regular `describe` block.
 */
export function itIfFeishu(
  name: string,
  fn: () => Promise<unknown> | void,
  timeout?: number
): void {
  return FEISHU_INTEGRATION
    ? it(name, fn, timeout)
    : it.skip(name, fn, timeout);
}

// ---------------------------------------------------------------------------
// Environment variable accessors
// ---------------------------------------------------------------------------

/**
 * Return the Feishu chat ID to target in integration tests.
 *
 * Must be provided via the `FEISHU_TEST_CHAT_ID` environment variable.
 * Throws a clear error when the variable is missing so that test output
 * is easy to diagnose.
 */
export function getTestChatId(): string {
  const chatId = process.env.FEISHU_TEST_CHAT_ID;
  if (!chatId) {
    throw new Error(
      'FEISHU_TEST_CHAT_ID environment variable is required for Feishu integration tests. ' +
        'Set it to the ID of the test group chat (e.g. oc_xxxxxxxxxxxxxxxx).'
    );
  }
  return chatId;
}

/**
 * Return the Feishu App ID for integration tests.
 *
 * Optional — only needed for tests that directly call Feishu Open API
 * (as opposed to going through the IPC layer).
 */
export function getTestAppId(): string | undefined {
  return process.env.FEISHU_TEST_APP_ID;
}

/**
 * Return the Feishu App Secret for integration tests.
 *
 * Optional — only needed for tests that directly call Feishu Open API.
 */
export function getTestAppSecret(): string | undefined {
  return process.env.FEISHU_TEST_APP_SECRET;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Default timeout for Feishu API calls in integration tests (30 s). */
export const FEISHU_API_TIMEOUT = 30_000;

/** Default timeout for IPC round-trips in integration tests (15 s). */
export const IPC_TIMEOUT = 15_000;
