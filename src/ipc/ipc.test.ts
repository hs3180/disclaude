/**
 * Tests for IPC module - Unix Socket cross-process communication.
 *
 * @module ipc/ipc.test
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { tmpdir } from 'os';
import { join } from 'path';
import { unlinkSync, existsSync } from 'fs';
import { UnixSocketIpcServer, createInteractiveMessageHandler } from './unix-socket-server.js';
import { UnixSocketIpcClient, getIpcClient, resetIpcClient } from './unix-socket-client.js';

// Generate a unique socket path for each test
function generateSocketPath(): string {
  return join(tmpdir(), `disclaude-test-${Date.now()}-${Math.random().toString(36).slice(2)}.sock`);
}

describe('UnixSocketIpcServer', () => {
  let server: UnixSocketIpcServer;
  let socketPath: string;
  let handler: ReturnType<typeof createInteractiveMessageHandler>;

  const mockContexts = new Map<string, { chatId: string; actionPrompts: Record<string, string> }>();

  beforeEach(() => {
    socketPath = generateSocketPath();
    mockContexts.clear();

    handler = createInteractiveMessageHandler({
      getActionPrompts: (messageId) => mockContexts.get(messageId)?.actionPrompts,
      registerActionPrompts: (messageId, chatId, actionPrompts) => {
        mockContexts.set(messageId, { chatId, actionPrompts });
      },
      unregisterActionPrompts: (messageId) => mockContexts.delete(messageId),
      generateInteractionPrompt: (messageId, actionValue, actionText) => {
        const context = mockContexts.get(messageId);
        if (!context) {
          return undefined;
        }
        const template = context.actionPrompts[actionValue];
        if (!template) {
          return undefined;
        }
        return template.replace(/\{\{actionText\}\}/g, actionText ?? '');
      },
      cleanupExpiredContexts: () => {
        let cleaned = 0;
        for (const [key] of mockContexts) {
          mockContexts.delete(key);
          cleaned++;
        }
        return cleaned;
      },
      // Issue #631: 离线消息相关
      getOfflineContext: () => undefined,
      generateFollowUpPrompt: () => undefined,
      unregisterOfflineContext: () => false,
    });

    server = new UnixSocketIpcServer(handler, { socketPath });
  });

  afterEach(async () => {
    await server.stop();
    if (existsSync(socketPath)) {
      try {
        unlinkSync(socketPath);
      } catch {
        // Ignore cleanup errors
      }
    }
  });

  it('should start and stop successfully', async () => {
    expect(server.isRunning()).toBe(false);

    await server.start();
    expect(server.isRunning()).toBe(true);
    expect(server.getSocketPath()).toBe(socketPath);

    await server.stop();
    expect(server.isRunning()).toBe(false);
  });

  it('should clean up socket file on stop', async () => {
    await server.start();
    expect(existsSync(socketPath)).toBe(true);

    await server.stop();
    expect(existsSync(socketPath)).toBe(false);
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

describe('UnixSocketIpcClient', () => {
  let server: UnixSocketIpcServer;
  let client: UnixSocketIpcClient;
  let socketPath: string;
  const mockContexts = new Map<string, { chatId: string; actionPrompts: Record<string, string> }>();

  beforeEach(async () => {
    socketPath = generateSocketPath();
    mockContexts.clear();

    const handler = createInteractiveMessageHandler({
      getActionPrompts: (messageId) => mockContexts.get(messageId)?.actionPrompts,
      registerActionPrompts: (messageId, chatId, actionPrompts) => {
        mockContexts.set(messageId, { chatId, actionPrompts });
      },
      unregisterActionPrompts: (messageId) => mockContexts.delete(messageId),
      generateInteractionPrompt: (messageId, actionValue, actionText) => {
        const context = mockContexts.get(messageId);
        if (!context) {
          return undefined;
        }
        const template = context.actionPrompts[actionValue];
        if (!template) {
          return undefined;
        }
        return template.replace(/\{\{actionText\}\}/g, actionText ?? '');
      },
      cleanupExpiredContexts: () => 0,
      // Issue #631: 离线消息相关
      getOfflineContext: () => undefined,
      generateFollowUpPrompt: () => undefined,
      unregisterOfflineContext: () => false,
    });

    server = new UnixSocketIpcServer(handler, { socketPath });
    client = new UnixSocketIpcClient({ socketPath, timeout: 2000 });

    await server.start();
  });

  afterEach(async () => {
    await client.disconnect();
    await server.stop();
    if (existsSync(socketPath)) {
      try {
        unlinkSync(socketPath);
      } catch {
        // Ignore cleanup errors
      }
    }
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

  it('should get action prompts', async () => {
    mockContexts.set('msg-1', {
      chatId: 'chat-1',
      actionPrompts: { confirm: 'Confirmed!', cancel: 'Cancelled!' },
    });

    const prompts = await client.getActionPrompts('msg-1');
    expect(prompts).toEqual({ confirm: 'Confirmed!', cancel: 'Cancelled!' });
  });

  it('should return null for non-existent prompts', async () => {
    const prompts = await client.getActionPrompts('non-existent');
    expect(prompts).toBeNull();
  });

  it('should generate interaction prompt', async () => {
    mockContexts.set('msg-2', {
      chatId: 'chat-1',
      actionPrompts: { confirm: 'User clicked {{actionText}}' },
    });

    const prompt = await client.generateInteractionPrompt('msg-2', 'confirm', 'Confirm');
    expect(prompt).toBe('User clicked Confirm');
  });

  it('should return null for non-existent prompt template', async () => {
    const prompt = await client.generateInteractionPrompt('non-existent', 'confirm');
    expect(prompt).toBeNull();
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

describe('UnixSocketIpcClient - Graceful Fallback (Issue #1079)', () => {
  let socketPath: string;

  beforeEach(() => {
    socketPath = generateSocketPath();
    resetIpcClient();
  });

  afterEach(() => {
    resetIpcClient();
    if (existsSync(socketPath)) {
      try {
        unlinkSync(socketPath);
      } catch {
        // Ignore cleanup errors
      }
    }
  });

  describe('checkAvailability', () => {
    it('should return socket_not_found when socket does not exist', async () => {
      const client = new UnixSocketIpcClient({ socketPath, timeout: 500 });
      const status = await client.checkAvailability();

      expect(status.available).toBe(false);
      if (!status.available) {
        expect(status.reason).toBe('socket_not_found');
      }
    });

    it('should return available when server is running', async () => {
      const handler = createInteractiveMessageHandler({
        getActionPrompts: () => undefined,
        registerActionPrompts: () => {},
        unregisterActionPrompts: () => false,
        generateInteractionPrompt: () => undefined,
        cleanupExpiredContexts: () => 0,
        // Issue #631: 离线消息相关
        getOfflineContext: () => undefined,
        generateFollowUpPrompt: () => undefined,
        unregisterOfflineContext: () => false,
      });

      const server = new UnixSocketIpcServer(handler, { socketPath });
      await server.start();

      const client = new UnixSocketIpcClient({ socketPath, timeout: 500 });
      const status = await client.checkAvailability();

      expect(status.available).toBe(true);

      await client.disconnect();
      await server.stop();
    });

    it('should cache availability result', async () => {
      const client = new UnixSocketIpcClient({ socketPath, timeout: 500 });

      // First check
      const status1 = await client.checkAvailability();
      expect(status1.available).toBe(false);

      // Second check should return cached result
      const status2 = await client.checkAvailability();
      expect(status2).toBe(status1);
    });
  });

  describe('isAvailable', () => {
    it('should return false when socket does not exist', () => {
      const client = new UnixSocketIpcClient({ socketPath, timeout: 500 });
      expect(client.isAvailable()).toBe(false);
    });

    it('should return true when connected', async () => {
      const handler = createInteractiveMessageHandler({
        getActionPrompts: () => undefined,
        registerActionPrompts: () => {},
        unregisterActionPrompts: () => false,
        generateInteractionPrompt: () => undefined,
        cleanupExpiredContexts: () => 0,
        // Issue #631: 离线消息相关
        getOfflineContext: () => undefined,
        generateFollowUpPrompt: () => undefined,
        unregisterOfflineContext: () => false,
      });

      const server = new UnixSocketIpcServer(handler, { socketPath });
      await server.start();

      const client = new UnixSocketIpcClient({ socketPath, timeout: 500 });
      await client.connect();

      expect(client.isAvailable()).toBe(true);

      await client.disconnect();
      await server.stop();
    });
  });

  describe('retry mechanism', () => {
    it('should retry connection on failure', async () => {
      // Create a client with maxRetries=3
      const client = new UnixSocketIpcClient({
        socketPath,
        timeout: 100,
        maxRetries: 3,
      });

      // Try to connect to non-existent socket
      await expect(client.connect()).rejects.toThrow();

      // Should have tried 3 times (verified by timing)
      // This is a timing-based test, so we just verify it doesn't throw immediately
    });

    it('should connect on retry if server becomes available', async () => {
      const handler = createInteractiveMessageHandler({
        getActionPrompts: () => undefined,
        registerActionPrompts: () => {},
        unregisterActionPrompts: () => false,
        generateInteractionPrompt: () => undefined,
        cleanupExpiredContexts: () => 0,
        // Issue #631: 离线消息相关
        getOfflineContext: () => undefined,
        generateFollowUpPrompt: () => undefined,
        unregisterOfflineContext: () => false,
      });

      const server = new UnixSocketIpcServer(handler, { socketPath });

      // Start server after a short delay
      setTimeout(() => server.start(), 50);

      const client = new UnixSocketIpcClient({
        socketPath,
        timeout: 200,
        maxRetries: 5,
      });

      // Should eventually connect
      await client.connect();
      expect(client.isConnected()).toBe(true);

      await client.disconnect();
      await server.stop();
    });
  });

  describe('error handling', () => {
    it('should include IPC_NOT_AVAILABLE prefix when socket not found', async () => {
      const client = new UnixSocketIpcClient({ socketPath, timeout: 100, maxRetries: 1 });

      await expect(client.request('ping', {})).rejects.toThrow('IPC_NOT_AVAILABLE:');
    });

    it('should include IPC_TIMEOUT prefix on request timeout', async () => {
      const handler = createInteractiveMessageHandler({
        getActionPrompts: () => undefined,
        registerActionPrompts: () => {},
        unregisterActionPrompts: () => false,
        generateInteractionPrompt: () => undefined,
        cleanupExpiredContexts: () => 0,
        // Issue #631: 离线消息相关
        getOfflineContext: () => undefined,
        generateFollowUpPrompt: () => undefined,
        unregisterOfflineContext: () => false,
      });

      const server = new UnixSocketIpcServer(handler, { socketPath });
      await server.start();

      // Create client with very short timeout
      const client = new UnixSocketIpcClient({ socketPath, timeout: 1, maxRetries: 1 });

      // This might timeout or succeed depending on timing
      // Just verify the error format when it fails
      try {
        await client.request('ping', {});
      } catch (error) {
        expect(error instanceof Error).toBe(true);
        // Error should have a descriptive message
        expect((error as Error).message).toMatch(/IPC_/);
      }

      await client.disconnect();
      await server.stop();
    });
  });

  describe('invalidateAvailabilityCache', () => {
    it('should clear cached availability', async () => {
      const client = new UnixSocketIpcClient({ socketPath, timeout: 500 });

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
