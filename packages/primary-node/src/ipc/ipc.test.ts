/**
 * Tests for IPC module - using InMemoryIpcTransport (Issue #2352).
 *
 * Follows the ACP MockTransport pattern:
 * - `IIpcServerTransport` / `IIpcClientTransport` interfaces in production code
 * - `InMemoryIpcTransport` implementations in this test file
 * - `UnixSocketIpcServer` / `UnixSocketIpcClient` accept optional transport injection
 *
 * Benefits:
 * - Zero filesystem side effects (no Unix socket files created)
 * - No try/finally cleanup needed (no resources to leak)
 * - Fully portable (works on Windows, CI, parallel test runs)
 * - Same test coverage as real-socket tests
 *
 * @module ipc/ipc.test
 * @see Issue #2352
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  UnixSocketIpcServer,
  UnixSocketIpcClient,
  getIpcClient,
  resetIpcClient,
  createInteractiveMessageHandler,
  type IpcConnectionLike,
  type IIpcServerTransport,
  type IIpcClientTransport,
  type IpcClientTransportHandlers,
} from '@disclaude/core';

// ============================================================================
// InMemoryIpcTransport — test-only transport (Issue #2352)
// ============================================================================

/**
 * In-memory connection that implements IpcConnectionLike.
 *
 * Uses a simple event system instead of EventEmitter to avoid
 * type casting issues. Two InMemoryConnection instances are
 * linked together so that writes on one side are received on the other.
 */
class InMemoryConnection implements IpcConnectionLike {
  remoteAddress = 'in-memory';

  private linkedTo: InMemoryConnection | null = null;
  private dataHandlers: Array<(data: string) => void> = [];
  private closeHandlers: Array<() => void> = [];
  private errorHandlers: Array<(error: Error) => void> = [];
  private destroyed = false;

  /** Link this connection to another (bidirectional) */
  link(other: InMemoryConnection): void {
    this.linkedTo = other;
    other.linkedTo = this;
  }

  write(data: string): void {
    if (this.destroyed) {return;}
    for (const handler of this.linkedTo?.dataHandlers ?? []) {
      handler(data);
    }
  }

  destroy(): void {
    if (this.destroyed) {return;}
    this.destroyed = true;
    for (const handler of this.linkedTo?.closeHandlers ?? []) {
      handler();
    }
  }

  on(event: string, handler: (...args: any[]) => void): void {
    switch (event) {
      case 'data':
        this.dataHandlers.push(handler as (data: string) => void);
        break;
      case 'close':
        this.closeHandlers.push(handler as () => void);
        break;
      case 'error':
        this.errorHandlers.push(handler as (error: Error) => void);
        break;
    }
  }
}

/**
 * Creates a connected in-memory transport pair for testing.
 *
 * Returns server and client transports that are internally linked.
 * Data written to the client transport is received by the server transport
 * and vice versa — all in memory, no filesystem or network involved.
 */
function createInMemoryTransportPair(): {
  serverTransport: IIpcServerTransport;
  clientTransport: IIpcClientTransport;
} {
  let connectionHandler: ((conn: IpcConnectionLike) => void) | null = null;
  let listening = false;
  let clientConnection: InMemoryConnection | null = null;

  const serverTransport: IIpcServerTransport = {
    // eslint-disable-next-line require-await
    async start(onConnection: (conn: IpcConnectionLike) => void): Promise<void> {
      connectionHandler = onConnection;
      listening = true;
    },
    // eslint-disable-next-line require-await
    async stop(): Promise<void> {
      listening = false;
      connectionHandler = null;
      clientConnection = null;
    },
    isListening(): boolean {
      return listening;
    },
  };

  const clientTransport: IIpcClientTransport = {
    // eslint-disable-next-line require-await
    async connect(handlers: IpcClientTransportHandlers): Promise<void> {
      if (!connectionHandler) {
        throw new Error('Server not listening');
      }

      const serverConn = new InMemoryConnection();
      const clientConn = new InMemoryConnection();
      serverConn.link(clientConn);

      // Notify server of new connection
      connectionHandler(serverConn);

      // Set up client-side event forwarding
      clientConn.on('data', (data: string) => handlers.onData(data));
      clientConn.on('close', () => handlers.onClose());
      clientConn.on('error', (err: Error) => handlers.onError(err));

      clientConnection = clientConn;
      handlers.onConnect();
    },
    write(data: string): void {
      clientConnection?.write(data);
    },
    destroy(): void {
      clientConnection?.destroy();
      clientConnection = null;
    },
  };

  return { serverTransport, clientTransport };
}

// ============================================================================
// Tests
// ============================================================================

describe('UnixSocketIpcServer (InMemory Transport)', () => {
  let server: UnixSocketIpcServer;
  let handler: ReturnType<typeof createInteractiveMessageHandler>;
  const mockContexts = new Map<string, { chatId: string; actionPrompts: Record<string, string> }>();

  beforeEach(() => {
    const { serverTransport } = createInMemoryTransportPair();
    mockContexts.clear();

    handler = createInteractiveMessageHandler(
      (messageId, chatId, actionPrompts) => {
        mockContexts.set(messageId, { chatId, actionPrompts });
      }
    );

    server = new UnixSocketIpcServer(handler, { socketPath: '/tmp/test-ipc.sock' }, serverTransport);
  });

  afterEach(async () => {
    await server.stop();
  });

  it('should start and stop successfully', async () => {
    expect(server.isRunning()).toBe(false);

    await server.start();
    expect(server.isRunning()).toBe(true);
    expect(server.getSocketPath()).toBe('/tmp/test-ipc.sock');

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

describe('UnixSocketIpcClient (InMemory Transport)', () => {
  let server: UnixSocketIpcServer;
  let client: UnixSocketIpcClient;
  const mockContexts = new Map<string, { chatId: string; actionPrompts: Record<string, string> }>();
  let feishuHandlersContainer: { handlers: import('@disclaude/core').FeishuApiHandlers | undefined };

  beforeEach(async () => {
    const { serverTransport, clientTransport } = createInMemoryTransportPair();
    mockContexts.clear();

    feishuHandlersContainer = {
      handlers: {
        sendMessage: async () => {},
        sendCard: async () => {},
        // eslint-disable-next-line require-await
        uploadFile: async () => ({ fileKey: '', fileType: 'file', fileName: 'f', fileSize: 0 }),
        // eslint-disable-next-line require-await
        sendInteractive: async (_chatId, params) => {
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

    server = new UnixSocketIpcServer(handler, { socketPath: '/tmp/test-ipc.sock' }, serverTransport);
    client = new UnixSocketIpcClient({ socketPath: '/tmp/test-ipc.sock', timeout: 2000 }, clientTransport);

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

describe('UnixSocketIpcClient - Graceful Fallback (InMemory Transport)', () => {
  describe('checkAvailability', () => {
    it('should return available when server is running', async () => {
      const { serverTransport, clientTransport } = createInMemoryTransportPair();

      const handler = createInteractiveMessageHandler(() => {});
      const server = new UnixSocketIpcServer(handler, { socketPath: '/tmp/test.sock' }, serverTransport);
      const client = new UnixSocketIpcClient({ socketPath: '/tmp/test.sock', timeout: 500 }, clientTransport);

      try {
        await server.start();
        const status = await client.checkAvailability();
        expect(status.available).toBe(true);
      } finally {
        await client.disconnect().catch(() => {});
        await server.stop().catch(() => {});
      }
    });

    it('should return unavailable when server is not running', async () => {
      const { clientTransport } = createInMemoryTransportPair();

      // Server never starts
      const client = new UnixSocketIpcClient({ socketPath: '/tmp/test.sock', timeout: 500 }, clientTransport);

      const status = await client.checkAvailability();
      expect(status.available).toBe(false);
      if (!status.available) {
        expect(status.reason).toBe('connection_failed');
      }
    });

    it('should cache availability result', async () => {
      const { clientTransport } = createInMemoryTransportPair();

      const client = new UnixSocketIpcClient({ socketPath: '/tmp/test.sock', timeout: 500 }, clientTransport);

      // First check (server not running)
      const status1 = await client.checkAvailability();
      expect(status1.available).toBe(false);

      // Second check should return cached result
      const status2 = await client.checkAvailability();
      expect(status2).toBe(status1);
    });
  });

  describe('isAvailable', () => {
    it('should return false when not connected', () => {
      const { clientTransport } = createInMemoryTransportPair();
      const client = new UnixSocketIpcClient({ socketPath: '/tmp/test.sock', timeout: 500 }, clientTransport);
      expect(client.isAvailable()).toBe(false);
    });

    it('should return true when connected', async () => {
      const { serverTransport, clientTransport } = createInMemoryTransportPair();

      const handler = createInteractiveMessageHandler(() => {});
      const server = new UnixSocketIpcServer(handler, { socketPath: '/tmp/test.sock' }, serverTransport);
      const client = new UnixSocketIpcClient({ socketPath: '/tmp/test.sock', timeout: 500 }, clientTransport);

      try {
        await server.start();
        await client.connect();
        expect(client.isAvailable()).toBe(true);
      } finally {
        await client.disconnect().catch(() => {});
        await server.stop().catch(() => {});
      }
    });
  });

  describe('error handling', () => {
    it('should include IPC_NOT_AVAILABLE prefix when server not found', async () => {
      const { clientTransport } = createInMemoryTransportPair();
      const client = new UnixSocketIpcClient({ socketPath: '/tmp/test.sock', timeout: 100 }, clientTransport);

      await expect(client.request('ping', {})).rejects.toThrow('IPC_NOT_AVAILABLE:');
    });
  });

  describe('invalidateAvailabilityCache', () => {
    it('should clear cached availability', async () => {
      const { clientTransport } = createInMemoryTransportPair();
      const client = new UnixSocketIpcClient({ socketPath: '/tmp/test.sock', timeout: 500 }, clientTransport);

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
