/**
 * Tests for ChannelLifecycleManager.
 *
 * Part of Issue #1594 (Phase 2): Abstract channel wiring into descriptors.
 */

import { expect } from 'chai';
import { describe, it, beforeEach, vi } from 'vitest';
import type {
  IChannel,
  ChannelConfig,
  MessageHandler,
  ControlHandler,
  ChannelCapabilities,
  ControlHandlerContext,
} from '@disclaude/core';
import type { PilotCallbacks } from '@disclaude/worker-node';
import { ChannelManager } from './channel-manager.js';
import {
  ChannelLifecycleManager,
  createChannelCallbacks,
  createDefaultMessageHandler,
  type WiredChannelDescriptor,
  type ChannelSetupContext,
} from './channel-lifecycle-manager.js';

// ============================================================================
// Mock Helpers
// ============================================================================

function createMockChannel(overrides?: Partial<IChannel>): IChannel {
  const messages: Array<{ chatId: string; type: string; text?: string; threadId?: string }> = [];

  return {
    id: overrides?.id ?? 'test-channel',
    name: overrides?.name ?? 'Test Channel',
    status: overrides?.status ?? 'ready',
    onMessage: vi.fn(),
    onControl: vi.fn(),
    sendMessage: vi.fn(async (msg) => {
      messages.push({ chatId: msg.chatId, type: msg.type, text: 'text' in msg ? msg.text : undefined });
    }),
    start: vi.fn(async () => {}),
    stop: vi.fn(async () => {}),
    isHealthy: () => true,
    getCapabilities: overrides?.getCapabilities ?? (() => ({
      supportsCard: true,
      supportsThread: false,
      supportsFile: false,
      supportsMarkdown: true,
      supportsMention: false,
      supportsUpdate: false,
    })),
    ...overrides,
  } as IChannel;
}

function createMockAgentPool() {
  return {
    getOrCreateChatAgent: vi.fn(() => ({
      processMessage: vi.fn(),
    })),
    reset: vi.fn(),
    stop: vi.fn(() => true),
    disposeAll: vi.fn(),
  } as unknown as import('./primary-agent-pool.js').PrimaryAgentPool;
}

function createMockPrimaryNode(channelManager?: ChannelManager) {
  return {
    getNodeId: () => 'test-node',
    getChannelManager: () => channelManager ?? new ChannelManager(),
    registerFeishuHandlers: vi.fn(),
    getExecNodeRegistry: () => ({ getNodes: () => [] }),
    getDebugGroupService: () => ({ getDebugGroup: () => null, clearDebugGroup: () => {} }),
  } as unknown as import('./primary-node.js').PrimaryNode;
}

function createMockControlHandler(): ControlHandler {
  return vi.fn(async () => ({ success: true }));
}

function createSetupContext(overrides?: Partial<ChannelSetupContext>): ChannelSetupContext {
  return {
    agentPool: createMockAgentPool(),
    controlHandler: createMockControlHandler(),
    primaryNode: createMockPrimaryNode(),
    ...overrides,
  };
}

// ============================================================================
// createChannelCallbacks Tests
// ============================================================================

describe('createChannelCallbacks', () => {
  it('should create callbacks that delegate to channel.sendMessage', async () => {
    const channel = createMockChannel();
    const callbacks = createChannelCallbacks(channel);

    await callbacks.sendMessage('chat-1', 'Hello World');
    expect(channel.sendMessage).toHaveBeenCalledWith({
      chatId: 'chat-1',
      type: 'text',
      text: 'Hello World',
      threadId: undefined,
    });

    const card = { header: { title: 'Test' } };
    await callbacks.sendCard('chat-1', card, 'desc', 'thread-1');
    expect(channel.sendMessage).toHaveBeenCalledWith({
      chatId: 'chat-1',
      type: 'card',
      card,
      description: 'desc',
      threadId: 'thread-1',
    });
  });

  it('should send done signal when sendDoneSignal is true', async () => {
    const channel = createMockChannel();
    const callbacks = createChannelCallbacks(channel, { sendDoneSignal: true });

    await callbacks.onDone?.('chat-1', 'thread-1');
    expect(channel.sendMessage).toHaveBeenCalledWith({
      chatId: 'chat-1',
      type: 'done',
      threadId: 'thread-1',
    });
  });

  it('should NOT send done signal when sendDoneSignal is false', async () => {
    const channel = createMockChannel();
    const callbacks = createChannelCallbacks(channel, { sendDoneSignal: false });

    await callbacks.onDone?.('chat-1', 'thread-1');
    expect(channel.sendMessage).not.toHaveBeenCalled();
  });

  it('should send file when channel supports it', async () => {
    const channel = createMockChannel({
      getCapabilities: () => ({
        supportsCard: true,
        supportsThread: false,
        supportsFile: true,
        supportsMarkdown: true,
        supportsMention: false,
        supportsUpdate: false,
      }),
    });
    const callbacks = createChannelCallbacks(channel);

    await callbacks.sendFile('chat-1', '/path/to/file.pdf');
    expect(channel.sendMessage).toHaveBeenCalledWith({
      chatId: 'chat-1',
      type: 'file',
      filePath: '/path/to/file.pdf',
    });
  });

  it('should NOT send file when channel does not support it', async () => {
    const channel = createMockChannel();
    const callbacks = createChannelCallbacks(channel);

    await callbacks.sendFile('chat-1', '/path/to/file.pdf');
    expect(channel.sendMessage).not.toHaveBeenCalled();
  });
});

// ============================================================================
// createDefaultMessageHandler Tests
// ============================================================================

describe('createDefaultMessageHandler', () => {
  it('should process message through agentPool', async () => {
    const channel = createMockChannel();
    const context = createSetupContext();
    const callbacks = createChannelCallbacks(channel);
    const handler = createDefaultMessageHandler(channel, context, callbacks);

    const processMessage = vi.fn();
    (context.agentPool.getOrCreateChatAgent as ReturnType<typeof vi.fn>).mockReturnValue({
      processMessage,
    });

    await handler({
      chatId: 'chat-1',
      content: 'Hello',
      messageId: 'msg-1',
      userId: 'user-1',
      messageType: 'text',
    });

    expect(context.agentPool.getOrCreateChatAgent).toHaveBeenCalledWith('chat-1', callbacks);
    expect(processMessage).toHaveBeenCalledWith(
      'chat-1', 'Hello', 'msg-1', 'user-1', undefined, undefined
    );
  });

  it('should send error message when processing fails', async () => {
    const channel = createMockChannel();
    const context = createSetupContext();
    const callbacks = createChannelCallbacks(channel);
    const handler = createDefaultMessageHandler(channel, context, callbacks, {
      sendDoneSignalOnError: false,
    });

    (context.agentPool.getOrCreateChatAgent as ReturnType<typeof vi.fn>).mockReturnValue({
      processMessage: vi.fn(() => { throw new Error('Agent failed'); }),
    });

    await handler({
      chatId: 'chat-1',
      content: 'Hello',
      messageId: 'msg-1',
      userId: 'user-1',
      messageType: 'text',
    });

    expect(channel.sendMessage).toHaveBeenCalledWith({
      chatId: 'chat-1',
      type: 'text',
      text: '❌ Error: Agent failed',
    });
  });

  it('should send done signal on error when configured', async () => {
    const channel = createMockChannel();
    const context = createSetupContext();
    const callbacks = createChannelCallbacks(channel);
    const handler = createDefaultMessageHandler(channel, context, callbacks, {
      sendDoneSignalOnError: true,
    });

    (context.agentPool.getOrCreateChatAgent as ReturnType<typeof vi.fn>).mockReturnValue({
      processMessage: vi.fn(() => { throw new Error('Agent failed'); }),
    });

    await handler({
      chatId: 'chat-1',
      content: 'Hello',
      messageId: 'msg-1',
      userId: 'user-1',
      messageType: 'text',
    });

    // Should have been called with error message AND done signal
    expect(channel.sendMessage).toHaveBeenCalledTimes(2);
    expect(channel.sendMessage).toHaveBeenLastCalledWith({
      chatId: 'chat-1',
      type: 'done',
    });
  });

  it('should convert attachments when converter is provided', async () => {
    const channel = createMockChannel();
    const context = createSetupContext();
    const callbacks = createChannelCallbacks(channel);

    const fileRefs = [{ filePath: '/path/to/image.png' }];
    const convertAttachments = vi.fn(() => fileRefs);

    const handler = createDefaultMessageHandler(channel, context, callbacks, {
      convertAttachments,
    });

    const processMessage = vi.fn();
    (context.agentPool.getOrCreateChatAgent as ReturnType<typeof vi.fn>).mockReturnValue({
      processMessage,
    });

    await handler({
      chatId: 'chat-1',
      content: 'Look at this',
      messageId: 'msg-1',
      userId: 'user-1',
      messageType: 'image',
      attachments: [{ fileName: 'image.png', filePath: '/path/to/image.png' }],
    });

    expect(convertAttachments).toHaveBeenCalled();
    expect(processMessage).toHaveBeenCalledWith(
      'chat-1', 'Look at this', 'msg-1', 'user-1', fileRefs, undefined
    );
  });
});

// ============================================================================
// ChannelLifecycleManager Tests
// ============================================================================

describe('ChannelLifecycleManager', () => {
  let channelManager: ChannelManager;
  let manager: ChannelLifecycleManager;
  let mockAgentPool: ReturnType<typeof createMockAgentPool>;
  let mockPrimaryNode: ReturnType<typeof createMockPrimaryNode>;

  beforeEach(() => {
    channelManager = new ChannelManager();
    mockAgentPool = createMockAgentPool();
    mockPrimaryNode = createMockPrimaryNode(channelManager);
    manager = new ChannelLifecycleManager({
      channelManager,
      agentPool: mockAgentPool,
      controlHandler: createMockControlHandler(),
      primaryNode: mockPrimaryNode,
    });
  });

  describe('registerDescriptor', () => {
    it('should register a descriptor', () => {
      const descriptor: WiredChannelDescriptor = {
        type: 'test',
        name: 'Test',
        factory: () => createMockChannel(),
        defaultCapabilities: {
          supportsCard: false,
          supportsThread: false,
          supportsFile: false,
          supportsMarkdown: false,
          supportsMention: false,
          supportsUpdate: false,
        },
        createCallbacks: () => createChannelCallbacks(createMockChannel()),
      };

      manager.registerDescriptor(descriptor);
      expect(manager.getDescriptor('test')).to.equal(descriptor);
      expect(manager.getRegisteredTypes()).to.deep.equal(['test']);
    });

    it('should replace descriptor when registering same type', () => {
      const desc1: WiredChannelDescriptor = {
        type: 'test',
        name: 'Test1',
        factory: () => createMockChannel(),
        defaultCapabilities: {
          supportsCard: false,
          supportsThread: false,
          supportsFile: false,
          supportsMarkdown: false,
          supportsMention: false,
          supportsUpdate: false,
        },
        createCallbacks: () => createChannelCallbacks(createMockChannel()),
      };
      const desc2: WiredChannelDescriptor = { ...desc1, name: 'Test2' };

      manager.registerDescriptor(desc1);
      manager.registerDescriptor(desc2);

      expect(manager.getDescriptor('test')).to.equal(desc2);
      expect(manager.getRegisteredTypes()).to.deep.equal(['test']);
    });
  });

  describe('createAndWire', () => {
    it('should create, wire, and register a channel', async () => {
      const channel = createMockChannel();
      const setupCalled = vi.fn();

      const descriptor: WiredChannelDescriptor = {
        type: 'test',
        name: 'Test',
        factory: () => channel,
        defaultCapabilities: {
          supportsCard: true,
          supportsThread: false,
          supportsFile: false,
          supportsMarkdown: true,
          supportsMention: false,
          supportsUpdate: false,
        },
        createCallbacks: () => createChannelCallbacks(channel),
        createMessageHandler: () => vi.fn(),
        setup: setupCalled,
      };

      manager.registerDescriptor(descriptor);
      const result = await manager.createAndWire('test', { id: 'test-channel' });

      expect(result).to.equal(channel);
      expect(channelManager.has('test-channel')).to.be.true;
      expect(channel.onMessage).toHaveBeenCalled();
      expect(channel.onControl).toHaveBeenCalled();
      expect(setupCalled).toHaveBeenCalled();
    });

    it('should use default message handler when createMessageHandler is not provided', async () => {
      const channel = createMockChannel();
      const processMessage = vi.fn();
      (mockAgentPool.getOrCreateChatAgent as ReturnType<typeof vi.fn>).mockReturnValue({
        processMessage,
      });

      const descriptor: WiredChannelDescriptor = {
        type: 'test',
        name: 'Test',
        factory: () => channel,
        defaultCapabilities: {
          supportsCard: true,
          supportsThread: false,
          supportsFile: false,
          supportsMarkdown: true,
          supportsMention: false,
          supportsUpdate: false,
        },
        createCallbacks: () => createChannelCallbacks(channel),
      };

      manager.registerDescriptor(descriptor);
      await manager.createAndWire('test', { id: 'test-channel' });

      // Verify onMessage was registered (wiring happened)
      expect(channel.onMessage).toHaveBeenCalled();

      // Simulate a message coming through the handler
      const messageHandler = (channel.onMessage as ReturnType<typeof vi.fn>).mock.calls[0][0];
      await messageHandler({
        chatId: 'chat-1',
        content: 'Hello',
        messageId: 'msg-1',
        userId: 'user-1',
        messageType: 'text',
      });

      expect(processMessage).toHaveBeenCalled();
    });

    it('should throw error for unknown channel type', async () => {
      try {
        await manager.createAndWire('unknown', {});
        expect.fail('Should have thrown');
      } catch (error) {
        expect((error as Error).message).to.include('Unknown channel type: "unknown"');
      }
    });

    it('should pass controlHandlerContext to setup hook', async () => {
      const channel = createMockChannel();
      const controlHandlerContext: ControlHandlerContext = {
        agentPool: { reset: vi.fn(), stop: vi.fn() },
        node: {
          nodeId: 'test',
          getExecNodes: () => [],
          getDebugGroup: () => null,
          clearDebugGroup: () => {},
        },
      };

      const managerWithContext = new ChannelLifecycleManager({
        channelManager,
        agentPool: mockAgentPool,
        controlHandler: createMockControlHandler(),
        controlHandlerContext,
        primaryNode: mockPrimaryNode,
      });

      const setupCalled = vi.fn();
      const descriptor: WiredChannelDescriptor = {
        type: 'test',
        name: 'Test',
        factory: () => channel,
        defaultCapabilities: {
          supportsCard: false,
          supportsThread: false,
          supportsFile: false,
          supportsMarkdown: false,
          supportsMention: false,
          supportsUpdate: false,
        },
        createCallbacks: () => createChannelCallbacks(channel),
        setup: setupCalled,
      };

      managerWithContext.registerDescriptor(descriptor);
      await managerWithContext.createAndWire('test', {});

      // Verify the context was passed to setup
      expect(setupCalled).toHaveBeenCalled();
      const setupContext = setupCalled.mock.calls[0][1];
      expect(setupContext.controlHandlerContext).to.equal(controlHandlerContext);
    });
  });

  describe('startAll / stopAll', () => {
    it('should delegate to ChannelManager.startAll', async () => {
      const startAllSpy = vi.spyOn(channelManager, 'startAll');
      await manager.startAll();
      expect(startAllSpy).toHaveBeenCalledOnce();
    });

    it('should delegate to ChannelManager.stopAll', async () => {
      const stopAllSpy = vi.spyOn(channelManager, 'stopAll');
      await manager.stopAll();
      expect(stopAllSpy).toHaveBeenCalledOnce();
    });
  });

  describe('getChannelManager', () => {
    it('should return the underlying ChannelManager', () => {
      expect(manager.getChannelManager()).to.equal(channelManager);
    });
  });
});
