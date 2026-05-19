/**
 * P2 Integration test: IPC transport reconnect after Unix socket disconnection.
 *
 * Tests the full disconnect/reconnect pipeline:
 *   1. Client connected → messaging works
 *   2. Server stops → connection lost, requests fail gracefully
 *   3. Server restarts → client reconnects → messaging resumes
 *
 * Verifies that the IPC transport layer handles connection disruption
 * and recovery correctly through real Unix socket connections with
 * mock handlers — no real Feishu credentials needed.
 *
 * @see Issue #1626
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  UnixSocketIpcServer,
  UnixSocketIpcClient,
  createInteractiveMessageHandler,
  type ChannelHandlersContainer,
} from '@disclaude/primary-node';
import { generateSocketPath, cleanupSocket } from './helpers.js';

describe('IPC transport reconnect after server restart', () => {
  let server: UnixSocketIpcServer;
  let client: UnixSocketIpcClient;
  let socketPath: string;
  let capturedMessages: Array<{ chatId: string; text: string }>;

  /** Create a mock container that captures sendMessage calls */
  function createMockContainer(): ChannelHandlersContainer {
    return {
      handlers: {
        sendMessage: async (chatId, text) => {
          capturedMessages.push({ chatId, text });
        },
        sendCard: async () => {},
        sendInteractive: async () => ({ messageId: 'om_mock' }),
        uploadFile: async () => ({ fileKey: 'fk', fileType: 'file', fileName: 'f', fileSize: 0 }),
      },
    };
  }

  /** Create and start a fresh server+client pair */
  async function createConnectedPair(sp: string): Promise<{
    srv: UnixSocketIpcServer;
    cli: UnixSocketIpcClient;
  }> {
    const container = createMockContainer();
    const handler = createInteractiveMessageHandler(() => {}, container);
    const srv = new UnixSocketIpcServer(handler, { socketPath: sp });
    const cli = new UnixSocketIpcClient({ socketPath: sp, timeout: 5000, maxRetries: 3 });
    await srv.start();
    await cli.connect();
    return { srv, cli };
  }

  beforeEach(async () => {
    socketPath = generateSocketPath();
    capturedMessages = [];

    const container = createMockContainer();
    const handler = createInteractiveMessageHandler(() => {}, container);

    server = new UnixSocketIpcServer(handler, { socketPath });
    client = new UnixSocketIpcClient({ socketPath, timeout: 5000, maxRetries: 3 });

    await server.start();
    await client.connect();
  });

  afterEach(async () => {
    try {
      await client.disconnect().catch(() => {});
      await server.stop().catch(() => {});
    } finally {
      cleanupSocket(socketPath);
    }
  });

  it('should send messages normally before server stop', async () => {
    const result = await client.sendMessage('oc_test', 'Hello before stop');

    expect(result.success).toBe(true);
    expect(capturedMessages).toHaveLength(1);
    expect(capturedMessages[0].text).toBe('Hello before stop');
  });

  it('should detect connection loss when server stops', async () => {
    expect(client.isConnected()).toBe(true);

    await server.stop();

    // Give the socket a moment to detect the close event
    await new Promise((resolve) => setTimeout(resolve, 100));

    expect(client.isConnected()).toBe(false);
  });

  it('should fail to send message after server stops', async () => {
    await server.stop();

    // Give the socket a moment to detect the close event
    await new Promise((resolve) => setTimeout(resolve, 100));

    // The client should detect it's disconnected and try to reconnect,
    // which will fail because the server is gone
    const result = await client.sendMessage('oc_test', 'After stop');

    expect(result.success).toBe(false);
    expect(result.errorType).toBe('ipc_unavailable');
  });

  it('should reconnect and resume messaging after server restart', async () => {
    // Step 1: Verify messaging works before stop
    const before = await client.sendMessage('oc_test', 'Before stop');
    expect(before.success).toBe(true);

    // Step 2: Stop the server
    await server.stop();
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(client.isConnected()).toBe(false);

    // Step 3: Restart the server at the same socket path
    capturedMessages = [];
    const container = createMockContainer();
    const handler = createInteractiveMessageHandler(() => {}, container);
    server = new UnixSocketIpcServer(handler, { socketPath });
    await server.start();

    // Step 4: Client should reconnect on next request
    const after = await client.sendMessage('oc_test', 'After restart');
    expect(after.success).toBe(true);
    expect(capturedMessages).toHaveLength(1);
    expect(capturedMessages[0].text).toBe('After restart');
  });

  it('should handle multiple sequential send after reconnect', async () => {
    // Stop and restart
    await server.stop();
    await new Promise((resolve) => setTimeout(resolve, 100));

    capturedMessages = [];
    const container = createMockContainer();
    const handler = createInteractiveMessageHandler(() => {}, container);
    server = new UnixSocketIpcServer(handler, { socketPath });
    await server.start();

    // Send multiple messages after reconnect
    for (let i = 0; i < 5; i++) {
      const result = await client.sendMessage('oc_test', `Message ${i}`);
      expect(result.success).toBe(true);
    }

    expect(capturedMessages).toHaveLength(5);
    expect(capturedMessages[4].text).toBe('Message 4');
  });

  it('should handle server restart with fresh client', async () => {
    // Simulate a full reconnect cycle with a new client instance
    await server.stop();
    await client.disconnect();
    await new Promise((resolve) => setTimeout(resolve, 50));

    // Start a new server
    capturedMessages = [];
    const container = createMockContainer();
    const handler = createInteractiveMessageHandler(() => {}, container);
    server = new UnixSocketIpcServer(handler, { socketPath });
    await server.start();

    // Create a fresh client and connect
    client = new UnixSocketIpcClient({ socketPath, timeout: 5000 });
    await client.connect();

    const result = await client.sendMessage('oc_test', 'Fresh client');
    expect(result.success).toBe(true);
    expect(capturedMessages).toHaveLength(1);
    expect(capturedMessages[0].text).toBe('Fresh client');
  });

  it('should reject pending request when connection drops mid-flight', async () => {
    // Create a slow handler that delays response
    const slowSocketPath = generateSocketPath();
    let resolveSlow: () => void;
    const slowPromise = new Promise<void>((resolve) => { resolveSlow = resolve; });

    const slowContainer: ChannelHandlersContainer = {
      handlers: {
        sendMessage: async () => {
          // Hold the request until we signal
          await slowPromise;
        },
        sendCard: async () => {},
        sendInteractive: async () => ({ messageId: 'om_mock' }),
        uploadFile: async () => ({ fileKey: 'fk', fileType: 'file', fileName: 'f', fileSize: 0 }),
      },
    };
    const slowHandler = createInteractiveMessageHandler(() => {}, slowContainer);
    const slowServer = new UnixSocketIpcServer(slowHandler, { socketPath: slowSocketPath });
    const slowClient = new UnixSocketIpcClient({ socketPath: slowSocketPath, timeout: 10000 });

    try {
      await slowServer.start();
      await slowClient.connect();

      // Start a request that will be pending
      const pendingResult = slowClient.sendMessage('oc_test', 'Pending');

      // Immediately stop the server (connection drops while request is in-flight)
      await new Promise((resolve) => setTimeout(resolve, 50));
      await slowServer.stop();

      const result = await pendingResult;
      expect(result.success).toBe(false);
    } finally {
      // Resolve the slow promise to clean up
      resolveSlow!();
      await slowClient.disconnect().catch(() => {});
      cleanupSocket(slowSocketPath);
    }
  });
});
