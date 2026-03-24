/**
 * Tests for ChannelDescriptor and ChannelLifecycleManager.
 *
 * Part of Issue #1594: Unify fragmented channel management architecture.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ChannelLifecycleManager, type ChannelDescriptor, type ChannelSetupContext } from './channel-descriptor.js';
import { ChannelManager } from './channel-manager.js';
import type { IChannel, IncomingMessage, ControlResponse, FileRef } from '@disclaude/core';
import type { PilotCallbacks } from '@disclaude/worker-node';

// Mock logger (pino BaseLogger shape) - must use vi.hoisted for vi.mock factory
const { mockLogger } = vi.hoisted(() => ({
  mockLogger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    fatal: vi.fn(),
    trace: vi.fn(),
    level: 'info' as const,
    silent: vi.fn(),
    msgPrefix: '',
  },
}));

vi.mock('@disclaude/core', () => ({
  createLogger: () => mockLogger,
}));

// Helper to create mock channel
function createMockChannel(id: string, name: string = `Channel ${id}`): IChannel {
  return {
    id,
    name,
    status: 'stopped',
    onMessage: vi.fn(),
    onControl: vi.fn(),
    sendMessage: vi.fn().mockResolvedValue(undefined),
    start: vi.fn().mockResolvedValue(undefined),
    stop: vi.fn().mockResolvedValue(undefined),
    isHealthy: vi.fn().mockReturnValue(true),
    getCapabilities: vi.fn().mockReturnValue({
      supportsCard: true, supportsThread: true, supportsFile: true,
      supportsMarkdown: true, supportsMention: true, supportsUpdate: true,
    }),
  };
}

// Helper to create mock agent pool
function createMockAgentPool() {
  return {
    getOrCreateChatAgent: vi.fn().mockReturnValue({
      processMessage: vi.fn(),
    }),
  };
}

// Helper to create mock control handler
function createMockControlHandler() {
  return vi.fn().mockResolvedValue({ success: true } as ControlResponse);
}

// Helper to create setup context
function createSetupContext(overrides?: Partial<ChannelSetupContext>): ChannelSetupContext {
  return {
    agentPool: createMockAgentPool(),
    controlHandler: createMockControlHandler(),
    controlHandlerContext: {},
    primaryNode: {
      registerFeishuHandlers: vi.fn(),
    },
    logger: mockLogger as unknown as ChannelSetupContext['logger'],
    ...overrides,
  };
}

// Helper to create a simple descriptor
function createSimpleDescriptor(overrides?: Partial<ChannelDescriptor>): ChannelDescriptor {
  const mockChannel = createMockChannel('test', 'Test Channel');
  return {
    type: 'test',
    name: 'Test Channel',
    factory: vi.fn().mockReturnValue(mockChannel),
    createCallbacks: vi.fn().mockReturnValue((_chatId: string): PilotCallbacks => ({
      sendMessage: vi.fn().mockResolvedValue(undefined),
      sendCard: vi.fn().mockResolvedValue(undefined),
      sendFile: vi.fn().mockResolvedValue(undefined),
      onDone: vi.fn().mockResolvedValue(undefined),
    })),
    ...overrides,
  };
}

describe('ChannelLifecycleManager', () => {
  let channelManager: ChannelManager;
  let context: ChannelSetupContext;
  let lifecycleManager: ChannelLifecycleManager;

  beforeEach(() => {
    channelManager = new ChannelManager();
    context = createSetupContext();
    lifecycleManager = new ChannelLifecycleManager(channelManager, context);
    vi.clearAllMocks();
  });

  describe('createAndWire()', () => {
    it('should create channel from factory and register it', async () => {
      const mockChannel = createMockChannel('test', 'Test Channel');
      const descriptor = createSimpleDescriptor({
        factory: vi.fn().mockReturnValue(mockChannel),
      });

      const result = await lifecycleManager.createAndWire(descriptor, {});

      expect(descriptor.factory).toHaveBeenCalledWith({});
      expect(channelManager.has('test')).toBe(true);
      expect(result).toBe(mockChannel);
    });

    it('should set up message and control handlers', async () => {
      const mockChannel = createMockChannel('test', 'Test Channel');
      const descriptor = createSimpleDescriptor({
        factory: vi.fn().mockReturnValue(mockChannel),
      });

      await lifecycleManager.createAndWire(descriptor, {});

      expect(mockChannel.onMessage).toHaveBeenCalled();
      expect(mockChannel.onControl).toHaveBeenCalledWith(context.controlHandler);
    });

    it('should call descriptor setup hook if provided', async () => {
      const mockChannel = createMockChannel('test', 'Test Channel');
      const setupFn = vi.fn().mockResolvedValue(undefined);
      const descriptor = createSimpleDescriptor({
        factory: vi.fn().mockReturnValue(mockChannel),
        setup: setupFn,
      });

      await lifecycleManager.createAndWire(descriptor, {});

      expect(setupFn).toHaveBeenCalledWith(mockChannel, context);
    });

    it('should use custom message handler from descriptor if provided', async () => {
      const mockChannel = createMockChannel('test', 'Test Channel');
      const customHandler = vi.fn().mockResolvedValue(undefined);
      const descriptor = createSimpleDescriptor({
        factory: vi.fn().mockReturnValue(mockChannel),
        createMessageHandler: vi.fn().mockReturnValue(customHandler),
      });

      await lifecycleManager.createAndWire(descriptor, {});

      expect(descriptor.createMessageHandler).toHaveBeenCalledWith(mockChannel, context);
      // The custom handler is wrapped by ChannelManager.setupHandlers() for error handling
      // Verify it's a function (not the raw handler, since it's wrapped)
      const [[registeredHandler]] = (mockChannel.onMessage as any).mock.calls;
      expect(typeof registeredHandler).toBe('function');
      // Verify the descriptor's custom handler was used (not default)
      expect(descriptor.createMessageHandler).toHaveBeenCalled();
    });

    it('should use default message handler when descriptor does not provide one', async () => {
      const mockChannel = createMockChannel('test', 'Test Channel');
      const descriptor = createSimpleDescriptor({
        factory: vi.fn().mockReturnValue(mockChannel),
      });

      await lifecycleManager.createAndWire(descriptor, {});

      // Get the registered handler
      const [[registeredHandler]] = (mockChannel.onMessage as any).mock.calls;
      expect(typeof registeredHandler).toBe('function');
      // Should NOT be the custom handler (none provided)
      expect(descriptor.createMessageHandler).toBeUndefined();
    });

    it('should pass config to factory', async () => {
      const mockChannel = createMockChannel('test', 'Test Channel');
      const config = { port: 3000, host: '0.0.0.0' };
      const descriptor = createSimpleDescriptor({
        factory: vi.fn().mockReturnValue(mockChannel),
      });

      await lifecycleManager.createAndWire(descriptor, config);

      expect(descriptor.factory).toHaveBeenCalledWith(config);
    });
  });

  describe('default message handler', () => {
    it('should create callbacks and process message through agent', async () => {
      const mockChannel = createMockChannel('test', 'Test Channel');
      const mockProcessMessage = vi.fn();
      const descriptor = createSimpleDescriptor({
        factory: vi.fn().mockReturnValue(mockChannel),
        createCallbacks: vi.fn().mockReturnValue((_chatId: string): PilotCallbacks => ({
          sendMessage: vi.fn().mockResolvedValue(undefined),
          sendCard: vi.fn().mockResolvedValue(undefined),
          sendFile: vi.fn().mockResolvedValue(undefined),
          onDone: vi.fn().mockResolvedValue(undefined),
        })),
      });

      (context.agentPool.getOrCreateChatAgent as any).mockReturnValue({
        processMessage: mockProcessMessage,
      });

      await lifecycleManager.createAndWire(descriptor, {});

      // Get the registered handler
      const [[registeredHandler]] = (mockChannel.onMessage as any).mock.calls;

      const message: IncomingMessage = {
        messageId: 'msg-1',
        chatId: 'chat-1',
        content: 'Hello',
        messageType: 'text',
        userId: 'user-1',
        metadata: { chatHistoryContext: 'context-1' },
      };

      await registeredHandler(message);

      // Should have created callbacks
      expect(descriptor.createCallbacks).toHaveBeenCalled();
      // Should have created agent
      expect(context.agentPool.getOrCreateChatAgent).toHaveBeenCalled();
      // Should have processed message
      expect(mockProcessMessage).toHaveBeenCalledWith(
        'chat-1', 'Hello', 'msg-1', 'user-1', undefined, 'context-1'
      );
    });

    it('should extract attachments if descriptor provides extractAttachments', async () => {
      const mockChannel = createMockChannel('test', 'Test Channel');
      const mockFileRef: FileRef = {
        id: 'file-1',
        fileName: 'test.png',
        localPath: '/tmp/test.png',
        mimeType: 'image/png',
        size: 1024,
        source: 'user',
        createdAt: Date.now(),
      };
      const descriptor = createSimpleDescriptor({
        factory: vi.fn().mockReturnValue(mockChannel),
        extractAttachments: vi.fn().mockReturnValue([mockFileRef]),
      });

      const mockProcessMessage = vi.fn();
      (context.agentPool.getOrCreateChatAgent as any).mockReturnValue({
        processMessage: mockProcessMessage,
      });

      await lifecycleManager.createAndWire(descriptor, {});

      // Get the registered handler
      const [[registeredHandler]] = (mockChannel.onMessage as any).mock.calls;

      const message: IncomingMessage = {
        messageId: 'msg-1',
        chatId: 'chat-1',
        content: 'Check this image',
        messageType: 'text',
        userId: 'user-1',
        attachments: [{
          fileName: 'test.png',
          filePath: '/tmp/test.png',
          mimeType: 'image/png',
          size: 1024,
        }],
      };

      await registeredHandler(message);

      expect(descriptor.extractAttachments).toHaveBeenCalledWith(message);
      expect(mockProcessMessage).toHaveBeenCalledWith(
        'chat-1', 'Check this image', 'msg-1', 'user-1', [mockFileRef], undefined
      );
    });

    it('should handle errors and send error message', async () => {
      const mockChannel = createMockChannel('test', 'Test Channel');
      const descriptor = createSimpleDescriptor({
        factory: vi.fn().mockReturnValue(mockChannel),
        sendDoneSignal: false,
      });

      const error = new Error('Processing failed');
      (context.agentPool.getOrCreateChatAgent as any).mockReturnValue({
        processMessage: vi.fn().mockImplementation(() => { throw error; }),
      });

      await lifecycleManager.createAndWire(descriptor, {});

      // Get the registered handler
      const [[registeredHandler]] = (mockChannel.onMessage as any).mock.calls;

      const message: IncomingMessage = {
        messageId: 'msg-1',
        chatId: 'chat-1',
        content: 'Hello',
        messageType: 'text',
        userId: 'user-1',
      };

      // Should not throw - error is caught internally
      await registeredHandler(message);

      // Should have sent error message
      expect(mockChannel.sendMessage).toHaveBeenCalledWith({
        chatId: 'chat-1',
        type: 'text',
        text: '❌ Error: Processing failed',
      });
    });

    it('should send done signal on error when sendDoneSignal is true', async () => {
      const mockChannel = createMockChannel('test', 'Test Channel');
      const descriptor = createSimpleDescriptor({
        factory: vi.fn().mockReturnValue(mockChannel),
        sendDoneSignal: true,
      });

      (context.agentPool.getOrCreateChatAgent as any).mockReturnValue({
        processMessage: vi.fn().mockImplementation(() => { throw new Error('fail'); }),
      });

      await lifecycleManager.createAndWire(descriptor, {});

      // Get the registered handler
      const [[registeredHandler]] = (mockChannel.onMessage as any).mock.calls;

      const message: IncomingMessage = {
        messageId: 'msg-1',
        chatId: 'chat-1',
        content: 'Hello',
        messageType: 'text',
        userId: 'user-1',
      };

      await registeredHandler(message);

      // Should have sent error message AND done signal
      const calls = (mockChannel.sendMessage as any).mock.calls;
      expect(calls.some((call: any[]) => call[0]?.type === 'text' && call[0]?.text?.includes('Error'))).toBe(true);
      expect(calls.some((call: any[]) => call[0]?.type === 'done')).toBe(true);
    });

    it('should NOT send done signal on error when sendDoneSignal is false', async () => {
      const mockChannel = createMockChannel('test', 'Test Channel');
      const descriptor = createSimpleDescriptor({
        factory: vi.fn().mockReturnValue(mockChannel),
        sendDoneSignal: false,
      });

      (context.agentPool.getOrCreateChatAgent as any).mockReturnValue({
        processMessage: vi.fn().mockImplementation(() => { throw new Error('fail'); }),
      });

      await lifecycleManager.createAndWire(descriptor, {});

      // Get the registered handler
      const [[registeredHandler]] = (mockChannel.onMessage as any).mock.calls;

      const message: IncomingMessage = {
        messageId: 'msg-1',
        chatId: 'chat-1',
        content: 'Hello',
        messageType: 'text',
        userId: 'user-1',
      };

      await registeredHandler(message);

      // Should have sent error message but NOT done signal
      const calls = (mockChannel.sendMessage as any).mock.calls;
      expect(calls.some((call: any[]) => call[0]?.type === 'text' && call[0]?.text?.includes('Error'))).toBe(true);
      expect(calls.some((call: any[]) => call[0]?.type === 'done')).toBe(false);
    });
  });

  describe('delegation to ChannelManager', () => {
    it('should delegate startAll() to ChannelManager', async () => {
      const mockChannel = createMockChannel('test');
      channelManager.register(mockChannel);

      await lifecycleManager.startAll();

      expect(mockChannel.start).toHaveBeenCalled();
    });

    it('should delegate stopAll() to ChannelManager', async () => {
      const mockChannel = createMockChannel('test');
      channelManager.register(mockChannel);

      await lifecycleManager.stopAll();

      expect(mockChannel.stop).toHaveBeenCalled();
    });

    it('should delegate get() to ChannelManager', () => {
      const mockChannel = createMockChannel('test');
      channelManager.register(mockChannel);

      expect(lifecycleManager.get('test')).toBe(mockChannel);
    });

    it('should delegate getAll() to ChannelManager', () => {
      const mockChannel = createMockChannel('test');
      channelManager.register(mockChannel);

      expect(lifecycleManager.getAll()).toHaveLength(1);
    });

    it('should delegate has() to ChannelManager', () => {
      expect(lifecycleManager.has('nonexistent')).toBe(false);
    });

    it('should expose getChannelManager()', () => {
      expect(lifecycleManager.getChannelManager()).toBe(channelManager);
    });

    it('should delegate getStatusInfo() to ChannelManager', () => {
      const mockChannel = createMockChannel('test');
      (mockChannel as any).status = 'running';
      channelManager.register(mockChannel);

      const statusInfo = lifecycleManager.getStatusInfo();
      expect(statusInfo).toHaveLength(1);
      expect(statusInfo[0].id).toBe('test');
    });
  });

  describe('multiple channels', () => {
    it('should wire multiple channels from different descriptors', async () => {
      const mockChannel1 = createMockChannel('rest', 'REST');
      const mockChannel2 = createMockChannel('feishu', 'Feishu');
      const descriptor1 = createSimpleDescriptor({
        type: 'rest',
        name: 'REST',
        factory: vi.fn().mockReturnValue(mockChannel1),
      });
      const descriptor2 = createSimpleDescriptor({
        type: 'feishu',
        name: 'Feishu',
        factory: vi.fn().mockReturnValue(mockChannel2),
      });

      await lifecycleManager.createAndWire(descriptor1, { port: 3000 });
      await lifecycleManager.createAndWire(descriptor2, { appId: 'test' });

      expect(channelManager.size()).toBe(2);
      expect(channelManager.has('rest')).toBe(true);
      expect(channelManager.has('feishu')).toBe(true);
    });

    it('should start and stop all channels', async () => {
      const mockChannel1 = createMockChannel('rest');
      const mockChannel2 = createMockChannel('feishu');
      const descriptor1 = createSimpleDescriptor({ factory: vi.fn().mockReturnValue(mockChannel1) });
      const descriptor2 = createSimpleDescriptor({ factory: vi.fn().mockReturnValue(mockChannel2) });

      await lifecycleManager.createAndWire(descriptor1, {});
      await lifecycleManager.createAndWire(descriptor2, {});

      await lifecycleManager.startAll();
      expect(mockChannel1.start).toHaveBeenCalled();
      expect(mockChannel2.start).toHaveBeenCalled();

      await lifecycleManager.stopAll();
      expect(mockChannel1.stop).toHaveBeenCalled();
      expect(mockChannel2.stop).toHaveBeenCalled();
    });
  });
});
