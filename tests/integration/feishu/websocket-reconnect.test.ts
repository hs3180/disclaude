/**
 * P2 Integration test: IPC transport layer reconnection behavior.
 *
 * Tests that the Unix socket IPC transport layer can recover from disconnections:
 *   1. Client sends message → Server receives and responds
 *   2. Server stops (simulating disconnection)
 *   3. New server starts on the same socket path
 *   4. New client connects and sends message → Server receives and responds
 *
 * Uses mock IPC handlers and real Unix socket transport.
 * No real Feishu credentials needed.
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

/**
 * Create a mock container that captures sendMessage calls.
 */
function createMockContainer(captured: Array<{ chatId: string; text: string }>): ChannelHandlersContainer {
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

describe('IPC transport layer reconnection', () => {
  it('should handle server restart with new client connection', async () => {
    const socketPath = generateSocketPath();
    const captured: Array<{ chatId: string; text: string }> = [];

    try {
      // --- Phase 1: Initial connection ---
      const container1 = createMockContainer(captured);
      const handler1 = createInteractiveMessageHandler(() => {}, container1);
      const server1 = new UnixSocketIpcServer(handler1, { socketPath });
      const client1 = new UnixSocketIpcClient({ socketPath, timeout: 5000 });

      await server1.start();
      await client1.connect();

      // Send a message through the first connection
      const result1 = await client1.sendMessage('oc_reconnect_test', 'Before disconnect');
      expect(result1.success).toBe(true);
      expect(captured).toHaveLength(1);
      expect(captured[0].text).toBe('Before disconnect');

      // Disconnect the client and stop the server
      await client1.disconnect();
      await server1.stop();

      // --- Phase 2: Server restart with new client ---
      // Small delay to ensure socket cleanup
      await new Promise((resolve) => setTimeout(resolve, 100));

      const container2 = createMockContainer(captured);
      const handler2 = createInteractiveMessageHandler(() => {}, container2);
      const server2 = new UnixSocketIpcServer(handler2, { socketPath });
      const client2 = new UnixSocketIpcClient({ socketPath, timeout: 5000 });

      await server2.start();
      await client2.connect();

      // Send a message through the new connection
      const result2 = await client2.sendMessage('oc_reconnect_test', 'After reconnect');
      expect(result2.success).toBe(true);
      expect(captured).toHaveLength(2);
      expect(captured[1].text).toBe('After reconnect');

      // Cleanup
      await client2.disconnect();
      await server2.stop();
    } finally {
      cleanupSocket(socketPath);
    }
  });

  it('should handle multiple sequential client connections on same server', async () => {
    const socketPath = generateSocketPath();
    const captured: Array<{ chatId: string; text: string }> = [];

    try {
      const container = createMockContainer(captured);
      const handler = createInteractiveMessageHandler(() => {}, container);
      const server = new UnixSocketIpcServer(handler, { socketPath });

      await server.start();

      // --- Client 1 ---
      const client1 = new UnixSocketIpcClient({ socketPath, timeout: 5000 });
      await client1.connect();
      const result1 = await client1.sendMessage('oc_multi', 'From client 1');
      expect(result1.success).toBe(true);
      await client1.disconnect();

      // --- Client 2 ---
      const client2 = new UnixSocketIpcClient({ socketPath, timeout: 5000 });
      await client2.connect();
      const result2 = await client2.sendMessage('oc_multi', 'From client 2');
      expect(result2.success).toBe(true);
      await client2.disconnect();

      // --- Client 3 ---
      const client3 = new UnixSocketIpcClient({ socketPath, timeout: 5000 });
      await client3.connect();
      const result3 = await client3.sendMessage('oc_multi', 'From client 3');
      expect(result3.success).toBe(true);
      await client3.disconnect();

      // Verify all messages were received in order
      expect(captured).toHaveLength(3);
      expect(captured[0].text).toBe('From client 1');
      expect(captured[1].text).toBe('From client 2');
      expect(captured[2].text).toBe('From client 3');

      await server.stop();
    } finally {
      cleanupSocket(socketPath);
    }
  });

  it('should detect server unavailability when server is stopped', async () => {
    const socketPath = generateSocketPath();
    const captured: Array<{ chatId: string; text: string }> = [];

    try {
      const container = createMockContainer(captured);
      const handler = createInteractiveMessageHandler(() => {}, container);
      const server = new UnixSocketIpcServer(handler, { socketPath });
      const client = new UnixSocketIpcClient({ socketPath, timeout: 2000 });

      await server.start();
      await client.connect();

      // Verify connection works
      const pingResult = await client.ping();
      expect(pingResult).toBe(true);

      // Stop the server
      await server.stop();

      // Client should detect the disconnection
      // The availability check should reflect the server is down
      // Note: disconnect may already have been detected via socket close event
      await client.disconnect();

      // A new client trying to connect to the stopped server should fail
      const lateClient = new UnixSocketIpcClient({ socketPath, timeout: 1000, maxRetries: 0 });
      await expect(lateClient.connect()).rejects.toThrow();
    } finally {
      cleanupSocket(socketPath);
    }
  });

  it('should preserve message order across reconnection', async () => {
    const socketPath = generateSocketPath();
    const captured: Array<{ chatId: string; text: string }> = [];

    try {
      // --- Phase 1: Send 3 messages ---
      const container1 = createMockContainer(captured);
      const handler1 = createInteractiveMessageHandler(() => {}, container1);
      const server1 = new UnixSocketIpcServer(handler1, { socketPath });
      const client1 = new UnixSocketIpcClient({ socketPath, timeout: 5000 });

      await server1.start();
      await client1.connect();

      for (let i = 1; i <= 3; i++) {
        await client1.sendMessage('oc_order', `Message ${i}`);
      }
      expect(captured).toHaveLength(3);

      await client1.disconnect();
      await server1.stop();

      // --- Phase 2: Reconnect and send 3 more messages ---
      await new Promise((resolve) => setTimeout(resolve, 100));

      const container2 = createMockContainer(captured);
      const handler2 = createInteractiveMessageHandler(() => {}, container2);
      const server2 = new UnixSocketIpcServer(handler2, { socketPath });
      const client2 = new UnixSocketIpcClient({ socketPath, timeout: 5000 });

      await server2.start();
      await client2.connect();

      for (let i = 4; i <= 6; i++) {
        await client2.sendMessage('oc_order', `Message ${i}`);
      }

      // All 6 messages should be in order
      expect(captured).toHaveLength(6);
      for (let i = 0; i < 6; i++) {
        expect(captured[i].text).toBe(`Message ${i + 1}`);
      }

      await client2.disconnect();
      await server2.stop();
    } finally {
      cleanupSocket(socketPath);
    }
  });
});
