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
import { mkdtempSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  UnixSocketIpcClient,
  getIpcSocketPath,
  getIpcClient,
  resetIpcClient,
  createInteractiveMessageHandler,
} from './index.js';

// ============================================================================
// Test helpers
// ============================================================================

/** Start a test IPC server and return its socket path */
async function startTestServer(tempDir: string): Promise<string> {
  const { UnixSocketIpcServer } = await import('./unix-socket-server.js');
  const socketPath = join(tempDir, `server-${Date.now()}.ipc`);
  const handler = createInteractiveMessageHandler(vi.fn());
  const server = new UnixSocketIpcServer(handler, { socketPath });
  await server.start();
  return socketPath;
}

// ============================================================================
// UnixSocketIpcClient tests
// ============================================================================

describe('UnixSocketIpcClient', () => {
  let tempDir: string;
  let socketPath: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'ipc-client-test-'));
    socketPath = join(tempDir, 'test.ipc');
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
      const serverSocketPath = await startTestServer(tempDir);
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
      const serverSocketPath = await startTestServer(tempDir);
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
      const serverSocketPath = await startTestServer(tempDir);
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
      const serverSocketPath = await startTestServer(tempDir);
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
      const serverSocketPath = await startTestServer(tempDir);
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
      const { UnixSocketIpcServer } = await import('./unix-socket-server.js');
      const serverSocketPath = join(tempDir, `error-server-${Date.now()}.ipc`);
      const errorResponse = { id: '1', success: false, error: 'Test error' };
      const errorHandler = vi.fn().mockResolvedValue(errorResponse);
      const server = new UnixSocketIpcServer(errorHandler, { socketPath: serverSocketPath });
      await server.start();

      const client = new UnixSocketIpcClient({
        socketPath: serverSocketPath,
        timeout: 2000,
        maxRetries: 1,
      });

      await expect(client.request('sendMessage', { chatId: 'x', text: 'y' }))
        .rejects.toThrow('IPC_REQUEST_FAILED');

      await client.disconnect();
      await server.stop();
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
      const { UnixSocketIpcServer } = await import('./unix-socket-server.js');
      const serverSocketPath = join(tempDir, `msg-server-${Date.now()}.ipc`);
      const handler = createInteractiveMessageHandler(vi.fn(), mockHandlers);
      const server = new UnixSocketIpcServer(handler, { socketPath: serverSocketPath });
      await server.start();

      const client = new UnixSocketIpcClient({
        socketPath: serverSocketPath,
        timeout: 2000,
        maxRetries: 1,
      });

      const result = await client.sendMessage('chat-1', 'Hello');
      expect(result.success).toBe(true);
      expect(mockHandlers.handlers.sendMessage).toHaveBeenCalledWith('chat-1', 'Hello', undefined);

      await client.disconnect();
      await server.stop();
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
      const { UnixSocketIpcServer } = await import('./unix-socket-server.js');
      const serverSocketPath = join(tempDir, `card-server-${Date.now()}.ipc`);
      const handler = createInteractiveMessageHandler(vi.fn(), mockHandlers);
      const server = new UnixSocketIpcServer(handler, { socketPath: serverSocketPath });
      await server.start();

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
      await server.stop();
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
      const { UnixSocketIpcServer } = await import('./unix-socket-server.js');
      const serverSocketPath = join(tempDir, `file-server-${Date.now()}.ipc`);
      const handler = createInteractiveMessageHandler(vi.fn(), mockHandlers);
      const server = new UnixSocketIpcServer(handler, { socketPath: serverSocketPath });
      await server.start();

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
      await server.stop();
    });

    it('should return failure when IPC not available', async () => {
      const client = new UnixSocketIpcClient({
        socketPath: join(tempDir, 'nonexistent.ipc'),
        timeout: 100,
        maxRetries: 1,
      });

      const result = await client.uploadFile('chat-1', '/path/to/file.pdf');
      expect(result.success).toBe(false);
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
      const { UnixSocketIpcServer } = await import('./unix-socket-server.js');
      const serverSocketPath = join(tempDir, `interact-server-${Date.now()}.ipc`);
      const handler = createInteractiveMessageHandler(vi.fn(), mockHandlers);
      const server = new UnixSocketIpcServer(handler, { socketPath: serverSocketPath });
      await server.start();

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
      await server.stop();
    });
  });

  describe('createChat / dissolveChat', () => {
    it('should create chat via IPC', async () => {
      const mockHandlers = {
        handlers: {
          sendMessage: vi.fn().mockResolvedValue(undefined),
          sendCard: vi.fn().mockResolvedValue(undefined),
          uploadFile: vi.fn().mockResolvedValue({ fileKey: '', fileType: '', fileName: '', fileSize: 0 }),
          sendInteractive: vi.fn().mockResolvedValue({}),
          createChat: vi.fn().mockResolvedValue({ chatId: 'oc_new', name: 'New Group' }),
          dissolveChat: vi.fn().mockResolvedValue({ success: true }),
        },
      };
      const { UnixSocketIpcServer } = await import('./unix-socket-server.js');
      const serverSocketPath = join(tempDir, `chat-server-${Date.now()}.ipc`);
      const handler = createInteractiveMessageHandler(vi.fn(), mockHandlers);
      const server = new UnixSocketIpcServer(handler, { socketPath: serverSocketPath });
      await server.start();

      const client = new UnixSocketIpcClient({
        socketPath: serverSocketPath,
        timeout: 2000,
        maxRetries: 1,
      });

      const result = await client.createChat('Test Group', 'Description', ['ou_a']);
      expect(result.success).toBe(true);
      expect(result.chatId).toBe('oc_new');

      await client.disconnect();
      await server.stop();
    });

    it('should dissolve chat via IPC', async () => {
      const mockHandlers = {
        handlers: {
          sendMessage: vi.fn().mockResolvedValue(undefined),
          sendCard: vi.fn().mockResolvedValue(undefined),
          uploadFile: vi.fn().mockResolvedValue({ fileKey: '', fileType: '', fileName: '', fileSize: 0 }),
          sendInteractive: vi.fn().mockResolvedValue({}),
          dissolveChat: vi.fn().mockResolvedValue({ success: true }),
        },
      };
      const { UnixSocketIpcServer } = await import('./unix-socket-server.js');
      const serverSocketPath = join(tempDir, `dissolve-server-${Date.now()}.ipc`);
      const handler = createInteractiveMessageHandler(vi.fn(), mockHandlers);
      const server = new UnixSocketIpcServer(handler, { socketPath: serverSocketPath });
      await server.start();

      const client = new UnixSocketIpcClient({
        socketPath: serverSocketPath,
        timeout: 2000,
        maxRetries: 1,
      });

      const result = await client.dissolveChat('oc_old');
      expect(result.success).toBe(true);

      await client.disconnect();
      await server.stop();
    });
  });

  describe('addMembers / removeMembers / listMembers / listChats', () => {
    it('should add members via IPC', async () => {
      const mockHandlers = {
        handlers: {
          sendMessage: vi.fn().mockResolvedValue(undefined),
          sendCard: vi.fn().mockResolvedValue(undefined),
          uploadFile: vi.fn().mockResolvedValue({ fileKey: '', fileType: '', fileName: '', fileSize: 0 }),
          sendInteractive: vi.fn().mockResolvedValue({}),
          addMembers: vi.fn().mockResolvedValue({ success: true }),
        },
      };
      const { UnixSocketIpcServer } = await import('./unix-socket-server.js');
      const serverSocketPath = join(tempDir, `add-members-server-${Date.now()}.ipc`);
      const handler = createInteractiveMessageHandler(vi.fn(), mockHandlers);
      const server = new UnixSocketIpcServer(handler, { socketPath: serverSocketPath });
      await server.start();

      const client = new UnixSocketIpcClient({
        socketPath: serverSocketPath,
        timeout: 2000,
        maxRetries: 1,
      });

      const result = await client.addMembers('oc_xxx', ['ou_a', 'ou_b']);
      expect(result.success).toBe(true);
      expect(mockHandlers.handlers.addMembers).toHaveBeenCalledWith('oc_xxx', ['ou_a', 'ou_b']);

      await client.disconnect();
      await server.stop();
    });

    it('should remove members via IPC', async () => {
      const mockHandlers = {
        handlers: {
          sendMessage: vi.fn().mockResolvedValue(undefined),
          sendCard: vi.fn().mockResolvedValue(undefined),
          uploadFile: vi.fn().mockResolvedValue({ fileKey: '', fileType: '', fileName: '', fileSize: 0 }),
          sendInteractive: vi.fn().mockResolvedValue({}),
          removeMembers: vi.fn().mockResolvedValue({ success: true }),
        },
      };
      const { UnixSocketIpcServer } = await import('./unix-socket-server.js');
      const serverSocketPath = join(tempDir, `remove-members-server-${Date.now()}.ipc`);
      const handler = createInteractiveMessageHandler(vi.fn(), mockHandlers);
      const server = new UnixSocketIpcServer(handler, { socketPath: serverSocketPath });
      await server.start();

      const client = new UnixSocketIpcClient({
        socketPath: serverSocketPath,
        timeout: 2000,
        maxRetries: 1,
      });

      const result = await client.removeMembers('oc_xxx', ['ou_a']);
      expect(result.success).toBe(true);
      expect(mockHandlers.handlers.removeMembers).toHaveBeenCalledWith('oc_xxx', ['ou_a']);

      await client.disconnect();
      await server.stop();
    });

    it('should list members via IPC', async () => {
      const mockHandlers = {
        handlers: {
          sendMessage: vi.fn().mockResolvedValue(undefined),
          sendCard: vi.fn().mockResolvedValue(undefined),
          uploadFile: vi.fn().mockResolvedValue({ fileKey: '', fileType: '', fileName: '', fileSize: 0 }),
          sendInteractive: vi.fn().mockResolvedValue({}),
          listMembers: vi.fn().mockResolvedValue({ members: ['ou_a', 'ou_b', 'ou_c'] }),
        },
      };
      const { UnixSocketIpcServer } = await import('./unix-socket-server.js');
      const serverSocketPath = join(tempDir, `list-members-server-${Date.now()}.ipc`);
      const handler = createInteractiveMessageHandler(vi.fn(), mockHandlers);
      const server = new UnixSocketIpcServer(handler, { socketPath: serverSocketPath });
      await server.start();

      const client = new UnixSocketIpcClient({
        socketPath: serverSocketPath,
        timeout: 2000,
        maxRetries: 1,
      });

      const result = await client.listMembers('oc_xxx');
      expect(result.success).toBe(true);
      expect(result.members).toEqual(['ou_a', 'ou_b', 'ou_c']);
      expect(mockHandlers.handlers.listMembers).toHaveBeenCalledWith('oc_xxx');

      await client.disconnect();
      await server.stop();
    });

    it('should list chats via IPC', async () => {
      const mockHandlers = {
        handlers: {
          sendMessage: vi.fn().mockResolvedValue(undefined),
          sendCard: vi.fn().mockResolvedValue(undefined),
          uploadFile: vi.fn().mockResolvedValue({ fileKey: '', fileType: '', fileName: '', fileSize: 0 }),
          sendInteractive: vi.fn().mockResolvedValue({}),
          listChats: vi.fn().mockResolvedValue([
            { chatId: 'oc_1', name: 'Group 1' },
            { chatId: 'oc_2', name: 'Group 2' },
          ]),
        },
      };
      const { UnixSocketIpcServer } = await import('./unix-socket-server.js');
      const serverSocketPath = join(tempDir, `list-chats-server-${Date.now()}.ipc`);
      const handler = createInteractiveMessageHandler(vi.fn(), mockHandlers);
      const server = new UnixSocketIpcServer(handler, { socketPath: serverSocketPath });
      await server.start();

      const client = new UnixSocketIpcClient({
        socketPath: serverSocketPath,
        timeout: 2000,
        maxRetries: 1,
      });

      const result = await client.listChats();
      expect(result.success).toBe(true);
      expect(result.chats).toHaveLength(2);
      expect(result.chats?.[0].name).toBe('Group 1');

      await client.disconnect();
      await server.stop();
    });

    it('should return ipc_unavailable when IPC not available for addMembers', async () => {
      const client = new UnixSocketIpcClient({
        socketPath: join(tempDir, 'nonexistent.ipc'),
        timeout: 100,
        maxRetries: 1,
      });

      const result = await client.addMembers('oc_xxx', ['ou_a']);
      expect(result.success).toBe(false);
      expect(result.errorType).toBe('ipc_unavailable');
    });
  });

  describe('ping', () => {
    it('should return true when server responds', async () => {
      const serverSocketPath = await startTestServer(tempDir);
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

  describe('availability', () => {
    it('should return available when connected', async () => {
      const serverSocketPath = await startTestServer(tempDir);
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
