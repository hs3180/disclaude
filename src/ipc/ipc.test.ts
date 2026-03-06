/**
 * Tests for IPC module - Unix Socket cross-process communication.
 *
 * @module ipc/ipc.test
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { tmpdir } from 'os';
import { join } from 'path';
import { unlinkSync, existsSync } from 'fs';
import { UnixSocketIpcServer, createInteractiveMessageHandler } from './unix-socket-server.js';
import { UnixSocketIpcClient, getIpcClient, resetIpcClient } from './unix-socket-client.js';
import type { IpcConfig } from './protocol.js';

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

    handler = createInteractiveMessageHandler(
      (messageId) => mockContexts.get(messageId)?.actionPrompts,
      (messageId, chatId, actionPrompts) => {
        mockContexts.set(messageId, { chatId, actionPrompts });
      },
      (messageId) => mockContexts.delete(messageId),
      (messageId, actionValue, actionText) => {
        const context = mockContexts.get(messageId);
        if (!context) return undefined;
        const template = context.actionPrompts[actionValue];
        if (!template) return undefined;
        return template.replace(/\{\{actionText\}\}/g, actionText ?? '');
      },
      () => {
        let cleaned = 0;
        for (const [key, value] of mockContexts) {
          mockContexts.delete(key);
          cleaned++;
        }
        return cleaned;
      }
    );

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

  it('should handle multiple stop calls gracefully', async () => {
    await server.start();
    await server.stop();
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

    const handler = createInteractiveMessageHandler(
      (messageId) => mockContexts.get(messageId)?.actionPrompts,
      (messageId, chatId, actionPrompts) => {
        mockContexts.set(messageId, { chatId, actionPrompts });
      },
      (messageId) => mockContexts.delete(messageId),
      (messageId, actionValue, actionText) => {
        const context = mockContexts.get(messageId);
        if (!context) return undefined;
        const template = context.actionPrompts[actionValue];
        if (!template) return undefined;
        return template.replace(/\{\{actionText\}\}/g, actionText ?? '');
      },
      () => 0
    );

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

  it('should register and get action prompts', async () => {
    await client.sendRequest('register_action_prompts', {
      messageId: 'test-msg-1',
      chatId: 'test-chat',
      actionPrompts: { confirm: 'You confirmed!', cancel: 'You cancelled!' },
    });

    const result = await client.sendRequest('get_action_prompts', {
      messageId: 'test-msg-1',
    });

    expect(result.prompts).toEqual({
      confirm: 'You confirmed!',
      cancel: 'You cancelled!',
    });
  });

  it('should return null for non-existent prompts', async () => {
    const result = await client.sendRequest('get_action_prompts', {
      messageId: 'non-existent',
    });

    expect(result.prompts).toBeNull();
  });

  it('should generate interaction prompt', async () => {
    await client.sendRequest('register_action_prompts', {
      messageId: 'test-msg-2',
      chatId: 'test-chat',
      actionPrompts: { confirm: 'User clicked {{actionText}} button' },
    });

    const result = await client.sendRequest('generate_interaction_prompt', {
      messageId: 'test-msg-2',
      actionValue: 'confirm',
      actionText: 'Confirm',
      actionType: 'button',
    });

    expect(result.prompt).toBe('User clicked Confirm button');
  });

  it('should return null for non-existent prompt template', async () => {
    const result = await client.sendRequest('generate_interaction_prompt', {
      messageId: 'non-existent',
      actionValue: 'unknown',
    });

    expect(result.prompt).toBeNull();
  });

  it('should unregister action prompts', async () => {
    await client.sendRequest('register_action_prompts', {
      messageId: 'test-msg-3',
      chatId: 'test-chat',
      actionPrompts: { test: 'Test prompt' },
    });

    const before = await client.sendRequest('get_action_prompts', {
      messageId: 'test-msg-3',
    });
    expect(before.prompts).not.toBeNull();

    await client.sendRequest('unregister_action_prompts', {
      messageId: 'test-msg-3',
    });

    const after = await client.sendRequest('get_action_prompts', {
      messageId: 'test-msg-3',
    });
    expect(after.prompts).toBeNull();
  });

  it('should handle generateInteractionPrompt helper method', async () => {
    await client.sendRequest('register_action_prompts', {
      messageId: 'test-msg-4',
      chatId: 'test-chat',
      actionPrompts: { approve: 'Approved!', reject: 'Rejected!' },
    });

    const prompt = await client.generateInteractionPrompt(
      'test-msg-4',
      'approve',
      'Approve',
      'button'
    );

    expect(prompt).toBe('Approved!');
  });

  it('should handle getActionPrompts helper method', async () => {
    await client.sendRequest('register_action_prompts', {
      messageId: 'test-msg-5',
      chatId: 'test-chat',
      actionPrompts: { test: 'Test' },
    });

    const prompts = await client.getActionPrompts('test-msg-5');
    expect(prompts).toEqual({ test: 'Test' });
  });
});

describe('IPC Singleton', () => {
  beforeEach(() => {
    resetIpcClient();
  });

  afterEach(() => {
    resetIpcClient();
  });

  it('should return the same client instance', () => {
    const client1 = getIpcClient();
    const client2 = getIpcClient();
    expect(client1).toBe(client2);
  });

  it('should reset client on resetIpcClient', () => {
    const client1 = getIpcClient();
    resetIpcClient();
    const client2 = getIpcClient();
    expect(client1).not.toBe(client2);
  });
});
