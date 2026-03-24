/**
 * Tests for Unified Channel Handler Factory.
 *
 * Tests the createChannelCallbacks, createMessageHandler, and
 * setupChannelHandlers utilities that provide capability-aware
 * handler injection for any IChannel implementation.
 *
 * @module handlers/channel-handler-factory.test
 * @see Issue #1555 - Unified Channel Handler Injection (Phase 2)
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  createChannelCallbacks,
  createMessageHandler,
  setupChannelHandlers,
  type IAgentPool,
} from './channel-handler-factory.js';
import type { IChannel, IncomingMessage, ChannelCapabilities, ControlHandler, ControlCommand, ControlResponse } from '@disclaude/core';
import type { PilotCallbacks } from '@disclaude/worker-node';

// --- Mock Helpers ---

function createMockChannel(overrides: Partial<IChannel> & { capabilities?: Partial<ChannelCapabilities> } = {}): IChannel & { sentMessages: Array<Record<string, unknown>> } {
  const defaultCapabilities: ChannelCapabilities = {
    supportsCard: false,
    supportsThread: false,
    supportsFile: false,
    supportsMarkdown: true,
    supportsMention: false,
    supportsUpdate: false,
    supportedMcpTools: [],
    ...overrides.capabilities,
  };

  const sentMessages: Array<Record<string, unknown>> = [];
  const registeredHandlers: {
    message?: (message: IncomingMessage) => Promise<void>;
    control?: (command: ControlCommand) => Promise<ControlResponse>;
  } = {};

  return {
    id: overrides.id ?? 'test-channel',
    name: overrides.name ?? 'Test Channel',
    status: 'stopped',
    sentMessages,
    registeredHandlers,

    getCapabilities: () => defaultCapabilities,

    sendMessage: vi.fn(async (message: Record<string, unknown>) => {
      sentMessages.push(message);
    }),

    onMessage: vi.fn((handler: (message: IncomingMessage) => Promise<void>) => {
      registeredHandlers.message = handler;
    }),

    onControl: vi.fn((handler: (command: ControlCommand) => Promise<ControlResponse>) => {
      registeredHandlers.control = handler;
    }),

    start: vi.fn(async () => {}),
    stop: vi.fn(async () => {}),
    isHealthy: () => true,

    ...overrides,
  } as IChannel & { sentMessages: Array<Record<string, unknown>>; registeredHandlers: { message?: (message: IncomingMessage) => Promise<void>; control?: (command: ControlCommand) => Promise<ControlResponse> } };
}

interface MockChatAgent {
  processMessage: ReturnType<typeof vi.fn>;
}

function createMockAgentPool() {
  const agents = new Map<string, MockChatAgent>();
  const getOrCreate = vi.fn((_chatId: string, _callbacks: PilotCallbacks) => {
    let agent = agents.get(_chatId);
    if (!agent) {
      agent = { processMessage: vi.fn() };
      agents.set(_chatId, agent);
    }
    return agent;
  });

  const pool = {
    agents,
    getOrCreateChatAgent: getOrCreate as IAgentPool['getOrCreateChatAgent'] & ReturnType<typeof vi.fn>,
  };
  return pool;
}

function createMockIncomingMessage(overrides: Partial<IncomingMessage> = {}): IncomingMessage {
  return {
    messageId: 'msg-001',
    chatId: 'chat-001',
    userId: 'user-001',
    content: 'Hello, world!',
    messageType: 'text',
    timestamp: Date.now(),
    ...overrides,
  };
}

// --- Test Suites ---

describe('Channel Handler Factory', () => {
  describe('createChannelCallbacks', () => {
    it('should create callbacks with sendMessage that forwards to channel', async () => {
      const channel = createMockChannel();
      const callbacks = createChannelCallbacks(channel);

      await callbacks.sendMessage('chat-1', 'Hello');

      expect(channel.sendMessage).toHaveBeenCalledWith({
        chatId: 'chat-1',
        type: 'text',
        text: 'Hello',
        threadId: undefined,
      });
    });

    it('should pass threadId to sendMessage', async () => {
      const channel = createMockChannel();
      const callbacks = createChannelCallbacks(channel);

      await callbacks.sendMessage('chat-1', 'Hello', 'thread-123');

      expect(channel.sendMessage).toHaveBeenCalledWith({
        chatId: 'chat-1',
        type: 'text',
        text: 'Hello',
        threadId: 'thread-123',
      });
    });

    it('should forward sendCard when channel supports cards', async () => {
      const channel = createMockChannel({ capabilities: { supportsCard: true } });
      const callbacks = createChannelCallbacks(channel);

      const card = { header: { title: 'Test' } };
      await callbacks.sendCard('chat-1', card, 'A test card', 'thread-456');

      expect(channel.sendMessage).toHaveBeenCalledWith({
        chatId: 'chat-1',
        type: 'card',
        card,
        description: 'A test card',
        threadId: 'thread-456',
      });
    });

    it('should warn and not send when channel does not support cards', async () => {
      const channel = createMockChannel({ capabilities: { supportsCard: false } });
      const callbacks = createChannelCallbacks(channel);

      await callbacks.sendCard('chat-1', { header: { title: 'Test' } });

      expect(channel.sendMessage).not.toHaveBeenCalled();
    });

    it('should forward sendFile when channel supports files', async () => {
      const channel = createMockChannel({ capabilities: { supportsFile: true } });
      const callbacks = createChannelCallbacks(channel);

      await callbacks.sendFile('chat-1', '/path/to/file.pdf');

      expect(channel.sendMessage).toHaveBeenCalledWith({
        chatId: 'chat-1',
        type: 'file',
        filePath: '/path/to/file.pdf',
      });
    });

    it('should warn and not send when channel does not support files', async () => {
      const channel = createMockChannel({ capabilities: { supportsFile: false } });
      const callbacks = createChannelCallbacks(channel);

      await callbacks.sendFile('chat-1', '/path/to/file.pdf');

      expect(channel.sendMessage).not.toHaveBeenCalled();
    });

    it('should only log on onDone when sendDoneSignal is false', async () => {
      const channel = createMockChannel();
      const callbacks = createChannelCallbacks(channel, { sendDoneSignal: false });

      await callbacks.onDone!('chat-1', 'thread-789');

      expect(channel.sendMessage).not.toHaveBeenCalled();
    });

    it('should send done signal on onDone when sendDoneSignal is true', async () => {
      const channel = createMockChannel();
      const callbacks = createChannelCallbacks(channel, { sendDoneSignal: true });

      await callbacks.onDone!('chat-1', 'thread-789');

      expect(channel.sendMessage).toHaveBeenCalledWith({
        chatId: 'chat-1',
        type: 'done',
        threadId: 'thread-789',
      });
    });

    it('should send done without threadId when onDone has no threadId', async () => {
      const channel = createMockChannel();
      const callbacks = createChannelCallbacks(channel, { sendDoneSignal: true });

      await callbacks.onDone!('chat-1');

      expect(channel.sendMessage).toHaveBeenCalledWith({
        chatId: 'chat-1',
        type: 'done',
        threadId: undefined,
      });
    });
  });

  describe('createMessageHandler', () => {
    let channel: ReturnType<typeof createMockChannel>;
    let agentPool: ReturnType<typeof createMockAgentPool>;

    beforeEach(() => {
      channel = createMockChannel({ id: 'test', name: 'Test' });
      agentPool = createMockAgentPool();
    });

    it('should create a handler function', () => {
      const handler = createMessageHandler(channel, agentPool);
      expect(typeof handler).toBe('function');
    });

    it('should get or create agent for the chat', async () => {
      const handler = createMessageHandler(channel, agentPool);
      const message = createMockIncomingMessage();

      await handler(message);

      expect(agentPool.getOrCreateChatAgent).toHaveBeenCalledWith('chat-001', expect.any(Object));
    });

    it('should process message through agent with correct arguments', async () => {
      const handler = createMessageHandler(channel, agentPool);
      const message = createMockIncomingMessage({
        chatId: 'chat-42',
        content: 'Test message',
        messageId: 'msg-42',
        userId: 'user-42',
        metadata: { chatHistoryContext: 'previous-context' },
      });

      await handler(message);

      const agent = agentPool.agents.get('chat-42');
      expect(agent?.processMessage).toHaveBeenCalledWith(
        'chat-42',
        'Test message',
        'msg-42',
        'user-42',
        undefined, // no fileRefs since supportsFile is false
        'previous-context'
      );
    });

    it('should convert attachments to FileRef when channel supports files', async () => {
      const fileChannel = createMockChannel({
        id: 'file-channel',
        name: 'File Channel',
        capabilities: { supportsFile: true },
      });
      const handler = createMessageHandler(fileChannel, agentPool);
      const message = createMockIncomingMessage({
        attachments: [
          { fileName: 'test.png', filePath: '/tmp/test.png', mimeType: 'image/png', size: 1024 },
          { fileName: 'doc.pdf', filePath: '/tmp/doc.pdf', mimeType: 'application/pdf', size: 2048 },
        ],
      });

      await handler(message);

      const agent = agentPool.agents.get('chat-001');
      expect(agent?.processMessage).toHaveBeenCalledWith(
        'chat-001',
        'Hello, world!',
        'msg-001',
        'user-001',
        expect.arrayContaining([
          expect.objectContaining({ fileName: 'test.png' }),
          expect.objectContaining({ fileName: 'doc.pdf' }),
        ]),
        undefined
      );
    });

    it('should not convert attachments when channel does not support files', async () => {
      const handler = createMessageHandler(channel, agentPool);
      const message = createMockIncomingMessage({
        attachments: [{ fileName: 'test.png', filePath: '/tmp/test.png' }],
      });

      await handler(message);

      const agent = agentPool.agents.get('chat-001');
      expect(agent?.processMessage).toHaveBeenCalledWith(
        'chat-001',
        'Hello, world!',
        'msg-001',
        'user-001',
        undefined, // fileRefs should be undefined
        undefined
      );
    });

    it('should handle errors and send error message to channel', async () => {
      // Pre-create the agent so we can set up the throwing behavior
      agentPool.getOrCreateChatAgent('chat-001', {} as any);
      const agent = agentPool.agents.get('chat-001')!;
      agent.processMessage.mockImplementation(() => {
        throw new Error('Agent processing failed');
      });

      const handler = createMessageHandler(channel, agentPool);
      const message = createMockIncomingMessage();

      await handler(message);

      // Should send error message
      expect(channel.sendMessage).toHaveBeenCalledWith({
        chatId: 'chat-001',
        type: 'text',
        text: '❌ Error: Agent processing failed',
      });
    });

    it('should send done signal on error when sendDoneSignal is true', async () => {
      agentPool.getOrCreateChatAgent('chat-001', {} as any);
      const agent = agentPool.agents.get('chat-001')!;
      agent.processMessage.mockImplementation(() => {
        throw new Error('Agent processing failed');
      });

      const handler = createMessageHandler(channel, agentPool, { sendDoneSignal: true });
      const message = createMockIncomingMessage();

      await handler(message);

      // Should send error message AND done signal
      expect(channel.sendMessage).toHaveBeenCalledWith({
        chatId: 'chat-001',
        type: 'text',
        text: '❌ Error: Agent processing failed',
      });
      expect(channel.sendMessage).toHaveBeenCalledWith({
        chatId: 'chat-001',
        type: 'done',
      });
    });

    it('should not send done signal on error when sendDoneSignal is false', async () => {
      agentPool.getOrCreateChatAgent('chat-001', {} as any);
      const agent = agentPool.agents.get('chat-001')!;
      agent.processMessage.mockImplementation(() => {
        throw new Error('Agent processing failed');
      });

      const handler = createMessageHandler(channel, agentPool, { sendDoneSignal: false });
      const message = createMockIncomingMessage();

      await handler(message);

      // Should only send error message, not done signal
      const calls = (channel.sendMessage as ReturnType<typeof vi.fn>).mock.calls;
      const doneCalls = calls.filter((call: any[]) => call[0]?.type === 'done');
      expect(doneCalls).toHaveLength(0);
    });

    it('should handle non-Error exceptions gracefully', async () => {
      agentPool.getOrCreateChatAgent('chat-001', {} as any);
      const agent = agentPool.agents.get('chat-001')!;
      agent.processMessage.mockImplementation(() => {
        throw 'string error';
      });

      const handler = createMessageHandler(channel, agentPool);
      const message = createMockIncomingMessage();

      await handler(message);

      expect(channel.sendMessage).toHaveBeenCalledWith({
        chatId: 'chat-001',
        type: 'text',
        text: '❌ Error: string error',
      });
    });

    it('should extract chatHistoryContext from metadata', async () => {
      const handler = createMessageHandler(channel, agentPool);
      const message = createMockIncomingMessage({
        metadata: { chatHistoryContext: 'shared-chat-history' },
      });

      await handler(message);

      const agent = agentPool.agents.get('chat-001');
      expect(agent?.processMessage).toHaveBeenCalledWith(
        'chat-001',
        'Hello, world!',
        'msg-001',
        'user-001',
        undefined,
        'shared-chat-history'
      );
    });

    it('should reuse the same callbacks instance across messages', async () => {
      const handler = createMessageHandler(channel, agentPool);
      const msg1 = createMockIncomingMessage({ messageId: 'msg-1' });
      const msg2 = createMockIncomingMessage({ messageId: 'msg-2' });

      await handler(msg1);
      const firstCallCallbacks = agentPool.getOrCreateChatAgent.mock.calls[0][1];

      await handler(msg2);
      const secondCallCallbacks = agentPool.getOrCreateChatAgent.mock.calls[1][1];

      // Both calls should use the same callbacks instance
      expect(firstCallCallbacks).toBe(secondCallCallbacks);
    });
  });

  describe('setupChannelHandlers', () => {
    it('should register both message and control handlers on the channel', () => {
      const channel = createMockChannel();
      const agentPool = createMockAgentPool();
      const controlHandler: ControlHandler = vi.fn(async () => ({ success: true }));

      setupChannelHandlers(channel, agentPool, controlHandler);

      expect(channel.onMessage).toHaveBeenCalledWith(expect.any(Function));
      expect(channel.onControl).toHaveBeenCalledWith(controlHandler);
    });

    it('should pass options through to the message handler', async () => {
      const channel = createMockChannel({ capabilities: { supportsCard: true } });
      const agentPool = createMockAgentPool();
      const controlHandler: ControlHandler = vi.fn(async () => ({ success: true }));

      setupChannelHandlers(channel, agentPool, controlHandler, { sendDoneSignal: true });

      // Pre-create the agent and set up throwing behavior
      agentPool.getOrCreateChatAgent('chat-001', {} as any);
      const agent = agentPool.agents.get('chat-001')!;
      agent.processMessage.mockImplementation(() => {
        throw new Error('Test error');
      });

      // Get the registered message handler
      const messageHandler = (channel.onMessage as ReturnType<typeof vi.fn>).mock.calls[0][0];

      // Simulate a message that triggers an error
      const message = createMockIncomingMessage();

      await messageHandler(message);

      // Should have sent both error and done signal
      expect(channel.sendMessage).toHaveBeenCalledWith({
        chatId: 'chat-001',
        type: 'text',
        text: '❌ Error: Test error',
      });
      expect(channel.sendMessage).toHaveBeenCalledWith({
        chatId: 'chat-001',
        type: 'done',
      });
    });

    it('should work with default options (no sendDoneSignal)', async () => {
      const channel = createMockChannel();
      const agentPool = createMockAgentPool();
      const controlHandler: ControlHandler = vi.fn(async () => ({ success: true }));

      setupChannelHandlers(channel, agentPool, controlHandler);

      const messageHandler = (channel.onMessage as ReturnType<typeof vi.fn>).mock.calls[0][0];

      // Pre-create the agent and set up throwing behavior
      agentPool.getOrCreateChatAgent('chat-001', {} as any);
      const agent = agentPool.agents.get('chat-001')!;
      agent.processMessage.mockImplementation(() => {
        throw new Error('Test error');
      });

      const message = createMockIncomingMessage();

      await messageHandler(message);

      // Should only send error message, not done signal
      const calls = (channel.sendMessage as ReturnType<typeof vi.fn>).mock.calls;
      const doneCalls = calls.filter((call: any[]) => call[0]?.type === 'done');
      expect(doneCalls).toHaveLength(0);
    });
  });

  describe('capability-aware behavior', () => {
    it('should adapt sendCard based on channel capabilities', async () => {
      const noCardChannel = createMockChannel({
        id: 'no-card',
        capabilities: { supportsCard: false },
      });
      const cardChannel = createMockChannel({
        id: 'with-card',
        capabilities: { supportsCard: true },
      });

      const noCardCallbacks = createChannelCallbacks(noCardChannel);
      const cardCallbacks = createChannelCallbacks(cardChannel);

      const card = { elements: [{ tag: 'div', text: 'Hello' }] };

      await noCardCallbacks.sendCard('chat-1', card);
      expect(noCardChannel.sendMessage).not.toHaveBeenCalled();

      await cardCallbacks.sendCard('chat-1', card);
      expect(cardChannel.sendMessage).toHaveBeenCalledWith({
        chatId: 'chat-1',
        type: 'card',
        card,
        description: undefined,
        threadId: undefined,
      });
    });

    it('should adapt sendFile based on channel capabilities', async () => {
      const noFileChannel = createMockChannel({
        id: 'no-file',
        capabilities: { supportsFile: false },
      });
      const fileChannel = createMockChannel({
        id: 'with-file',
        capabilities: { supportsFile: true },
      });

      const noFileCallbacks = createChannelCallbacks(noFileChannel);
      const fileCallbacks = createChannelCallbacks(fileChannel);

      await noFileCallbacks.sendFile('chat-1', '/path/file.pdf');
      expect(noFileChannel.sendMessage).not.toHaveBeenCalled();

      await fileCallbacks.sendFile('chat-1', '/path/file.pdf');
      expect(fileChannel.sendMessage).toHaveBeenCalledWith({
        chatId: 'chat-1',
        type: 'file',
        filePath: '/path/file.pdf',
      });
    });

    it('should skip empty attachment arrays', async () => {
      const fileChannel = createMockChannel({
        capabilities: { supportsFile: true },
      });
      const pool = createMockAgentPool();
      const handler = createMessageHandler(fileChannel, pool);
      const message = createMockIncomingMessage({ attachments: [] });

      await handler(message);

      const agent = pool.agents.get('chat-001');
      expect(agent?.processMessage).toHaveBeenCalledWith(
        'chat-001',
        'Hello, world!',
        'msg-001',
        'user-001',
        undefined, // No fileRefs for empty attachments
        undefined
      );
    });
  });
});
