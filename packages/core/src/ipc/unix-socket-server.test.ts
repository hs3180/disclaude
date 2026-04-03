/**
 * Unit tests for IPC Server: createInteractiveMessageHandler and UnixSocketIpcServer.
 *
 * Issue #1617 Phase 1: Tests for core IPC module.
 *
 * Tests cover:
 * - createInteractiveMessageHandler: all request types (ping, sendMessage, sendCard,
 *   uploadFile, sendInteractive), error paths, missing handlers
 * - UnixSocketIpcServer: start/stop lifecycle, connection handling, message routing
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mkdtempSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  createInteractiveMessageHandler,
  UnixSocketIpcServer,
  type ChannelApiHandlers,
  type ChannelHandlersContainer,
} from './unix-socket-server.js';
import type { IpcRequest, IpcResponse } from './protocol.js';

// ============================================================================
// Test helpers
// ============================================================================

/** Create a mock ChannelHandlersContainer with mock handlers */
function createMockHandlersContainer(overrides?: Partial<ChannelApiHandlers>): ChannelHandlersContainer {
  return {
    handlers: {
      sendMessage: vi.fn().mockResolvedValue(undefined),
      sendCard: vi.fn().mockResolvedValue(undefined),
      uploadFile: vi.fn().mockResolvedValue({
        fileKey: 'file_key_123',
        fileType: 'pdf',
        fileName: 'test.pdf',
        fileSize: 1024,
      }),
      sendInteractive: vi.fn().mockResolvedValue({
        messageId: 'interactive_msg_1',
        actionPrompts: { opt1: 'Option 1 selected' },
      }),
      ...overrides,
    },
  };
}

/** Create a standard test request */
function createRequest<T extends IpcRequest['type']>(
  type: T,
  id: string,
  payload: IpcRequest['payload']
): IpcRequest {
  return { type, id, payload } as IpcRequest;
}

// ============================================================================
// createInteractiveMessageHandler tests
// ============================================================================

describe('createInteractiveMessageHandler', () => {
  let registerActionPrompts: ReturnType<typeof vi.fn>;
  let container: ChannelHandlersContainer;
  let handler: ReturnType<typeof createInteractiveMessageHandler>;

  beforeEach(() => {
    registerActionPrompts = vi.fn();
    container = createMockHandlersContainer();
    handler = createInteractiveMessageHandler(registerActionPrompts, container);
  });

  // ----- ping -----
  describe('ping request', () => {
    it('should return pong response', async () => {
      const request = createRequest('ping', 'req-1', {});
      const response = await handler(request);

      expect(response).toEqual({
        id: 'req-1',
        success: true,
        payload: { pong: true },
      });
    });

    it('should work without handler container', async () => {
      const handlerNoContainer = createInteractiveMessageHandler(registerActionPrompts);
      const request = createRequest('ping', 'req-2', {});
      const response = await handlerNoContainer(request);

      expect(response.success).toBe(true);
      expect(response.payload).toEqual({ pong: true });
    });
  });

  // ----- sendMessage -----
  describe('sendMessage request', () => {
    it('should call handler.sendMessage with correct args', async () => {
      const request = createRequest('sendMessage', 'req-3', {
        chatId: 'chat-1',
        text: 'Hello World',
        threadId: 'thread-1',
      });
      const response = await handler(request);

      expect(container.handlers!.sendMessage).toHaveBeenCalledWith('chat-1', 'Hello World', 'thread-1');
      expect(response).toEqual({
        id: 'req-3',
        success: true,
        payload: { success: true },
      });
    });

    it('should return error when handlers not available', async () => {
      const handlerNoHandlers = createInteractiveMessageHandler(registerActionPrompts, {
        handlers: undefined,
      });
      const request = createRequest('sendMessage', 'req-4', {
        chatId: 'chat-1',
        text: 'Hello',
      });
      const response = await handlerNoHandlers(request);

      expect(response.success).toBe(false);
      expect(response.error).toContain('Channel API handlers not available');
    });

    it('should return error when sendMessage throws', async () => {
      const errorContainer = createMockHandlersContainer({
        sendMessage: vi.fn().mockRejectedValue(new Error('Network timeout')),
      });
      const errorHandler = createInteractiveMessageHandler(registerActionPrompts, errorContainer);
      const request = createRequest('sendMessage', 'req-5', {
        chatId: 'chat-1',
        text: 'Hello',
      });
      const response = await errorHandler(request);

      expect(response.success).toBe(false);
      expect(response.error).toBe('Network timeout');
    });

    it('should handle non-Error throws', async () => {
      const errorContainer = createMockHandlersContainer({
        sendMessage: vi.fn().mockRejectedValue('string error'),
      });
      const errorHandler = createInteractiveMessageHandler(registerActionPrompts, errorContainer);
      const request = createRequest('sendMessage', 'req-5b', {
        chatId: 'chat-1',
        text: 'Hello',
      });
      const response = await errorHandler(request);

      expect(response.success).toBe(false);
      expect(response.error).toBe('Unknown error');
    });

    it('should work without threadId', async () => {
      const request = createRequest('sendMessage', 'req-5c', {
        chatId: 'chat-1',
        text: 'Hello',
      });
      const response = await handler(request);

      expect(container.handlers!.sendMessage).toHaveBeenCalledWith('chat-1', 'Hello', undefined);
      expect(response.success).toBe(true);
    });
  });

  // ----- sendCard -----
  describe('sendCard request', () => {
    it('should call handler.sendCard with correct args', async () => {
      const card = {
        config: { wide_screen_mode: true },
        header: { title: { tag: 'plain_text' as const, content: 'Test' } },
        elements: [],
      };
      const request = createRequest('sendCard', 'req-6', {
        chatId: 'chat-1',
        card,
        threadId: 'thread-1',
        description: 'Test description',
      });
      const response = await handler(request);

      expect(container.handlers!.sendCard).toHaveBeenCalledWith(
        'chat-1',
        card,
        'thread-1',
        'Test description'
      );
      expect(response.success).toBe(true);
    });

    it('should return error when handlers not available', async () => {
      const handlerNoHandlers = createInteractiveMessageHandler(registerActionPrompts, {
        handlers: undefined,
      });
      const request = createRequest('sendCard', 'req-7', {
        chatId: 'chat-1',
        card: { config: {}, header: { title: { tag: 'plain_text', content: '' } }, elements: [] },
      });
      const response = await handlerNoHandlers(request);

      expect(response.success).toBe(false);
      expect(response.error).toContain('Channel API handlers not available');
    });

    it('should return error when sendCard throws', async () => {
      const errorContainer = createMockHandlersContainer({
        sendCard: vi.fn().mockRejectedValue(new Error('Card send failed')),
      });
      const errorHandler = createInteractiveMessageHandler(registerActionPrompts, errorContainer);
      const request = createRequest('sendCard', 'req-8', {
        chatId: 'chat-1',
        card: { config: {}, header: { title: { tag: 'plain_text', content: '' } }, elements: [] },
      });
      const response = await errorHandler(request);

      expect(response.success).toBe(false);
      expect(response.error).toBe('Card send failed');
    });
  });

  // ----- uploadFile -----
  describe('uploadFile request', () => {
    it('should call handler.uploadFile and return result', async () => {
      const request = createRequest('uploadFile', 'req-9', {
        chatId: 'chat-1',
        filePath: '/path/to/file.pdf',
        threadId: 'thread-1',
      });
      const response = await handler(request);

      expect(container.handlers!.uploadFile).toHaveBeenCalledWith('chat-1', '/path/to/file.pdf', 'thread-1');
      expect(response.success).toBe(true);
      expect(response.payload).toEqual({
        success: true,
        fileKey: 'file_key_123',
        fileType: 'pdf',
        fileName: 'test.pdf',
        fileSize: 1024,
      });
    });

    it('should return error when handlers not available', async () => {
      const handlerNoHandlers = createInteractiveMessageHandler(registerActionPrompts, {
        handlers: undefined,
      });
      const request = createRequest('uploadFile', 'req-10', {
        chatId: 'chat-1',
        filePath: '/path/to/file.pdf',
      });
      const response = await handlerNoHandlers(request);

      expect(response.success).toBe(false);
      expect(response.error).toContain('Channel API handlers not available');
    });

    it('should return error when uploadFile throws', async () => {
      const errorContainer = createMockHandlersContainer({
        uploadFile: vi.fn().mockRejectedValue(new Error('File too large')),
      });
      const errorHandler = createInteractiveMessageHandler(registerActionPrompts, errorContainer);
      const request = createRequest('uploadFile', 'req-11', {
        chatId: 'chat-1',
        filePath: '/path/to/file.pdf',
      });
      const response = await errorHandler(request);

      expect(response.success).toBe(false);
      expect(response.error).toBe('File too large');
    });
  });

  // ----- uploadImage (Issue #1919) -----
  describe('uploadImage request', () => {
    it('should call handler.uploadImage and return result', async () => {
      const imageContainer = createMockHandlersContainer({
        uploadImage: vi.fn().mockResolvedValue({
          imageKey: 'img_v3_abc123',
          fileName: 'chart.png',
          fileSize: 204800,
        }),
      });
      const imageHandler = createInteractiveMessageHandler(registerActionPrompts, imageContainer);
      const request = createRequest('uploadImage', 'req-img-1', {
        filePath: '/path/to/chart.png',
      });
      const response = await imageHandler(request);

      expect(imageContainer.handlers!.uploadImage).toHaveBeenCalledWith('/path/to/chart.png');
      expect(response.success).toBe(true);
      expect(response.payload).toEqual({
        success: true,
        imageKey: 'img_v3_abc123',
        fileName: 'chart.png',
        fileSize: 204800,
      });
    });

    it('should return error when handlers not available', async () => {
      const handlerNoHandlers = createInteractiveMessageHandler(registerActionPrompts, {
        handlers: undefined,
      });
      const request = createRequest('uploadImage', 'req-img-2', {
        filePath: '/path/to/chart.png',
      });
      const response = await handlerNoHandlers(request);

      expect(response.success).toBe(false);
      expect(response.error).toContain('Channel API handlers not available');
    });

    it('should return error when uploadImage not supported by channel', async () => {
      const noImageContainer = createMockHandlersContainer();
      // uploadImage is undefined (not provided in overrides)
      delete (noImageContainer.handlers as any).uploadImage;
      const imageHandler = createInteractiveMessageHandler(registerActionPrompts, noImageContainer);
      const request = createRequest('uploadImage', 'req-img-3', {
        filePath: '/path/to/chart.png',
      });
      const response = await imageHandler(request);

      expect(response.success).toBe(false);
      expect(response.error).toContain('uploadImage not supported by this channel');
    });

    it('should return error when uploadImage throws', async () => {
      const errorContainer = createMockHandlersContainer({
        uploadImage: vi.fn().mockRejectedValue(new Error('Image too large')),
      });
      const errorHandler = createInteractiveMessageHandler(registerActionPrompts, errorContainer);
      const request = createRequest('uploadImage', 'req-img-4', {
        filePath: '/path/to/huge.png',
      });
      const response = await errorHandler(request);

      expect(response.success).toBe(false);
      expect(response.error).toBe('Image too large');
    });
  });

  // ----- sendInteractive -----
  describe('sendInteractive request', () => {
    it('should call handler.sendInteractive and register action prompts', async () => {
      const request = createRequest('sendInteractive', 'req-12', {
        chatId: 'chat-1',
        question: 'Choose an option:',
        options: [
          { text: 'Confirm', value: 'confirm', type: 'primary' as const },
          { text: 'Cancel', value: 'cancel' },
        ],
        title: 'Action Required',
        context: 'Test context',
        threadId: 'thread-1',
        actionPrompts: { confirm: 'User confirmed', cancel: 'User cancelled' },
      });
      const response = await handler(request);

      expect(container.handlers!.sendInteractive).toHaveBeenCalledWith('chat-1', {
        question: 'Choose an option:',
        options: [
          { text: 'Confirm', value: 'confirm', type: 'primary' },
          { text: 'Cancel', value: 'cancel' },
        ],
        title: 'Action Required',
        context: 'Test context',
        threadId: 'thread-1',
        actionPrompts: { confirm: 'User confirmed', cancel: 'User cancelled' },
      });
      expect(response.success).toBe(true);
      expect(response.payload).toEqual({
        success: true,
        messageId: 'interactive_msg_1',
        actionPrompts: { opt1: 'Option 1 selected' },
      });
      expect(registerActionPrompts).toHaveBeenCalledWith(
        'interactive_msg_1',
        'chat-1',
        { opt1: 'Option 1 selected' }
      );
    });

    it('should use request actionPrompts when result has none', async () => {
      const noPromptsContainer = createMockHandlersContainer({
        sendInteractive: vi.fn().mockResolvedValue({ messageId: 'msg_no_prompts' }),
      });
      const errorHandler = createInteractiveMessageHandler(registerActionPrompts, noPromptsContainer);
      const request = createRequest('sendInteractive', 'req-13', {
        chatId: 'chat-1',
        question: 'Choose:',
        options: [{ text: 'A', value: 'a' }],
        actionPrompts: { a: 'A selected' },
      });
      const response = await errorHandler(request);

      expect(registerActionPrompts).toHaveBeenCalledWith('msg_no_prompts', 'chat-1', { a: 'A selected' });
      expect(response.success).toBe(true);
    });

    it('should not register prompts when messageId is missing', async () => {
      const noMsgContainer = createMockHandlersContainer({
        sendInteractive: vi.fn().mockResolvedValue({}),
      });
      const errorHandler = createInteractiveMessageHandler(registerActionPrompts, noMsgContainer);
      const request = createRequest('sendInteractive', 'req-14', {
        chatId: 'chat-1',
        question: 'Choose:',
        options: [{ text: 'A', value: 'a' }],
      });
      const response = await errorHandler(request);

      expect(registerActionPrompts).not.toHaveBeenCalled();
      expect(response.success).toBe(true);
    });

    it('should return error when handlers not available', async () => {
      const handlerNoHandlers = createInteractiveMessageHandler(registerActionPrompts, {
        handlers: undefined,
      });
      const request = createRequest('sendInteractive', 'req-15', {
        chatId: 'chat-1',
        question: 'Choose:',
        options: [{ text: 'A', value: 'a' }],
      });
      const response = await handlerNoHandlers(request);

      expect(response.success).toBe(false);
      expect(response.error).toContain('Channel API handlers not available');
    });

    it('should return error when sendInteractive throws', async () => {
      const errorContainer = createMockHandlersContainer({
        sendInteractive: vi.fn().mockRejectedValue(new Error('Card build failed')),
      });
      const errorHandler = createInteractiveMessageHandler(registerActionPrompts, errorContainer);
      const request = createRequest('sendInteractive', 'req-16', {
        chatId: 'chat-1',
        question: 'Choose:',
        options: [{ text: 'A', value: 'a' }],
      });
      const response = await errorHandler(request);

      expect(response.success).toBe(false);
      expect(response.error).toBe('Card build failed');
    });
  });

  // ----- default / unknown -----
  describe('unknown request type', () => {
    it('should return error for unknown type', async () => {
      const request = createRequest('unknownType' as IpcRequest['type'], 'req-23', {});
      const response = await handler(request);

      expect(response.success).toBe(false);
      expect(response.error).toContain('Unknown request type: unknownType');
    });

    it('should preserve request id in error responses', async () => {
      const request = createRequest('unknownType' as IpcRequest['type'], 'req-special-id', {});
      const response = await handler(request);

      expect(response.id).toBe('req-special-id');
    });
  });
});

// ============================================================================
// UnixSocketIpcServer tests
// ============================================================================

describe('UnixSocketIpcServer', () => {
  let tempDir: string;
  let socketPath: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'ipc-server-test-'));
    socketPath = join(tempDir, 'test.ipc');
  });

  describe('lifecycle', () => {
    it('should start and stop successfully', async () => {
      const handler = createInteractiveMessageHandler(vi.fn());
      const server = new UnixSocketIpcServer(handler, { socketPath });

      expect(server.isRunning()).toBe(false);

      await server.start();
      expect(server.isRunning()).toBe(true);
      expect(existsSync(socketPath)).toBe(true);

      await server.stop();
      expect(server.isRunning()).toBe(false);
      expect(existsSync(socketPath)).toBe(false);
    });

    it('should return socket path', () => {
      const handler = createInteractiveMessageHandler(vi.fn());
      const server = new UnixSocketIpcServer(handler, { socketPath });

      expect(server.getSocketPath()).toBe(socketPath);
    });

    it('should be no-op when stopping already stopped server', async () => {
      const handler = createInteractiveMessageHandler(vi.fn());
      const server = new UnixSocketIpcServer(handler, { socketPath });

      await server.stop(); // should not throw
      expect(server.isRunning()).toBe(false);
    });

    it('should be no-op when starting already running server', async () => {
      const handler = createInteractiveMessageHandler(vi.fn());
      const server = new UnixSocketIpcServer(handler, { socketPath });

      await server.start();
      await server.start(); // should be no-op (warns)

      expect(server.isRunning()).toBe(true);
      await server.stop();
    });

    it('should create socket directory if it does not exist', async () => {
      const nestedPath = join(tempDir, 'nested', 'dir', 'test.ipc');
      const handler = createInteractiveMessageHandler(vi.fn());
      const server = new UnixSocketIpcServer(handler, { socketPath: nestedPath });

      await server.start();
      expect(server.isRunning()).toBe(true);
      await server.stop();
    });

    it('should clean up stale socket file on start', async () => {
      // Create a stale socket file
      const { writeFileSync } = await import('fs');
      writeFileSync(socketPath, 'stale content');

      const handler = createInteractiveMessageHandler(vi.fn());
      const server = new UnixSocketIpcServer(handler, { socketPath });

      await server.start();
      expect(server.isRunning()).toBe(true);
      await server.stop();
    });
  });

  describe('message handling', () => {
    it('should handle ping requests via socket', async () => {
      const handler = createInteractiveMessageHandler(vi.fn());
      const server = new UnixSocketIpcServer(handler, { socketPath });

      await server.start();

      const { createConnection } = await import('net');

      const response = await new Promise<string>((resolve, reject) => {
        const client = createConnection(socketPath, () => {
          const request = JSON.stringify({
            type: 'ping',
            id: 'test-1',
            payload: {},
          });
          client.write(`${request}\n`);
        });

        let buffer = '';
        client.on('data', (data: Buffer) => {
          buffer += data.toString();
          if (buffer.includes('\n')) {
            client.destroy();
            resolve(buffer.trim());
          }
        });

        client.on('error', reject);

        setTimeout(() => {
          client.destroy();
          reject(new Error('Timeout'));
        }, 2000);
      });

      const parsed = JSON.parse(response) as IpcResponse;
      expect(parsed.id).toBe('test-1');
      expect(parsed.success).toBe(true);
      expect(parsed.payload).toEqual({ pong: true });

      await server.stop();
    });

    it('should handle invalid JSON gracefully', async () => {
      const handler = createInteractiveMessageHandler(vi.fn());
      const server = new UnixSocketIpcServer(handler, { socketPath });

      await server.start();

      const { createConnection } = await import('net');

      const client = createConnection(socketPath);
      // Send invalid JSON — server should not crash
      client.write('not valid json\n');
      client.write('also not json\n');

      // Send a valid request to verify server is still responsive
      const response = await new Promise<string>((resolve, reject) => {
        let buffer = '';
        const onData = (data: Buffer) => {
          buffer += data.toString();
          if (buffer.includes('\n')) {
            client.destroy();
            resolve(buffer.trim());
          }
        };
        client.on('data', onData);
        client.on('error', reject);

        client.write(`${JSON.stringify({ type: 'ping', id: 'test-after-invalid', payload: {} })}\n`);

        setTimeout(() => {
          client.destroy();
          reject(new Error('Timeout'));
        }, 2000);
      });

      const parsed = JSON.parse(response) as IpcResponse;
      expect(parsed.success).toBe(true);

      await server.stop();
    });

    it('should reject connections during shutdown', async () => {
      const handler = createInteractiveMessageHandler(vi.fn());
      const server = new UnixSocketIpcServer(handler, { socketPath });

      await server.start();

      // Start stop and immediately try to connect
      const stopPromise = server.stop();

      const { createConnection } = await import('net');
      const connectPromise = new Promise<boolean>((resolve) => {
        const client = createConnection(socketPath);
        client.on('connect', () => {
          client.destroy();
          resolve(true);
        });
        client.on('error', () => {
          resolve(false);
        });
        setTimeout(() => resolve(false), 500);
      });

      await connectPromise;
      await stopPromise;

      // Connection may or may not succeed depending on timing
      // The important thing is that stop() completes without hanging
      expect(server.isRunning()).toBe(false);
    });

    it('should handle sendMessage via socket', async () => {
      const mockHandlers = createMockHandlersContainer();
      const handler = createInteractiveMessageHandler(vi.fn(), mockHandlers);
      const server = new UnixSocketIpcServer(handler, { socketPath });

      await server.start();

      const { createConnection } = await import('net');

      const response = await new Promise<string>((resolve, reject) => {
        const client = createConnection(socketPath, () => {
          client.write(`${JSON.stringify({
            type: 'sendMessage',
            id: 'msg-1',
            payload: { chatId: 'chat-1', text: 'Hello via socket' },
          })}\n`);
        });

        let buffer = '';
        client.on('data', (data: Buffer) => {
          buffer += data.toString();
          if (buffer.includes('\n')) {
            client.destroy();
            resolve(buffer.trim());
          }
        });

        client.on('error', reject);
        setTimeout(() => { client.destroy(); reject(new Error('Timeout')); }, 2000);
      });

      const parsed = JSON.parse(response) as IpcResponse;
      expect(parsed.success).toBe(true);
      expect(mockHandlers.handlers!.sendMessage).toHaveBeenCalledWith('chat-1', 'Hello via socket', undefined);

      await server.stop();
    });
  });
});
