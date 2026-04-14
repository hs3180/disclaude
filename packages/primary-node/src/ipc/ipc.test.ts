/**
 * Tests for IPC module — In-memory transport, no filesystem side effects.
 *
 * Issue #2352: Refactored to use InMemoryIpcTransport pattern (like ACP MockTransport).
 * All tests run purely in memory without creating real Unix socket files.
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
  createInMemoryTransportPair,
} from '@disclaude/core';

// ============================================================================
// Helpers
// ============================================================================

/** Create a connected server+client pair using in-memory transport */
function createTestPair() {
  const { serverTransport, clientTransport } = createInMemoryTransportPair();
  return { serverTransport, clientTransport };
}

// ============================================================================
// UnixSocketIpcServer
// ============================================================================

describe('UnixSocketIpcServer', () => {
  let server: UnixSocketIpcServer;
  let handler: ReturnType<typeof createInteractiveMessageHandler>;

  const mockContexts = new Map<string, { chatId: string; actionPrompts: Record<string, string> }>();

  beforeEach(() => {
    mockContexts.clear();

    handler = createInteractiveMessageHandler(
      (messageId, chatId, actionPrompts) => {
        mockContexts.set(messageId, { chatId, actionPrompts });
      }
    );
  });

  afterEach(async () => {
    await server.stop();
  });

  it('should start and stop successfully', async () => {
    const { serverTransport, clientTransport } = createTestPair();
    server = new UnixSocketIpcServer(handler, {
      socketPath: 'mock://test',
      testConnection: { server: serverTransport, client: clientTransport },
    });

    expect(server.isRunning()).toBe(false);

    await server.start();
    expect(server.isRunning()).toBe(true);
    expect(server.getSocketPath()).toBe('mock://test');

    await server.stop();
    expect(server.isRunning()).toBe(false);
  });

  it('should handle multiple start calls gracefully', async () => {
    const { serverTransport, clientTransport } = createTestPair();
    server = new UnixSocketIpcServer(handler, {
      socketPath: 'mock://test',
      testConnection: { server: serverTransport, client: clientTransport },
    });

    await server.start();
    await server.start(); // Should not throw
    expect(server.isRunning()).toBe(true);
  });

  it('should handle stop when not running', async () => {
    const { serverTransport, clientTransport } = createTestPair();
    server = new UnixSocketIpcServer(handler, {
      socketPath: 'mock://test',
      testConnection: { server: serverTransport, client: clientTransport },
    });

    await server.stop(); // Should not throw
    expect(server.isRunning()).toBe(false);
  });
});

// ============================================================================
// UnixSocketIpcClient
// ============================================================================

describe('UnixSocketIpcClient', () => {
  let server: UnixSocketIpcServer;
  let client: UnixSocketIpcClient;
  const mockContexts = new Map<string, { chatId: string; actionPrompts: Record<string, string> }>();

  beforeEach(async () => {
    mockContexts.clear();

    const channelHandlers = {
      sendMessage: async () => {},
      sendCard: async () => {},
      // eslint-disable-next-line require-await
      uploadFile: async () => ({ fileKey: '', fileType: 'file', fileName: 'f', fileSize: 0 }),
      // eslint-disable-next-line require-await
      sendInteractive: async (_chatId: string, params: { options: Array<{ value: string }> }) => {
        // Mock handler that returns a messageId
        return { messageId: `om_${params.options[0]?.value}` };
      },
    };

    const handler = createInteractiveMessageHandler(
      (messageId, chatId, actionPrompts) => {
        mockContexts.set(messageId, { chatId, actionPrompts });
      },
      { handlers: channelHandlers }
    );

    const { serverTransport, clientTransport } = createTestPair();

    server = new UnixSocketIpcServer(handler, {
      socketPath: 'mock://test',
      testConnection: { server: serverTransport, client: clientTransport },
    });

    client = new UnixSocketIpcClient({
      socketPath: 'mock://test',
      timeout: 2000,
      testTransport: server.getTestClientTransport(),
    });

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
// getIpcClient singleton
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
// Graceful Fallback (Issue #1079)
// ============================================================================

describe('UnixSocketIpcClient - Graceful Fallback (Issue #1079)', () => {
  describe('checkAvailability', () => {
    it('should return available when connected via test transport', async () => {
      const handler = createInteractiveMessageHandler(() => {});
      const { serverTransport, clientTransport } = createTestPair();

      const server = new UnixSocketIpcServer(handler, {
        socketPath: 'mock://test',
        testConnection: { server: serverTransport, client: clientTransport },
      });
      await server.start();

      const client = new UnixSocketIpcClient({
        socketPath: 'mock://test',
        timeout: 500,
        testTransport: server.getTestClientTransport(),
      });

      await client.connect();
      const status = await client.checkAvailability();

      expect(status.available).toBe(true);

      await client.disconnect();
      await server.stop();
    });

    it('should cache availability result', async () => {
      const handler = createInteractiveMessageHandler(() => {});
      const { serverTransport, clientTransport } = createTestPair();

      const server = new UnixSocketIpcServer(handler, {
        socketPath: 'mock://test',
        testConnection: { server: serverTransport, client: clientTransport },
      });
      await server.start();

      const client = new UnixSocketIpcClient({
        socketPath: 'mock://test',
        timeout: 500,
        testTransport: server.getTestClientTransport(),
      });
      await client.connect();

      // First check
      const status1 = await client.checkAvailability();
      expect(status1.available).toBe(true);

      // Second check should return cached result
      const status2 = await client.checkAvailability();
      expect(status2).toBe(status1);

      await client.disconnect();
      await server.stop();
    });
  });

  describe('isAvailable', () => {
    it('should return true when connected via test transport', async () => {
      const handler = createInteractiveMessageHandler(() => {});
      const { serverTransport, clientTransport } = createTestPair();

      const server = new UnixSocketIpcServer(handler, {
        socketPath: 'mock://test',
        testConnection: { server: serverTransport, client: clientTransport },
      });
      await server.start();

      const client = new UnixSocketIpcClient({
        socketPath: 'mock://test',
        timeout: 500,
        testTransport: server.getTestClientTransport(),
      });
      await client.connect();

      expect(client.isAvailable()).toBe(true);

      await client.disconnect();
      await server.stop();
    });
  });

  describe('error handling', () => {
    it('should return socket_not_found when socket does not exist (real mode)', async () => {
      // This test uses a real client without test transport to verify
      // the socket-not-found path — but with a non-existent path so no files are created
      const client = new UnixSocketIpcClient({
        socketPath: `/tmp/disclaude-test-nonexistent-${Date.now()}.sock`,
        timeout: 500,
      });
      const status = await client.checkAvailability();

      expect(status.available).toBe(false);
      if (!status.available) {
        expect(status.reason).toBe('socket_not_found');
      }
    });

    it('should include IPC_NOT_AVAILABLE prefix when socket not found', async () => {
      // Real client with non-existent path
      const client = new UnixSocketIpcClient({
        socketPath: `/tmp/disclaude-test-nonexistent-${Date.now()}.sock`,
        timeout: 100,
        maxRetries: 1,
      });

      await expect(client.request('ping', {})).rejects.toThrow('IPC_NOT_AVAILABLE:');
    });
  });

  describe('invalidateAvailabilityCache', () => {
    it('should clear cached availability', async () => {
      const handler = createInteractiveMessageHandler(() => {});
      const { serverTransport, clientTransport } = createTestPair();

      const server = new UnixSocketIpcServer(handler, {
        socketPath: 'mock://test',
        testConnection: { server: serverTransport, client: clientTransport },
      });
      await server.start();

      const client = new UnixSocketIpcClient({
        socketPath: 'mock://test',
        timeout: 500,
        testTransport: server.getTestClientTransport(),
      });
      await client.connect();

      // First check caches the result
      const status1 = await client.checkAvailability();
      expect(status1.available).toBe(true);

      // Invalidate cache
      client.invalidateAvailabilityCache();

      // Check again - should be a new object
      const status2 = await client.checkAvailability();
      expect(status2).not.toBe(status1);

      await client.disconnect();
      await server.stop();
    });
  });
});

// ============================================================================
// In-memory transport pair
// ============================================================================

describe('createInMemoryTransportPair', () => {
  it('should transmit data from client to server', () => {
    const { serverTransport, clientTransport } = createInMemoryTransportPair();

    const received: string[] = [];
    serverTransport.onData((data) => received.push(data));

    clientTransport.write('hello from client\n');
    expect(received).toEqual(['hello from client\n']);
  });

  it('should transmit data from server to client', () => {
    const { serverTransport, clientTransport } = createInMemoryTransportPair();

    const received: string[] = [];
    clientTransport.onData((data) => received.push(data));

    serverTransport.write('hello from server\n');
    expect(received).toEqual(['hello from server\n']);
  });

  it('should notify the other side on destroy', () => {
    const { serverTransport, clientTransport } = createInMemoryTransportPair();

    let clientClosed = false;
    clientTransport.onClose(() => { clientClosed = true; });

    serverTransport.destroy();
    expect(clientClosed).toBe(true);
  });

  it('should support bidirectional communication', () => {
    const { serverTransport, clientTransport } = createInMemoryTransportPair();

    const serverReceived: string[] = [];
    const clientReceived: string[] = [];

    serverTransport.onData((data) => serverReceived.push(data));
    clientTransport.onData((data) => clientReceived.push(data));

    // Client sends request
    clientTransport.write('{"type":"ping","id":"1","payload":{}}\n');
    expect(serverReceived).toHaveLength(1);

    // Server sends response
    serverTransport.write('{"id":"1","success":true,"payload":{"pong":true}}\n');
    expect(clientReceived).toHaveLength(1);
  });
});
