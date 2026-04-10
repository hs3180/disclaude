/**
 * Tests for ChannelLifecycleManager and WiredChannelDescriptor.
 *
 * Issue #1594 Phase 2: Tests the descriptor-based channel wiring system.
 * Issue #1594 Phase 3: Tests config-driven type-based channel creation.
 */

 

import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  ChannelLifecycleManager,
  type ChannelSetupContext,
  type WiredChannelDescriptor,
  type WiredContext,
} from './channel-lifecycle-manager.js';
import type { IChannel, MessageHandler, ControlHandler, ChannelCapabilities } from '@disclaude/core';
import { ChannelManager } from './channel-manager.js';

// Mock logger (typed as any to avoid pino BaseLogger compatibility issues in tests)
const mockLogger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
} as any;

const DEFAULT_CAPABILITIES: ChannelCapabilities = {
  supportsCard: true,
  supportsThread: false,
  supportsFile: false,
  supportsMarkdown: true,
  supportsMention: false,
  supportsUpdate: false,
};

// Helper to create mock channel
function createMockChannel(id: string, name: string = `Channel ${id}`): IChannel {
  return {
    id,
    name,
    status: 'stopped',
    onMessage: vi.fn().mockImplementation((_handler) => {
      // no-op: just capture the handler registration
    }),
    onControl: vi.fn(),
    start: vi.fn().mockResolvedValue(undefined),
    stop: vi.fn().mockResolvedValue(undefined),
    sendMessage: vi.fn().mockResolvedValue(undefined),
    getCapabilities: vi.fn().mockReturnValue(DEFAULT_CAPABILITIES),
  } as unknown as IChannel;
}

// Helper to create mock setup context
function createMockContext(overrides?: Partial<ChannelSetupContext>): ChannelSetupContext {
  return {
    agentPool: {
      getOrCreateChatAgent: vi.fn().mockReturnValue({ processMessage: vi.fn() }),
    },
    controlHandler: vi.fn() as unknown as ControlHandler,
    controlHandlerContext: {},
    logger: mockLogger,
    primaryNode: {
      getInteractiveContextStore: vi.fn().mockReturnValue({
        generatePrompt: vi.fn().mockReturnValue('Generated prompt'),
      }),
      registerFeishuHandlers: vi.fn(),
      getChatStore: vi.fn().mockReturnValue({}),
    },
    ...overrides,
  };
}

// Helper to create a simple test descriptor
function createTestDescriptor(
  options?: Partial<WiredChannelDescriptor>
): WiredChannelDescriptor {
  const mockChannel = createMockChannel('test', 'Test Channel');
  return {
    type: 'test',
    name: 'Test Channel',
    factory: () => mockChannel,
    defaultCapabilities: DEFAULT_CAPABILITIES,
    createCallbacks: vi.fn().mockReturnValue(() => ({
      sendMessage: vi.fn().mockResolvedValue(undefined),
      sendCard: vi.fn().mockResolvedValue(undefined),
      sendFile: vi.fn().mockResolvedValue(undefined),
      onDone: vi.fn().mockResolvedValue(undefined),
    })),
    createMessageHandler: vi.fn().mockReturnValue(vi.fn().mockResolvedValue(undefined)),
    ...options,
  };
}

describe('ChannelLifecycleManager', () => {
  let channelManager: ChannelManager;
  let context: ChannelSetupContext;

  beforeEach(() => {
    vi.clearAllMocks();
    channelManager = new ChannelManager();
    context = createMockContext();
  });

  describe('constructor', () => {
    it('should create a ChannelLifecycleManager with channelManager and context', () => {
      const manager = new ChannelLifecycleManager(channelManager, context);
      expect(manager).toBeDefined();
      expect(manager.getChannelManager()).toBe(channelManager);
    });
  });

  describe('createAndWire', () => {
    it('should create a channel using the descriptor factory', async () => {
      const mockChannel = createMockChannel('test', 'Test Channel');
      const descriptor = createTestDescriptor({
        factory: () => mockChannel,
      });

      const manager = new ChannelLifecycleManager(channelManager, context);
      const channel = await manager.createAndWire(descriptor, {});

      expect(channel).toBe(mockChannel);
      expect(channelManager.has('test')).toBe(true);
    });

    it('should call createCallbacks with channel and context', async () => {
      const descriptor = createTestDescriptor();
      const manager = new ChannelLifecycleManager(channelManager, context);

      await manager.createAndWire(descriptor, {});

      expect(descriptor.createCallbacks).toHaveBeenCalledTimes(1);
      expect(descriptor.createCallbacks).toHaveBeenCalledWith(
        expect.any(Object), // channel
        context
      );
    });

    it('should call createMessageHandler with channel and wiredContext', async () => {
      const descriptor = createTestDescriptor();
      const manager = new ChannelLifecycleManager(channelManager, context);

      await manager.createAndWire(descriptor, {});

      expect((descriptor.createMessageHandler as any).mock).toBeDefined();
      // The wiredContext should include channel and callbacks
      const wiredContext = (descriptor.createMessageHandler as any).mock.calls[0][1] as WiredContext;
      expect(wiredContext.channel).toBeDefined();
      expect(wiredContext.callbacks).toBeDefined();
      expect(typeof wiredContext.callbacks).toBe('function');
    });

    it('should wire handlers via ChannelManager.setupHandlers', async () => {
      const mockChannel = createMockChannel('test', 'Test Channel');
      const descriptor = createTestDescriptor({
        factory: () => mockChannel,
      });
      const manager = new ChannelLifecycleManager(channelManager, context);

      await manager.createAndWire(descriptor, {});

      expect(mockChannel.onMessage).toHaveBeenCalledTimes(1);
      expect(mockChannel.onControl).toHaveBeenCalledTimes(1);
    });

    it('should call setup hook if provided', async () => {
      const setup = vi.fn().mockResolvedValue(undefined);
      const mockChannel = createMockChannel('test', 'Test Channel');
      const descriptor = createTestDescriptor({
        factory: () => mockChannel,
        setup,
      });
      const manager = new ChannelLifecycleManager(channelManager, context);

      await manager.createAndWire(descriptor, {});

      expect(setup).toHaveBeenCalledTimes(1);
      expect(setup).toHaveBeenCalledWith(mockChannel, {}, context);
    });

    it('should not call setup hook if not provided', async () => {
      const descriptor = createTestDescriptor({ setup: undefined });
      const manager = new ChannelLifecycleManager(channelManager, context);

      // Should not throw
      await manager.createAndWire(descriptor, {});
    });

    it('should support async setup hook', async () => {
      const setup = vi.fn().mockImplementation(async () => {
        await new Promise((resolve) => setTimeout(resolve, 1));
      });
      const descriptor = createTestDescriptor({ setup });
      const manager = new ChannelLifecycleManager(channelManager, context);

      await manager.createAndWire(descriptor, {});

      expect(setup).toHaveBeenCalledTimes(1);
    });

    it('should register the channel with ChannelManager', async () => {
      const mockChannel = createMockChannel('test', 'Test Channel');
      const descriptor = createTestDescriptor({
        factory: () => mockChannel,
      });
      const manager = new ChannelLifecycleManager(channelManager, context);

      await manager.createAndWire(descriptor, {});

      expect(channelManager.get('test')).toBe(mockChannel);
    });

    it('should pass the message handler to the channel', async () => {
      const mockChannel = createMockChannel('test', 'Test Channel');
      const messageHandler: MessageHandler = vi.fn().mockResolvedValue(undefined);
      const descriptor = createTestDescriptor({
        factory: () => mockChannel,
        createMessageHandler: () => messageHandler,
      });
      const manager = new ChannelLifecycleManager(channelManager, context);

      await manager.createAndWire(descriptor, {});

      // ChannelManager.setupHandlers wraps the message handler in a try-catch,
      // so onMessage receives a wrapper function, not the raw messageHandler.
      expect(mockChannel.onMessage).toHaveBeenCalledTimes(1);
      expect(typeof (mockChannel.onMessage as any).mock.calls[0][0]).toBe('function');
    });
  });

  describe('startAll', () => {
    it('should delegate to ChannelManager.startAll', async () => {
      const startAllSpy = vi.spyOn(channelManager, 'startAll');
      const manager = new ChannelLifecycleManager(channelManager, context);

      await manager.startAll();

      expect(startAllSpy).toHaveBeenCalledTimes(1);
    });
  });

  describe('stopAll', () => {
    it('should delegate to ChannelManager.stopAll', async () => {
      const stopAllSpy = vi.spyOn(channelManager, 'stopAll');
      const manager = new ChannelLifecycleManager(channelManager, context);

      await manager.stopAll();

      expect(stopAllSpy).toHaveBeenCalledTimes(1);
    });
  });

  describe('getChannelManager', () => {
    it('should return the underlying ChannelManager', () => {
      const manager = new ChannelLifecycleManager(channelManager, context);
      expect(manager.getChannelManager()).toBe(channelManager);
    });
  });

  // Issue #1594 Phase 3: Descriptor registry and type-based creation
  describe('registerWiredDescriptor', () => {
    it('should register a descriptor for type-based lookup', () => {
      const descriptor = createTestDescriptor({ type: 'rest' });
      const manager = new ChannelLifecycleManager(channelManager, context);

      manager.registerWiredDescriptor(descriptor);

      expect(manager.hasWiredDescriptor('rest')).toBe(true);
      expect(manager.getWiredDescriptor('rest')).toBe(descriptor);
    });

    it('should throw on duplicate registration', () => {
      const descriptor = createTestDescriptor({ type: 'rest' });
      const manager = new ChannelLifecycleManager(channelManager, context);

      manager.registerWiredDescriptor(descriptor);

      expect(() => manager.registerWiredDescriptor(descriptor)).toThrow(
        /already registered/
      );
    });

    it('should return registered types', () => {
      const restDescriptor = createTestDescriptor({ type: 'rest' });
      const feishuDescriptor = createTestDescriptor({ type: 'feishu' });
      const manager = new ChannelLifecycleManager(channelManager, context);

      manager.registerWiredDescriptor(restDescriptor);
      manager.registerWiredDescriptor(feishuDescriptor);

      const types = manager.getRegisteredTypes();
      expect(types).toContain('rest');
      expect(types).toContain('feishu');
      expect(types).toHaveLength(2);
    });
  });

  describe('createAndWireByType', () => {
    it('should create and wire a channel by type string', async () => {
      const mockChannel = createMockChannel('rest', 'REST Channel');
      const descriptor = createTestDescriptor({
        type: 'rest',
        factory: () => mockChannel,
      });
      const manager = new ChannelLifecycleManager(channelManager, context);

      manager.registerWiredDescriptor(descriptor);
      const channel = await manager.createAndWireByType('rest', { port: 3000 } as any);

      expect(channel).toBe(mockChannel);
      expect(channelManager.has('rest')).toBe(true);
    });

    it('should throw for unknown channel type', async () => {
      const manager = new ChannelLifecycleManager(channelManager, context);

      await expect(
        manager.createAndWireByType('unknown', {})
      ).rejects.toThrow(/Unknown channel type "unknown"/);
    });

    it('should include available types in error message', async () => {
      const restDescriptor = createTestDescriptor({ type: 'rest' });
      const manager = new ChannelLifecycleManager(channelManager, context);

      manager.registerWiredDescriptor(restDescriptor);

      await expect(
        manager.createAndWireByType('feishu', {})
      ).rejects.toThrow(/rest/);
    });

    it('should support creating multiple channels by type', async () => {
      const restChannel = createMockChannel('rest', 'REST');
      const feishuChannel = createMockChannel('feishu', 'Feishu');
      const restDescriptor = createTestDescriptor({
        type: 'rest',
        factory: () => restChannel,
      });
      const feishuDescriptor = createTestDescriptor({
        type: 'feishu',
        factory: () => feishuChannel,
      });
      const manager = new ChannelLifecycleManager(channelManager, context);

      manager.registerWiredDescriptor(restDescriptor);
      manager.registerWiredDescriptor(feishuDescriptor);

      await manager.createAndWireByType('rest', { port: 3000 } as any);
      await manager.createAndWireByType('feishu', { appId: 'xxx' } as any);

      expect(channelManager.size()).toBe(2);
      expect(channelManager.has('rest')).toBe(true);
      expect(channelManager.has('feishu')).toBe(true);
    });
  });
});

describe('WiredChannelDescriptor integration', () => {
  let channelManager: ChannelManager;
  let context: ChannelSetupContext;

  beforeEach(() => {
    vi.clearAllMocks();
    channelManager = new ChannelManager();
    context = createMockContext();
  });

  it('should create callbacks factory that returns PilotCallbacks', async () => {
    const mockChannel = createMockChannel('test', 'Test Channel');
    const createCallbacksSpy = vi.fn().mockReturnValue(() => ({
      sendMessage: vi.fn().mockResolvedValue(undefined),
      sendCard: vi.fn().mockResolvedValue(undefined),
      sendFile: vi.fn().mockResolvedValue(undefined),
      onDone: vi.fn().mockResolvedValue(undefined),
    }));

    const descriptor: WiredChannelDescriptor = {
      type: 'test',
      name: 'Test',
      factory: () => mockChannel,
      defaultCapabilities: DEFAULT_CAPABILITIES,
      createCallbacks: createCallbacksSpy,
      createMessageHandler: vi.fn().mockReturnValue(vi.fn().mockResolvedValue(undefined)),
    };

    const manager = new ChannelLifecycleManager(channelManager, context);
    await manager.createAndWire(descriptor, {});

    // createCallbacks should have been called once with channel and context
    expect(createCallbacksSpy).toHaveBeenCalledTimes(1);
    expect(createCallbacksSpy).toHaveBeenCalledWith(mockChannel, context);
  });

  it('should pass callbacks factory to message handler via wiredContext', async () => {
    const mockChannel = createMockChannel('test', 'Test Channel');
    const callbackFactory = vi.fn().mockReturnValue({
      sendMessage: vi.fn().mockResolvedValue(undefined),
      sendCard: vi.fn().mockResolvedValue(undefined),
      sendFile: vi.fn().mockResolvedValue(undefined),
    });

    let capturedWiredContext: WiredContext | undefined;

    const descriptor: WiredChannelDescriptor = {
      type: 'test',
      name: 'Test',
      factory: () => mockChannel,
      defaultCapabilities: DEFAULT_CAPABILITIES,
      createCallbacks: () => callbackFactory,
      createMessageHandler: (_channel, wiredCtx) => {
        capturedWiredContext = wiredCtx;
        return vi.fn().mockResolvedValue(undefined);
      },
    };

    const manager = new ChannelLifecycleManager(channelManager, context);
    await manager.createAndWire(descriptor, {});

    expect(capturedWiredContext).toBeDefined();
    expect(capturedWiredContext?.channel).toBe(mockChannel);
    expect(capturedWiredContext?.callbacks).toBe(callbackFactory);
    expect(capturedWiredContext?.agentPool).toBe(context.agentPool);
    expect(capturedWiredContext?.logger).toBe(context.logger);
  });
});
