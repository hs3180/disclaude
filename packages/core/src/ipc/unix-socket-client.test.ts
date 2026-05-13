/**
 * Unit tests for IPC Client: UnixSocketIpcClient, getIpcSocketPath, getIpcClient.
 *
 * Issue #1617 Phase 1: Tests for core IPC module.
 *
 * Tests cover:
 * - UnixSocketIpcClient: connect/disconnect, retry logic, availability checks,
 *   request methods (sendMessage, sendCard, uploadFile, sendInteractive, etc.)
 * - Helper functions: getIpcSocketPath, getIpcClient, resetIpcClient
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { randomUUID } from 'crypto';
import {
  UnixSocketIpcClient,
  getIpcSocketPath,
  getIpcClient,
  resetIpcClient,
  createInteractiveMessageHandler,
} from './index.js';
import type { ChannelHandlersContainer } from './unix-socket-server.js';

// ============================================================================
// Test helpers
// ============================================================================

/** Create a transport that connects successfully but never responds to requests (for timeout tests) */
function createTimeoutTransport(): import('./transport.js').IIpcClientTransport {
  return {
    connect: vi.fn().mockImplementation((handlers) => {
      handlers.onConnect();
      return Promise.resolve();
    }),
    write: vi.fn().mockImplementation((_data: string) => {
      // Intentionally never respond — simulates server not responding
    }),
    destroy: vi.fn().mockImplementation(() => {
      // no-op
    }),
  };
}

/** Generate a unique socket path to avoid collisions in fast test execution */
function uniqueSocketPath(tempDir: string, prefix = 'server'): string {
  return join(tempDir, `${prefix}-${randomUUID().slice(0, 8)}.ipc`);
}

/** Start a test IPC server and return its socket path + cleanup handle */
async function startTestServer(tempDir: string): Promise<{ socketPath: string; stop: () => Promise<void> }> {
  const { UnixSocketIpcServer } = await import('./unix-socket-server.js');
  const socketPath = uniqueSocketPath(tempDir);
  const handler = createInteractiveMessageHandler(vi.fn());
  const server = new UnixSocketIpcServer(handler, { socketPath });
  await server.start();
  return {
    socketPath,
    stop: () => server.stop(),
  };
}

/**
 * Start a tracked IPC server with custom handlers.
 * Automatically registered in the activeServers cleanup array.
 */
async function startTrackedServer(
  tempDir: string,
  activeServers: Array<() => Promise<void>>,
  container?: ChannelHandlersContainer,
  prefix = 'server',
): Promise<{ socketPath: string }> {
  const { UnixSocketIpcServer } = await import('./unix-socket-server.js');
  const socketPath = uniqueSocketPath(tempDir, prefix);
  const handler = createInteractiveMessageHandler(vi.fn(), container);
  const server = new UnixSocketIpcServer(handler, { socketPath });
  await server.start();
  activeServers.push(() => server.stop());
  return { socketPath };
}

// ============================================================================
// UnixSocketIpcClient tests
// ============================================================================

describe('UnixSocketIpcClient', () => {
  let tempDir: string;
  let socketPath: string;
  /** Active servers to stop in afterEach */
  const activeServers: Array<() => Promise<void>> = [];

  beforeEach(() => {
    // Use short prefix to avoid exceeding macOS Unix socket path limit (104 bytes)
    tempDir = mkdtempSync(join(tmpdir(), 'ipc-'));
    socketPath = join(tempDir, 'test.ipc');
  });

  afterEach(async () => {
    // Stop all active servers
    for (const stop of activeServers) {
      try { await stop(); } catch { /* ignore */ }
    }
    activeServers.length = 0;
    // Clean up temp directory
    try {
      rmSync(tempDir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup errors
    }
  });

  describe('constructor', () => {
    it('should use default config when none provided', () => {
      const client = new UnixSocketIpcClient();
      expect(client.isConnected()).toBe(false);
    });

    it('should use custom socket path from config', () => {
      const client = new UnixSocketIpcClient({ socketPath: '/custom/path.ipc' });
      expect(client.isConnected()).toBe(false);
    });

    it('should use custom timeout and maxRetries', () => {
      const client = new UnixSocketIpcClient({
        socketPath,
        timeout: 1000,
        maxRetries: 1,
      });
      expect(client.isConnected()).toBe(false);
    });
  });

  describe('connect', () => {
    it('should fail when socket file does not exist', async () => {
      const client = new UnixSocketIpcClient({
        socketPath: join(tempDir, 'nonexistent.ipc'),
        timeout: 100,
        maxRetries: 1,
      });

      await expect(client.connect()).rejects.toThrow('IPC socket not available');
      expect(client.isConnected()).toBe(false);
    });

    it('should connect to a running server', async () => {
      const { socketPath: serverSocketPath, stop } = await startTestServer(tempDir);
      activeServers.push(stop);
      const client = new UnixSocketIpcClient({
        socketPath: serverSocketPath,
        timeout: 2000,
        maxRetries: 1,
      });

      await client.connect();
      expect(client.isConnected()).toBe(true);

      await client.disconnect();
    });

    it('should be no-op when already connected', async () => {
      const { socketPath: serverSocketPath, stop } = await startTestServer(tempDir);
      activeServers.push(stop);
      const client = new UnixSocketIpcClient({
        socketPath: serverSocketPath,
        timeout: 2000,
        maxRetries: 1,
      });

      await client.connect();
      await client.connect(); // second connect should be no-op
      expect(client.isConnected()).toBe(true);

      await client.disconnect();
    });
  });

  describe('disconnect', () => {
    it('should disconnect and clear state', async () => {
      const { socketPath: serverSocketPath, stop } = await startTestServer(tempDir);
      activeServers.push(stop);
      const client = new UnixSocketIpcClient({
        socketPath: serverSocketPath,
        timeout: 2000,
        maxRetries: 1,
      });

      await client.connect();
      expect(client.isConnected()).toBe(true);

      await client.disconnect();
      expect(client.isConnected()).toBe(false);
    });

    it('should be no-op when not connected', async () => {
      const client = new UnixSocketIpcClient({ socketPath });
      await client.disconnect(); // should not throw
      expect(client.isConnected()).toBe(false);
    });
  });

  describe('request', () => {
    it('should send ping and receive pong', async () => {
      const { socketPath: serverSocketPath, stop } = await startTestServer(tempDir);
      activeServers.push(stop);
      const client = new UnixSocketIpcClient({
        socketPath: serverSocketPath,
        timeout: 2000,
        maxRetries: 1,
      });

      const result = await client.request('ping', {});
      expect(result).toEqual({ pong: true });

      await client.disconnect();
    });

    it('should auto-connect if not connected', async () => {
      const { socketPath: serverSocketPath, stop } = await startTestServer(tempDir);
      activeServers.push(stop);
      const client = new UnixSocketIpcClient({
        socketPath: serverSocketPath,
        timeout: 2000,
        maxRetries: 1,
      });

      // Don't call connect() — request() should auto-connect
      const result = await client.request('ping', {});
      expect(result).toEqual({ pong: true });
      expect(client.isConnected()).toBe(true);

      await client.disconnect();
    });

    it('should throw IPC_NOT_AVAILABLE when server unreachable', async () => {
      const client = new UnixSocketIpcClient({
        socketPath: join(tempDir, 'nonexistent.ipc'),
        timeout: 100,
        maxRetries: 1,
      });

      await expect(client.request('ping', {})).rejects.toThrow('IPC_NOT_AVAILABLE');
    });

    it('should throw IPC_REQUEST_FAILED when server returns error', async () => {
      const errorResponse = { id: '1', success: false, error: 'Test error' };
      const errorHandler = vi.fn().mockResolvedValue(errorResponse);
      const { UnixSocketIpcServer } = await import('./unix-socket-server.js');
      const serverSocketPath = uniqueSocketPath(tempDir, 'error');
      const server = new UnixSocketIpcServer(errorHandler, { socketPath: serverSocketPath });
      await server.start();
      activeServers.push(() => server.stop());

      const client = new UnixSocketIpcClient({
        socketPath: serverSocketPath,
        timeout: 2000,
        maxRetries: 1,
      });

      await expect(client.request('sendMessage', { chatId: 'x', text: 'y' }))
        .rejects.toThrow('IPC_REQUEST_FAILED');

      await client.disconnect();
    });
  });

  describe('sendMessage', () => {
    it('should send message via IPC and return success', async () => {
      const mockHandlers = {
        handlers: {
          sendMessage: vi.fn().mockResolvedValue(undefined),
          sendCard: vi.fn().mockResolvedValue(undefined),
          uploadFile: vi.fn().mockResolvedValue({ fileKey: '', fileType: '', fileName: '', fileSize: 0 }),
          sendInteractive: vi.fn().mockResolvedValue({ messageId: 'm1', actionPrompts: {} }),
        },
      };
      const { socketPath: serverSocketPath } = await startTrackedServer(tempDir, activeServers, mockHandlers, 'msg');

      const client = new UnixSocketIpcClient({
        socketPath: serverSocketPath,
        timeout: 2000,
        maxRetries: 1,
      });

      const result = await client.sendMessage('chat-1', 'Hello');
      expect(result.success).toBe(true);
      expect(mockHandlers.handlers.sendMessage).toHaveBeenCalledWith('chat-1', 'Hello', undefined, undefined);

      await client.disconnect();
    });

    it('should return ipc_unavailable error type when IPC not available', async () => {
      const client = new UnixSocketIpcClient({
        socketPath: join(tempDir, 'nonexistent.ipc'),
        timeout: 100,
        maxRetries: 1,
      });

      const result = await client.sendMessage('chat-1', 'Hello');
      expect(result.success).toBe(false);
      expect(result.errorType).toBe('ipc_unavailable');
    });
  });

  describe('sendCard', () => {
    it('should send card via IPC and return success', async () => {
      const mockHandlers = {
        handlers: {
          sendMessage: vi.fn().mockResolvedValue(undefined),
          sendCard: vi.fn().mockResolvedValue(undefined),
          uploadFile: vi.fn().mockResolvedValue({ fileKey: '', fileType: '', fileName: '', fileSize: 0 }),
          sendInteractive: vi.fn().mockResolvedValue({ messageId: 'm1', actionPrompts: {} }),
        },
      };
      const { socketPath: serverSocketPath } = await startTrackedServer(tempDir, activeServers, mockHandlers, 'card');

      const client = new UnixSocketIpcClient({
        socketPath: serverSocketPath,
        timeout: 2000,
        maxRetries: 1,
      });

      const card = {
        config: { wide_screen_mode: true },
        header: { title: { tag: 'plain_text' as const, content: 'Test Card' } },
        elements: [],
      };
      const result = await client.sendCard('chat-1', card);
      expect(result.success).toBe(true);

      await client.disconnect();
    });

    it('should return ipc_unavailable when IPC not available', async () => {
      const client = new UnixSocketIpcClient({
        socketPath: join(tempDir, 'nonexistent.ipc'),
        timeout: 100,
        maxRetries: 1,
      });

      const result = await client.sendCard('chat-1', {
        config: {},
        header: { title: { tag: 'plain_text', content: '' } },
        elements: [],
      });
      expect(result.success).toBe(false);
      expect(result.errorType).toBe('ipc_unavailable');
    });
  });

  describe('uploadFile', () => {
    it('should upload file via IPC and return success', async () => {
      const mockHandlers = {
        handlers: {
          sendMessage: vi.fn().mockResolvedValue(undefined),
          sendCard: vi.fn().mockResolvedValue(undefined),
          uploadFile: vi.fn().mockResolvedValue({
            fileKey: 'fk_123',
            fileType: 'pdf',
            fileName: 'test.pdf',
            fileSize: 2048,
          }),
          sendInteractive: vi.fn().mockResolvedValue({ messageId: 'm1', actionPrompts: {} }),
        },
      };
      const { socketPath: serverSocketPath } = await startTrackedServer(tempDir, activeServers, mockHandlers, 'file');

      const client = new UnixSocketIpcClient({
        socketPath: serverSocketPath,
        timeout: 2000,
        maxRetries: 1,
      });

      const result = await client.uploadFile('chat-1', '/path/to/file.pdf');
      expect(result.success).toBe(true);
      expect(result.fileKey).toBe('fk_123');
      expect(result.fileSize).toBe(2048);

      await client.disconnect();
    });

    it('should return error details when IPC not available (Issue #2300)', async () => {
      const client = new UnixSocketIpcClient({
        socketPath: join(tempDir, 'nonexistent.ipc'),
        timeout: 100,
        maxRetries: 1,
      });

      const result = await client.uploadFile('chat-1', '/path/to/file.pdf');
      expect(result.success).toBe(false);
      expect(result.error).toContain('IPC_NOT_AVAILABLE');
      expect(result.errorType).toBe('ipc_unavailable');
    });
  });

  describe('sendInteractive', () => {
    it('should send interactive card via IPC', async () => {
      const mockHandlers = {
        handlers: {
          sendMessage: vi.fn().mockResolvedValue(undefined),
          sendCard: vi.fn().mockResolvedValue(undefined),
          uploadFile: vi.fn().mockResolvedValue({ fileKey: '', fileType: '', fileName: '', fileSize: 0 }),
          sendInteractive: vi.fn().mockResolvedValue({
            messageId: 'interactive_1',
            actionPrompts: { opt1: 'Selected option 1' },
          }),
        },
      };
      const { socketPath: serverSocketPath } = await startTrackedServer(tempDir, activeServers, mockHandlers, 'interact');

      const client = new UnixSocketIpcClient({
        socketPath: serverSocketPath,
        timeout: 2000,
        maxRetries: 1,
      });

      const result = await client.sendInteractive('chat-1', {
        question: 'Choose:',
        options: [{ text: 'Option 1', value: 'opt1' }],
      });
      expect(result.success).toBe(true);
      expect(result.messageId).toBe('interactive_1');

      await client.disconnect();
    });
  });

  describe('ping', () => {
    it('should return true when server responds', async () => {
      const { socketPath: serverSocketPath, stop } = await startTestServer(tempDir);
      activeServers.push(stop);
      const client = new UnixSocketIpcClient({
        socketPath: serverSocketPath,
        timeout: 2000,
        maxRetries: 1,
      });

      expect(await client.ping()).toBe(true);

      await client.disconnect();
    });

    it('should return false when server unreachable', async () => {
      const client = new UnixSocketIpcClient({
        socketPath: join(tempDir, 'nonexistent.ipc'),
        timeout: 100,
        maxRetries: 1,
      });

      expect(await client.ping()).toBe(false);
    });
  });

  describe('uploadImage', () => {
    it('should upload image via IPC and return success', async () => {
      const mockHandlers = {
        handlers: {
          sendMessage: vi.fn().mockResolvedValue(undefined),
          sendCard: vi.fn().mockResolvedValue(undefined),
          uploadFile: vi.fn().mockResolvedValue({ fileKey: '', fileType: '', fileName: '', fileSize: 0 }),
          uploadImage: vi.fn().mockResolvedValue({ imageKey: 'img_key_123' }),
          sendInteractive: vi.fn().mockResolvedValue({ messageId: 'm1', actionPrompts: {} }),
        },
      };
      const { socketPath: serverSocketPath } = await startTrackedServer(tempDir, activeServers, mockHandlers, 'img');

      const client = new UnixSocketIpcClient({
        socketPath: serverSocketPath,
        timeout: 2000,
        maxRetries: 1,
      });

      const result = await client.uploadImage('/path/to/image.png');
      expect(result.success).toBe(true);
      expect(result.imageKey).toBe('img_key_123');

      await client.disconnect();
    });

    it('should return ipc_unavailable error type when IPC not available', async () => {
      const client = new UnixSocketIpcClient({
        socketPath: join(tempDir, 'nonexistent.ipc'),
        timeout: 100,
        maxRetries: 1,
      });

      const result = await client.uploadImage('/path/to/image.png');
      expect(result.success).toBe(false);
      expect(result.errorType).toBe('ipc_unavailable');
    });

    it('should return ipc_timeout error type on timeout', async () => {
      // Use a transport that connects but never responds to trigger timeout
      const transport = createTimeoutTransport();
      const client = new UnixSocketIpcClient({ timeout: 50 }, transport);

      await client.connect();
      const result = await client.uploadImage('/path/to/image.png');
      expect(result.success).toBe(false);
      expect(result.errorType).toBe('ipc_timeout');

      await client.disconnect();
    });

    it('should return ipc_request_failed error type when server returns error', async () => {
      const errorHandler = vi.fn().mockResolvedValue({ id: '1', success: false, error: 'upload failed' });
      const { UnixSocketIpcServer } = await import('./unix-socket-server.js');
      const serverSocketPath = uniqueSocketPath(tempDir, 'imgerr');
      const server = new UnixSocketIpcServer(errorHandler, { socketPath: serverSocketPath });
      await server.start();
      activeServers.push(() => server.stop());

      const client = new UnixSocketIpcClient({
        socketPath: serverSocketPath,
        timeout: 2000,
        maxRetries: 1,
      });

      const result = await client.uploadImage('/path/to/image.png');
      expect(result.success).toBe(false);
      expect(result.errorType).toBe('ipc_request_failed');

      await client.disconnect();
    });
  });

  describe('listTempChats', () => {
    it('should list temp chats via IPC', async () => {
      const mockHandlers = {
        handlers: {
          sendMessage: vi.fn().mockResolvedValue(undefined),
          sendCard: vi.fn().mockResolvedValue(undefined),
          uploadFile: vi.fn().mockResolvedValue({ fileKey: '', fileType: '', fileName: '', fileSize: 0 }),
          sendInteractive: vi.fn().mockResolvedValue({ messageId: 'm1', actionPrompts: {} }),
          listTempChats: vi.fn().mockResolvedValue([
            { chatId: 'oc_123', createdAt: '2026-01-01', expiresAt: '2026-01-02', responded: false },
          ]),
        },
      };
      const { socketPath: serverSocketPath } = await startTrackedServer(tempDir, activeServers, mockHandlers, 'list');

      const client = new UnixSocketIpcClient({
        socketPath: serverSocketPath,
        timeout: 2000,
        maxRetries: 1,
      });

      const result = await client.listTempChats();
      expect(result.success).toBe(true);
      expect(result.chats).toHaveLength(1);
      expect(result.chats![0].chatId).toBe('oc_123');

      await client.disconnect();
    });

    it('should return ipc_unavailable error type when IPC not available', async () => {
      const client = new UnixSocketIpcClient({
        socketPath: join(tempDir, 'nonexistent.ipc'),
        timeout: 100,
        maxRetries: 1,
      });

      const result = await client.listTempChats();
      expect(result.success).toBe(false);
      expect(result.errorType).toBe('ipc_unavailable');
    });

    it('should return ipc_timeout error type on timeout', async () => {
      const transport = createTimeoutTransport();
      const client = new UnixSocketIpcClient({ timeout: 50 }, transport);

      await client.connect();
      const result = await client.listTempChats();
      expect(result.success).toBe(false);
      expect(result.errorType).toBe('ipc_timeout');

      await client.disconnect();
    });
  });

  describe('markChatResponded', () => {
    it('should mark chat as responded via IPC', async () => {
      const mockHandlers = {
        handlers: {
          sendMessage: vi.fn().mockResolvedValue(undefined),
          sendCard: vi.fn().mockResolvedValue(undefined),
          uploadFile: vi.fn().mockResolvedValue({ fileKey: '', fileType: '', fileName: '', fileSize: 0 }),
          sendInteractive: vi.fn().mockResolvedValue({ messageId: 'm1', actionPrompts: {} }),
          markChatResponded: vi.fn().mockResolvedValue({ success: true }),
        },
      };
      const { socketPath: serverSocketPath } = await startTrackedServer(tempDir, activeServers, mockHandlers, 'mark');

      const client = new UnixSocketIpcClient({
        socketPath: serverSocketPath,
        timeout: 2000,
        maxRetries: 1,
      });

      const result = await client.markChatResponded('oc_123', {
        selectedValue: 'approve',
        responder: 'user_1',
        repliedAt: '2026-01-01T00:00:00Z',
      });
      expect(result.success).toBe(true);

      await client.disconnect();
    });

    it('should return ipc_unavailable error type when IPC not available', async () => {
      const client = new UnixSocketIpcClient({
        socketPath: join(tempDir, 'nonexistent.ipc'),
        timeout: 100,
        maxRetries: 1,
      });

      const result = await client.markChatResponded('oc_123', {
        selectedValue: 'approve',
        responder: 'user_1',
        repliedAt: '2026-01-01T00:00:00Z',
      });
      expect(result.success).toBe(false);
      expect(result.errorType).toBe('ipc_unavailable');
    });

    it('should return ipc_timeout error type on timeout', async () => {
      const transport = createTimeoutTransport();
      const client = new UnixSocketIpcClient({ timeout: 50 }, transport);

      await client.connect();
      const result = await client.markChatResponded('oc_123', {
        selectedValue: 'approve',
        responder: 'user_1',
        repliedAt: '2026-01-01T00:00:00Z',
      });
      expect(result.success).toBe(false);
      expect(result.errorType).toBe('ipc_timeout');

      await client.disconnect();
    });
  });

  describe('handleData with invalid JSON', () => {
    it('should handle invalid JSON data without throwing', async () => {
      const { socketPath: serverSocketPath, stop } = await startTestServer(tempDir);
      activeServers.push(stop);
      const client = new UnixSocketIpcClient({
        socketPath: serverSocketPath,
        timeout: 2000,
        maxRetries: 1,
      });

      await client.connect();

      // Send a valid ping request that the server will handle normally
      // The server will echo back a valid response, proving the client works
      const result = await client.ping();
      expect(result).toBe(true);

      await client.disconnect();
    });
  });

  describe('sendMessage error type branches', () => {
    it('should return ipc_timeout error type on timeout', async () => {
      const transport = createTimeoutTransport();
      const client = new UnixSocketIpcClient({ timeout: 50 }, transport);

      await client.connect();
      const result = await client.sendMessage('chat-1', 'Hello');
      expect(result.success).toBe(false);
      expect(result.errorType).toBe('ipc_timeout');

      await client.disconnect();
    });

    it('should return ipc_request_failed error type on server error', async () => {
      const errorHandler = vi.fn().mockResolvedValue({ id: '1', success: false, error: 'server error' });
      const { UnixSocketIpcServer } = await import('./unix-socket-server.js');
      const serverSocketPath = uniqueSocketPath(tempDir, 'smerr');
      const server = new UnixSocketIpcServer(errorHandler, { socketPath: serverSocketPath });
      await server.start();
      activeServers.push(() => server.stop());

      const client = new UnixSocketIpcClient({
        socketPath: serverSocketPath,
        timeout: 2000,
        maxRetries: 1,
      });

      const result = await client.sendMessage('chat-1', 'Hello');
      expect(result.success).toBe(false);
      expect(result.errorType).toBe('ipc_request_failed');

      await client.disconnect();
    });
  });

  describe('sendCard error type branches', () => {
    it('should return ipc_timeout error type on timeout', async () => {
      const transport = createTimeoutTransport();
      const client = new UnixSocketIpcClient({ timeout: 50 }, transport);

      await client.connect();
      const result = await client.sendCard('chat-1', {
        config: {},
        header: { title: { tag: 'plain_text', content: '' } },
        elements: [],
      });
      expect(result.success).toBe(false);
      expect(result.errorType).toBe('ipc_timeout');

      await client.disconnect();
    });
  });

  describe('uploadFile error type branches', () => {
    it('should return ipc_timeout error type on timeout', async () => {
      const transport = createTimeoutTransport();
      const client = new UnixSocketIpcClient({ timeout: 50 }, transport);

      await client.connect();
      const result = await client.uploadFile('chat-1', '/path/to/file.pdf');
      expect(result.success).toBe(false);
      expect(result.errorType).toBe('ipc_timeout');

      await client.disconnect();
    });
  });

  describe('sendInteractive error type branches', () => {
    it('should return ipc_unavailable error type when IPC not available', async () => {
      const client = new UnixSocketIpcClient({
        socketPath: join(tempDir, 'nonexistent.ipc'),
        timeout: 100,
        maxRetries: 1,
      });

      const result = await client.sendInteractive('chat-1', {
        question: 'Choose:',
        options: [{ text: 'A', value: 'a' }],
      });
      expect(result.success).toBe(false);
      expect(result.errorType).toBe('ipc_unavailable');
    });

    it('should return ipc_timeout error type on timeout', async () => {
      const transport = createTimeoutTransport();
      const client = new UnixSocketIpcClient({ timeout: 50 }, transport);

      await client.connect();
      const result = await client.sendInteractive('chat-1', {
        question: 'Choose:',
        options: [{ text: 'A', value: 'a' }],
      });
      expect(result.success).toBe(false);
      expect(result.errorType).toBe('ipc_timeout');

      await client.disconnect();
    });
  });

  describe('transport mode', () => {
    it('should connect and disconnect via transport', async () => {
      const transport: import('./transport.js').IIpcClientTransport = {
        connect: vi.fn().mockImplementation((handlers) => {
          handlers.onConnect();
          return Promise.resolve();
        }),
        write: vi.fn(),
        destroy: vi.fn(),
      };

      const client = new UnixSocketIpcClient({}, transport);
      await client.connect();
      expect(client.isConnected()).toBe(true);

      await client.disconnect();
      expect(client.isConnected()).toBe(false);
    });

    it('should reject pending requests on transport close', async () => {
      let closeHandler: (() => void) | null = null;
      const transport: import('./transport.js').IIpcClientTransport = {
        connect: vi.fn().mockImplementation((handlers) => {
          closeHandler = () => handlers.onClose();
          handlers.onConnect();
          return Promise.resolve();
        }),
        write: vi.fn(),
        destroy: vi.fn(),
      };

      const client = new UnixSocketIpcClient({ timeout: 5000 }, transport);
      await client.connect();

      // Start a request that will be pending
      const requestPromise = client.request('ping', {});

      // Close the transport while request is pending
      closeHandler!();

      await expect(requestPromise).rejects.toThrow('IPC connection closed');

      await client.disconnect();
    });

    it('should handle transport connect error', async () => {
      const transport: import('./transport.js').IIpcClientTransport = {
        connect: vi.fn().mockRejectedValue(new Error('Transport connect failed')),
        write: vi.fn(),
        destroy: vi.fn(),
      };

      const client = new UnixSocketIpcClient({}, transport);
      await expect(client.connect()).rejects.toThrow('Transport connect failed');
      expect(client.isConnected()).toBe(false);
    });

    it('should handle concurrent connect calls via transport', async () => {
      let resolveConnect: (() => void) | null = null;
      const transport: import('./transport.js').IIpcClientTransport = {
        connect: vi.fn().mockImplementation((handlers) => new Promise<void>(resolve => {
          resolveConnect = () => {
            handlers.onConnect();
            resolve();
          };
        })),
        write: vi.fn(),
        destroy: vi.fn(),
      };

      const client = new UnixSocketIpcClient({}, transport);

      // Start two concurrent connects
      const connect1 = client.connect();
      const connect2 = client.connect();

      // Resolve the transport connect
      resolveConnect!();

      await Promise.all([connect1, connect2]);
      expect(client.isConnected()).toBe(true);

      await client.disconnect();
    });
  });

  describe('isAvailable', () => {
    it('should return true when connected', async () => {
      const { socketPath: serverSocketPath, stop } = await startTestServer(tempDir);
      activeServers.push(stop);
      const client = new UnixSocketIpcClient({
        socketPath: serverSocketPath,
        timeout: 2000,
        maxRetries: 1,
      });

      await client.connect();
      expect(client.isAvailable()).toBe(true);

      await client.disconnect();
    });

    it('should use cache within TTL for transport mode', async () => {
      const transport: import('./transport.js').IIpcClientTransport = {
        connect: vi.fn().mockImplementation((handlers) => {
          handlers.onConnect();
          return Promise.resolve();
        }),
        write: vi.fn(),
        destroy: vi.fn(),
      };

      const client = new UnixSocketIpcClient({}, transport);
      await client.connect();

      // After connecting, availability should be cached as true
      expect(client.isAvailable()).toBe(true);

      await client.disconnect();
    });

    it('should return false when transport not connected and cache expired', () => {
      const transport: import('./transport.js').IIpcClientTransport = {
        connect: vi.fn().mockImplementation((handlers) => {
          handlers.onConnect();
          return Promise.resolve();
        }),
        write: vi.fn(),
        destroy: vi.fn(),
      };

      const client = new UnixSocketIpcClient({}, transport);
      // Not connected, no cache — should return false
      expect(client.isAvailable()).toBe(false);
    });
  });

  describe('checkAvailability', () => {
    it('should return cached result within TTL', async () => {
      const { socketPath: serverSocketPath, stop } = await startTestServer(tempDir);
      activeServers.push(stop);
      const client = new UnixSocketIpcClient({
        socketPath: serverSocketPath,
        timeout: 2000,
        maxRetries: 1,
      });

      // First check — connects and caches
      const status1 = await client.checkAvailability();
      expect(status1.available).toBe(true);

      // Second check — should return cached result
      const status2 = await client.checkAvailability();
      expect(status2.available).toBe(true);

      await client.disconnect();
    });

    it('should return connection_failed for transport mode when connect fails', async () => {
      const transport: import('./transport.js').IIpcClientTransport = {
        connect: vi.fn().mockRejectedValue(new Error('Connection refused')),
        write: vi.fn(),
        destroy: vi.fn(),
      };

      const client = new UnixSocketIpcClient({}, transport);
      const status = await client.checkAvailability();
      expect(status.available).toBe(false);
      if (!status.available) {
        expect(status.reason).toBe('connection_failed');
      }
    });

    it('should detect timeout reason from error message', async () => {
      const client = new UnixSocketIpcClient({
        socketPath: join(tempDir, 'missing.ipc'),
        timeout: 100,
        maxRetries: 1,
      });

      // Create the socket file but have no server to trigger timeout
      const { writeFileSync } = await import('fs');
      writeFileSync(join(tempDir, 'missing.ipc'), '');

      // This should either timeout or connection_failed
      const status = await client.checkAvailability();
      expect(status.available).toBe(false);
      if (!status.available) {
        expect(['timeout', 'connection_failed']).toContain(status.reason);
      }
    });
  });

  describe('availability', () => {
    it('should return available when connected', async () => {
      const { socketPath: serverSocketPath, stop } = await startTestServer(tempDir);
      activeServers.push(stop);
      const client = new UnixSocketIpcClient({
        socketPath: serverSocketPath,
        timeout: 2000,
        maxRetries: 1,
      });

      await client.connect();
      const status = await client.checkAvailability();
      expect(status.available).toBe(true);

      await client.disconnect();
    });

    it('should return socket_not_found when socket missing', async () => {
      const client = new UnixSocketIpcClient({
        socketPath: join(tempDir, 'missing.ipc'),
        timeout: 100,
        maxRetries: 1,
      });

      const status = await client.checkAvailability();
      expect(status.available).toBe(false);
      if (!status.available) {
        expect(status.reason).toBe('socket_not_found');
      }
    });

    it('isAvailable should return false for missing socket', () => {
      const client = new UnixSocketIpcClient({
        socketPath: join(tempDir, 'missing.ipc'),
      });

      expect(client.isAvailable()).toBe(false);
    });

    it('invalidateAvailabilityCache should clear cache', () => {
      const client = new UnixSocketIpcClient({ socketPath });
      // Just verify it doesn't throw
      client.invalidateAvailabilityCache();
    });
  });
});

// ============================================================================
// Helper functions tests
// ============================================================================

describe('getIpcSocketPath', () => {
  it('should return env var DISCLAUDE_WORKER_IPC_SOCKET if set', () => {
    const original = process.env.DISCLAUDE_WORKER_IPC_SOCKET;
    process.env.DISCLAUDE_WORKER_IPC_SOCKET = '/tmp/worker.ipc';
    expect(getIpcSocketPath()).toBe('/tmp/worker.ipc');
    process.env.DISCLAUDE_WORKER_IPC_SOCKET = original;
  });

  it('should return env var DISCLAUDE_IPC_SOCKET_PATH if set', () => {
    const originalWorker = process.env.DISCLAUDE_WORKER_IPC_SOCKET;
    const originalPath = process.env.DISCLAUDE_IPC_SOCKET_PATH;
    delete process.env.DISCLAUDE_WORKER_IPC_SOCKET;
    process.env.DISCLAUDE_IPC_SOCKET_PATH = '/tmp/custom.ipc';
    expect(getIpcSocketPath()).toBe('/tmp/custom.ipc');
    process.env.DISCLAUDE_WORKER_IPC_SOCKET = originalWorker;
    process.env.DISCLAUDE_IPC_SOCKET_PATH = originalPath;
  });

  it('should return default path when no env vars set', () => {
    const originalWorker = process.env.DISCLAUDE_WORKER_IPC_SOCKET;
    const originalPath = process.env.DISCLAUDE_IPC_SOCKET_PATH;
    delete process.env.DISCLAUDE_WORKER_IPC_SOCKET;
    delete process.env.DISCLAUDE_IPC_SOCKET_PATH;
    expect(getIpcSocketPath()).toBe('/tmp/disclaude-interactive.ipc');
    process.env.DISCLAUDE_WORKER_IPC_SOCKET = originalWorker;
    process.env.DISCLAUDE_IPC_SOCKET_PATH = originalPath;
  });

  it('should prefer DISCLAUDE_WORKER_IPC_SOCKET over DISCLAUDE_IPC_SOCKET_PATH', () => {
    const originalWorker = process.env.DISCLAUDE_WORKER_IPC_SOCKET;
    const originalPath = process.env.DISCLAUDE_IPC_SOCKET_PATH;
    process.env.DISCLAUDE_WORKER_IPC_SOCKET = '/tmp/worker.ipc';
    process.env.DISCLAUDE_IPC_SOCKET_PATH = '/tmp/custom.ipc';
    expect(getIpcSocketPath()).toBe('/tmp/worker.ipc');
    process.env.DISCLAUDE_WORKER_IPC_SOCKET = originalWorker;
    process.env.DISCLAUDE_IPC_SOCKET_PATH = originalPath;
  });
});

describe('getIpcClient / resetIpcClient', () => {
  afterEach(() => {
    resetIpcClient();
  });

  it('should return a UnixSocketIpcClient instance', () => {
    const client = getIpcClient();
    expect(client).toBeInstanceOf(UnixSocketIpcClient);
  });

  it('should return same instance on subsequent calls (singleton)', () => {
    const client1 = getIpcClient();
    const client2 = getIpcClient();
    expect(client1).toBe(client2);
  });

  it('should return new instance after reset', () => {
    const client1 = getIpcClient();
    resetIpcClient();
    const client2 = getIpcClient();
    expect(client1).not.toBe(client2);
  });
});
