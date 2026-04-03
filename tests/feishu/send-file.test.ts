/**
 * P1: File upload end-to-end test.
 *
 * Tests the IPC uploadFile chain:
 * 1. File upload via IPC
 * 2. Success response with file metadata
 *
 * Requires:
 * - FEISHU_INTEGRATION_TEST=true
 * - FEISHU_TEST_CHAT_ID set to a valid chat ID
 * - Running Primary Node with IPC server and Feishu handlers
 * - A test file at /tmp/feishu-test-file.txt (created automatically)
 *
 * @see Issue #1626 - Optional Feishu integration tests
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { writeFileSync, unlinkSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  FEISHU_INTEGRATION,
  describeIfFeishu,
  getTestChatId,
  getIpcSocketPath,
} from './helpers.js';
import { UnixSocketIpcClient } from '../../packages/core/dist/ipc/unix-socket-client.js';

/** Path for the test file used by upload tests */
const TEST_FILE_PATH = join(tmpdir(), 'feishu-test-file.txt');

describeIfFeishu('IPC uploadFile end-to-end', () => {
  let client: UnixSocketIpcClient;
  let chatId: string;

  beforeAll(async () => {
    if (!FEISHU_INTEGRATION) return;

    chatId = getTestChatId();
    const socketPath = getIpcSocketPath();

    // Create a test file for upload
    const testContent = `🧪 Feishu Integration Test File\nGenerated at: ${new Date().toISOString()}\n${'x'.repeat(1000)}`;
    writeFileSync(TEST_FILE_PATH, testContent, 'utf-8');

    client = new UnixSocketIpcClient({
      socketPath,
      timeout: 30000,
      maxRetries: 3,
    });

    await client.connect();
  }, 60000);

  afterAll(async () => {
    if (!FEISHU_INTEGRATION) return;

    await client.disconnect();

    // Clean up test file
    if (existsSync(TEST_FILE_PATH)) {
      unlinkSync(TEST_FILE_PATH);
    }
  });

  it('should upload a text file', async () => {
    const result = await client.uploadFile(chatId, TEST_FILE_PATH);

    expect(result.success).toBe(true);
    expect(result.fileKey).toBeDefined();
    expect(result.fileName).toBeDefined();
    expect(result.fileSize).toBeGreaterThan(0);
  });

  it('should upload a file with threadId', async () => {
    const threadId = 'test-thread-' + Date.now();
    const result = await client.uploadFile(chatId, TEST_FILE_PATH, threadId);

    expect(result.success).toBe(true);
  });
});

// When tests are disabled, output a skip notice
describe('Feishu Integration Tests - uploadFile', () => {
  it('should be enabled via FEISHU_INTEGRATION_TEST=true', () => {
    if (!FEISHU_INTEGRATION) {
      console.log(
        '\n⏭️  Feishu uploadFile integration tests are skipped by default.\n' +
        '   To enable: FEISHU_INTEGRATION_TEST=true FEISHU_TEST_CHAT_ID=<chat_id> npm run test:feishu\n'
      );
    }
    expect(true).toBe(true);
  });
});
