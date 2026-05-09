/**
 * P2 Integration test: IPC Unix socket reconnection behavior.
 *
 * Tests the full reconnection pipeline:
 *   Server stop → Client disconnect → Server restart → Client auto-reconnect → Message delivered
 *
 * Verifies that:
 * - Pending requests are rejected when connection drops
 * - Client auto-reconnects on next request after server restart
 * - Messages are correctly delivered after reconnection
 * - Multiple reconnection cycles work without degradation
 *
 * Uses mock IPC handlers and real Unix socket transport.
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

describe('IPC Unix socket reconnection', () => {
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

  /** Start a server with a fresh handler at the given socket path */
  async function startServer(path: string): Promise<UnixSocketIpcServer> {
    const container = createMockContainer();
    const handler = createInteractiveMessageHandler(() => {}, container);
    const srv = new UnixSocketIpcServer(handler, { socketPath: path });
    await srv.start();
    return srv;
  }

  beforeEach(async () => {
    socketPath = generateSocketPath();
    capturedMessages = [];

    server = await startServer(socketPath);
    client = new UnixSocketIpcClient({ socketPath, timeout: 5000, maxRetries: 5 });
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

  it('should deliver messages before and after server restart', async () => {
    // Step 1: Verify initial communication works
    const result1 = await client.sendMessage('oc_test', 'before restart');
    expect(result1.success).toBe(true);
    expect(capturedMessages).toHaveLength(1);
    expect(capturedMessages[0].text).toBe('before restart');

    // Step 2: Stop server (simulates disconnection)
    await server.stop();
    // Give the client a moment to detect the closed connection
    await new Promise(resolve => setTimeout(resolve, 100));

    // Step 3: Restart server at the same socket path
    server = await startServer(socketPath);
    // Small delay for server to be ready
    await new Promise(resolve => setTimeout(resolve, 50));

    // Step 4: Verify client auto-reconnects and delivers message
    capturedMessages = [];
    const result2 = await client.sendMessage('oc_test', 'after restart');
    expect(result2.success).toBe(true);
    expect(capturedMessages).toHaveLength(1);
    expect(capturedMessages[0].text).toBe('after restart');
  });

  it('should handle disconnection with error for in-flight requests', async () => {
    // Use a separate client with short timeout for this test
    const shortTimeoutPath = generateSocketPath();
    const container = createMockContainer();
    // Make the handler slow to simulate an in-flight request
    container.handlers!.sendMessage = async () => {
      await new Promise(resolve => setTimeout(resolve, 2000));
    };
    const handler = createInteractiveMessageHandler(() => {}, container);
    const slowServer = new UnixSocketIpcServer(handler, { socketPath: shortTimeoutPath });
    const shortClient = new UnixSocketIpcClient({ socketPath: shortTimeoutPath, timeout: 3000 });

    try {
      await slowServer.start();
      await shortClient.connect();

      // Send a message that will be in-flight
      const messagePromise = shortClient.sendMessage('oc_test', 'in-flight');

      // Stop the server while the message is in-flight
      await new Promise(resolve => setTimeout(resolve, 50));
      await slowServer.stop();

      // The in-flight request should fail
      const result = await messagePromise;
      expect(result.success).toBe(false);
      expect(result.error).toBeDefined();
    } finally {
      await shortClient.disconnect().catch(() => {});
      await slowServer.stop().catch(() => {});
      cleanupSocket(shortTimeoutPath);
    }
  });

  it('should survive multiple server restart cycles', async () => {
    // Cycle 1
    const r1 = await client.sendMessage('oc_test', 'cycle 1');
    expect(r1.success).toBe(true);

    await server.stop();
    await new Promise(resolve => setTimeout(resolve, 100));
    server = await startServer(socketPath);
    await new Promise(resolve => setTimeout(resolve, 50));

    // Cycle 2
    capturedMessages = [];
    const r2 = await client.sendMessage('oc_test', 'cycle 2');
    expect(r2.success).toBe(true);
    expect(capturedMessages[0].text).toBe('cycle 2');

    await server.stop();
    await new Promise(resolve => setTimeout(resolve, 100));
    server = await startServer(socketPath);
    await new Promise(resolve => setTimeout(resolve, 50));

    // Cycle 3
    capturedMessages = [];
    const r3 = await client.sendMessage('oc_test', 'cycle 3');
    expect(r3.success).toBe(true);
    expect(capturedMessages[0].text).toBe('cycle 3');
  });

  it('should auto-reconnect using request() after connection drop', async () => {
    // Verify connection is alive
    const ping1 = await client.ping();
    expect(ping1).toBe(true);

    // Drop the connection
    await server.stop();
    await new Promise(resolve => setTimeout(resolve, 100));

    // Restart server
    server = await startServer(socketPath);
    await new Promise(resolve => setTimeout(resolve, 50));

    // ping() uses request() internally, should trigger auto-reconnect
    const ping2 = await client.ping();
    expect(ping2).toBe(true);
  });

  it('should report ipc_unavailable when server is down', async () => {
    // Stop server without restarting
    await server.stop();
    await new Promise(resolve => setTimeout(resolve, 100));

    // Try to send — should fail with ipc_unavailable
    const result = await client.sendMessage('oc_test', 'should fail');
    expect(result.success).toBe(false);
    expect(result.errorType).toBe('ipc_unavailable');

    // Restart server for afterEach cleanup
    server = await startServer(socketPath);
  });

  it('should recover sendCard after reconnection', async () => {
    // Verify initial card send works
    const r1 = await client.sendCard('oc_test', {
      config: { wide_screen_mode: true },
      header: { title: { tag: 'plain_text', content: 'Test' } },
      elements: [{ tag: 'div', text: { tag: 'plain_text', content: 'Hello' } }],
    });
    expect(r1.success).toBe(true);

    // Restart server
    await server.stop();
    await new Promise(resolve => setTimeout(resolve, 100));
    server = await startServer(socketPath);
    await new Promise(resolve => setTimeout(resolve, 50));

    // Verify card send works after reconnect
    const r2 = await client.sendCard('oc_test', {
      config: { wide_screen_mode: true },
      header: { title: { tag: 'plain_text', content: 'Test 2' } },
      elements: [{ tag: 'div', text: { tag: 'plain_text', content: 'After reconnect' } }],
    });
    expect(r2.success).toBe(true);
  });
});
