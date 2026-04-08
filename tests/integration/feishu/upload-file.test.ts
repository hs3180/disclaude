/**
 * Integration tests for IPC uploadFile end-to-end flow.
 *
 * Tests the complete chain: IPC request → file upload → file_key retrieval.
 *
 * Prerequisites:
 *   - Primary Node must be running with IPC enabled
 *   - FEISHU_INTEGRATION_TEST=true
 *   - FEISHU_TEST_CHAT_ID set to a valid chat where the bot is a member
 *
 * @see Issue #1626 - Feishu integration test framework
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { writeFileSync, unlinkSync, mkdtempSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { UnixSocketIpcClient } from '@disclaude/core';
import {
  describeIfFeishu,
  getTestChatId,
  getTestSocketPath,
} from './helpers.js';

describeIfFeishu('IPC uploadFile end-to-end', () => {
  let client: UnixSocketIpcClient;
  let chatId: string;
  let tempDir: string;

  beforeAll(async () => {
    chatId = getTestChatId();
    client = new UnixSocketIpcClient({
      socketPath: getTestSocketPath(),
      timeout: 15000,
    });
    await client.connect();
    tempDir = mkdtempSync(join(tmpdir(), 'feishu-integration-'));
  });

  afterAll(async () => {
    if (client) {
      await client.disconnect();
    }
    // Clean up temp files
    try {
      unlinkSync(join(tempDir, 'test-upload.txt'));
    } catch { /* ignore */ }
  });

  it('should upload a text file and receive file metadata', async () => {
    // Create a test file
    const testFilePath = join(tempDir, 'test-upload.txt');
    writeFileSync(testFilePath, `集成测试文件\n上传时间: ${new Date().toISOString()}`);

    const result = await client.uploadFile(chatId, testFilePath);

    expect(result.success).toBe(true);
    expect(result.fileKey).toBeDefined();
    expect(typeof result.fileKey).toBe('string');
  });
});
