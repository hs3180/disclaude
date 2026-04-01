/**
 * Feishu Integration Test: IPC uploadFile End-to-End.
 *
 * Tests the full file upload flow:
 * 1. File upload via IPC → Primary Node → Feishu API
 * 2. File delivery verification
 *
 * Priority: P1 (Important)
 *
 * Prerequisites:
 * - `FEISHU_INTEGRATION_TEST=true`
 * - `FEISHU_TEST_CHAT_ID=<valid_chat_id>`
 * - Running Primary Node with Feishu connection
 * - `DISCLADE_IPC_SOCKET=<socket_path>` (optional, uses default)
 * - A test file at the path specified by `FEISHU_TEST_FILE_PATH` (optional)
 *
 * @module integration/feishu/send-file
 * @see Issue #1626 - Optional Feishu integration tests
 */

import { it, expect, beforeAll, afterAll } from 'vitest';
import {
  describeIfFeishu,
  getTestChatId,
  getIpcSocketPath,
  enableFeishuNetwork,
  INTEGRATION_TEST_TIMEOUT,
} from './helpers.js';
import { UnixSocketIpcClient } from '@disclaude/core';
import { writeFileSync, unlinkSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

describeIfFeishu('IPC uploadFile - End-to-End (P1)', () => {
  let client: UnixSocketIpcClient;
  let chatId: string;
  let socketPath: string;
  let connected = false;
  let testFilePath: string;

  beforeAll(async () => {
    enableFeishuNetwork();

    chatId = getTestChatId();
    socketPath = getIpcSocketPath();

    client = new UnixSocketIpcClient({
      socketPath,
      timeout: 10000,
      maxRetries: 2,
    });

    try {
      await client.connect();
      connected = true;
    } catch (error) {
      console.warn(
        `[Feishu Integration] Cannot connect to IPC server at ${socketPath}. ` +
          `Make sure Primary Node is running. Error: ${error}`
      );
    }

    // Create a temporary test file
    testFilePath = process.env.FEISHU_TEST_FILE_PATH ||
      join(tmpdir(), `disclaude-integration-test-${Date.now()}.txt`);
    if (!process.env.FEISHU_TEST_FILE_PATH) {
      writeFileSync(testFilePath, '🧪 Integration test file content\n');
    }
  }, INTEGRATION_TEST_TIMEOUT);

  afterAll(async () => {
    if (connected) {
      await client.disconnect();
    }

    // Clean up temp file if we created it
    if (!process.env.FEISHU_TEST_FILE_PATH && existsSync(testFilePath)) {
      try {
        unlinkSync(testFilePath);
      } catch {
        // Ignore cleanup errors
      }
    }
  });

  it('should be connected to the Primary Node IPC server', () => {
    expect(connected).toBe(true);
  });

  it(
    'should upload a text file',
    async () => {
      if (!connected) return;

      const result = await client.uploadFile(chatId, testFilePath);

      expect(result.success).toBe(true);
      expect(result.fileKey).toBeDefined();
      expect(typeof result.fileKey).toBe('string');
    },
    INTEGRATION_TEST_TIMEOUT
  );
});
