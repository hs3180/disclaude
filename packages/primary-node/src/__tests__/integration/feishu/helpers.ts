/**
 * Shared helpers for optional Feishu integration tests.
 *
 * These tests are skipped by default and only run when FEISHU_INTEGRATION_TEST=true.
 * They require real Feishu API credentials and a test chat ID.
 *
 * @see Issue #1626
 *
 * Usage:
 * ```bash
 * FEISHU_INTEGRATION_TEST=true \
 * FEISHU_APP_ID=cli_xxx \
 * FEISHU_APP_SECRET=xxx \
 * FEISHU_TEST_CHAT_ID=oc_xxx \
 * npm run test:feishu
 * ```
 */

import { describe } from 'vitest';
import nock from 'nock';
import * as lark from '@larksuiteoapi/node-sdk';
import { createFeishuClient } from '../../../platforms/feishu/create-feishu-client.js';

/** Whether Feishu integration tests are enabled */
export const FEISHU_INTEGRATION = process.env.FEISHU_INTEGRATION_TEST === 'true';

/**
 * Conditional describe that skips when integration tests are disabled.
 *
 * @example
 * ```typescript
 * describeIfFeishu('Feishu API', () => {
 *   it('should send a message', async () => { ... });
 * });
 * ```
 */
export const describeIfFeishu: typeof describe = FEISHU_INTEGRATION
  ? describe
  : (...args: Parameters<typeof describe>) => describe.skip(...args);

/**
 * Get the test chat ID from environment variables.
 *
 * @throws Error if FEISHU_TEST_CHAT_ID is not set
 */
export function getTestChatId(): string {
  const chatId = process.env.FEISHU_TEST_CHAT_ID;
  if (!chatId) {
    throw new Error(
      'FEISHU_TEST_CHAT_ID env var is required for Feishu integration tests. ' +
      'Set it to a chat ID where the bot has permission to send messages.',
    );
  }
  return chatId;
}

/**
 * Get Feishu credentials from environment variables.
 *
 * @throws Error if credentials are missing
 */
function getFeishuCredentials(): { appId: string; appSecret: string } {
  const appId = process.env.FEISHU_APP_ID;
  const appSecret = process.env.FEISHU_APP_SECRET;

  if (!appId || !appSecret) {
    throw new Error(
      'FEISHU_APP_ID and FEISHU_APP_SECRET env vars are required for Feishu integration tests.',
    );
  }

  return { appId, appSecret };
}

/**
 * Allow Feishu API hosts through nock network isolation.
 *
 * Must be called in beforeAll of each integration test file.
 * The test setup (tests/setup.ts) blocks all external network by default;
 * this function selectively enables Feishu API endpoints.
 */
export function allowFeishuHosts(): void {
  nock.enableNetConnect('open.feishu.cn');
  nock.enableNetConnect('open.larksuite.com');
  nock.enableNetConnect('internal-api.feishu.cn');
  nock.enableNetConnect('ws.feishu.cn');
}

/** Cached client instance to reuse across test files */
let cachedClient: lark.Client | null = null;

/**
 * Get or create a Feishu client for integration testing.
 *
 * The client is reused across test files to avoid redundant
 * tenant_access_token requests (each token is valid for 2 hours).
 *
 * @returns Configured Lark Client instance
 * @throws Error if credentials are missing
 */
export function getTestClient(): lark.Client {
  if (!cachedClient) {
    const { appId, appSecret } = getFeishuCredentials();
    cachedClient = createFeishuClient(appId, appSecret, {
      loggerLevel: 0, // Silent — reduce noise in test output
    });
  }
  return cachedClient;
}

/**
 * Generate a unique test marker to identify messages sent by integration tests.
 *
 * @param testName - Name of the test case
 * @returns A string like "[Integration Test: send-message] 2026-04-05T12:00:00Z"
 */
export function testMarker(testName: string): string {
  return `[Integration Test: ${testName}] ${new Date().toISOString()}`;
}

/**
 * Extract message_id from a Feishu API response.
 *
 * @param response - Raw response from lark client
 * @returns The message_id string, or undefined if not found
 */
export function extractMessageId(response: unknown): string | undefined {
  const resp = response as { data?: { message_id?: string } };
  return resp?.data?.message_id;
}
