/**
 * Tests for unified channel handler utilities.
 *
 * Issue #1555: Verifies that createChannelCallbacks and createChannelMessageHandler
 * correctly unify the duplicated handler creation logic from cli.ts.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  createChannelCallbacks,
  createChannelMessageHandler,
} from './channel-handlers.js';
import type { IChannel, IncomingMessage } from '@disclaude/core';

// Helper to create mock channel
function createMockChannel(id: string = 'test-channel', name: string = 'Test Channel'): IChannel {
  return {
    id,
    name,
    status: 'running',
    onMessage: vi.fn(),
    onControl: vi.fn(),
    sendMessage: vi.fn().mockResolvedValue(undefined),
    start: vi.fn().mockResolvedValue(undefined),
    stop: vi.fn().mockResolvedValue(undefined),
    isHealthy: vi.fn().mockReturnValue(true),
    getCapabilities: vi.fn().mockReturnValue({
      supportsCard: true,
      supportsThread: false,
      supportsFile: false,
      supportsMarkdown: true,
      supportsMention: false,
      supportsUpdate: false,
    }),
  };
}

// Helper to create mock agent
function createMockAgent() {
  return {
    processMessage: vi.fn(),
  };
}

// Helper to create mock agent pool
function createMockAgentPool() {
  const mockAgent = createMockAgent();
  return {
    getOrCreateChatAgent: vi.fn().mockReturnValue(mockAgent),
    mockAgent,
  };
}

// Helper to create test message
function createTestMessage(overrides: Partial<IncomingMessage> = {}): IncomingMessage {
  return {
    messageId: 'msg-1',
    chatId: 'chat-1',
    content: 'Hello',
    messageType: 'text',
    userId: 'user-1',
    ...overrides,
  };
}

describe('createChannelCallbacks', () => {
  let channel: IChannel;

  beforeEach(() => {
    channel = createMockChannel();
  });

  describe('sendMessage', () => {
    it('should delegate sendMessage to channel with text type', async () => {
      const factory = createChannelCallbacks(channel);
      const callbacks = factory();

      await callbacks.sendMessage('chat-1', 'Hello');

      expect(channel.sendMessage).toHaveBeenCalledWith({
        chatId: 'chat-1',
        type: 'text',
        text: 'Hello',
        threadId: undefined,
      });
    });

    it('should pass parentMessageId as threadId', async () => {
      const factory = createChannelCallbacks(channel);
      const callbacks = factory();

      await callbacks.sendMessage('chat-1', 'Hello', 'parent-123');

      expect(channel.sendMessage).toHaveBeenCalledWith({
        chatId: 'chat-1',
        type: 'text',
        text: 'Hello',
        threadId: 'parent-123',
      });
    });
  });

  describe('sendCard', () => {
    it('should delegate sendCard to channel with card type', async () => {
      const factory = createChannelCallbacks(channel);
      const callbacks = factory();
      const card = { header: { title: 'Test' } };

      await callbacks.sendCard('chat-1', card, 'desc', 'parent-123');

      expect(channel.sendMessage).toHaveBeenCalledWith({
        chatId: 'chat-1',
        type: 'card',
        card,
        description: 'desc',
        threadId: 'parent-123',
      });
    });

    it('should handle optional description and parentMessageId', async () => {
      const factory = createChannelCallbacks(channel);
      const callbacks = factory();
      const card = { header: { title: 'Test' } };

      await callbacks.sendCard('chat-1', card);

      expect(channel.sendMessage).toHaveBeenCalledWith({
        chatId: 'chat-1',
        type: 'card',
        card,
        description: undefined,
        threadId: undefined,
      });
    });
  });

  describe('sendFile', () => {
    it('should log warning (not fully implemented)', async () => {
      const factory = createChannelCallbacks(channel);
      const callbacks = factory();

      // Should not throw
      await expect(callbacks.sendFile('chat-1', '/path/to/file.txt')).resolves.toBeUndefined();

      // Should NOT call sendMessage (file sending not fully implemented)
      expect(channel.sendMessage).not.toHaveBeenCalled();
    });
  });

  describe('onDone', () => {
    it('should NOT include onDone by default', () => {
      const factory = createChannelCallbacks(channel);
      const callbacks = factory();

      expect(callbacks.onDone).toBeUndefined();
    });

    it('should include onDone when enableDoneSignal is true', async () => {
      const factory = createChannelCallbacks(channel, { enableDoneSignal: true });
      const callbacks = factory();

      expect(callbacks.onDone).toBeDefined();

      await callbacks.onDone!('chat-1', 'parent-123');

      expect(channel.sendMessage).toHaveBeenCalledWith({
        chatId: 'chat-1',
        type: 'done',
        threadId: 'parent-123',
      });
    });

    it('should handle onDone without parentMessageId', async () => {
      const factory = createChannelCallbacks(channel, { enableDoneSignal: true });
      const callbacks = factory();

      await callbacks.onDone!('chat-1');

      expect(channel.sendMessage).toHaveBeenCalledWith({
        chatId: 'chat-1',
        type: 'done',
        threadId: undefined,
      });
    });
  });

  describe('factory pattern', () => {
    it('should return a function that creates new callbacks each call', () => {
      const factory = createChannelCallbacks(channel);
      const callbacks1 = factory();
      const callbacks2 = factory();

      // Should be different objects
      expect(callbacks1).not.toBe(callbacks2);
    });
  });
});

describe('createChannelMessageHandler', () => {
  let channel: IChannel;
  let agentPool: ReturnType<typeof createMockAgentPool>;

  beforeEach(() => {
    channel = createMockChannel('test-ch', 'Test Channel');
    agentPool = createMockAgentPool();
  });

  it('should create a message handler function', () => {
    const handler = createChannelMessageHandler(channel, agentPool as any);
    expect(typeof handler).toBe('function');
  });

  it('should get or create agent from pool', async () => {
    const handler = createChannelMessageHandler(channel, agentPool as any);
    const message = createTestMessage();

    await handler(message);

    expect(agentPool.getOrCreateChatAgent).toHaveBeenCalledWith(
      'chat-1',
      expect.objectContaining({
        sendMessage: expect.any(Function),
        sendCard: expect.any(Function),
      }),
    );
  });

  it('should process message through agent', async () => {
    const handler = createChannelMessageHandler(channel, agentPool as any);
    const message = createTestMessage();

    await handler(message);

    expect(agentPool.mockAgent.processMessage).toHaveBeenCalledWith(
      'chat-1',
      'Hello',
      'msg-1',
      'user-1',
      undefined, // no fileRefs
      undefined, // no chatHistoryContext
    );
  });

  it('should convert attachments to FileRef[]', async () => {
    const handler = createChannelMessageHandler(channel, agentPool as any);
    const message = createTestMessage({
      attachments: [
        {
          fileName: 'test.png',
          filePath: '/tmp/test.png',
          mimeType: 'image/png',
          size: 1024,
        },
      ],
      messageType: 'image',
    });

    await handler(message);

    expect(agentPool.mockAgent.processMessage).toHaveBeenCalledWith(
      'chat-1',
      'Hello',
      'msg-1',
      'user-1',
      expect.arrayContaining([
        expect.objectContaining({
          fileName: 'test.png',
        }),
      ]),
      undefined,
    );
  });

  it('should pass chatHistoryContext from metadata', async () => {
    const handler = createChannelMessageHandler(channel, agentPool as any);
    const message = createTestMessage({
      metadata: { chatHistoryContext: 'previous context' },
    });

    await handler(message);

    expect(agentPool.mockAgent.processMessage).toHaveBeenCalledWith(
      'chat-1',
      'Hello',
      'msg-1',
      'user-1',
      undefined,
      'previous context',
    );
  });

  describe('error handling', () => {
    it('should send error message to channel on failure', async () => {
      const handler = createChannelMessageHandler(channel, agentPool as any);
      agentPool.mockAgent.processMessage.mockImplementation(() => {
        throw new Error('Processing failed');
      });

      const message = createTestMessage();
      await handler(message);

      expect(channel.sendMessage).toHaveBeenCalledWith({
        chatId: 'chat-1',
        type: 'text',
        text: '❌ Error: Processing failed',
      });
    });

    it('should handle non-Error exceptions', async () => {
      const handler = createChannelMessageHandler(channel, agentPool as any);
      agentPool.mockAgent.processMessage.mockImplementation(() => {
        throw 'string error';
      });

      const message = createTestMessage();
      await handler(message);

      expect(channel.sendMessage).toHaveBeenCalledWith({
        chatId: 'chat-1',
        type: 'text',
        text: '❌ Error: string error',
      });
    });

    it('should send done signal on error when sendDoneOnError is true', async () => {
      const handler = createChannelMessageHandler(channel, agentPool as any, {
        sendDoneOnError: true,
      });
      agentPool.mockAgent.processMessage.mockImplementation(() => {
        throw new Error('Processing failed');
      });

      const message = createTestMessage();
      await handler(message);

      // Should send error message AND done signal
      expect(channel.sendMessage).toHaveBeenCalledTimes(2);
      expect(channel.sendMessage).toHaveBeenNthCalledWith(1, {
        chatId: 'chat-1',
        type: 'text',
        text: '❌ Error: Processing failed',
      });
      expect(channel.sendMessage).toHaveBeenNthCalledWith(2, {
        chatId: 'chat-1',
        type: 'done',
      });
    });

    it('should NOT send done signal on error when sendDoneOnError is false', async () => {
      const handler = createChannelMessageHandler(channel, agentPool as any, {
        sendDoneOnError: false,
      });
      agentPool.mockAgent.processMessage.mockImplementation(() => {
        throw new Error('Processing failed');
      });

      const message = createTestMessage();
      await handler(message);

      // Should only send error message
      expect(channel.sendMessage).toHaveBeenCalledTimes(1);
      expect(channel.sendMessage).toHaveBeenCalledWith({
        chatId: 'chat-1',
        type: 'text',
        text: '❌ Error: Processing failed',
      });
    });

    it('should NOT send done signal on error by default', async () => {
      const handler = createChannelMessageHandler(channel, agentPool as any);
      agentPool.mockAgent.processMessage.mockImplementation(() => {
        throw new Error('Processing failed');
      });

      const message = createTestMessage();
      await handler(message);

      // Should only send error message
      expect(channel.sendMessage).toHaveBeenCalledTimes(1);
    });
  });
});
