/**
 * IPC uploadFile integration test.
 *
 * Tests the IPC uploadFile flow with a real IPC server/client.
 *
 * Tier 1: No Feishu credentials required (uses mock handlers).
 *
 * @module __tests__/integration/feishu/send-file
 * @see Issue #1626 - Optional Feishu integration tests
 */

import { it, expect, beforeEach, afterEach } from 'vitest';
import { tmpdir } from 'os';
import { join } from 'path';
import { unlinkSync, existsSync, writeFileSync, mkdirSync, rmSync } from 'fs';
import {
  UnixSocketIpcServer,
  UnixSocketIpcClient,
  createInteractiveMessageHandler,
} from '@disclaude/core';
import { describeIfFeishu, generateTestMarker } from './helpers.js';

describeIfFeishu('IPC uploadFile flow', () => {
  let server: UnixSocketIpcServer;
  let client: UnixSocketIpcClient;
  let socketPath: string;
  let tempDir: string;
  const uploadedFiles: Array<{
    chatId: string;
    filePath: string;
    threadId?: string;
  }> = [];

  function generateSocketPath(): string {
    return join(
      tmpdir(),
      `feishu-file-test-${Date.now()}-${Math.random().toString(36).slice(2)}.sock`
    );
  }

  beforeEach(async () => {
    socketPath = generateSocketPath();
    tempDir = join(tmpdir(), `feishu-test-files-${Date.now()}`);
    mkdirSync(tempDir, { recursive: true });
    uploadedFiles.length = 0;

    const handler = createInteractiveMessageHandler(
      () => {},
      {
        handlers: {
          sendMessage: async () => {},
          sendCard: async () => {},
          uploadFile: async (chatId, filePath, threadId) => {
            uploadedFiles.push({ chatId, filePath, threadId });
            return {
              fileKey: 'file_test_key',
              fileType: 'file',
              fileName: 'test.txt',
              fileSize: 100,
            };
          },
          sendInteractive: async (_chatId, params) => ({
            messageId: `om_${params.options[0]?.value}`,
          }),
        },
      }
    );

    server = new UnixSocketIpcServer(handler, { socketPath });
    client = new UnixSocketIpcClient({ socketPath, timeout: 5000 });
    await server.start();
    await client.connect();
  });

  afterEach(async () => {
    await client.disconnect();
    await server.stop();
    if (existsSync(socketPath)) {
      try {
        unlinkSync(socketPath);
      } catch {
        /* ignore */
      }
    }
    if (existsSync(tempDir)) {
      try {
        rmSync(tempDir, { recursive: true, force: true });
      } catch {
        /* ignore */
      }
    }
  });

  it('should upload file via IPC', async () => {
    const chatId = `oc_test_${generateTestMarker()}`;
    const filePath = join(tempDir, 'test-upload.txt');
    writeFileSync(filePath, 'test content for upload');

    const result = await client.uploadFile(chatId, filePath);

    expect(result.success).toBe(true);
    expect(result.fileKey).toBe('file_test_key');
    expect(result.fileName).toBe('test.txt');
    expect(result.fileSize).toBe(100);

    expect(uploadedFiles).toHaveLength(1);
    expect(uploadedFiles[0].chatId).toBe(chatId);
    expect(uploadedFiles[0].filePath).toBe(filePath);
  });

  it('should upload file with threadId via IPC', async () => {
    const chatId = `oc_test_${generateTestMarker()}`;
    const threadId = `thread_${generateTestMarker()}`;
    const filePath = join(tempDir, 'threaded-file.txt');
    writeFileSync(filePath, 'threaded content');

    const result = await client.uploadFile(chatId, filePath, threadId);

    expect(result.success).toBe(true);
    expect(uploadedFiles[0].threadId).toBe(threadId);
  });

  it('should handle multiple file uploads', async () => {
    const chatId = `oc_test_${generateTestMarker()}`;

    const file1 = join(tempDir, 'file1.txt');
    const file2 = join(tempDir, 'file2.txt');
    writeFileSync(file1, 'content 1');
    writeFileSync(file2, 'content 2');

    await client.uploadFile(chatId, file1);
    await client.uploadFile(chatId, file2);

    expect(uploadedFiles).toHaveLength(2);
    expect(uploadedFiles[0].filePath).toBe(file1);
    expect(uploadedFiles[1].filePath).toBe(file2);
  });
});
