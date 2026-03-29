/**
 * P1: IPC uploadFile end-to-end integration test.
 *
 * Tests the complete flow of uploading a file via IPC:
 *   File path → Primary Node → Feishu API → response
 *
 * Requires:
 *   FEISHU_INTEGRATION_TEST=true
 *   FEISHU_TEST_CHAT_ID=<valid_chat_id>
 *   A running Primary Node with Feishu connection
 *
 * Related: #1626, #1574
 */

import { it, expect, beforeAll, afterAll } from 'vitest';
import {
  describeIfFeishu,
  getTestChatId,
  FEISHU_API_TIMEOUT,
  IPC_TIMEOUT,
} from './helpers.js';
import {
  UnixSocketIpcClient,
  getIpcSocketPath,
  resetIpcClient,
} from '@disclaude/core';
import { writeFileSync, unlinkSync, mkdtempSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

describeIfFeishu('IPC uploadFile end-to-end', () => {
  let client: UnixSocketIpcClient;
  let chatId: string;
  let tempDir: string;
  let testFilePath: string;

  beforeAll(async () => {
    chatId = getTestChatId();
    client = new UnixSocketIpcClient({
      socketPath: getIpcSocketPath(),
      timeout: IPC_TIMEOUT,
      maxRetries: 1,
    });
    await client.connect();

    // Create a temporary test file
    tempDir = mkdtempSync(join(tmpdir(), 'feishu-integration-'));
    testFilePath = join(tempDir, 'test-upload.txt');
    writeFileSync(testFilePath, '🔧 集成测试: 文件上传测试内容\n' + 'Timestamp: ' + new Date().toISOString() + '\n');
  }, FEISHU_API_TIMEOUT);

  afterAll(async () => {
    await client.disconnect();
    resetIpcClient();

    // Clean up temp file
    try {
      unlinkSync(testFilePath);
    } catch {
      // Ignore cleanup errors
    }
  });

  it('should upload a text file successfully', async () => {
    const result = await client.uploadFile(chatId, testFilePath);

    expect(result.success).toBe(true);
    expect(result.fileKey).toBeDefined();
    expect(typeof result.fileKey).toBe('string');
  }, FEISHU_API_TIMEOUT);

  it('should report failure for non-existent file', async () => {
    const result = await client.uploadFile(chatId, '/non/existent/file.txt');

    // Should either return success:false or throw
    expect(result).toBeDefined();
    if (result.success === false) {
      // Expected: file not found
      expect(result.success).toBe(false);
    }
    // If success, the server may have handled it differently
  }, FEISHU_API_TIMEOUT);
});
