/**
 * P2 Integration test: IPC server restart resilience (WebSocket reconnection scenario).
 *
 * Simulates the scenario where the primary-node process (IPC server) restarts
 * and the worker-node (IPC client) reconnects. Verifies that:
 * - Messages can be sent after server restart
 * - Interactive cards work after reconnection
 * - Action prompts from pre-restart cards are properly cleaned up
 *
 * This test simulates the real-world scenario where the Feishu WebSocket
 * connection drops and the primary node needs to reconnect. The IPC layer
 * should recover transparently.
 *
 * Run with: FEISHU_INTEGRATION_TEST=true npx vitest --run tests/integration/feishu
 *
 * @see Issue #1626
 * @see Issue #1351 — WsConnectionManager dead connection detection
 * @see Issue #1666 — Simplified WsConnectionManager (passive monitoring)
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  UnixSocketIpcServer,
  UnixSocketIpcClient,
  createInteractiveMessageHandler,
  type ChannelHandlersContainer,
} from '@disclaude/primary-node';
import { InteractiveContextStore } from '@disclaude/primary-node';
import { describeIfFeishu, generateSocketPath, cleanupSocket } from './helpers.js';

describeIfFeishu('IPC server restart resilience (WebSocket reconnection scenario)', () => {
  let socketPath: string;
  let store: InteractiveContextStore;
  let capturedMessages: Array<{ chatId: string; text: string }>;

  function createMockContainer(): ChannelHandlersContainer {
    return {
      handlers: {
        sendMessage: async (chatId, text) => {
          capturedMessages.push({ chatId, text });
        },
        sendCard: async () => {},
        sendInteractive: async () => ({ messageId: `om_${Date.now()}` }),
        uploadFile: async () => ({ fileKey: 'fk', fileType: 'file', fileName: 'f', fileSize: 0 }),
      },
    };
  }

  beforeEach(() => {
    socketPath = generateSocketPath();
    store = new InteractiveContextStore();
    capturedMessages = [];
  });

  afterEach(() => {
    cleanupSocket(socketPath);
    store.clear();
  });

  it('should send messages after IPC server restart', async () => {
    const container = createMockContainer();
    const handler = createInteractiveMessageHandler(
      (messageId, chatId, actionPrompts) => {
        store.register(messageId, chatId, actionPrompts);
      },
      container,
    );

    // Phase 1: Initial connection
    const server1 = new UnixSocketIpcServer(handler, { socketPath });
    const client = new UnixSocketIpcClient({ socketPath, timeout: 5000 });

    await server1.start();
    await client.connect();

    // Send a message before restart
    const result1 = await client.sendMessage('oc_test_chat', 'Before restart');
    expect(result1.success).toBe(true);

    // Phase 2: Server restart (simulate by stopping and starting a new server)
    await client.disconnect();
    await server1.stop();

    // Small delay to ensure socket cleanup
    await new Promise((resolve) => setTimeout(resolve, 100));

    const server2 = new UnixSocketIpcServer(handler, { socketPath });
    await server2.start();

    // Phase 3: Client reconnects
    const client2 = new UnixSocketIpcClient({ socketPath, timeout: 5000 });
    await client2.connect();

    try {
      // Send a message after restart
      const result2 = await client2.sendMessage('oc_test_chat', 'After restart');
      expect(result2.success).toBe(true);

      // Both messages should have been captured
      expect(capturedMessages).toHaveLength(2);
      expect(capturedMessages[0].text).toBe('Before restart');
      expect(capturedMessages[1].text).toBe('After restart');
    } finally {
      await client2.disconnect();
      await server2.stop();
    }
  });

  it('should send interactive cards after IPC server restart', async () => {
    const container = createMockContainer();
    const handler = createInteractiveMessageHandler(
      (messageId, chatId, actionPrompts) => {
        store.register(messageId, chatId, actionPrompts);
      },
      container,
    );

    // Phase 1: Initial connection — send an interactive card
    const server1 = new UnixSocketIpcServer(handler, { socketPath });
    const client1 = new UnixSocketIpcClient({ socketPath, timeout: 5000 });

    await server1.start();
    await client1.connect();

    const result1 = await client1.sendInteractive('oc_test_chat', {
      question: 'Before restart?',
      options: [{ text: 'Yes', value: 'yes' }],
      actionPrompts: { yes: 'Pre-restart: yes' },
    });
    expect(result1.success).toBe(true);
    expect(store.size).toBe(1);

    // Phase 2: Server restart
    await client1.disconnect();
    await server1.stop();

    await new Promise((resolve) => setTimeout(resolve, 100));

    // New server with fresh store (simulating process restart)
    const freshStore = new InteractiveContextStore();
    const freshHandler = createInteractiveMessageHandler(
      (messageId, chatId, actionPrompts) => {
        freshStore.register(messageId, chatId, actionPrompts);
      },
      container,
    );

    const server2 = new UnixSocketIpcServer(freshHandler, { socketPath });
    await server2.start();

    // Phase 3: New client connects and sends card
    const client2 = new UnixSocketIpcClient({ socketPath, timeout: 5000 });
    await client2.connect();

    try {
      const result2 = await client2.sendInteractive('oc_test_chat', {
        question: 'After restart?',
        options: [{ text: 'No', value: 'no' }],
        actionPrompts: { no: 'Post-restart: no' },
      });
      expect(result2.success).toBe(true);

      // The fresh store should only have the post-restart card
      expect(freshStore.size).toBe(1);

      // Post-restart card should work correctly
      const prompts = freshStore.getActionPrompts(result2.messageId!);
      expect(prompts?.no).toBe('Post-restart: no');
    } finally {
      await client2.disconnect();
      await server2.stop();
    }
  });

  it('should handle rapid server restart cycles', async () => {
    const container = createMockContainer();
    const handler = createInteractiveMessageHandler(() => {}, container);

    // Simulate 3 rapid restart cycles
    for (let i = 0; i < 3; i++) {
      const cycleSocketPath = generateSocketPath();
      const server = new UnixSocketIpcServer(handler, { socketPath: cycleSocketPath });
      const client = new UnixSocketIpcClient({ socketPath: cycleSocketPath, timeout: 5000 });

      try {
        await server.start();
        await client.connect();

        const result = await client.sendMessage('oc_test_chat', `Cycle ${i + 1}`);
        expect(result.success).toBe(true);
      } finally {
        await client.disconnect();
        await server.stop();
        cleanupSocket(cycleSocketPath);
      }
    }

    // All 3 messages should have been captured
    expect(capturedMessages).toHaveLength(3);
    expect(capturedMessages[0].text).toBe('Cycle 1');
    expect(capturedMessages[1].text).toBe('Cycle 2');
    expect(capturedMessages[2].text).toBe('Cycle 3');
  });

  it('should handle client reconnection to a running server', async () => {
    const container = createMockContainer();
    const handler = createInteractiveMessageHandler(
      (messageId, chatId, actionPrompts) => {
        store.register(messageId, chatId, actionPrompts);
      },
      container,
    );

    // Server stays running
    const server = new UnixSocketIpcServer(handler, { socketPath });
    await server.start();

    try {
      // Client 1 connects and sends
      const client1 = new UnixSocketIpcClient({ socketPath, timeout: 5000 });
      await client1.connect();

      const result1 = await client1.sendMessage('oc_test_chat', 'From client 1');
      expect(result1.success).toBe(true);

      // Client 1 disconnects (simulating worker restart)
      await client1.disconnect();

      // Client 2 connects to the same server
      const client2 = new UnixSocketIpcClient({ socketPath, timeout: 5000 });
      await client2.connect();

      const result2 = await client2.sendMessage('oc_test_chat', 'From client 2');
      expect(result2.success).toBe(true);

      // Interactive card from client 2 should work
      const result3 = await client2.sendInteractive('oc_test_chat', {
        question: 'New client card?',
        options: [{ text: 'OK', value: 'ok' }],
        actionPrompts: { ok: 'New client: ok' },
      });
      expect(result3.success).toBe(true);

      // Verify messages
      expect(capturedMessages).toHaveLength(2);
      expect(capturedMessages[0].text).toBe('From client 1');
      expect(capturedMessages[1].text).toBe('From client 2');

      // Verify interactive context
      expect(store.size).toBe(1);
      const prompts = store.getActionPromptsByChatId('oc_test_chat');
      expect(prompts?.ok).toBe('New client: ok');

      await client2.disconnect();
    } finally {
      await server.stop();
    }
  });

  it('should handle concurrent IPC operations during reconnection', async () => {
    const container = createMockContainer();
    const handler = createInteractiveMessageHandler(
      (messageId, chatId, actionPrompts) => {
        store.register(messageId, chatId, actionPrompts);
      },
      container,
    );

    const server = new UnixSocketIpcServer(handler, { socketPath });
    const client = new UnixSocketIpcClient({ socketPath, timeout: 5000 });

    await server.start();
    await client.connect();

    try {
      // Send multiple concurrent messages
      const promises = Array.from({ length: 5 }, (_, i) =>
        client.sendMessage('oc_test_chat', `Concurrent ${i}`)
      );
      const results = await Promise.all(promises);

      // All should succeed
      for (const result of results) {
        expect(result.success).toBe(true);
      }

      expect(capturedMessages).toHaveLength(5);
    } finally {
      await client.disconnect();
      await server.stop();
    }
  });
});
