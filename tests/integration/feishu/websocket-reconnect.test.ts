/**
 * P2 Integration test: IPC Unix socket reconnect behavior.
 *
 * Tests the reconnection behavior when the IPC server restarts:
 *   Client → Unix Socket → Server (stop) → Server (restart) → Client auto-reconnect → Message delivered
 *
 * Uses real Unix socket transport with mock handlers — no real Feishu credentials needed.
 * Follows the same pattern as other integration tests in this directory.
 *
 * @see Issue #1626 — P2: WebSocket reconnect
 */

import { describe, it, expect } from 'vitest';
import {
  UnixSocketIpcServer,
  UnixSocketIpcClient,
  createInteractiveMessageHandler,
  type ChannelHandlersContainer,
} from '@disclaude/primary-node';
import { generateSocketPath, cleanupSocket } from './helpers.js';

/** Small delay to allow async events (close, data) to propagate */
function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Create a mock container that captures sendMessage calls */
function createMockContainer(
  captured: Array<{ chatId: string; text: string; threadId?: string }>,
): ChannelHandlersContainer {
  return {
    handlers: {
      sendMessage: async (chatId, text, threadId?) => {
        captured.push({ chatId, text, threadId });
      },
      sendCard: async () => {},
      sendInteractive: async () => ({ messageId: 'om_mock' }),
      uploadFile: async () => ({ fileKey: 'fk', fileType: 'file', fileName: 'f', fileSize: 0 }),
    },
  };
}

describe('IPC Unix socket reconnect', () => {
  it('should auto-reconnect and deliver message after server restart', async () => {
    const socketPath = generateSocketPath();
    const captured: Array<{ chatId: string; text: string }> = [];

    const container = createMockContainer(captured);
    const handler = createInteractiveMessageHandler(() => {}, container);

    // Phase 1: Start server, connect client, verify communication works
    const server1 = new UnixSocketIpcServer(handler, { socketPath });
    const client = new UnixSocketIpcClient({
      socketPath,
      timeout: 5000,
      maxRetries: 10,
    });

    await server1.start();
    await client.connect();

    const result1 = await client.sendMessage('oc_reconnect', 'before restart');
    expect(result1.success).toBe(true);
    expect(captured).toHaveLength(1);
    expect(captured[0].text).toBe('before restart');

    // Phase 2: Stop server (simulates server crash / restart)
    await server1.stop();
    // Wait for client to detect disconnect via socket 'close' event
    await delay(200);

    // Phase 3: Start new server on the same socket path
    const server2 = new UnixSocketIpcServer(handler, { socketPath });
    await server2.start();

    // Phase 4: Client should auto-reconnect on next request and deliver message
    const result2 = await client.sendMessage('oc_reconnect', 'after restart');
    expect(result2.success).toBe(true);
    expect(captured).toHaveLength(2);
    expect(captured[1].text).toBe('after restart');

    // Cleanup
    await client.disconnect();
    await server2.stop();
    cleanupSocket(socketPath);
  });

  it('should handle multiple reconnect cycles', async () => {
    const socketPath = generateSocketPath();
    const captured: Array<{ chatId: string; text: string }> = [];

    const container = createMockContainer(captured);
    const handler = createInteractiveMessageHandler(() => {}, container);

    const client = new UnixSocketIpcClient({
      socketPath,
      timeout: 5000,
      maxRetries: 10,
    });

    // Cycle 1
    const server1 = new UnixSocketIpcServer(handler, { socketPath });
    await server1.start();
    await client.connect();

    let result = await client.sendMessage('oc_cycle', 'cycle 1');
    expect(result.success).toBe(true);

    await server1.stop();
    await delay(200);

    // Cycle 2
    const server2 = new UnixSocketIpcServer(handler, { socketPath });
    await server2.start();

    result = await client.sendMessage('oc_cycle', 'cycle 2');
    expect(result.success).toBe(true);

    await server2.stop();
    await delay(200);

    // Cycle 3
    const server3 = new UnixSocketIpcServer(handler, { socketPath });
    await server3.start();

    result = await client.sendMessage('oc_cycle', 'cycle 3');
    expect(result.success).toBe(true);

    // Verify all 3 messages were captured across reconnects
    expect(captured).toHaveLength(3);
    expect(captured[0].text).toBe('cycle 1');
    expect(captured[1].text).toBe('cycle 2');
    expect(captured[2].text).toBe('cycle 3');

    // Cleanup
    await client.disconnect();
    await server3.stop();
    cleanupSocket(socketPath);
  });

  it('should reconnect with ping after server restart', async () => {
    const socketPath = generateSocketPath();
    const captured: Array<{ chatId: string; text: string }> = [];

    const container = createMockContainer(captured);
    const handler = createInteractiveMessageHandler(() => {}, container);

    const server1 = new UnixSocketIpcServer(handler, { socketPath });
    const client = new UnixSocketIpcClient({
      socketPath,
      timeout: 5000,
      maxRetries: 10,
    });

    await server1.start();
    await client.connect();

    // Ping before restart
    expect(await client.ping()).toBe(true);

    // Stop and restart server
    await server1.stop();
    await delay(200);

    const server2 = new UnixSocketIpcServer(handler, { socketPath });
    await server2.start();

    // Ping after restart — should auto-reconnect and succeed
    expect(await client.ping()).toBe(true);

    // Cleanup
    await client.disconnect();
    await server2.stop();
    cleanupSocket(socketPath);
  });

  it('should report unavailability when server is down', async () => {
    const socketPath = generateSocketPath();
    const captured: Array<{ chatId: string; text: string }> = [];

    const container = createMockContainer(captured);
    const handler = createInteractiveMessageHandler(() => {}, container);

    const server = new UnixSocketIpcServer(handler, { socketPath });
    const client = new UnixSocketIpcClient({
      socketPath,
      timeout: 3000,
      maxRetries: 2, // Low retries so the test doesn't hang
    });

    await server.start();
    await client.connect();

    // Verify connected
    expect(client.isConnected()).toBe(true);

    // Stop server
    await server.stop();
    await delay(200);

    // Client should detect disconnect
    expect(client.isConnected()).toBe(false);

    // Request should fail (no server to connect to)
    const result = await client.sendMessage('oc_down', 'should fail');
    expect(result.success).toBe(false);

    // Cleanup
    await client.disconnect().catch(() => {});
    cleanupSocket(socketPath);
  });

  it('should deliver sendCard after reconnect', async () => {
    const socketPath = generateSocketPath();
    let cardCaptured = false;

    const container: ChannelHandlersContainer = {
      handlers: {
        sendMessage: async () => {},
        sendCard: async () => {
          cardCaptured = true;
        },
        sendInteractive: async () => ({ messageId: 'om_mock' }),
        uploadFile: async () => ({ fileKey: 'fk', fileType: 'file', fileName: 'f', fileSize: 0 }),
      },
    };
    const handler = createInteractiveMessageHandler(() => {}, container);

    const server1 = new UnixSocketIpcServer(handler, { socketPath });
    const client = new UnixSocketIpcClient({
      socketPath,
      timeout: 5000,
      maxRetries: 10,
    });

    await server1.start();
    await client.connect();

    // Send card before restart
    const result1 = await client.sendCard('oc_card', { config: {}, header: {}, elements: [] });
    expect(result1.success).toBe(true);
    expect(cardCaptured).toBe(true);

    // Stop and restart
    await server1.stop();
    await delay(200);

    cardCaptured = false;
    const server2 = new UnixSocketIpcServer(handler, { socketPath });
    await server2.start();

    // Send card after reconnect
    const result2 = await client.sendCard('oc_card', { config: {}, header: {}, elements: [] });
    expect(result2.success).toBe(true);
    expect(cardCaptured).toBe(true);

    // Cleanup
    await client.disconnect();
    await server2.stop();
    cleanupSocket(socketPath);
  });

  it('should reconnect with thread context preserved', async () => {
    const socketPath = generateSocketPath();
    const captured: Array<{ chatId: string; text: string; threadId?: string }> = [];

    const container = createMockContainer(captured);
    const handler = createInteractiveMessageHandler(() => {}, container);

    const server1 = new UnixSocketIpcServer(handler, { socketPath });
    const client = new UnixSocketIpcClient({
      socketPath,
      timeout: 5000,
      maxRetries: 10,
    });

    await server1.start();
    await client.connect();

    // Send with threadId before restart
    const result1 = await client.sendMessage('oc_thread', 'in thread', 'om_parent_1');
    expect(result1.success).toBe(true);

    // Restart
    await server1.stop();
    await delay(200);

    const server2 = new UnixSocketIpcServer(handler, { socketPath });
    await server2.start();

    // Send with threadId after reconnect
    const result2 = await client.sendMessage('oc_thread', 'reconnected thread', 'om_parent_2');
    expect(result2.success).toBe(true);

    // Verify both messages captured with correct threadId
    expect(captured).toHaveLength(2);
    expect(captured[0].threadId).toBe('om_parent_1');
    expect(captured[1].threadId).toBe('om_parent_2');

    // Cleanup
    await client.disconnect();
    await server2.stop();
    cleanupSocket(socketPath);
  });
});
