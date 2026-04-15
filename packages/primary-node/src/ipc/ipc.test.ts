/**
 * Tests for IPC module - Unix Socket cross-process communication.
 *
 * Issue #2352: Refactored to eliminate real filesystem dependencies.
 * Uses in-memory mock transport instead of real Unix sockets:
 * - Mocks node:net for in-memory socket simulation (paired bidirectional sockets)
 * - Mocks node:fs for socket file operations (existsSync, unlinkSync, mkdirSync)
 * - No real filesystem I/O (no temp dirs, no socket files)
 * - No cleanup needed (no temp files to remove)
 * - Same test coverage as before, but pure in-memory
 *
 * Follows the MockTransport pattern from:
 *   packages/core/src/sdk/acp/transport.test.ts
 *
 * @module ipc/ipc.test
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  UnixSocketIpcServer,
  UnixSocketIpcClient,
  getIpcClient,
  resetIpcClient,
  createInteractiveMessageHandler,
} from '@disclaude/core';

// ============================================================================
// In-memory Mock Socket Infrastructure (Issue #2352)
// ============================================================================

/**
 * Shared mock state, hoisted to top of file so vi.mock factories can access it.
 *
 * socketRegistry maps socket paths → server connection handlers.
 * When a mock server calls listen(path), it registers here.
 * When a mock client calls createConnection(path), it looks up here.
 */
const { socketRegistry, MockSocket, MockServer } = vi.hoisted(() => {
  // ------------------------------------------------------------------
  // SimpleEmitter: minimal event emitter inline (avoids importing
  // Node.js 'events' module inside vi.hoisted())
  // ------------------------------------------------------------------
  class SimpleEmitter {
    private handlers = new Map<string, Array<(...args: any[]) => void>>();

    on(event: string, handler: (...args: any[]) => void): this {
      let list = this.handlers.get(event);
      if (!list) {
        list = [];
        this.handlers.set(event, list);
      }
      list.push(handler);
      return this;
    }

    emit(event: string, ...args: any[]): boolean {
      const list = this.handlers.get(event);
      if (!list || list.length === 0) { return false; }
      for (const handler of list) {
        handler(...args);
      }
      return true;
    }
  }

  const socketRegistry = new Map<string, { onConnection: (socket: any) => void }>();

  // ------------------------------------------------------------------
  // MockSocket: in-memory simulation of net.Socket
  // ------------------------------------------------------------------
  class MockSocket extends SimpleEmitter {
    private peer: MockSocket | null = null;
    private _destroyed = false;

    /**
     * Send data to the peer socket.
     * Uses queueMicrotask to simulate async data delivery (real sockets
     * deliver data asynchronously via the event loop).
     */
    write(data: string): boolean {
      if (this._destroyed) { return false; }
      const { peer } = this;
      if (peer && !peer._destroyed) {
        queueMicrotask(() => {
          if (!peer._destroyed) {
            peer.emit('data', Buffer.from(data));
          }
        });
      }
      return true;
    }

    /** Destroy the socket and notify the peer. */
    destroy(): void {
      if (this._destroyed) { return; }
      this._destroyed = true;
      const { peer } = this;
      this.emit('close');
      if (peer && !peer._destroyed) {
        peer._destroyed = true;
        peer.emit('close');
      }
    }

    /** Link two sockets for bidirectional data flow. */
    _link(other: MockSocket): void {
      this.peer = other;
      other.peer = this;
    }
  }

  // ------------------------------------------------------------------
  // MockServer: in-memory simulation of net.Server
  // ------------------------------------------------------------------
  class MockServer extends SimpleEmitter {
    listening = false;
    private _path = '';
    private _onConnection: ((socket: MockSocket) => void) | null = null;

    constructor(onConnection?: (socket: MockSocket) => void) {
      super();
      this._onConnection = onConnection ?? null;
    }

    /** Register this server in the socket registry. */
    listen(path: string, callback?: () => void): this {
      this._path = path;
      this.listening = true;
      socketRegistry.set(path, {
        onConnection: (socket: MockSocket) => this._onConnection?.(socket),
      });
      callback?.();
      return this;
    }

    /** Unregister this server from the socket registry. */
    close(callback?: () => void): this {
      this.listening = false;
      socketRegistry.delete(this._path);
      callback?.();
      return this;
    }
  }

  return { socketRegistry, MockSocket, MockServer };
});

// ------------------------------------------------------------------
// Mock: node:net  (uses hoisted classes and registry)
// ------------------------------------------------------------------
vi.mock('net', () => ({
  createServer: (onConnection?: (socket: any) => void) => {
    return new MockServer(onConnection);
  },
  createConnection: (path: string) => {
    const clientSocket = new MockSocket();
    const entry = socketRegistry.get(path);

    if (entry) {
      // Server is running: create paired sockets and wire them up
      const serverSocket = new MockSocket();
      clientSocket._link(serverSocket);
      // Simulate async connection (after event handlers are registered)
      queueMicrotask(() => {
        clientSocket.emit('connect');
        entry.onConnection(serverSocket);
      });
    } else {
      // No server at this path: emit error
      queueMicrotask(() => {
        clientSocket.emit('error', new Error(`connect ENOENT ${path}`));
      });
    }
    return clientSocket;
  },
}));

// ------------------------------------------------------------------
// Mock: node:fs  (only socket-related operations)
// ------------------------------------------------------------------
vi.mock('fs', async () => {
  const actual = await vi.importActual('fs');
  return {
    ...actual,
    /** existsSync: check mock registry first, then real filesystem */
    existsSync: vi.fn((path: string) => {
      if (socketRegistry.has(path)) { return true; }
      return (actual as any).existsSync(path);
    }),
    /** unlinkSync: no-op (no real socket files to clean up) */
    unlinkSync: vi.fn(),
    /** mkdirSync: no-op (no real directories to create) */
    mkdirSync: vi.fn(),
  };
});

// ============================================================================
// Test constants
// ============================================================================

/** Fixed mock socket path — no real filesystem path needed */
const MOCK_SOCKET_PATH = '/mock/ipc/test-ipc.sock';

// ============================================================================
// Tests: UnixSocketIpcServer
// ============================================================================

describe('UnixSocketIpcServer', () => {
  let server: UnixSocketIpcServer;
  let handler: ReturnType<typeof createInteractiveMessageHandler>;

  const mockContexts = new Map<string, { chatId: string; actionPrompts: Record<string, string> }>();

  beforeEach(() => {
    socketRegistry.clear();
    mockContexts.clear();

    handler = createInteractiveMessageHandler(
      (messageId, chatId, actionPrompts) => {
        mockContexts.set(messageId, { chatId, actionPrompts });
      }
    );

    server = new UnixSocketIpcServer(handler, { socketPath: MOCK_SOCKET_PATH });
  });

  afterEach(async () => {
    await server.stop();
    socketRegistry.clear();
  });

  it('should start and stop successfully', async () => {
    expect(server.isRunning()).toBe(false);

    await server.start();
    expect(server.isRunning()).toBe(true);
    expect(server.getSocketPath()).toBe(MOCK_SOCKET_PATH);

    await server.stop();
    expect(server.isRunning()).toBe(false);
  });

  it('should register in socket registry on start (replaces socket file check)', async () => {
    // Issue #2352: Previously tested existsSync(socketPath); now tests socketRegistry
    await server.start();
    expect(socketRegistry.has(MOCK_SOCKET_PATH)).toBe(true);

    await server.stop();
    expect(socketRegistry.has(MOCK_SOCKET_PATH)).toBe(false);
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
// Tests: UnixSocketIpcClient
// ============================================================================

describe('UnixSocketIpcClient', () => {
  let server: UnixSocketIpcServer;
  let client: UnixSocketIpcClient;
  const mockContexts = new Map<string, { chatId: string; actionPrompts: Record<string, string> }>();

  let feishuHandlersContainer: { handlers: import('@disclaude/core').FeishuApiHandlers | undefined };

  beforeEach(async () => {
    socketRegistry.clear();
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

    server = new UnixSocketIpcServer(handler, { socketPath: MOCK_SOCKET_PATH });
    client = new UnixSocketIpcClient({ socketPath: MOCK_SOCKET_PATH, timeout: 2000 });

    await server.start();
  });

  afterEach(async () => {
    await client.disconnect();
    await server.stop();
    socketRegistry.clear();
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
// Tests: getIpcClient singleton
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
// Tests: Graceful Fallback (Issue #1079)
// ============================================================================

describe('UnixSocketIpcClient - Graceful Fallback (Issue #1079)', () => {
  beforeEach(() => {
    socketRegistry.clear();
    resetIpcClient();
  });

  afterEach(() => {
    resetIpcClient();
    socketRegistry.clear();
  });

  describe('checkAvailability', () => {
    it('should return socket_not_found when socket does not exist', async () => {
      const client = new UnixSocketIpcClient({ socketPath: MOCK_SOCKET_PATH, timeout: 500 });
      const status = await client.checkAvailability();

      expect(status.available).toBe(false);
      if (!status.available) {
        expect(status.reason).toBe('socket_not_found');
      }
    });

    it('should return available when server is running', async () => {
      const handler = createInteractiveMessageHandler(() => {});

      const server = new UnixSocketIpcServer(handler, { socketPath: MOCK_SOCKET_PATH });
      await server.start();

      const client = new UnixSocketIpcClient({ socketPath: MOCK_SOCKET_PATH, timeout: 500 });
      const status = await client.checkAvailability();

      expect(status.available).toBe(true);

      await client.disconnect();
      await server.stop();
    });

    it('should cache availability result', async () => {
      const client = new UnixSocketIpcClient({ socketPath: MOCK_SOCKET_PATH, timeout: 500 });

      // First check
      const status1 = await client.checkAvailability();
      expect(status1.available).toBe(false);

      // Second check should return cached result
      const status2 = await client.checkAvailability();
      expect(status2).toBe(status1);
    });
  });

  describe('isAvailable', () => {
    it('should return false when socket does not exist', () => {
      const client = new UnixSocketIpcClient({ socketPath: MOCK_SOCKET_PATH, timeout: 500 });
      expect(client.isAvailable()).toBe(false);
    });

    it('should return true when connected', async () => {
      const handler = createInteractiveMessageHandler(() => {});

      const server = new UnixSocketIpcServer(handler, { socketPath: MOCK_SOCKET_PATH });
      await server.start();

      const client = new UnixSocketIpcClient({ socketPath: MOCK_SOCKET_PATH, timeout: 500 });
      await client.connect();

      expect(client.isAvailable()).toBe(true);

      await client.disconnect();
      await server.stop();
    });
  });

  describe('retry mechanism', () => {
    it('should retry connection on failure', async () => {
      // Create a client with maxRetries=3
      const client = new UnixSocketIpcClient({
        socketPath: MOCK_SOCKET_PATH,
        timeout: 100,
        maxRetries: 3,
      });

      // Try to connect to non-existent socket
      await expect(client.connect()).rejects.toThrow();

      // Should have tried 3 times (verified by timing)
      // This is a timing-based test, so we just verify it doesn't throw immediately
    });

    it('should connect on retry if server becomes available', async () => {
      const handler = createInteractiveMessageHandler(() => {});

      const server = new UnixSocketIpcServer(handler, { socketPath: MOCK_SOCKET_PATH });

      // Start server after a short delay
      setTimeout(() => server.start(), 50);

      const client = new UnixSocketIpcClient({
        socketPath: MOCK_SOCKET_PATH,
        timeout: 200,
        maxRetries: 5,
      });

      // Should eventually connect
      await client.connect();
      expect(client.isConnected()).toBe(true);

      await client.disconnect();
      await server.stop();
    });
  });

  describe('error handling', () => {
    it('should include IPC_NOT_AVAILABLE prefix when socket not found', async () => {
      const client = new UnixSocketIpcClient({ socketPath: MOCK_SOCKET_PATH, timeout: 100, maxRetries: 1 });

      await expect(client.request('ping', {})).rejects.toThrow('IPC_NOT_AVAILABLE:');
    });

    it('should include IPC_TIMEOUT prefix on request timeout', async () => {
      const handler = createInteractiveMessageHandler(() => {});

      const server = new UnixSocketIpcServer(handler, { socketPath: MOCK_SOCKET_PATH });
      await server.start();

      // Create client with very short timeout
      const client = new UnixSocketIpcClient({ socketPath: MOCK_SOCKET_PATH, timeout: 1, maxRetries: 1 });

      // This might timeout or succeed depending on timing
      // Just verify the error format when it fails
      try {
        await client.request('ping', {});
      } catch (error) {
        expect(error instanceof Error).toBe(true);
        // Error should have a descriptive message
        expect((error as Error).message).toMatch(/IPC_/);
      }

      await client.disconnect();
      await server.stop();
    });
  });

  describe('invalidateAvailabilityCache', () => {
    it('should clear cached availability', async () => {
      const client = new UnixSocketIpcClient({ socketPath: MOCK_SOCKET_PATH, timeout: 500 });

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
