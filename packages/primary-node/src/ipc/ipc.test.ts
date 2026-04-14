/**
 * Tests for IPC module - In-memory transport (Issue #2352).
 *
 * Refactored from real Unix Socket tests to use InMemoryIpcTransport,
 * eliminating filesystem side effects entirely.
 *
 * Benefits:
 * - No socket file pollution on test crash
 * - No parallel test conflicts
 * - No filesystem I/O in unit tests
 * - Cross-platform compatible (works on Windows too)
 *
 * @module ipc/ipc.test
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  UnixSocketIpcServer,
  UnixSocketIpcClient,
  getIpcClient,
  resetIpcClient,
  createInteractiveMessageHandler,
  InMemoryIpcServerTransport,
  InMemoryIpcClientTransport,
} from '@disclaude/core';

// ============================================================================
// Helper: Create paired in-memory server + client transports
// ============================================================================

function createInMemoryPair() {
  const serverTransport = new InMemoryIpcServerTransport();
  const clientTransport = new InMemoryIpcClientTransport(serverTransport);
  return { serverTransport, clientTransport };
}

// ============================================================================
// Server lifecycle tests (using in-memory transport)
// ============================================================================

describe('UnixSocketIpcServer (in-memory transport)', () => {
  let server: UnixSocketIpcServer;
  let serverTransport: InMemoryIpcServerTransport;
  let handler: ReturnType<typeof createInteractiveMessageHandler>;

  const mockContexts = new Map<string, { chatId: string; actionPrompts: Record<string, string> }>();

  beforeEach(() => {
    mockContexts.clear();

    handler = createInteractiveMessageHandler(
      (messageId, chatId, actionPrompts) => {
        mockContexts.set(messageId, { chatId, actionPrompts });
      }
    );

    serverTransport = new InMemoryIpcServerTransport();
    server = new UnixSocketIpcServer(handler, { serverTransport });
  });

  afterEach(async () => {
    await server.stop();
  });

  it('should start and stop successfully', async () => {
    expect(server.isRunning()).toBe(false);

    await server.start();
    expect(server.isRunning()).toBe(true);

    await server.stop();
    expect(server.isRunning()).toBe(false);
  });

  it('should handle multiple start calls gracefully', async () => {
    await server.start();
    await server.start(); // Should not throw
    expect(server.isRunning()).toBe(true);
  });

  it('should handle stop when not running', async () => {
    await server.stop(); // Should not throw
    expect(server.isRunning()).toBe(false);
  });
});

// ============================================================================
// Client + Server communication tests (using in-memory transport)
// ============================================================================

describe('UnixSocketIpcClient (in-memory transport)', () => {
  let server: UnixSocketIpcServer;
  let client: UnixSocketIpcClient;
  const mockContexts = new Map<string, { chatId: string; actionPrompts: Record<string, string> }>();
  let feishuHandlersContainer: { handlers: import('@disclaude/core').FeishuApiHandlers | undefined };

  beforeEach(async () => {
    mockContexts.clear();

    feishuHandlersContainer = {
      handlers: {
        sendMessage: async () => {},
        sendCard: async () => {},
        // eslint-disable-next-line require-await
        uploadFile: async () => ({ fileKey: '', fileType: 'file', fileName: 'f', fileSize: 0 }),
        // eslint-disable-next-line require-await
        sendInteractive: async (_chatId, params) => {
          // Mock handler that returns a messageId
          return { messageId: `om_${params.options[0]?.value}` };
        },
      },
    };

    const handler = createInteractiveMessageHandler(
      (messageId, chatId, actionPrompts) => {
        mockContexts.set(messageId, { chatId, actionPrompts });
      },
      feishuHandlersContainer
    );

    const { serverTransport, clientTransport } = createInMemoryPair();
    server = new UnixSocketIpcServer(handler, { serverTransport });
    client = new UnixSocketIpcClient({ clientTransport, timeout: 2000 });

    await server.start();
  });

  afterEach(async () => {
    await client.disconnect();
    await server.stop();
  });

  it('should connect and disconnect', async () => {
    expect(client.isConnected()).toBe(false);

    await client.connect();
    expect(client.isConnected()).toBe(true);

    await client.disconnect();
    expect(client.isConnected()).toBe(false);
  });

  it('should ping the server', async () => {
    const result = await client.ping();
    expect(result).toBe(true);
  });

  it('should handle multiple connect calls', async () => {
    await client.connect();
    await client.connect(); // Should not throw
    expect(client.isConnected()).toBe(true);
  });

  it('should send interactive card via sendInteractive IPC', async () => {
    const result = await client.sendInteractive('chat-1', {
      question: 'Choose an option:',
      options: [
        { text: 'Confirm', value: 'confirm', type: 'primary' },
        { text: 'Cancel', value: 'cancel' },
      ],
      title: 'Action Required',
      context: 'Some context',
      actionPrompts: { confirm: 'User confirmed', cancel: 'User cancelled' },
    });

    expect(result.success).toBe(true);
    expect(result.messageId).toBe('om_confirm');
  });
});

// ============================================================================
// Singleton management tests (no transport needed)
// ============================================================================

describe('getIpcClient singleton', () => {
  beforeEach(() => {
    resetIpcClient();
  });

  afterEach(() => {
    resetIpcClient();
  });

  it('should return the same instance', () => {
    const client1 = getIpcClient();
    const client2 = getIpcClient();
    expect(client1).toBe(client2);
  });

  it('should reset to a new instance', () => {
    const client1 = getIpcClient();
    resetIpcClient();
    const client2 = getIpcClient();
    expect(client1).not.toBe(client2);
  });
});

// ============================================================================
// Graceful Fallback tests (using in-memory transport)
// Issue #1079: Client availability checks and error handling
// ============================================================================

describe('UnixSocketIpcClient - Graceful Fallback (in-memory transport)', () => {
  beforeEach(() => {
    resetIpcClient();
  });

  afterEach(() => {
    resetIpcClient();
  });

  describe('checkAvailability', () => {
    it('should return socket_not_found when server not started', async () => {
      const serverTransport = new InMemoryIpcServerTransport();
      const clientTransport = new InMemoryIpcClientTransport(serverTransport);
      // Server transport NOT started → endpoint doesn't exist

      const client = new UnixSocketIpcClient({ clientTransport, timeout: 500 });
      const status = await client.checkAvailability();

      expect(status.available).toBe(false);
      if (!status.available) {
        expect(status.reason).toBe('socket_not_found');
      }
    });

    it('should return available when server is running', async () => {
      const serverTransport = new InMemoryIpcServerTransport();
      const clientTransport = new InMemoryIpcClientTransport(serverTransport);

      const handler = createInteractiveMessageHandler(() => {});
      const server = new UnixSocketIpcServer(handler, { serverTransport });
      await server.start();

      const client = new UnixSocketIpcClient({ clientTransport, timeout: 500 });
      const status = await client.checkAvailability();

      expect(status.available).toBe(true);

      await client.disconnect();
      await server.stop();
    });

    it('should cache availability result', async () => {
      const serverTransport = new InMemoryIpcServerTransport();
      const clientTransport = new InMemoryIpcClientTransport(serverTransport);

      const client = new UnixSocketIpcClient({ clientTransport, timeout: 500 });

      // First check
      const status1 = await client.checkAvailability();
      expect(status1.available).toBe(false);

      // Second check should return cached result
      const status2 = await client.checkAvailability();
      expect(status2).toBe(status1);
    });
  });

  describe('isAvailable', () => {
    it('should return false when server not started', () => {
      const serverTransport = new InMemoryIpcServerTransport();
      const clientTransport = new InMemoryIpcClientTransport(serverTransport);

      const client = new UnixSocketIpcClient({ clientTransport, timeout: 500 });
      expect(client.isAvailable()).toBe(false);
    });

    it('should return true when connected', async () => {
      const serverTransport = new InMemoryIpcServerTransport();
      const clientTransport = new InMemoryIpcClientTransport(serverTransport);

      const handler = createInteractiveMessageHandler(() => {});
      const server = new UnixSocketIpcServer(handler, { serverTransport });
      await server.start();

      const client = new UnixSocketIpcClient({ clientTransport, timeout: 500 });
      await client.connect();

      expect(client.isAvailable()).toBe(true);

      await client.disconnect();
      await server.stop();
    });
  });

  describe('error handling', () => {
    it('should include IPC_NOT_AVAILABLE prefix when server not available', async () => {
      const serverTransport = new InMemoryIpcServerTransport();
      const clientTransport = new InMemoryIpcClientTransport(serverTransport);

      const client = new UnixSocketIpcClient({ clientTransport, timeout: 100, maxRetries: 1 });

      await expect(client.request('ping', {})).rejects.toThrow('IPC_NOT_AVAILABLE:');
    });
  });

  describe('invalidateAvailabilityCache', () => {
    it('should clear cached availability', async () => {
      const serverTransport = new InMemoryIpcServerTransport();
      const clientTransport = new InMemoryIpcClientTransport(serverTransport);

      const client = new UnixSocketIpcClient({ clientTransport, timeout: 500 });

      // First check caches the result
      const status1 = await client.checkAvailability();
      expect(status1.available).toBe(false);

      // Invalidate cache
      client.invalidateAvailabilityCache();

      // Check again - should be a new object
      const status2 = await client.checkAvailability();
      expect(status2).not.toBe(status1);
    });
  });
});
