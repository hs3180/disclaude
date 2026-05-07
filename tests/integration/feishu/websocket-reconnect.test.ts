/**
 * P2 Integration test: IPC Unix socket reconnection behavior.
 *
 * Tests the IPC transport layer when the Unix socket connection is disrupted:
 *   - Client detects server shutdown (connected → false)
 *   - Pending requests are rejected on disconnect
 *   - Client reconnects after server restart
 *   - Auto-reconnect via request() method
 *   - Multiple disconnect/reconnect cycles work reliably
 *
 * Uses mock IPC handlers with real Unix socket transport.
 * No real Feishu credentials needed.
 *
 * @see Issue #1626 — P2: WebSocket 重连（重新设计为 Unix socket 重连测试）
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  UnixSocketIpcServer,
  UnixSocketIpcClient,
  createInteractiveMessageHandler,
  type ChannelHandlersContainer,
} from '@disclaude/primary-node';
import { generateSocketPath, cleanupSocket } from './helpers.js';

/** Create a mock container that captures sendMessage calls */
function createMockContainer(
  captured: Array<{ chatId: string; text: string }>,
): ChannelHandlersContainer {
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

describe('IPC Unix socket reconnection', () => {
  let socketPath: string;

  beforeEach(() => {
    socketPath = generateSocketPath();
  });

  afterEach(() => {
    cleanupSocket(socketPath);
  });

  it('should detect server shutdown and set connected to false', async () => {
    const captured: Array<{ chatId: string; text: string }> = [];
    const container = createMockContainer(captured);
    const handler = createInteractiveMessageHandler(() => {}, container);

    const server = new UnixSocketIpcServer(handler, { socketPath });
    const client = new UnixSocketIpcClient({ socketPath, timeout: 3000 });

    try {
      await server.start();
      await client.connect();

      // Verify initially connected
      expect(client.isConnected()).toBe(true);

      // Send a message to confirm the connection works
      const result = await client.sendMessage('oc_test', 'before disconnect');
      expect(result.success).toBe(true);
      expect(captured).toHaveLength(1);

      // Stop the server — simulates crash / process exit
      await server.stop();

      // Wait for the client to detect the closed connection
      await new Promise((resolve) => setTimeout(resolve, 200));

      // Client should detect disconnection
      expect(client.isConnected()).toBe(false);
    } finally {
      await client.disconnect().catch(() => {});
      await server.stop().catch(() => {});
    }
  });

  it('should reject pending requests when connection drops', async () => {
    const container: ChannelHandlersContainer = {
      handlers: {
        // Intentionally slow handler to keep request pending
        sendMessage: async () => {
          await new Promise((resolve) => setTimeout(resolve, 2000));
        },
        sendCard: async () => {},
        sendInteractive: async () => ({ messageId: 'om_mock' }),
        uploadFile: async () => ({ fileKey: 'fk', fileType: 'file', fileName: 'f', fileSize: 0 }),
      },
    };
    const handler = createInteractiveMessageHandler(() => {}, container);

    const server = new UnixSocketIpcServer(handler, { socketPath });
    const client = new UnixSocketIpcClient({ socketPath, timeout: 5000 });

    try {
      await server.start();
      await client.connect();

      // Start a request that will be pending (slow handler)
      const pendingResult = client.sendMessage('oc_test', 'pending message');

      // Immediately stop the server while the request is in-flight
      await new Promise((resolve) => setTimeout(resolve, 50));
      await server.stop();

      // The pending request should be rejected
      const result = await pendingResult;
      expect(result.success).toBe(false);
      expect(result.error).toBeDefined();
    } finally {
      await client.disconnect().catch(() => {});
      await server.stop().catch(() => {});
    }
  });

  it('should reconnect after server restart and send messages successfully', async () => {
    const captured: Array<{ chatId: string; text: string }> = [];
    const container = createMockContainer(captured);
    const handler = createInteractiveMessageHandler(() => {}, container);

    // Phase 1: Initial connection
    const server = new UnixSocketIpcServer(handler, { socketPath });
    const client = new UnixSocketIpcClient({ socketPath, timeout: 3000, maxRetries: 3 });

    try {
      await server.start();
      await client.connect();

      const result1 = await client.sendMessage('oc_test', 'before restart');
      expect(result1.success).toBe(true);
      expect(captured).toHaveLength(1);
      expect(captured[0].text).toBe('before restart');

      // Phase 2: Server stops (simulating crash)
      await server.stop();
      await new Promise((resolve) => setTimeout(resolve, 200));
      expect(client.isConnected()).toBe(false);

      // Phase 3: Server restarts at same socket path
      const server2 = new UnixSocketIpcServer(handler, { socketPath });
      await server2.start();

      // Phase 4: Client reconnects
      await client.connect();
      expect(client.isConnected()).toBe(true);

      const result2 = await client.sendMessage('oc_test', 'after restart');
      expect(result2.success).toBe(true);
      expect(captured).toHaveLength(2);
      expect(captured[1].text).toBe('after restart');

      await server2.stop();
    } finally {
      await client.disconnect().catch(() => {});
    }
  });

  it('should auto-reconnect via request() after server restart', async () => {
    const captured: Array<{ chatId: string; text: string }> = [];
    const container = createMockContainer(captured);
    const handler = createInteractiveMessageHandler(() => {}, container);

    const server = new UnixSocketIpcServer(handler, { socketPath });
    const client = new UnixSocketIpcClient({ socketPath, timeout: 3000, maxRetries: 3 });

    try {
      await server.start();
      await client.connect();

      // Send a message successfully
      const result1 = await client.sendMessage('oc_auto', 'initial');
      expect(result1.success).toBe(true);

      // Stop the server
      await server.stop();
      await new Promise((resolve) => setTimeout(resolve, 200));

      // Try to send while disconnected — should fail
      const result2 = await client.sendMessage('oc_auto', 'disconnected');
      expect(result2.success).toBe(false);

      // Restart the server at same path
      const server2 = new UnixSocketIpcServer(handler, { socketPath });
      await server2.start();

      // sendMessage internally calls connect() when not connected,
      // so this should auto-reconnect and succeed
      const result3 = await client.sendMessage('oc_auto', 'auto-reconnected');
      expect(result3.success).toBe(true);
      expect(captured).toHaveLength(2);
      expect(captured[1].text).toBe('auto-reconnected');

      await server2.stop();
    } finally {
      await client.disconnect().catch(() => {});
    }
  });

  it('should handle multiple disconnect/reconnect cycles', async () => {
    const captured: Array<{ chatId: string; text: string }> = [];
    const container = createMockContainer(captured);
    const handler = createInteractiveMessageHandler(() => {}, container);

    const client = new UnixSocketIpcClient({ socketPath, timeout: 3000, maxRetries: 3 });

    try {
      for (let cycle = 1; cycle <= 3; cycle++) {
        const server = new UnixSocketIpcServer(handler, { socketPath });

        // Start server and connect
        await server.start();
        if (!client.isConnected()) {
          await client.connect();
        }

        // Send a message in this cycle
        const result = await client.sendMessage('oc_cycle', `cycle ${cycle}`);
        expect(result.success).toBe(true);
        expect(captured).toHaveLength(cycle);
        expect(captured[cycle - 1].text).toBe(`cycle ${cycle}`);

        // Stop server (disconnect)
        await server.stop();
        await new Promise((resolve) => setTimeout(resolve, 200));
        expect(client.isConnected()).toBe(false);
      }

      // Verify all 3 cycles produced messages
      expect(captured).toHaveLength(3);
    } finally {
      await client.disconnect().catch(() => {});
    }
  });

  it('should handle ping after reconnection', async () => {
    const captured: Array<{ chatId: string; text: string }> = [];
    const container = createMockContainer(captured);
    const handler = createInteractiveMessageHandler(() => {}, container);

    const server = new UnixSocketIpcServer(handler, { socketPath });
    const client = new UnixSocketIpcClient({ socketPath, timeout: 3000, maxRetries: 3 });

    try {
      await server.start();
      await client.connect();

      // Ping before disconnect
      expect(await client.ping()).toBe(true);

      // Disconnect
      await server.stop();
      await new Promise((resolve) => setTimeout(resolve, 200));

      // Ping while disconnected should fail
      expect(await client.ping()).toBe(false);

      // Reconnect
      const server2 = new UnixSocketIpcServer(handler, { socketPath });
      await server2.start();
      await client.connect();

      // Ping after reconnect should work
      expect(await client.ping()).toBe(true);

      await server2.stop();
    } finally {
      await client.disconnect().catch(() => {});
    }
  });
});
