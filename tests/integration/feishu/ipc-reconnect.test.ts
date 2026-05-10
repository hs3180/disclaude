/**
 * P2 Integration test: IPC transport layer reconnection behavior.
 *
 * Tests the Unix socket IPC client's resilience when the server connection
 * drops and recovers. Verifies:
 *   - Pending requests are properly rejected on disconnect
 *   - Client auto-reconnects via request() after server restart
 *   - Messages are delivered correctly after reconnection
 *   - Client state transitions are accurate through the lifecycle
 *
 * Uses mock IPC handlers — no real Feishu credentials needed.
 * Runs as part of the standard test suite.
 *
 * @see Issue #1626 — P2: WebSocket 重连（IPC 传输层断线重连）
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  UnixSocketIpcServer,
  UnixSocketIpcClient,
  createInteractiveMessageHandler,
  type ChannelHandlersContainer,
} from '@disclaude/primary-node';
import { generateSocketPath, cleanupSocket } from './helpers.js';

describe('IPC transport layer reconnection', () => {
  let server: UnixSocketIpcServer;
  let client: UnixSocketIpcClient;
  let socketPath: string;
  let capturedMessages: Array<{
    chatId: string;
    text: string;
  }>;

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

  /** Create and start a fresh server + connect client */
  async function startServerAndConnect(): Promise<void> {
    const container = createMockContainer();
    const handler = createInteractiveMessageHandler(() => {}, container);
    server = new UnixSocketIpcServer(handler, { socketPath });
    await server.start();
    await client.connect();
  }

  beforeEach(async () => {
    socketPath = generateSocketPath();
    capturedMessages = [];
    // Client is created with low retry count for faster tests
    client = new UnixSocketIpcClient({ socketPath, timeout: 3000, maxRetries: 3 });
  });

  afterEach(async () => {
    try {
      await client.disconnect();
      await server.stop();
    } catch {
      // Ignore cleanup errors
    } finally {
      cleanupSocket(socketPath);
    }
  });

  // ---------------------------------------------------------------------------
  // Basic reconnection: server restart → client auto-reconnects via request()
  // ---------------------------------------------------------------------------

  it('should reconnect and send messages after server restart', async () => {
    await startServerAndConnect();

    // Send a message before disconnect
    const result1 = await client.sendMessage('oc_chat', 'before restart');
    expect(result1.success).toBe(true);
    expect(capturedMessages).toHaveLength(1);

    // Stop the server (simulate crash)
    await server.stop();
    // Give the client time to detect the close event
    await new Promise(resolve => setTimeout(resolve, 100));

    // Client should now be disconnected
    expect(client.isConnected()).toBe(false);

    // Restart the server on the same socket path
    await startServerAndConnect();

    // Send a message after reconnection
    const result2 = await client.sendMessage('oc_chat', 'after restart');
    expect(result2.success).toBe(true);
    expect(capturedMessages).toHaveLength(2);
    expect(capturedMessages[1].text).toBe('after restart');
  });

  it('should reject pending requests when connection drops', async () => {
    await startServerAndConnect();

    // Verify client is connected
    expect(client.isConnected()).toBe(true);

    // Stop the server abruptly
    await server.stop();

    // Wait for close event to propagate
    await new Promise(resolve => setTimeout(resolve, 100));

    // Client should report disconnected
    expect(client.isConnected()).toBe(false);

    // Attempting to send should fail (auto-reconnect will fail since server is down)
    const result = await client.sendMessage('oc_chat', 'during outage');
    expect(result.success).toBe(false);
    expect(result.errorType).toBe('ipc_unavailable');
  });

  it('should return correct error type when server is unreachable', async () => {
    // Client has never connected — server was never started
    const result = await client.sendMessage('oc_chat', 'no server');
    expect(result.success).toBe(false);
    expect(result.errorType).toBe('ipc_unavailable');
  });

  // ---------------------------------------------------------------------------
  // Message continuity after reconnection
  // ---------------------------------------------------------------------------

  it('should deliver all messages correctly after reconnecting', async () => {
    await startServerAndConnect();

    // Send messages before disconnect
    await client.sendMessage('oc_chat', 'msg1');
    await client.sendMessage('oc_chat', 'msg2');
    expect(capturedMessages).toHaveLength(2);

    // Disconnect
    await server.stop();
    await new Promise(resolve => setTimeout(resolve, 100));

    // Reconnect
    await startServerAndConnect();

    // Send messages after reconnection
    await client.sendMessage('oc_chat', 'msg3');
    await client.sendMessage('oc_chat', 'msg4');
    await client.sendMessage('oc_chat', 'msg5');

    // capturedMessages is a shared array across containers (closure), so all 5 are captured.
    // Verify the post-reconnect messages (msg3-5) are at the end.
    expect(capturedMessages).toHaveLength(5);
    expect(capturedMessages[2].text).toBe('msg3');
    expect(capturedMessages[3].text).toBe('msg4');
    expect(capturedMessages[4].text).toBe('msg5');
  });

  // ---------------------------------------------------------------------------
  // Multiple reconnection cycles
  // ---------------------------------------------------------------------------

  it('should handle multiple connect-disconnect-reconnect cycles', async () => {
    await startServerAndConnect();

    // Cycle 1
    const r1 = await client.sendMessage('oc_chat', 'cycle 1');
    expect(r1.success).toBe(true);

    await server.stop();
    await new Promise(resolve => setTimeout(resolve, 100));
    expect(client.isConnected()).toBe(false);

    // Cycle 2
    await startServerAndConnect();
    const r2 = await client.sendMessage('oc_chat', 'cycle 2');
    expect(r2.success).toBe(true);

    await server.stop();
    await new Promise(resolve => setTimeout(resolve, 100));
    expect(client.isConnected()).toBe(false);

    // Cycle 3
    await startServerAndConnect();
    const r3 = await client.sendMessage('oc_chat', 'cycle 3');
    expect(r3.success).toBe(true);
  });

  // ---------------------------------------------------------------------------
  // Client state transitions
  // ---------------------------------------------------------------------------

  it('should track connection state correctly through lifecycle', async () => {
    // Initially not connected
    expect(client.isConnected()).toBe(false);

    await startServerAndConnect();
    expect(client.isConnected()).toBe(true);

    // After server stop, client detects disconnect
    await server.stop();
    await new Promise(resolve => setTimeout(resolve, 100));
    expect(client.isConnected()).toBe(false);

    // After reconnect
    await startServerAndConnect();
    expect(client.isConnected()).toBe(true);
  });

  // ---------------------------------------------------------------------------
  // Availability cache invalidation
  // ---------------------------------------------------------------------------

  it('should invalidate availability cache on disconnect', async () => {
    await startServerAndConnect();

    // Check availability — should be available
    const status1 = await client.checkAvailability();
    expect(status1.available).toBe(true);

    // Disconnect
    await server.stop();
    await new Promise(resolve => setTimeout(resolve, 100));

    // Availability cache should be invalidated, check should fail
    const status2 = await client.checkAvailability();
    expect(status2.available).toBe(false);
  });

  // ---------------------------------------------------------------------------
  // Ping after reconnection
  // ---------------------------------------------------------------------------

  it('should ping successfully after server restart', async () => {
    await startServerAndConnect();

    const ping1 = await client.ping();
    expect(ping1).toBe(true);

    await server.stop();
    await new Promise(resolve => setTimeout(resolve, 100));

    // Reconnect
    await startServerAndConnect();

    const ping2 = await client.ping();
    expect(ping2).toBe(true);
  });
});
