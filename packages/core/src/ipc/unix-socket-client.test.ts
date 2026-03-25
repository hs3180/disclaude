/**
 * Comprehensive tests for IPC Client.
 *
 * Tests client helper functions and client methods with real server integration.
 * @module ipc/unix-socket-client.test
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { tmpdir } from 'os';
import { join } from 'path';
import { unlinkSync, existsSync } from 'fs';
import {
  UnixSocketIpcClient,
  UnixSocketIpcServer,
  createInteractiveMessageHandler,
  getIpcSocketPath,
  getIpcClient,
  resetIpcClient,
  type FeishuApiHandlers,
  type FeishuHandlersContainer,
} from './index.js';

function generateTestSocketPath(): string {
  return join(tmpdir(), `disclaude-test-${Date.now()}-${Math.random().toString(36).slice(2)}.sock`);
}

describe('getIpcSocketPath', () => {
  const originalEnv = process.env;

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it('should prefer DISCLAUDE_WORKER_IPC_SOCKET env var', () => {
    process.env.DISCLAUDE_WORKER_IPC_SOCKET = '/tmp/worker.ipc';
    process.env.DISCLAUDE_IPC_SOCKET_PATH = '/tmp/custom.ipc';
    expect(getIpcSocketPath()).toBe('/tmp/worker.ipc');
  });

  it('should fall back to DISCLAUDE_IPC_SOCKET_PATH', () => {
    delete process.env.DISCLAUDE_WORKER_IPC_SOCKET;
    process.env.DISCLAUDE_IPC_SOCKET_PATH = '/tmp/custom.ipc';
    expect(getIpcSocketPath()).toBe('/tmp/custom.ipc');
  });

  it('should use default path when no env vars set', () => {
    delete process.env.DISCLAUDE_WORKER_IPC_SOCKET;
    delete process.env.DISCLAUDE_IPC_SOCKET_PATH;
    expect(getIpcSocketPath()).toBe('/tmp/disclaude-interactive.ipc');
  });
});

describe('getIpcClient / resetIpcClient', () => {
  beforeEach(() => {
    resetIpcClient();
  });

  afterEach(() => {
    resetIpcClient();
  });

  it('should return the same instance on repeated calls', () => {
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

describe('UnixSocketIpcClient - client methods with real server', () => {
  let server: UnixSocketIpcServer;
  let client: UnixSocketIpcClient;
  let socketPath: string;
  const registeredPrompts = new Map<string, { chatId: string; prompts: Record<string, string> }>();

  function createServerAndClient(maxRetries = 3) {
    const mockSendInteractive = vi.fn().mockImplementation(async (_chatId: string, params: any) => {
      return { messageId: `om_${params.options[0]?.value}` };
    });
    const container: FeishuHandlersContainer = {
      handlers: {
        sendMessage: vi.fn().mockResolvedValue(undefined),
        sendCard: vi.fn().mockResolvedValue(undefined),
        uploadFile: vi.fn().mockResolvedValue({ fileKey: 'fk', fileType: 'pdf', fileName: 'f.pdf', fileSize: 100 }),
        sendInteractive: mockSendInteractive,
      },
    };

    const handler = createInteractiveMessageHandler(
      (messageId, chatId, actionPrompts) => {
        registeredPrompts.set(messageId, { chatId, prompts: actionPrompts });
      },
      container
    );

    server = new UnixSocketIpcServer(handler, { socketPath });
    client = new UnixSocketIpcClient({ socketPath, timeout: 2000, maxRetries });
  }

  beforeEach(async () => {
    socketPath = generateTestSocketPath();
    registeredPrompts.clear();
    createServerAndClient();
    await server.start();
  });

  afterEach(async () => {
    await client.disconnect();
    await server.stop();
    if (existsSync(socketPath)) {
      try { unlinkSync(socketPath); } catch { /* ignore */ }
    }
  });

  it('should send message via sendMessage', async () => {
    const result = await client.sendMessage('chat-1', 'Hello world', 'thread-1');
    expect(result.success).toBe(true);
  });

  it('should send card via sendCard', async () => {
    const result = await client.sendCard('chat-1', { type: 'text', content: 'test' });
    expect(result.success).toBe(true);
  });

  it('should upload file via uploadFile', async () => {
    const result = await client.uploadFile('chat-1', '/path/to/file.pdf');
    expect(result.success).toBe(true);
    expect(result.fileKey).toBe('fk');
    expect(result.fileType).toBe('pdf');
    expect(result.fileName).toBe('f.pdf');
    expect(result.fileSize).toBe(100);
  });

  it('should send interactive card via sendInteractive', async () => {
    const result = await client.sendInteractive('chat-1', {
      question: 'Choose:',
      options: [
        { text: 'Confirm', value: 'confirm', type: 'primary' },
        { text: 'Cancel', value: 'cancel' },
      ],
      title: 'Action',
      actionPrompts: { confirm: 'Confirmed', cancel: 'Cancelled' },
    });

    expect(result.success).toBe(true);
    expect(result.messageId).toBe('om_confirm');
  });

  it('should return error with IPC_NOT_AVAILABLE prefix when disconnected', async () => {
    await client.disconnect();
    // Create a new client pointing to a non-existent socket
    const badClient = new UnixSocketIpcClient({
      socketPath: '/tmp/nonexistent-' + Date.now() + '.sock',
      timeout: 100,
      maxRetries: 1,
    });

    try {
      await badClient.request('ping', {});
      expect.unreachable('Should have thrown');
    } catch (error) {
      expect((error as Error).message).toMatch(/^IPC_NOT_AVAILABLE:/);
    }
  });

  it('should connect on first request if not connected', async () => {
    expect(client.isConnected()).toBe(false);
    const result = await client.ping();
    expect(result).toBe(true);
    expect(client.isConnected()).toBe(true);
  });

  it('should handle disconnect gracefully', async () => {
    await client.connect();
    expect(client.isConnected()).toBe(true);
    await client.disconnect();
    expect(client.isConnected()).toBe(false);
    expect(client.isConnected()).toBe(false);
  });

  describe('sendMessage error handling', () => {
    it('should return error details when server handler fails', async () => {
      // Stop server and create one with failing handler
      await server.stop();
      if (existsSync(socketPath)) {
        try { unlinkSync(socketPath); } catch { /* ignore */ }
      }

      const container: FeishuHandlersContainer = {
        handlers: {
          sendMessage: vi.fn().mockRejectedValue(new Error('Permission denied')),
          sendCard: vi.fn().mockResolvedValue(undefined),
          uploadFile: vi.fn().mockResolvedValue({ fileKey: '', fileType: 'file', fileName: 'f', fileSize: 0 }),
          sendInteractive: vi.fn().mockResolvedValue({ messageId: 'om_1' }),
        },
      };
      const handler = createInteractiveMessageHandler(() => {}, container);
      server = new UnixSocketIpcServer(handler, { socketPath });
      await server.start();

      // Reconnect client
      await client.disconnect();
      client = new UnixSocketIpcClient({ socketPath, timeout: 2000 });
      await client.connect();

      const result = await client.sendMessage('chat-1', 'test');
      expect(result.success).toBe(false);
      expect(result.error).toContain('Permission denied');
      expect(result.errorType).toBe('ipc_request_failed');
    });
  });

  describe('sendCard error handling', () => {
    it('should return error when server handler rejects', async () => {
      await server.stop();
      if (existsSync(socketPath)) {
        try { unlinkSync(socketPath); } catch { /* ignore */ }
      }

      const container: FeishuHandlersContainer = {
        handlers: {
          sendMessage: vi.fn().mockResolvedValue(undefined),
          sendCard: vi.fn().mockRejectedValue(new Error('Card rejected')),
          uploadFile: vi.fn().mockResolvedValue({ fileKey: '', fileType: 'file', fileName: 'f', fileSize: 0 }),
          sendInteractive: vi.fn().mockResolvedValue({ messageId: 'om_1' }),
        },
      };
      const handler = createInteractiveMessageHandler(() => {}, container);
      server = new UnixSocketIpcServer(handler, { socketPath });
      await server.start();

      await client.disconnect();
      client = new UnixSocketIpcClient({ socketPath, timeout: 2000 });
      await client.connect();

      const result = await client.sendCard('chat-1', {});
      expect(result.success).toBe(false);
      expect(result.error).toContain('Card rejected');
    });
  });

  describe('sendInteractive error handling', () => {
    it('should return error when server handler rejects', async () => {
      await server.stop();
      if (existsSync(socketPath)) {
        try { unlinkSync(socketPath); } catch { /* ignore */ }
      }

      const container: FeishuHandlersContainer = {
        handlers: {
          sendMessage: vi.fn().mockResolvedValue(undefined),
          sendCard: vi.fn().mockResolvedValue(undefined),
          uploadFile: vi.fn().mockResolvedValue({ fileKey: '', fileType: 'file', fileName: 'f', fileSize: 0 }),
          sendInteractive: vi.fn().mockRejectedValue(new Error('Build failed')),
        },
      };
      const handler = createInteractiveMessageHandler(() => {}, container);
      server = new UnixSocketIpcServer(handler, { socketPath });
      await server.start();

      await client.disconnect();
      client = new UnixSocketIpcClient({ socketPath, timeout: 2000 });
      await client.connect();

      const result = await client.sendInteractive('chat-1', {
        question: 'Choose:',
        options: [{ text: 'A', value: 'a' }],
      });
      expect(result.success).toBe(false);
      expect(result.error).toContain('Build failed');
    });
  });

  describe('availability checks', () => {
    it('should report available when connected', async () => {
      await client.connect();
      expect(client.isAvailable()).toBe(true);
    });

    it('should cache availability check result', async () => {
      const status1 = await client.checkAvailability();
      expect(status1.available).toBe(true);
      // Second call should return cached result
      const status2 = await client.checkAvailability();
      expect(status2).toBe(status1);
    });

    it('should invalidate availability cache', async () => {
      const status1 = await client.checkAvailability();
      client.invalidateAvailabilityCache();
      const status2 = await client.checkAvailability();
      // Should be a new check (not same reference)
      expect(status2).not.toBe(status1);
    });

    it('should return socket_not_found when socket does not exist', async () => {
      const badClient = new UnixSocketIpcClient({
        socketPath: '/tmp/nonexistent-' + Date.now() + '.sock',
        timeout: 100,
        maxRetries: 1,
      });
      const status = await badClient.checkAvailability();
      expect(status.available).toBe(false);
      if (!status.available) {
        expect(status.reason).toBe('socket_not_found');
      }
    });
  });
});
