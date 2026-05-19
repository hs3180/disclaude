/**
 * Tests for WiredChannelDescriptors.
 *
 * Tests the descriptor-based channel wiring for REST, Feishu, and WeChat channels.
 *
 * @see Issue #1594 - Channel Lifecycle Manager
 * @see Issue #1554 - WeChat Channel Dynamic Registration (Phase 1)
 */

 

import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  REST_WIRED_DESCRIPTOR,
  FEISHU_WIRED_DESCRIPTOR,
  WECHAT_WIRED_DESCRIPTOR,
} from './wired-descriptors.js';
import type {
  ChannelSetupContext,
  WiredContext,
} from '../channel-lifecycle-manager.js';
import type { IChannel, ControlHandler, ChannelCapabilities, FeishuApiHandlers } from '@disclaude/core';

// Mock logger
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
    onMessage: vi.fn().mockImplementation((_handler) => {}),
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
    },
    ...overrides,
  };
}

describe('WiredChannelDescriptors', () => {
  describe('REST_WIRED_DESCRIPTOR', () => {
    it('should have correct type and name', () => {
      expect(REST_WIRED_DESCRIPTOR.type).toBe('rest');
      expect(REST_WIRED_DESCRIPTOR.name).toBe('REST API');
    });

    it('should have REST-specific capabilities', () => {
      expect(REST_WIRED_DESCRIPTOR.defaultCapabilities).toEqual({
        supportsCard: true,
        supportsThread: false,
        supportsFile: false,
        supportsMarkdown: true,
        supportsMention: false,
        supportsUpdate: false,
      });
    });

    it('should create a channel via factory', () => {
      const channel = REST_WIRED_DESCRIPTOR.factory({ port: 3000, host: '0.0.0.0', fileStorageDir: './data' });
      expect(channel).toBeDefined();
      expect(channel.id).toBeDefined();
    });

    it('should create callbacks factory with sendDoneSignal', () => {
      const mockChannel = createMockChannel('rest');
      const context = createMockContext();
      const callbacksFactory = REST_WIRED_DESCRIPTOR.createCallbacks(mockChannel, context);

      expect(typeof callbacksFactory).toBe('function');
      const callbacks = callbacksFactory('test-chat');
      expect(callbacks.sendMessage).toBeDefined();
      expect(callbacks.sendCard).toBeDefined();
      expect(callbacks.onDone).toBeDefined();
    });

    it('should create message handler', () => {
      const mockChannel = createMockChannel('rest');
      const context = createMockContext();
      const callbacksFactory = REST_WIRED_DESCRIPTOR.createCallbacks(mockChannel, context);
      const wiredContext: WiredContext = { ...context, channel: mockChannel, callbacks: callbacksFactory };

      const handler = REST_WIRED_DESCRIPTOR.createMessageHandler(mockChannel, wiredContext);
      expect(typeof handler).toBe('function');
    });
  });

  describe('FEISHU_WIRED_DESCRIPTOR', () => {
    it('should have correct type and name', () => {
      expect(FEISHU_WIRED_DESCRIPTOR.type).toBe('feishu');
      expect(FEISHU_WIRED_DESCRIPTOR.name).toBe('Feishu');
    });

    it('should have Feishu-specific capabilities', () => {
      expect(FEISHU_WIRED_DESCRIPTOR.defaultCapabilities).toEqual({
        supportsCard: true,
        supportsThread: true,
        supportsFile: true,
        supportsMarkdown: true,
        supportsMention: true,
        supportsUpdate: true,
      });
    });

    it('should create a channel via factory', () => {
      const channel = FEISHU_WIRED_DESCRIPTOR.factory({ appId: 'test-id', appSecret: 'test-secret' });
      expect(channel).toBeDefined();
      expect(channel.id).toBeDefined();
    });

    it('should create callbacks factory without sendDoneSignal', () => {
      const mockChannel = createMockChannel('feishu');
      const context = createMockContext();
      const callbacksFactory = FEISHU_WIRED_DESCRIPTOR.createCallbacks(mockChannel, context);

      expect(typeof callbacksFactory).toBe('function');
      const callbacks = callbacksFactory('test-chat');
      expect(callbacks.sendMessage).toBeDefined();
      expect(callbacks.sendCard).toBeDefined();
      expect(callbacks.onDone).toBeDefined();
    });

    it('should create message handler with attachment extraction', () => {
      const mockChannel = createMockChannel('feishu');
      const context = createMockContext();
      const callbacksFactory = FEISHU_WIRED_DESCRIPTOR.createCallbacks(mockChannel, context);
      const wiredContext: WiredContext = { ...context, channel: mockChannel, callbacks: callbacksFactory };

      const handler = FEISHU_WIRED_DESCRIPTOR.createMessageHandler(mockChannel, wiredContext);
      expect(typeof handler).toBe('function');
    });

    it('should have a setup hook', () => {
      expect(FEISHU_WIRED_DESCRIPTOR.setup).toBeDefined();
      expect(typeof FEISHU_WIRED_DESCRIPTOR.setup).toBe('function');
    });
  });

  describe('WECHAT_WIRED_DESCRIPTOR (Issue #1554)', () => {
    it('should have correct type and name', () => {
      expect(WECHAT_WIRED_DESCRIPTOR.type).toBe('wechat');
      expect(WECHAT_WIRED_DESCRIPTOR.name).toBe('WeChat');
    });

    it('should have MVP capabilities (text only)', () => {
      expect(WECHAT_WIRED_DESCRIPTOR.defaultCapabilities).toEqual({
        supportsCard: false,
        supportsThread: false,
        supportsFile: false,
        supportsMarkdown: false,
        supportsMention: false,
        supportsUpdate: false,
      });
    });

    it('should create a WeChat channel via factory', () => {
      const channel = WECHAT_WIRED_DESCRIPTOR.factory({
        baseUrl: 'https://ilinkai.weixin.qq.com',
      });
      expect(channel).toBeDefined();
      expect(channel.id).toBeDefined();
    });

    it('should create a WeChat channel with token config', () => {
      const channel = WECHAT_WIRED_DESCRIPTOR.factory({
        baseUrl: 'https://ilinkai.weixin.qq.com',
        token: 'test-token',
        routeTag: 'test-route',
      });
      expect(channel).toBeDefined();
      expect(channel.id).toBeDefined();
    });

    it('should create callbacks factory without sendDoneSignal', () => {
      const mockChannel = createMockChannel('wechat');
      const context = createMockContext();
      const callbacksFactory = WECHAT_WIRED_DESCRIPTOR.createCallbacks(mockChannel, context);

      expect(typeof callbacksFactory).toBe('function');
      const callbacks = callbacksFactory('test-chat');
      expect(callbacks.sendMessage).toBeDefined();
      expect(callbacks.sendCard).toBeDefined();
      expect(callbacks.sendFile).toBeDefined();
      expect(callbacks.onDone).toBeDefined();
    });

    it('should create message handler', () => {
      const mockChannel = createMockChannel('wechat');
      const context = createMockContext();
      const callbacksFactory = WECHAT_WIRED_DESCRIPTOR.createCallbacks(mockChannel, context);
      const wiredContext: WiredContext = { ...context, channel: mockChannel, callbacks: callbacksFactory };

      const handler = WECHAT_WIRED_DESCRIPTOR.createMessageHandler(mockChannel, wiredContext);
      expect(typeof handler).toBe('function');
    });

    it('should not have a setup hook (MVP)', () => {
      expect(WECHAT_WIRED_DESCRIPTOR.setup).toBeUndefined();
    });

    it('should send text messages through callbacks', async () => {
      const mockChannel = createMockChannel('wechat');
      const context = createMockContext();
      const callbacksFactory = WECHAT_WIRED_DESCRIPTOR.createCallbacks(mockChannel, context);
      const callbacks = callbacksFactory('test-chat-id');

      await callbacks.sendMessage('test-chat-id', 'Hello WeChat!');

      expect(mockChannel.sendMessage).toHaveBeenCalledWith({
        chatId: 'test-chat-id',
        type: 'text',
        text: 'Hello WeChat!',
        threadId: undefined,
      });
    });

    it('should send card as card type through callbacks (channel handles downgrade)', async () => {
      const mockChannel = createMockChannel('wechat');
      const context = createMockContext();
      const callbacksFactory = WECHAT_WIRED_DESCRIPTOR.createCallbacks(mockChannel, context);
      const callbacks = callbacksFactory('test-chat-id');

      const card = { config: {}, header: { title: { tag: 'plain_text', content: 'Test' } }, elements: [{ tag: 'div', text: { tag: 'plain_text', content: 'test' } }] };
      await callbacks.sendCard('test-chat-id', card, 'card description');

      // The shared helper sends card type - the WeChat channel's doSendMessage
      // handles the downgrade to text internally
      expect(mockChannel.sendMessage).toHaveBeenCalledWith({
        chatId: 'test-chat-id',
        type: 'card',
        card,
        description: 'card description',
        threadId: undefined,
      });
    });

    it('should process incoming messages via message handler', async () => {
      const mockChannel = createMockChannel('wechat');
      const mockAgent = { processMessage: vi.fn() };
      const context = createMockContext({
        agentPool: {
          getOrCreateChatAgent: vi.fn().mockReturnValue(mockAgent),
        },
      });
      const callbacksFactory = WECHAT_WIRED_DESCRIPTOR.createCallbacks(mockChannel, context);
      const wiredContext: WiredContext = { ...context, channel: mockChannel, callbacks: callbacksFactory };
      const handler = WECHAT_WIRED_DESCRIPTOR.createMessageHandler(mockChannel, wiredContext);

      await handler({
        chatId: 'chat-1',
        content: 'Hello from WeChat',
        messageId: 'msg-1',
        userId: 'user-1',
        messageType: 'text',
        timestamp: Date.now(),
      });

      expect(context.agentPool.getOrCreateChatAgent).toHaveBeenCalledWith('chat-1', expect.objectContaining({
        sendMessage: expect.any(Function),
        sendCard: expect.any(Function),
        sendFile: expect.any(Function),
        onDone: expect.any(Function),
      }));
      expect(mockAgent.processMessage).toHaveBeenCalledWith('chat-1', 'Hello from WeChat', 'msg-1', 'user-1', undefined, undefined, undefined, undefined);
    });

    it('should handle errors in message processing', async () => {
      const mockChannel = createMockChannel('wechat');
      const error = new Error('Agent processing failed');
      const mockAgent = { processMessage: vi.fn().mockImplementation(() => { throw error; }) };
      const context = createMockContext({
        agentPool: {
          getOrCreateChatAgent: vi.fn().mockReturnValue(mockAgent),
        },
      });
      const callbacksFactory = WECHAT_WIRED_DESCRIPTOR.createCallbacks(mockChannel, context);
      const wiredContext: WiredContext = { ...context, channel: mockChannel, callbacks: callbacksFactory };
      const handler = WECHAT_WIRED_DESCRIPTOR.createMessageHandler(mockChannel, wiredContext);

      await handler({
        chatId: 'chat-1',
        content: 'Hello',
        messageId: 'msg-1',
        userId: 'user-1',
        messageType: 'text',
        timestamp: Date.now(),
      });

      expect(mockChannel.sendMessage).toHaveBeenCalledWith({
        chatId: 'chat-1',
        type: 'text',
        text: '❌ Error: Agent processing failed',
      });
    });
  });

  describe('FEISHU_WIRED_DESCRIPTOR.setup — pushToAgent (Issue #631)', () => {
    let registeredHandlers: FeishuApiHandlers | undefined;
    const mockRoute = vi.fn();

    function createFeishuSetupContext(overrides?: Partial<ChannelSetupContext>): ChannelSetupContext {
      return createMockContext({
        inputMessageRouter: { route: mockRoute } as any,
        primaryNode: {
          getInteractiveContextStore: vi.fn().mockReturnValue({
            generatePrompt: vi.fn().mockReturnValue('Generated prompt'),
          }),
          registerFeishuHandlers: vi.fn((handlers: FeishuApiHandlers) => {
            registeredHandlers = handlers;
          }),
        } as any,
        ...overrides,
      });
    }

    function createMockFeishuChannel() {
      return {
        id: 'feishu-test',
        name: 'Feishu Test',
        status: 'stopped',
        onMessage: vi.fn(),
        onControl: vi.fn(),
        start: vi.fn().mockResolvedValue(undefined),
        stop: vi.fn().mockResolvedValue(undefined),
        sendMessage: vi.fn().mockResolvedValue('msg_123'),
        getCapabilities: vi.fn().mockReturnValue(DEFAULT_CAPABILITIES),
        getTriggerModeManager: vi.fn().mockReturnValue({
          getMode: vi.fn().mockReturnValue('mention'),
          setMode: vi.fn(),
        }),
        uploadImage: vi.fn().mockResolvedValue('img_key_123'),
      } as any;
    }

    beforeEach(() => {
      registeredHandlers = undefined;
      mockRoute.mockReset();
    });

    it('should register pushToAgent handler via registerFeishuHandlers', () => {
      const channel = createMockFeishuChannel();
      const context = createFeishuSetupContext();

      void FEISHU_WIRED_DESCRIPTOR.setup!(channel, {}, context);

      expect(registeredHandlers).toBeDefined();
      expect(registeredHandlers!.pushToAgent).toBeDefined();
      expect(typeof registeredHandlers!.pushToAgent).toBe('function');
    });

    it('should push instruction to agent via InputMessageRouter', async () => {
      const channel = createMockFeishuChannel();
      const context = createFeishuSetupContext();

      void FEISHU_WIRED_DESCRIPTOR.setup!(channel, {}, context);

      const result = await registeredHandlers!.pushToAgent!('oc_test123', 'You are a discussion moderator.');

      expect(result).toEqual({ success: true });
      expect(mockRoute).toHaveBeenCalledTimes(1);
      expect(mockRoute).toHaveBeenCalledWith(expect.objectContaining({
        chatId: 'oc_test123',
        payload: 'You are a discussion moderator.',
        source: 'system',
        trigger: 'command',
      }));
      expect(mockRoute.mock.calls[0][0].id).toMatch(/^push_/);
    });

    it('should throw when InputMessageRouter is not initialized', async () => {
      const channel = createMockFeishuChannel();
      const context = createFeishuSetupContext({ inputMessageRouter: undefined } as any);

      void FEISHU_WIRED_DESCRIPTOR.setup!(channel, {}, context);

      await expect(
        registeredHandlers!.pushToAgent!('oc_test123', 'Hello')
      ).rejects.toThrow('InputMessageRouter not initialized — cannot push to agent');

      expect(mockRoute).not.toHaveBeenCalled();
    });

    it('should propagate routing errors', async () => {
      const channel = createMockFeishuChannel();
      const context = createFeishuSetupContext();
      mockRoute.mockRejectedValue(new Error('Agent pool full'));

      void FEISHU_WIRED_DESCRIPTOR.setup!(channel, {}, context);

      await expect(
        registeredHandlers!.pushToAgent!('oc_test123', 'Hello')
      ).rejects.toThrow('Agent pool full');
    });
  });
});
