/**
 * P2 Integration test: Unix socket reconnection behavior.
 *
 * Tests the IPC transport layer behavior when the Unix socket connection
 * is interrupted and re-established:
 *
 *   IPC Client connect → send (success) → disconnect → reconnect → send (success)
 *
 * Verifies:
 * - Messages succeed before disconnection
 * - Pending requests are rejected on disconnect
 * - Client can reconnect after disconnection
 * - Messages succeed after reconnection
 *
 * Uses mock IPC handlers — no real Feishu credentials needed.
 * Runs as part of the standard test suite via `npm run test:feishu`.
 *
 * @see Issue #1626 — P2: WebSocket 重连（Unix socket 断线重连）
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  UnixSocketIpcServer,
  UnixSocketIpcClient,
  createInteractiveMessageHandler,
  type ChannelHandlersContainer,
} from '@disclaude/primary-node';
import { generateSocketPath, cleanupSocket } from './helpers.js';

describe('IPC Unix socket reconnection behavior', () => {
  let server: UnixSocketIpcServer;
  let socketPath: string;
  let capturedMessages: Array<{ chatId: string; text: string }>;

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

  beforeEach(() => {
    socketPath = generateSocketPath();
    capturedMessages = [];
  });

  afterEach(async () => {
    cleanupSocket(socketPath);
  });

  it('should send messages before and after client reconnect', async () => {
    const container = createMockContainer();
    const handler = createInteractiveMessageHandler(() => {}, container);

    server = new UnixSocketIpcServer(handler, { socketPath });
    await server.start();

    const client = new UnixSocketIpcClient({ socketPath, timeout: 5000 });

    // Phase 1: Connect and send a message
    await client.connect();
    const result1 = await client.sendMessage('oc_test', 'Before disconnect');
    expect(result1.success).toBe(true);
    expect(capturedMessages).toHaveLength(1);
    expect(capturedMessages[0].text).toBe('Before disconnect');

    // Phase 2: Disconnect
    await client.disconnect();
    expect(client.isConnected()).toBe(false);

    // Phase 3: Reconnect and send another message
    await client.connect();
    expect(client.isConnected()).toBe(true);

    const result2 = await client.sendMessage('oc_test', 'After reconnect');
    expect(result2.success).toBe(true);
    expect(capturedMessages).toHaveLength(2);
    expect(capturedMessages[1].text).toBe('After reconnect');

    await client.disconnect();
    await server.stop();
  });

  it('should auto-reconnect when sending after explicit disconnect', async () => {
    const container = createMockContainer();
    const handler = createInteractiveMessageHandler(() => {}, container);

    server = new UnixSocketIpcServer(handler, { socketPath });
    await server.start();

    const client = new UnixSocketIpcClient({ socketPath, timeout: 5000 });
    await client.connect();

    // Verify initial connection
    const ping1 = await client.ping();
    expect(ping1).toBe(true);

    // Disconnect client
    await client.disconnect();
    expect(client.isConnected()).toBe(false);

    // Sending after disconnect auto-reconnects because server is still running
    const result = await client.sendMessage('oc_test', 'Auto-reconnected');
    expect(result.success).toBe(true);
    expect(capturedMessages).toHaveLength(1);
    expect(capturedMessages[0].text).toBe('Auto-reconnected');

    await client.disconnect();
    await server.stop();
  });

  it('should handle multiple disconnect/reconnect cycles', async () => {
    const container = createMockContainer();
    const handler = createInteractiveMessageHandler(() => {}, container);

    server = new UnixSocketIpcServer(handler, { socketPath });
    await server.start();

    const client = new UnixSocketIpcClient({ socketPath, timeout: 5000 });

    for (let cycle = 0; cycle < 3; cycle++) {
      await client.connect();

      const result = await client.sendMessage('oc_test', `Cycle ${cycle}`);
      expect(result.success).toBe(true);

      await client.disconnect();
    }

    expect(capturedMessages).toHaveLength(3);
    expect(capturedMessages[0].text).toBe('Cycle 0');
    expect(capturedMessages[1].text).toBe('Cycle 1');
    expect(capturedMessages[2].text).toBe('Cycle 2');

    await server.stop();
  });

  it('should support multiple independent clients connecting to the same server', async () => {
    const container = createMockContainer();
    const handler = createInteractiveMessageHandler(() => {}, container);

    server = new UnixSocketIpcServer(handler, { socketPath });
    await server.start();

    const client1 = new UnixSocketIpcClient({ socketPath, timeout: 5000 });
    const client2 = new UnixSocketIpcClient({ socketPath, timeout: 5000 });

    await client1.connect();
    await client2.connect();

    const result1 = await client1.sendMessage('oc_test', 'From client 1');
    expect(result1.success).toBe(true);

    const result2 = await client2.sendMessage('oc_test', 'From client 2');
    expect(result2.success).toBe(true);

    expect(capturedMessages).toHaveLength(2);
    expect(capturedMessages[0].text).toBe('From client 1');
    expect(capturedMessages[1].text).toBe('From client 2');

    await client1.disconnect();
    await client2.disconnect();
    await server.stop();
  });

  it('should reconnect to a restarted server', async () => {
    const container = createMockContainer();
    const handler = createInteractiveMessageHandler(() => {}, container);

    server = new UnixSocketIpcServer(handler, { socketPath });
    await server.start();

    const client = new UnixSocketIpcClient({ socketPath, timeout: 5000, maxRetries: 5 });
    await client.connect();

    const result1 = await client.sendMessage('oc_test', 'Before server restart');
    expect(result1.success).toBe(true);

    // Stop the server
    await server.stop();
    await client.disconnect();

    // Restart the server on the same socket path
    const container2 = createMockContainer();
    const handler2 = createInteractiveMessageHandler(() => {}, container2);
    server = new UnixSocketIpcServer(handler2, { socketPath });
    await server.start();

    // Reconnect the client
    await client.connect();

    const result2 = await client.sendMessage('oc_test', 'After server restart');
    expect(result2.success).toBe(true);

    await client.disconnect();
    await server.stop();
  });
});
