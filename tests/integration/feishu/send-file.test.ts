/**
 * P1 Integration test: IPC uploadFile end-to-end chain.
 *
 * Tests the full pipeline:
 *   IPC Client.uploadFile()  →  IPC Server  →  Mock uploadFile handler
 *
 * Verifies file upload works correctly through the IPC layer,
 * including threadId routing and error handling.
 *
 * Run with: FEISHU_INTEGRATION_TEST=true npx vitest --run tests/integration/feishu
 *
 * @see Issue #1626 — Optional Feishu integration tests (default skipped)
 * @see Issue #2300 — IPC uploadFile detailed error information
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

  /** Captured uploadFile calls for assertion */
  let capturedCalls: Array<{
    chatId: string;
    filePath: string;
    threadId?: string;
  }>;

  function createMockContainer(): ChannelHandlersContainer {
    return {
      handlers: {
        sendMessage: async () => {},
        sendCard: async () => {},
        sendInteractive: async () => ({ messageId: 'om_mock' }),
        uploadFile: async (chatId, filePath, threadId?) => {
          capturedCalls.push({ chatId, filePath, threadId });
          return {
            fileKey: `fk_${Date.now()}`,
            fileType: 'file',
            fileName: filePath.split('/').pop() ?? 'unknown',
            fileSize: 1024,
          };
        },
      },
    };
  }

  beforeEach(async () => {
    socketPath = generateSocketPath();
    capturedCalls = [];

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
    }
  });

  it('should upload a file through IPC', async () => {
    const result = await client.uploadFile('oc_test_chat', '/tmp/report.pdf');

    expect(result.success).toBe(true);
    expect(result.fileKey).toBeDefined();
    expect(result.fileType).toBe('file');
    expect(result.fileName).toBe('report.pdf');
    expect(result.fileSize).toBe(1024);

    expect(capturedCalls).toHaveLength(1);
    expect(capturedCalls[0].chatId).toBe('oc_test_chat');
    expect(capturedCalls[0].filePath).toBe('/tmp/report.pdf');
    expect(capturedCalls[0].threadId).toBeUndefined();
  });

  it('should upload a file with threadId for threaded file sharing', async () => {
    const result = await client.uploadFile('oc_test_chat', '/tmp/data.csv', 'om_thread_456');

    expect(result.success).toBe(true);
    expect(capturedCalls[0].threadId).toBe('om_thread_456');
  });

  it('should handle various file extensions', async () => {
    const files = [
      '/tmp/document.pdf',
      '/tmp/image.png',
      '/tmp/data.json',
      '/tmp/archive.zip',
      '/tmp/script.ts',
    ];

    for (const filePath of files) {
      const result = await client.uploadFile('oc_test_chat', filePath);
      expect(result.success).toBe(true);
      expect(result.fileName).toBe(filePath.split('/').pop());
    }

    expect(capturedCalls).toHaveLength(5);
  });

  it('should handle file paths with special characters', async () => {
    const specialPath = '/tmp/my folder/report (final) v2.pdf';
    const result = await client.uploadFile('oc_test_chat', specialPath);

    expect(result.success).toBe(true);
    expect(capturedCalls[0].filePath).toBe(specialPath);
  });

  it('should upload multiple files to different chats', async () => {
    const uploads = [
      { chatId: 'oc_chat_a', filePath: '/tmp/file_a.txt' },
      { chatId: 'oc_chat_b', filePath: '/tmp/file_b.txt' },
      { chatId: 'oc_chat_a', filePath: '/tmp/file_c.txt' },
    ];

    for (const { chatId, filePath } of uploads) {
      const result = await client.uploadFile(chatId, filePath);
      expect(result.success).toBe(true);
    }

    expect(capturedCalls).toHaveLength(3);
    expect(capturedCalls.map((c) => c.chatId)).toEqual([
      'oc_chat_a',
      'oc_chat_b',
      'oc_chat_a',
    ]);
  });

  it('should return error when uploadFile handler is not available', async () => {
    const emptySocketPath = generateSocketPath();
    const emptyContainer: ChannelHandlersContainer = { handlers: undefined };
    const emptyHandler = createInteractiveMessageHandler(() => {}, emptyContainer);
    const emptyServer = new UnixSocketIpcServer(emptyHandler, { socketPath: emptySocketPath });
    const emptyClient = new UnixSocketIpcClient({ socketPath: emptySocketPath, timeout: 2000 });

    try {
      await emptyServer.start();
      await emptyClient.connect();

      const result = await emptyClient.uploadFile('oc_test', '/tmp/test.txt');

      expect(result.success).toBe(false);
      expect(result.error).toContain('not available');
    } finally {
      await emptyClient.disconnect().catch(() => {});
      await emptyServer.stop().catch(() => {});
      cleanupSocket(emptySocketPath);
    }
  });

  it('should return error when handler throws', async () => {
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

      const result = await errorClient.uploadFile('oc_test', '/tmp/huge.zip');

      expect(result.success).toBe(false);
      expect(result.error).toContain('too large');
    } finally {
      await errorClient.disconnect().catch(() => {});
      await errorServer.stop().catch(() => {});
      cleanupSocket(errorSocketPath);
    }
  });
});
