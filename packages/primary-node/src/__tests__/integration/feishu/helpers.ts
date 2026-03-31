/**
 * Shared helpers for Feishu integration tests.
 *
 * All tests in this directory are gated by the FEISHU_INTEGRATION_TEST
 * environment variable. When not set, tests are automatically skipped.
 *
 * Usage:
 *   FEISHU_INTEGRATION_TEST=true npm run test:feishu
 *
 * @see Issue #1626 — Optional Feishu integration tests (skip by default)
 * @module __tests__/integration/feishu/helpers
 */

import { describe } from 'vitest';

// ---------------------------------------------------------------------------
// Environment gating
// ---------------------------------------------------------------------------

/**
 * Whether Feishu integration tests are enabled.
 *
 * Set FEISHU_INTEGRATION_TEST=true to activate.
 */
export const FEISHU_INTEGRATION =
  process.env.FEISHU_INTEGRATION_TEST === 'true';

/**
 * Test chat ID for real API calls.
 * Required only when tests need to send messages to an actual Feishu chat.
 */
export const TEST_CHAT_ID = process.env.FEISHU_TEST_CHAT_ID;

/**
 * A `describe` that is replaced with `describe.skip` when
 * FEISHU_INTEGRATION_TEST is not set, making all tests inside it
 * inert during regular test runs.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const describeIfFeishu: any = FEISHU_INTEGRATION ? describe : describe.skip;

// ---------------------------------------------------------------------------
// Assertion helpers
// ---------------------------------------------------------------------------

/**
 * Assert that a value is a non-empty string.
 */
export function assertNonEmptyString(value: unknown, label: string): void {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`${label}: expected non-empty string, got ${JSON.stringify(value)}`);
  }
}

/**
 * Assert that a value is a valid Feishu message ID (starts with 'om_').
 */
export function assertFeishuMessageId(value: unknown, label: string): void {
  assertNonEmptyString(value, label);
  if (!(value as string).startsWith('om_')) {
    throw new Error(`${label}: expected Feishu message ID (om_*), got ${value}`);
  }
}
