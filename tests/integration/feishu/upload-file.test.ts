/**
 * P1 Integration test: IPC uploadFile end-to-end chain.
 *
 * Tests the full pipeline:
 *   IPC Client.uploadFile()  →  IPC Server  →  Mock uploadFile handler  →  Response
 *
 * Verifies file upload through the real Unix socket IPC transport layer,
 * including thread support, error handling, and response metadata.
 *
 * Uses mock IPC handlers — no real Feishu credentials needed.
 * Runs as part of the standard test suite.
 *
 * @see Issue #1626
 * @see Issue #1574 — Phase 5 of IPC refactor (platform-agnostic messaging)
 * @see Issue #2300 — uploadFile error information consistency
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { writeFileSync, unlinkSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  UnixSocketIpcServer,
  UnixSocketIpcClient,
  createInteractiveMessageHandler,
  type ChannelHandlersContainer,
} from '@disclaude/primary-node';
import { generateSocketPath, cleanupSocket } from './helpers.js';

describe('IPC uploadFile end-to-end chain', () => {
  let server: UnixSocketIpcServer;
  let client: UnixSocketIpcClient;
  let socketPath: string;
  let capturedUploads: Array<{
    chatId: string;
    filePath: string;
    threadId?: string;
  }>;
  let testFilePath: string;
  let uploadCounter: number;

  /** Create a mock container that captures uploadFile calls */
  function createMockContainer(): ChannelHandlersContainer {
    return {
      handlers: {
        sendMessage: async () => {},
        sendCard: async () => {},
        sendInteractive: async () => ({ messageId: 'om_mock' }),
        uploadFile: async (chatId, filePath, threadId?) => {
          capturedUploads.push({ chatId, filePath, threadId });
          uploadCounter++;
          // Simulate Feishu upload response
          const fileName = filePath.split('/').pop() ?? 'unknown';
          const fileSize = existsSync(filePath)
            ? (await import('fs')).statSync(filePath).size
            : 1024;
          return {
            fileKey: `fk_upload_${uploadCounter}`,
            fileType: 'file',
            fileName,
            fileSize,
          };
        },
      },
    };
  }

  beforeEach(async () => {
    socketPath = generateSocketPath();
    capturedUploads = [];
    uploadCounter = 0;

    // Create a small test file
    testFilePath = join(tmpdir(), `feishu-integ-upload-${Date.now()}.txt`);
    writeFileSync(testFilePath, 'Test file content for upload\n');

    const container = createMockContainer();
    const handler = createInteractiveMessageHandler(() => {}, container);

    server = new UnixSocketIpcServer(handler, { socketPath });
    client = new UnixSocketIpcClient({ socketPath, timeout: 5000 });

    await server.start();
    await client.connect();
  });

  afterEach(async () => {
    try {
      await client.disconnect();
      await server.stop();
    } finally {
      cleanupSocket(socketPath);
      if (existsSync(testFilePath)) {
        try {
          unlinkSync(testFilePath);
        } catch {
          // Ignore cleanup errors
        }
      }
    }
  });

  it('should upload a file and return file metadata', async () => {
    const result = await client.uploadFile('oc_test_chat', testFilePath);

    expect(result.success).toBe(true);
    expect(result.fileKey).toBeDefined();
    expect(result.fileType).toBe('file');
    expect(result.fileName).toContain('feishu-integ-upload-');
    expect(result.fileSize).toBeGreaterThan(0);
    expect(capturedUploads).toHaveLength(1);
    expect(capturedUploads[0].chatId).toBe('oc_test_chat');
    expect(capturedUploads[0].filePath).toBe(testFilePath);
  });

  it('should upload a file with threadId', async () => {
    const result = await client.uploadFile(
      'oc_thread_chat',
      testFilePath,
      'om_parent_msg_789',
    );

    expect(result.success).toBe(true);
    expect(capturedUploads[0].threadId).toBe('om_parent_msg_789');
  });

  it('should upload multiple files in sequence', async () => {
    const fileA = join(tmpdir(), `upload-a-${Date.now()}.txt`);
    const fileB = join(tmpdir(), `upload-b-${Date.now()}.txt`);
    writeFileSync(fileA, 'Content A');
    writeFileSync(fileB, 'Content B is longer than A');

    try {
      const resultA = await client.uploadFile('oc_multi_chat', fileA);
      const resultB = await client.uploadFile('oc_multi_chat', fileB);

      expect(resultA.success).toBe(true);
      expect(resultB.success).toBe(true);
      expect(resultA.fileKey).not.toBe(resultB.fileKey);
      expect(capturedUploads).toHaveLength(2);
      expect(capturedUploads[0].filePath).toContain('upload-a');
      expect(capturedUploads[1].filePath).toContain('upload-b');
    } finally {
      if (existsSync(fileA)) unlinkSync(fileA);
      if (existsSync(fileB)) unlinkSync(fileB);
    }
  });

  it('should upload to different chats independently', async () => {
    const result1 = await client.uploadFile('oc_chat_alpha', testFilePath);
    const result2 = await client.uploadFile('oc_chat_beta', testFilePath);

    expect(result1.success).toBe(true);
    expect(result2.success).toBe(true);
    expect(capturedUploads[0].chatId).toBe('oc_chat_alpha');
    expect(capturedUploads[1].chatId).toBe('oc_chat_beta');
  });

  it('should return error when channel handlers are not available', async () => {
    const emptySocketPath = generateSocketPath();
    const emptyContainer: ChannelHandlersContainer = { handlers: undefined };
    const emptyHandler = createInteractiveMessageHandler(() => {}, emptyContainer);
    const emptyServer = new UnixSocketIpcServer(emptyHandler, { socketPath: emptySocketPath });
    const emptyClient = new UnixSocketIpcClient({ socketPath: emptySocketPath, timeout: 2000 });

    try {
      await emptyServer.start();
      await emptyClient.connect();

      const result = await emptyClient.uploadFile('oc_test', testFilePath);

      expect(result.success).toBe(false);
      expect(result.error).toContain('not available');
    } finally {
      await emptyClient.disconnect().catch(() => {});
      await emptyServer.stop().catch(() => {});
      cleanupSocket(emptySocketPath);
    }
  });

  it('should return error when uploadFile handler throws', async () => {
    const errorSocketPath = generateSocketPath();
    const errorContainer: ChannelHandlersContainer = {
      handlers: {
        sendMessage: async () => {},
        sendCard: async () => {},
        sendInteractive: async () => ({ messageId: 'om_mock' }),
        uploadFile: async () => {
          throw new Error('File size exceeds limit (50MB)');
        },
      },
    };
    const errorHandler = createInteractiveMessageHandler(() => {}, errorContainer);
    const errorServer = new UnixSocketIpcServer(errorHandler, { socketPath: errorSocketPath });
    const errorClient = new UnixSocketIpcClient({ socketPath: errorSocketPath, timeout: 2000 });

    try {
      await errorServer.start();
      await errorClient.connect();

      const result = await errorClient.uploadFile('oc_test', testFilePath);

      expect(result.success).toBe(false);
      expect(result.error).toContain('File size exceeds limit');
    } finally {
      await errorClient.disconnect().catch(() => {});
      await errorServer.stop().catch(() => {});
      cleanupSocket(errorSocketPath);
    }
  });

  it('should handle upload with special characters in file path', async () => {
    const specialFilePath = join(tmpdir(), `test-file_${Date.now()}-special.txt`);
    writeFileSync(specialFilePath, 'Special file content');

    try {
      const result = await client.uploadFile('oc_special_chat', specialFilePath);

      expect(result.success).toBe(true);
      expect(capturedUploads[0].filePath).toBe(specialFilePath);
    } finally {
      if (existsSync(specialFilePath)) unlinkSync(specialFilePath);
    }
  });
});
