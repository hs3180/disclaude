/**
 * P1 Integration test: IPC uploadFile end-to-end chain.
 *
 * Tests the full pipeline:
 *   IPC Client.uploadFile()  →  IPC Server  →  Mock uploadFile handler
 *
 * Verifies file upload through the IPC layer including threadId
 * support, error handling, and response payload integrity.
 *
 * Run with: FEISHU_INTEGRATION_TEST=true npx vitest --run tests/integration/feishu
 *
 * @see Issue #1626
 * @see Issue #1574 — Platform-agnostic messaging operations
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  UnixSocketIpcServer,
  UnixSocketIpcClient,
  createInteractiveMessageHandler,
  type ChannelHandlersContainer,
} from '@disclaude/primary-node';
import { describeIfFeishu, generateSocketPath, cleanupSocket } from './helpers.js';

describeIfFeishu('IPC uploadFile end-to-end chain', () => {
  let server: UnixSocketIpcServer;
  let client: UnixSocketIpcClient;
  let socketPath: string;
  let capturedArgs: {
    chatId?: string;
    filePath?: string;
    threadId?: string;
  };
  let uploadCounter: number;

  beforeEach(async () => {
    socketPath = generateSocketPath();
    capturedArgs = {};
    uploadCounter = 0;

    const container: ChannelHandlersContainer = {
      handlers: {
        sendMessage: async () => {},
        sendCard: async () => {},
        sendInteractive: async () => ({ messageId: 'om_mock' }),
        uploadFile: async (chatId, filePath, threadId?) => {
          capturedArgs = { chatId, filePath, threadId };
          uploadCounter++;
          return {
            fileKey: `fk_${uploadCounter}`,
            fileType: filePath.endsWith('.png') ? 'image' : 'file',
            fileName: filePath.split('/').pop() ?? 'unknown',
            fileSize: 1024 * uploadCounter,
          };
        },
      },
    };

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
    }
  });

  it('should upload a file and return correct metadata', async () => {
    const result = await client.uploadFile('oc_file_chat', '/tmp/report.pdf');

    expect(result.success).toBe(true);
    expect(result.fileKey).toBe('fk_1');
    expect(result.fileName).toBe('report.pdf');
    expect(result.fileSize).toBe(1024);
    expect(capturedArgs.chatId).toBe('oc_file_chat');
    expect(capturedArgs.filePath).toBe('/tmp/report.pdf');
    expect(capturedArgs.threadId).toBeUndefined();
  });

  it('should upload an image file and detect type correctly', async () => {
    const result = await client.uploadFile('oc_image_chat', '/tmp/screenshot.png');

    expect(result.success).toBe(true);
    expect(result.fileType).toBe('image');
    expect(result.fileName).toBe('screenshot.png');
  });

  it('should upload a file to a specific thread', async () => {
    const result = await client.uploadFile('oc_thread_chat', '/tmp/data.csv', 'om_thread_parent');

    expect(result.success).toBe(true);
    expect(capturedArgs.threadId).toBe('om_thread_parent');
    expect(capturedArgs.chatId).toBe('oc_thread_chat');
  });

  it('should upload multiple files to different chats', async () => {
    const results = await Promise.all([
      client.uploadFile('oc_chat_a', '/tmp/file_a.txt'),
      client.uploadFile('oc_chat_b', '/tmp/file_b.txt'),
    ]);

    expect(results[0].success).toBe(true);
    expect(results[0].fileKey).toBe('fk_1');

    expect(results[1].success).toBe(true);
    expect(results[1].fileKey).toBe('fk_2');
  });

  it('should handle file paths with special characters', async () => {
    const specialPath = '/tmp/文件夹/文件 (1) - 副本.txt';

    const result = await client.uploadFile('oc_special_chat', specialPath);

    expect(result.success).toBe(true);
    expect(capturedArgs.filePath).toBe(specialPath);
  });

  it('should return failure when channel handlers are not available', async () => {
    const emptySocketPath = generateSocketPath();
    const emptyContainer: ChannelHandlersContainer = { handlers: undefined };
    const emptyHandler = createInteractiveMessageHandler(() => {}, emptyContainer);
    const emptyServer = new UnixSocketIpcServer(emptyHandler, { socketPath: emptySocketPath });
    const emptyClient = new UnixSocketIpcClient({ socketPath: emptySocketPath, timeout: 2000 });

    try {
      await emptyServer.start();
      await emptyClient.connect();

      const result = await emptyClient.uploadFile('oc_test', '/tmp/test.txt');

      // uploadFile catches errors and returns { success: false }
      expect(result.success).toBe(false);
      expect(result.fileKey).toBeUndefined();
    } finally {
      await emptyClient.disconnect().catch(() => {});
      await emptyServer.stop().catch(() => {});
      cleanupSocket(emptySocketPath);
    }
  });

  it('should return failure when uploadFile handler throws', async () => {
    const errorSocketPath = generateSocketPath();
    const errorContainer: ChannelHandlersContainer = {
      handlers: {
        sendMessage: async () => {},
        sendCard: async () => {},
        sendInteractive: async () => ({ messageId: 'om_mock' }),
        uploadFile: async () => {
          throw new Error('File too large: exceeds 50MB limit');
        },
      },
    };
    const errorHandler = createInteractiveMessageHandler(() => {}, errorContainer);
    const errorServer = new UnixSocketIpcServer(errorHandler, { socketPath: errorSocketPath });
    const errorClient = new UnixSocketIpcClient({ socketPath: errorSocketPath, timeout: 2000 });

    try {
      await errorServer.start();
      await errorClient.connect();

      const result = await errorClient.uploadFile('oc_test', '/tmp/huge_file.zip');

      // uploadFile catches errors and returns { success: false }
      expect(result.success).toBe(false);
      expect(result.fileKey).toBeUndefined();
    } finally {
      await errorClient.disconnect().catch(() => {});
      await errorServer.stop().catch(() => {});
      cleanupSocket(errorSocketPath);
    }
  });
});
