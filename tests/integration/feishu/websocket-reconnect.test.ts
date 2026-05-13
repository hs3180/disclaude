/**
 * P2 Integration test: IPC transport reconnection after Unix socket disconnection.
 *
 * Tests the IPC transport layer behavior when the server stops and restarts:
 *   1. Client connects to server
 *   2. Server stops (socket file removed)
 *   3. Client detects disconnection
 *   4. Server restarts at same path
 *   5. Client auto-reconnects on next request
 *   6. Messages flow correctly after reconnection
 *
 * Uses real Unix domain sockets with mock handlers — no real Feishu credentials needed.
 * Runs as part of the standard Feishu IPC integration test suite.
 *
 * @see Issue #1626 — P2: IPC transport reconnection
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  UnixSocketIpcServer,
  UnixSocketIpcClient,
  createInteractiveMessageHandler,
  type ChannelHandlersContainer,
} from '@disclaude/primary-node';
import { generateSocketPath, cleanupSocket } from './helpers.js';

/**
 * Helper: wait for a specified duration.
 */
function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Helper: create a mock container that captures sendMessage calls.
 */
function createMockContainer(captured: Array<{
  chatId: string;
  text: string;
}>): ChannelHandlersContainer {
  return {
    handlers: {
      sendMessage: async (chatId, text) => {
        captured.push({ chatId, text });
      },
      sendCard: async () => {},
      sendInteractive: async () => ({ messageId: 'om_mock' }),
      uploadFile: async () => ({ fileKey: 'fk', fileType: 'file', fileName: 'f', fileSize: 0 }),
    },
  };
}

describe('IPC transport reconnection after server restart', () => {
  let socketPath: string;
  let capturedMessages: Array<{ chatId: string; text: string }>;

  beforeEach(() => {
    socketPath = generateSocketPath();
    capturedMessages = [];
  });

  afterEach(() => {
    cleanupSocket(socketPath);
  });

  it('should reconnect and send messages after server restart', async () => {
    const container = createMockContainer(capturedMessages);
    const handler = createInteractiveMessageHandler(() => {}, container);

    // Phase 1: Start server, connect client, send a message
    const server1 = new UnixSocketIpcServer(handler, { socketPath });
    const client = new UnixSocketIpcClient({ socketPath, timeout: 5000 });

    await server1.start();
    await client.connect();

    const result1 = await client.sendMessage('oc_test', 'before restart');
    expect(result1.success).toBe(true);
    expect(capturedMessages).toHaveLength(1);
    expect(capturedMessages[0].text).toBe('before restart');

    // Phase 2: Stop the server (simulates server crash / restart)
    await server1.stop();
    // Wait for the client to detect the disconnection (socket close event)
    await delay(200);

    // Phase 3: Restart the server at the same socket path
    const server2 = new UnixSocketIpcServer(handler, { socketPath });
    await server2.start();

    // Phase 4: Client should auto-reconnect on next request
    const result2 = await client.sendMessage('oc_test', 'after restart');
    expect(result2.success).toBe(true);
    expect(capturedMessages).toHaveLength(2);
    expect(capturedMessages[1].text).toBe('after restart');

    // Cleanup
    await client.disconnect();
    await server2.stop();
  });

  it('should reject pending requests when server disconnects', async () => {
    const slowSocketPath = generateSocketPath();
    const slowCaptured: Array<{ chatId: string; text: string }> = [];

    // Create a handler with a slow sendMessage that delays before completing
    const slowContainer: ChannelHandlersContainer = {
      handlers: {
        sendMessage: async (chatId, text) => {
          await delay(2000); // Delay longer than client timeout
          slowCaptured.push({ chatId, text });
        },
        sendCard: async () => {},
        sendInteractive: async () => ({ messageId: 'om_mock' }),
        uploadFile: async () => ({ fileKey: 'fk', fileType: 'file', fileName: 'f', fileSize: 0 }),
      },
    };
    const handler = createInteractiveMessageHandler(() => {}, slowContainer);

    const server = new UnixSocketIpcServer(handler, { socketPath: slowSocketPath });
    const client = new UnixSocketIpcClient({ socketPath: slowSocketPath, timeout: 5000 });

    try {
      await server.start();
      await client.connect();

      // Send a message and immediately stop the server
      const messagePromise = client.sendMessage('oc_test', 'pending msg');
      await delay(50); // Let the request reach the server
      await server.stop();

      // The pending request should be rejected
      const result = await messagePromise;
      expect(result.success).toBe(false);
      expect(result.error).toBeDefined();
    } finally {
      await client.disconnect().catch(() => {});
      await server.stop().catch(() => {});
      cleanupSocket(slowSocketPath);
    }
  });

  it('should handle multiple disconnect/reconnect cycles', async () => {
    const container = createMockContainer(capturedMessages);
    const handler = createInteractiveMessageHandler(() => {}, container);

    const client = new UnixSocketIpcClient({ socketPath, timeout: 5000 });

    // Cycle 1
    const server1 = new UnixSocketIpcServer(handler, { socketPath });
    await server1.start();
    await client.connect();

    const r1 = await client.sendMessage('oc_test', 'cycle 1');
    expect(r1.success).toBe(true);

    await server1.stop();
    await delay(100);

    // Cycle 2
    const server2 = new UnixSocketIpcServer(handler, { socketPath });
    await server2.start();

    const r2 = await client.sendMessage('oc_test', 'cycle 2');
    expect(r2.success).toBe(true);

    await server2.stop();
    await delay(100);

    // Cycle 3
    const server3 = new UnixSocketIpcServer(handler, { socketPath });
    await server3.start();

    const r3 = await client.sendMessage('oc_test', 'cycle 3');
    expect(r3.success).toBe(true);

    // Verify all messages were captured
    expect(capturedMessages).toHaveLength(3);
    expect(capturedMessages[0].text).toBe('cycle 1');
    expect(capturedMessages[1].text).toBe('cycle 2');
    expect(capturedMessages[2].text).toBe('cycle 3');

    await client.disconnect();
    await server3.stop();
  });

  it('should report unavailability when server is down', async () => {
    const container = createMockContainer(capturedMessages);
    const handler = createInteractiveMessageHandler(() => {}, container);

    const server = new UnixSocketIpcServer(handler, { socketPath });
    const client = new UnixSocketIpcClient({ socketPath, timeout: 2000 });

    await server.start();
    await client.connect();

    // Verify connected
    expect(client.isConnected()).toBe(true);

    // Stop server
    await server.stop();
    await delay(200);

    // Client should detect disconnection
    expect(client.isConnected()).toBe(false);

    // Invalidate cache so availability check re-probes
    client.invalidateAvailabilityCache();

    // Availability check should report unavailable
    const status = await client.checkAvailability();
    expect(status.available).toBe(false);

    await client.disconnect().catch(() => {});
  });

  it('should send multiple messages after reconnection', async () => {
    const container = createMockContainer(capturedMessages);
    const handler = createInteractiveMessageHandler(() => {}, container);

    const server1 = new UnixSocketIpcServer(handler, { socketPath });
    const client = new UnixSocketIpcClient({ socketPath, timeout: 5000 });

    await server1.start();
    await client.connect();

    // Send initial message
    await client.sendMessage('oc_test', 'initial');
    expect(capturedMessages).toHaveLength(1);

    // Restart server
    await server1.stop();
    await delay(100);
    const server2 = new UnixSocketIpcServer(handler, { socketPath });
    await server2.start();

    // Send multiple messages after reconnection
    const messages = ['msg-a', 'msg-b', 'msg-c', 'msg-d'];
    for (const text of messages) {
      const result = await client.sendMessage('oc_test', text);
      expect(result.success).toBe(true);
    }

    // All messages captured
    expect(capturedMessages).toHaveLength(5); // 1 initial + 4 after reconnect
    expect(capturedMessages.slice(1).map(m => m.text)).toEqual(messages);

    await client.disconnect();
    await server2.stop();
  });

  it('should handle ping after server restart', async () => {
    const container = createMockContainer(capturedMessages);
    const handler = createInteractiveMessageHandler(() => {}, container);

    const server1 = new UnixSocketIpcServer(handler, { socketPath });
    const client = new UnixSocketIpcClient({ socketPath, timeout: 5000 });

    await server1.start();
    await client.connect();

    // Ping before restart
    const ping1 = await client.ping();
    expect(ping1).toBe(true);

    // Restart server
    await server1.stop();
    await delay(100);
    const server2 = new UnixSocketIpcServer(handler, { socketPath });
    await server2.start();

    // Ping after restart — should auto-reconnect and succeed
    const ping2 = await client.ping();
    expect(ping2).toBe(true);

    await client.disconnect();
    await server2.stop();
  });

  it('should report ipc_unavailable error type when server is down', async () => {
    const container = createMockContainer(capturedMessages);
    const handler = createInteractiveMessageHandler(() => {}, container);

    const server = new UnixSocketIpcServer(handler, { socketPath });
    const client = new UnixSocketIpcClient({
      socketPath,
      timeout: 1000,
      maxRetries: 1,
    });

    await server.start();
    await client.connect();

    // Verify initial connectivity
    const r1 = await client.sendMessage('oc_test', 'before');
    expect(r1.success).toBe(true);

    // Stop server — no restart
    await server.stop();
    await delay(200);

    // Sending should fail with ipc_unavailable error type
    const r2 = await client.sendMessage('oc_test', 'during downtime');
    expect(r2.success).toBe(false);
    expect(r2.errorType).toBe('ipc_unavailable');

    await client.disconnect().catch(() => {});
  });
});
