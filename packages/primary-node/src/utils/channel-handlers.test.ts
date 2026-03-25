/**
 * Tests for shared channel handler utilities.
 *
 * Issue #1555 Phase 2: Tests for createChannelCallbacksFactory and
 * createDefaultMessageHandler extracted from wired-descriptors.ts.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  createChannelCallbacksFactory,
  createDefaultMessageHandler,
} from './channel-handlers.js';
import type { IChannel, IncomingMessage } from '@disclaude/core';
import type { WiredContext } from '../channel-lifecycle-manager.js';

// ============================================================================
// Helpers
// ============================================================================

const mockLogger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
} as any;

function createMockChannel(): IChannel {
  return {
    id: 'test-channel',
    name: 'Test Channel',
    status: 'running',
    sendMessage: vi.fn().mockResolvedValue(undefined),
    onMessage: vi.fn(),
    onControl: vi.fn(),
    start: vi.fn().mockResolvedValue(undefined),
    stop: vi.fn().mockResolvedValue(undefined),
    getCapabilities: vi.fn().mockReturnValue({
      supportsCard: true,
      supportsThread: false,
      supportsFile: false,
      supportsMarkdown: true,
      supportsMention: false,
      supportsUpdate: false,
    }),
  } as unknown as IChannel;
}

function createMockWiredContext(overrides?: Partial<WiredContext>): WiredContext {
  return {
    channel: createMockChannel(),
    agentPool: {
      getOrCreateChatAgent: vi.fn().mockReturnValue({
        processMessage: vi.fn(),
      }),
    },
    controlHandler: vi.fn(),
    controlHandlerContext: {},
    logger: mockLogger,
    primaryNode: {
      getInteractiveContextStore: vi.fn().mockReturnValue({
        generatePrompt: vi.fn().mockReturnValue('prompt'),
      }),
      registerFeishuHandlers: vi.fn(),
    },
    callbacks: vi.fn().mockReturnValue({
      sendMessage: vi.fn().mockResolvedValue(undefined),
      sendCard: vi.fn().mockResolvedValue(undefined),
      sendFile: vi.fn().mockResolvedValue(undefined),
      onDone: vi.fn().mockResolvedValue(undefined),
    }),
    ...overrides,
  };
}

function createMockMessage(overrides?: Partial<IncomingMessage>): IncomingMessage {
  return {
    messageId: 'msg-001',
    chatId: 'chat-001',
    userId: 'user-001',
    content: 'Hello, agent!',
    messageType: 'text',
    timestamp: Date.now(),
    ...overrides,
  };
}

// ============================================================================
// Tests: createChannelCallbacksFactory
// ============================================================================

describe('createChannelCallbacksFactory', () => {
  let channel: IChannel;

  beforeEach(() => {
    channel = createMockChannel();
    vi.clearAllMocks();
  });

  it('should return a factory function', () => {
    const factory = createChannelCallbacksFactory(channel, mockLogger);
    expect(typeof factory).toBe('function');
  });

  it('should return PilotCallbacks when factory is called', () => {
    const factory = createChannelCallbacksFactory(channel, mockLogger);
    const callbacks = factory('chat-001');
    expect(callbacks.sendMessage).toBeDefined();
    expect(callbacks.sendCard).toBeDefined();
    expect(callbacks.sendFile).toBeDefined();
    expect(callbacks.onDone).toBeDefined();
  });

  it('sendMessage should delegate to channel.sendMessage with text type', async () => {
    const factory = createChannelCallbacksFactory(channel, mockLogger);
    const callbacks = factory('chat-001');
    await callbacks.sendMessage('chat-001', 'Hello!');
    expect(channel.sendMessage).toHaveBeenCalledWith({
      chatId: 'chat-001',
      type: 'text',
      text: 'Hello!',
      threadId: undefined,
    });
  });

  it('sendMessage should pass threadId as parentMessageId', async () => {
    const factory = createChannelCallbacksFactory(channel, mockLogger);
    const callbacks = factory('chat-001');
    await callbacks.sendMessage('chat-001', 'Reply', 'thread-123');
    expect(channel.sendMessage).toHaveBeenCalledWith({
      chatId: 'chat-001',
      type: 'text',
      text: 'Reply',
      threadId: 'thread-123',
    });
  });

  it('sendCard should delegate to channel.sendMessage with card type', async () => {
    const factory = createChannelCallbacksFactory(channel, mockLogger);
    const callbacks = factory('chat-001');
    const card = { elements: [] };
    await callbacks.sendCard('chat-001', card, 'Test card');
    expect(channel.sendMessage).toHaveBeenCalledWith({
      chatId: 'chat-001',
      type: 'card',
      card,
      description: 'Test card',
      threadId: undefined,
    });
  });

  it('sendCard should pass threadId as parentMessageId', async () => {
    const factory = createChannelCallbacksFactory(channel, mockLogger);
    const callbacks = factory('chat-001');
    await callbacks.sendCard('chat-001', { elements: [] }, 'desc', 'thread-456');
    expect(channel.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({ threadId: 'thread-456' }),
    );
  });

  it('sendFile should log a warning (not fully implemented)', async () => {
    const factory = createChannelCallbacksFactory(channel, mockLogger);
    const callbacks = factory('chat-001');
    await callbacks.sendFile('chat-001', '/path/to/file.pdf');
    expect(mockLogger.warn).toHaveBeenCalledWith(
      { chatId: 'chat-001', filePath: '/path/to/file.pdf' },
      'File sending not fully implemented',
    );
  });

  it('onDone should log completion when sendDoneSignal is false', async () => {
    const factory = createChannelCallbacksFactory(channel, mockLogger, {
      sendDoneSignal: false,
    });
    const callbacks = factory('chat-001');
    await callbacks.onDone!('chat-001');
    expect(mockLogger.info).toHaveBeenCalledWith({ chatId: 'chat-001' }, 'Task completed');
    expect(channel.sendMessage).not.toHaveBeenCalled();
  });

  it('onDone should send done message when sendDoneSignal is true', async () => {
    const factory = createChannelCallbacksFactory(channel, mockLogger, {
      sendDoneSignal: true,
    });
    const callbacks = factory('chat-001');
    await callbacks.onDone!('chat-001');
    expect(channel.sendMessage).toHaveBeenCalledWith({
      chatId: 'chat-001',
      type: 'done',
      threadId: undefined,
    });
  });

  it('onDone with sendDoneSignal=true should pass threadId', async () => {
    const factory = createChannelCallbacksFactory(channel, mockLogger, {
      sendDoneSignal: true,
    });
    const callbacks = factory('chat-001');
    await callbacks.onDone!('chat-001', 'thread-789');
    expect(channel.sendMessage).toHaveBeenCalledWith({
      chatId: 'chat-001',
      type: 'done',
      threadId: 'thread-789',
    });
  });

  it('onDone should default to false when no options provided', async () => {
    const factory = createChannelCallbacksFactory(channel, mockLogger);
    const callbacks = factory('chat-001');
    await callbacks.onDone!('chat-001');
    expect(channel.sendMessage).not.toHaveBeenCalled();
    expect(mockLogger.info).toHaveBeenCalledWith({ chatId: 'chat-001' }, 'Task completed');
  });
});

// ============================================================================
// Tests: createDefaultMessageHandler
// ============================================================================

describe('createDefaultMessageHandler', () => {
  let channel: IChannel;
  let context: WiredContext;

  beforeEach(() => {
    channel = createMockChannel();
    context = createMockWiredContext({ channel });
    vi.clearAllMocks();
  });

  it('should return a message handler function', () => {
    const handler = createDefaultMessageHandler(channel, context, {
      channelName: 'Test channel',
    });
    expect(typeof handler).toBe('function');
  });

  it('should get or create agent from pool with callbacks', async () => {
    const handler = createDefaultMessageHandler(channel, context, {
      channelName: 'Test channel',
    });
    const message = createMockMessage();
    await handler(message);
    expect(context.agentPool.getOrCreateChatAgent).toHaveBeenCalledWith(
      'chat-001',
      expect.objectContaining({
        sendMessage: expect.any(Function),
        sendCard: expect.any(Function),
        sendFile: expect.any(Function),
        onDone: expect.any(Function),
      }),
    );
  });

  it('should process message through agent', async () => {
    const handler = createDefaultMessageHandler(channel, context, {
      channelName: 'Test channel',
    });
    const message = createMockMessage();
    await handler(message);

    const agent = (context.agentPool.getOrCreateChatAgent as any).mock.results[0].value;
    expect(agent.processMessage).toHaveBeenCalledWith(
      'chat-001',
      'Hello, agent!',
      'msg-001',
      'user-001',
      undefined,
      undefined,
    );
  });

  it('should pass file refs when extractAttachments is provided', async () => {
    const fileRefs = [{
      id: 'file-001',
      fileName: 'test.pdf',
      source: 'user' as const,
      localPath: '/tmp/test.pdf',
      createdAt: Date.now(),
    }];
    const handler = createDefaultMessageHandler(channel, context, {
      channelName: 'Test channel',
      extractAttachments: () => fileRefs,
    });
    const message = createMockMessage();
    await handler(message);

    const agent = (context.agentPool.getOrCreateChatAgent as any).mock.results[0].value;
    expect(agent.processMessage).toHaveBeenCalledWith(
      'chat-001',
      'Hello, agent!',
      'msg-001',
      'user-001',
      fileRefs,
      undefined,
    );
  });

  it('should pass chatHistoryContext from metadata', async () => {
    const handler = createDefaultMessageHandler(channel, context, {
      channelName: 'Test channel',
    });
    const message = createMockMessage({
      metadata: { chatHistoryContext: 'Previous conversation context' },
    });
    await handler(message);

    const agent = (context.agentPool.getOrCreateChatAgent as any).mock.results[0].value;
    expect(agent.processMessage).toHaveBeenCalledWith(
      'chat-001',
      'Hello, agent!',
      'msg-001',
      'user-001',
      undefined,
      'Previous conversation context',
    );
  });

  it('should handle undefined userId gracefully', async () => {
    const handler = createDefaultMessageHandler(channel, context, {
      channelName: 'Test channel',
    });
    const message = createMockMessage({ userId: undefined });
    await handler(message);

    const agent = (context.agentPool.getOrCreateChatAgent as any).mock.results[0].value;
    expect(agent.processMessage).toHaveBeenCalledWith(
      'chat-001',
      'Hello, agent!',
      'msg-001',
      undefined,
      undefined,
      undefined,
    );
  });

  it('should log message processing with correct channel name', async () => {
    const handler = createDefaultMessageHandler(channel, context, {
      channelName: 'My Custom Channel',
    });
    const message = createMockMessage();
    await handler(message);
    expect(context.logger.info).toHaveBeenCalledWith(
      expect.objectContaining({
        chatId: 'chat-001',
        messageId: 'msg-001',
        contentLength: 13,
        hasAttachments: false,
      }),
      'Processing message from My Custom Channel',
    );
  });

  it('should log hasAttachments as true when attachments present', async () => {
    const handler = createDefaultMessageHandler(channel, context, {
      channelName: 'Test channel',
    });
    const message = createMockMessage({
      attachments: [{ fileName: 'file.pdf', filePath: '/tmp/file.pdf' }],
    });
    await handler(message);
    expect(context.logger.info).toHaveBeenCalledWith(
      expect.objectContaining({ hasAttachments: true }),
      expect.any(String),
    );
  });

  it('should send error message when agent.processMessage throws', async () => {
    const handler = createDefaultMessageHandler(channel, context, {
      channelName: 'Test channel',
    });
    const mockAgent = {
      processMessage: vi.fn().mockImplementation(() => {
        throw new Error('Agent exploded');
      }),
    };
    (context.agentPool.getOrCreateChatAgent as any).mockReturnValue(mockAgent);

    const message = createMockMessage();
    await handler(message);

    expect(channel.sendMessage).toHaveBeenCalledWith({
      chatId: 'chat-001',
      type: 'text',
      text: '❌ Error: Agent exploded',
    });
  });

  it('should send done signal on error when sendDoneSignal is true', async () => {
    const handler = createDefaultMessageHandler(channel, context, {
      channelName: 'Test channel',
      sendDoneSignal: true,
    });
    const mockAgent = {
      processMessage: vi.fn().mockImplementation(() => {
        throw new Error('Fail');
      }),
    };
    (context.agentPool.getOrCreateChatAgent as any).mockReturnValue(mockAgent);

    const message = createMockMessage();
    await handler(message);

    // First call: error message, Second call: done signal
    expect(channel.sendMessage).toHaveBeenCalledTimes(2);
    expect(channel.sendMessage).toHaveBeenLastCalledWith({
      chatId: 'chat-001',
      type: 'done',
    });
  });

  it('should NOT send done signal on error when sendDoneSignal is false', async () => {
    const handler = createDefaultMessageHandler(channel, context, {
      channelName: 'Test channel',
      sendDoneSignal: false,
    });
    const mockAgent = {
      processMessage: vi.fn().mockImplementation(() => {
        throw new Error('Fail');
      }),
    };
    (context.agentPool.getOrCreateChatAgent as any).mockReturnValue(mockAgent);

    const message = createMockMessage();
    await handler(message);

    // Only the error message, no done signal
    expect(channel.sendMessage).toHaveBeenCalledTimes(1);
    expect(channel.sendMessage).toHaveBeenCalledWith({
      chatId: 'chat-001',
      type: 'text',
      text: '❌ Error: Fail',
    });
  });

  it('should handle non-Error exceptions in processMessage', async () => {
    const handler = createDefaultMessageHandler(channel, context, {
      channelName: 'Test channel',
    });
    const mockAgent = {
      processMessage: vi.fn().mockImplementation(() => {
        throw 'string error'; // eslint-disable-line no-throw-literal
      }),
    };
    (context.agentPool.getOrCreateChatAgent as any).mockReturnValue(mockAgent);

    const message = createMockMessage();
    await handler(message);

    expect(channel.sendMessage).toHaveBeenCalledWith({
      chatId: 'chat-001',
      type: 'text',
      text: '❌ Error: string error',
    });
  });
});
