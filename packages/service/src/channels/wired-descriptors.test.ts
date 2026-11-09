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
import { createControlHandler, type IChannel, type ControlHandler, type ChannelCapabilities, type FeishuApiHandlers, type ChannelApiHandlers } from '@disclaude/core';

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
  supportsStreaming: false,
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
    ownsChatId: vi.fn().mockReturnValue(false),
  } as unknown as IChannel;
}

// Helper to create mock setup context
function createMockContext(overrides?: Partial<ChannelSetupContext>): ChannelSetupContext {
  return {
    agentPool: {
      getOrCreateChatAgent: vi.fn().mockReturnValue({ processMessage: vi.fn() }),
      getPoolStats: vi.fn(() => ({ active: 0, busy: 0, idle: 0, peakActive: 0, totalEvictions: 0 })),
    },
    controlHandler: vi.fn() as unknown as ControlHandler,
    controlHandlerContext: {},
    logger: mockLogger,
    service: {
      getInteractiveContextStore: vi.fn().mockReturnValue({
        generatePrompt: vi.fn().mockReturnValue('Generated prompt'),
      }),
      registerFeishuHandlers: vi.fn(),
      registerChannelHandlers: vi.fn(),
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
        supportsStreaming: false,
        supportedChannelTools: [],
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

    it('should have a setup hook (Issue #3808)', () => {
      expect(REST_WIRED_DESCRIPTOR.setup).toBeDefined();
      expect(typeof REST_WIRED_DESCRIPTOR.setup).toBe('function');
    });
  });

  describe('REST_WIRED_DESCRIPTOR.setup — InputMessageRouter injection (Issue #3808)', () => {
    it('should inject InputMessageRouter into REST channel', () => {
      const channel = REST_WIRED_DESCRIPTOR.factory({ port: 3000 });
      const mockRouter = { route: vi.fn().mockResolvedValue(undefined) };
      const context = createMockContext({ inputMessageRouter: mockRouter as any });

      void REST_WIRED_DESCRIPTOR.setup!(channel, { port: 3000 }, context);

      // Verify the channel has the router injected by checking log message
      expect(context.logger.info).toHaveBeenCalledWith(
        expect.stringContaining('/api/push'),
      );
    });

    it('should warn when InputMessageRouter is not available', () => {
      const channel = REST_WIRED_DESCRIPTOR.factory({ port: 3000 });
      const context = createMockContext({ inputMessageRouter: undefined } as any);

      void REST_WIRED_DESCRIPTOR.setup!(channel, { port: 3000 }, context);

      expect(context.logger.warn).toHaveBeenCalledWith(
        expect.stringContaining('InputMessageRouter not available'),
      );
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
        supportsStreaming: false,
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

    it('passes an explicit topic root through the interactive-card handler', async () => {
      const mockChannel = Object.assign(createMockChannel('feishu'), {
        getTriggerModeManager: () => ({ getMode: vi.fn(), setMode: vi.fn() }),
        setWelcomeService: vi.fn(),
      });
      vi.mocked(mockChannel.sendMessage).mockResolvedValue('om_real_card');
      const context = createMockContext();
      await FEISHU_WIRED_DESCRIPTOR.setup!(mockChannel, { appId: 'test', appSecret: 'test' }, context);
      const [handlers] = vi.mocked(context.service.registerFeishuHandlers).mock.calls.at(-1)!;

      const result = await handlers.sendInteractive('chat_123', {
        question: 'Choose a direction', options: [{ text: 'Continue', value: 'continue' }],
        threadId: 'card_action_trigger', threadRootId: 'om_topic_root',
      });
      expect(mockChannel.sendMessage).toHaveBeenCalledWith(expect.objectContaining({
        threadId: 'card_action_trigger', threadRootId: 'om_topic_root', type: 'card',
      }));
      expect(result.messageId).toBe('om_real_card');
    });

    it('does not manufacture a successful interactive receipt without a delivered message ID', async () => {
      const mockChannel = Object.assign(createMockChannel('feishu'), {
        getTriggerModeManager: () => ({ getMode: vi.fn(), setMode: vi.fn() }),
        setWelcomeService: vi.fn(),
      });
      const context = createMockContext();
      await FEISHU_WIRED_DESCRIPTOR.setup!(mockChannel, { appId: 'test', appSecret: 'test' }, context);
      const [handlers] = vi.mocked(context.service.registerFeishuHandlers).mock.calls.at(-1)!;

      await expect(handlers.sendInteractive('chat_123', {
        question: 'Choose', options: [{ text: 'Continue', value: 'continue' }],
      })).rejects.toThrow('message_id');
    });

    it('wires the agent config card to the shared selection services and the command surface (#4914)', async () => {
      const requestAgentConfigCard = vi.fn().mockResolvedValue({ ok: true });
      const mockChannel = Object.assign(createMockChannel('feishu'), {
        getTriggerModeManager: () => ({ getMode: vi.fn(), setMode: vi.fn() }),
        setWelcomeService: vi.fn(),
        requestAgentConfigCard,
      });
      const listAgentPresets = vi.fn().mockReturnValue([
        { name: 'default', agentBackend: 'claude', model: 'claude-sonnet' },
      ]);
      const getActiveAgentPreset = vi.fn().mockReturnValue(
        { name: 'default', agentBackend: 'claude', model: 'claude-sonnet' });
      const switchAgentPreset = vi.fn().mockReturnValue({
        ok: true, active: { name: 'default', agentBackend: 'claude', model: 'claude-sonnet' }, sessionBoundary: 'new-session' as const,
      });
      const isCommandAllowed = vi.fn().mockReturnValue(true);
      const context = createMockContext({
        controlHandlerContext: {
          agentPool: {
            reset: vi.fn(), stop: vi.fn(),
            listAgentPresets, getActiveAgentPreset, switchAgentPreset,
          },
          isCommandAllowed,
        },
      });
      const config: import('./feishu-channel.js').FeishuChannelConfig = { appId: 'test', appSecret: 'test' };
      await FEISHU_WIRED_DESCRIPTOR.setup!(mockChannel, config, context);

      // The injected access ports route to the SAME services as /agent.
      const access = config.agentConfigAccess!;
      expect(access.listPresets()).toEqual([{ name: 'default', agentBackend: 'claude', model: 'claude-sonnet' }]);
      expect(access.getActivePreset('oc_1')).toMatchObject({ name: 'default' });
      access.switchAgentPreset('oc_1', 'default', undefined, 'ou_actor');
      expect(switchAgentPreset).toHaveBeenCalledExactlyOnceWith('oc_1', 'default', undefined, 'ou_actor');
      expect(access.isCommandAllowed?.({ type: 'agent', chatId: 'oc_1', data: { subcommand: 'use' } })).toBe(true);
      expect(isCommandAllowed).toHaveBeenCalled();

      // End-to-end: /agent config through the wired control handler opens the channel card.
      const controlHandler = vi.mocked(mockChannel.onControl).mock.calls[0][0] as import('@disclaude/core').ControlHandler;
      const response = await controlHandler({
        type: 'agent', chatId: 'oc_1', actorId: 'ou_actor', data: { subcommand: 'config' },
      });
      expect(response.success).toBe(true);
      expect(requestAgentConfigCard).toHaveBeenCalledWith({ chatId: 'oc_1', actorId: 'ou_actor' });
    });

    it('gates the contextual config hint on a model-class failure and a real preset choice (#4914)', () => {
      const twoPresets = [
        { name: 'default', agentBackend: 'claude', model: 'claude-sonnet' },
        { name: 'fast', agentBackend: 'pi', model: 'glm-fast' },
      ];
      const listAgentPresets = vi.fn().mockReturnValue(twoPresets);
      const context = createMockContext({
        controlHandlerContext: { agentPool: { reset: vi.fn(), stop: vi.fn(), listAgentPresets } },
      });
      const callbacks = FEISHU_WIRED_DESCRIPTOR.createCallbacks(createMockChannel('feishu'), context)('oc_1');
      const suggest = callbacks.suggestAgentConfig!;
      expect(suggest('oc_1', 'Error code: 404 - The model `gpt-5.6` does not exist or you do not have access to it.'))
        .toContain('/agent config');
      expect(suggest('oc_1', 'Selected model is at capacity. Please try a different model.'))
        .toContain('/agent config');
      // Unrelated failures stay untouched.
      expect(suggest('oc_1', 'upstream request failed: overloaded_error (529)')).toBeUndefined();
      expect(suggest('oc_1', 'workspace routing discovery failed: connect ETIMEDOUT')).toBeUndefined();
      // A model failure without a real choice (single preset) stays silent.
      listAgentPresets.mockReturnValueOnce([twoPresets[0]]);
      expect(suggest('oc_1', 'model not found: glm-4.7')).toBeUndefined();
      // Channels without the card never wire the hint.
      const restCallbacks = REST_WIRED_DESCRIPTOR.createCallbacks(createMockChannel('rest'), createMockContext())('c1');
      expect(restCallbacks.suggestAgentConfig).toBeUndefined();
    });

    it('adds the one-line config entry to first-contact welcomes only when a real choice exists (#4914)', async () => {
      const welcomeForPresets = async (presets: Array<{ name: string; agentBackend: string; model: string }>) => {
        const mockChannel = Object.assign(createMockChannel('feishu'), {
          getTriggerModeManager: () => ({ getMode: vi.fn(), setMode: vi.fn() }),
          setWelcomeService: vi.fn(),
          requestAgentConfigCard: vi.fn().mockResolvedValue({ ok: true }),
          // Native P2P welcome delivery goes through sendWelcomeMessage.
          sendWelcomeMessage: vi.fn().mockResolvedValue(undefined),
        });
        const context = createMockContext({
          controlHandlerContext: {
            agentPool: {
              reset: vi.fn(), stop: vi.fn(),
              listAgentPresets: vi.fn().mockReturnValue(presets),
              getActiveAgentPreset: vi.fn().mockReturnValue(presets[0]),
              switchAgentPreset: vi.fn(),
            },
          },
        });
        await FEISHU_WIRED_DESCRIPTOR.setup!(mockChannel, { appId: 'test', appSecret: 'test' }, context);
        const [[welcomeService]] = vi.mocked(mockChannel.setWelcomeService).mock.calls;
        await welcomeService.handleP2PChatEntered('ou_newcomer', 'p2p');
        const { sendMessage } = vi.mocked(mockChannel);
        const sent = sendMessage.mock.calls
          .map(call => String((call[0] as { text?: string }).text ?? ''));
        const native = (mockChannel as unknown as { sendWelcomeMessage: ReturnType<typeof vi.fn> })
          .sendWelcomeMessage.mock.calls.map((call: unknown[]) => String(call[1] ?? ''));
        return [...sent, ...native];
      };

      const twoPresets = [
        { name: 'default', agentBackend: 'claude', model: 'claude-sonnet' },
        { name: 'fast', agentBackend: 'pi', model: 'glm-fast' },
      ];
      const welcomedWithChoice = await welcomeForPresets(twoPresets);
      expect(welcomedWithChoice.some(t => t.includes('/agent config') && t.includes('模型预设'))).toBe(true);
      // Task examples stay intact — the config line is appended, not a replacement.
      expect(welcomedWithChoice.some(t => (t.match(/「[^」]+」/g) ?? []).length === 3)).toBe(true);

      const welcomedWithoutChoice = await welcomeForPresets([twoPresets[0]]);
      expect(welcomedWithoutChoice.some(t => t.includes('/agent config'))).toBe(false);
    });
  });

  describe('WECHAT_WIRED_DESCRIPTOR (Issue #1554)', () => {
    it('should have correct type and name', () => {
      expect(WECHAT_WIRED_DESCRIPTOR.type).toBe('wechat');
      expect(WECHAT_WIRED_DESCRIPTOR.name).toBe('WeChat');
    });

    it('declares attachments and native MP4 delivery', () => {
      expect(WECHAT_WIRED_DESCRIPTOR.defaultCapabilities).toEqual({
        supportsCard: false,
        supportsThread: false,
        supportsFile: true,
        supportsMarkdown: false,
        supportsMention: false,
        supportsUpdate: false,
        supportsStreaming: false,
        supportedChannelTools: ['send_text', 'send_file'],
        nativeVideoFormats: ['mp4'],
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

    it('should have a setup hook (Issue #3814)', () => {
      expect(WECHAT_WIRED_DESCRIPTOR.setup).toBeDefined();
      expect(typeof WECHAT_WIRED_DESCRIPTOR.setup).toBe('function');
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
          getPoolStats: vi.fn(() => ({ active: 0, busy: 0, idle: 0, peakActive: 0, totalEvictions: 0 })),
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
      }),
      // Issue #4587 (part 2): no threadRootId in this message → chat-scoped agent
      undefined);
      expect(mockAgent.processMessage).toHaveBeenCalledWith(expect.objectContaining({ chatId: 'chat-1', payload: 'Hello from WeChat', messageId: 'msg-1', senderOpenId: 'user-1' }));
    });

    it('should handle errors in message processing', async () => {
      const mockChannel = createMockChannel('wechat');
      const error = new Error('Agent processing failed');
      const mockAgent = { processMessage: vi.fn().mockImplementation(() => { throw error; }) };
      const context = createMockContext({
        agentPool: {
          getOrCreateChatAgent: vi.fn().mockReturnValue(mockAgent),
          getPoolStats: vi.fn(() => ({ active: 0, busy: 0, idle: 0, peakActive: 0, totalEvictions: 0 })),
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

  describe('WECHAT_WIRED_DESCRIPTOR.setup — REST API handlers (Issue #3814)', () => {
    let registeredType: string | undefined;
    let registeredHandlers: ChannelApiHandlers | undefined;
    const mockRoute = vi.fn();

    function createWechatSetupContext(overrides?: Partial<ChannelSetupContext>): ChannelSetupContext {
      return createMockContext({
        inputMessageRouter: { route: mockRoute } as any,
        service: {
          getInteractiveContextStore: vi.fn().mockReturnValue({
            generatePrompt: vi.fn().mockReturnValue('Generated prompt'),
          }),
          registerFeishuHandlers: vi.fn(),
          registerChannelHandlers: vi.fn((type: string, handlers: ChannelApiHandlers) => {
            registeredType = type;
            registeredHandlers = handlers;
          }),
        } as any,
        ...overrides,
      });
    }

    function createMockWechatChannel() {
      return {
        id: 'wechat-test',
        name: 'WeChat Test',
        status: 'stopped',
        onMessage: vi.fn(),
        onControl: vi.fn(),
        start: vi.fn().mockResolvedValue(undefined),
        stop: vi.fn().mockResolvedValue(undefined),
        sendMessage: vi.fn().mockResolvedValue(undefined),
        getCapabilities: vi.fn().mockReturnValue(DEFAULT_CAPABILITIES),
        ownsChatId: vi.fn().mockReturnValue(false),
        getApiClient: vi.fn().mockReturnValue(undefined),
      } as any;
    }

    beforeEach(() => {
      registeredType = undefined;
      registeredHandlers = undefined;
      mockRoute.mockReset();
    });

    it('should register handlers via registerChannelHandlers', () => {
      const channel = createMockWechatChannel();
      const context = createWechatSetupContext();

      void WECHAT_WIRED_DESCRIPTOR.setup!(channel, {}, context);

      expect(registeredType).toBe('wechat');
      expect(registeredHandlers).toBeDefined();
    });

    it('should register pushToAgent handler', () => {
      const channel = createMockWechatChannel();
      const context = createWechatSetupContext();

      void WECHAT_WIRED_DESCRIPTOR.setup!(channel, {}, context);

      expect(registeredHandlers!.pushToAgent).toBeDefined();
      expect(typeof registeredHandlers!.pushToAgent).toBe('function');
    });

    it('should push instruction to agent via InputMessageRouter', async () => {
      const channel = createMockWechatChannel();
      const context = createWechatSetupContext();

      void WECHAT_WIRED_DESCRIPTOR.setup!(channel, {}, context);

      const result = await registeredHandlers!.pushToAgent!('wx_test123', 'Test instruction');

      expect(result).toEqual({ success: true });
      expect(mockRoute).toHaveBeenCalledTimes(1);
      expect(mockRoute).toHaveBeenCalledWith(expect.objectContaining({
        chatId: 'wx_test123',
        payload: 'Test instruction',
        source: 'system',
        trigger: 'command',
      }));
    });

    it('should throw when InputMessageRouter is not initialized', async () => {
      const channel = createMockWechatChannel();
      const context = createWechatSetupContext({ inputMessageRouter: undefined } as any);

      void WECHAT_WIRED_DESCRIPTOR.setup!(channel, {}, context);

      await expect(
        registeredHandlers!.pushToAgent!('wx_test123', 'Hello')
      ).rejects.toThrow('InputMessageRouter not initialized');

      expect(mockRoute).not.toHaveBeenCalled();
    });

    it('rejects unsupported interactive cards without claiming delivery', async () => {
      const channel = createMockWechatChannel();
      const context = createWechatSetupContext();

      void WECHAT_WIRED_DESCRIPTOR.setup!(channel, {}, context);

      await expect(registeredHandlers!.sendInteractive('user@im.wechat', {
        question: 'Choose', options: [{ text: 'Yes', value: 'yes' }],
      })).rejects.toThrow('does not support interactive cards');
      expect(channel.sendMessage).not.toHaveBeenCalled();
    });

    it('should have base handlers (sendMessage, sendCard, uploadFile)', () => {
      const channel = createMockWechatChannel();
      const context = createWechatSetupContext();

      void WECHAT_WIRED_DESCRIPTOR.setup!(channel, {}, context);

      expect(registeredHandlers!.sendMessage).toBeDefined();
      expect(registeredHandlers!.sendCard).toBeDefined();
      expect(registeredHandlers!.uploadFile).toBeDefined();
    });
  });

  describe('FEISHU_WIRED_DESCRIPTOR.setup — pushToAgent (Issue #631)', () => {
    let registeredHandlers: FeishuApiHandlers | undefined;
    const mockRoute = vi.fn();

    function createFeishuSetupContext(overrides?: Partial<ChannelSetupContext>): ChannelSetupContext {
      return createMockContext({
        inputMessageRouter: { route: mockRoute } as any,
        service: {
          getInteractiveContextStore: vi.fn().mockReturnValue({
            generatePrompt: vi.fn().mockReturnValue('Generated prompt'),
          }),
          registerFeishuHandlers: vi.fn((handlers: FeishuApiHandlers) => {
            registeredHandlers = handlers;
          }),
          registerChannelHandlers: vi.fn(),
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
        setWelcomeService: vi.fn(),
        sendWelcomeMessage: vi.fn().mockResolvedValue(undefined),
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

    it('wires welcome events and per-channel help using the actual capabilities and host access policy', async () => {
      const channel = createMockFeishuChannel();
      const policy = vi.fn((command: { type: string; actorId?: string }) => command.type === 'help' && command.actorId === 'actor');
      const context = createFeishuSetupContext({ controlHandlerContext: { isCommandAllowed: policy } as any });
      await FEISHU_WIRED_DESCRIPTOR.setup!(channel, {}, context);
      expect(channel.setWelcomeService).toHaveBeenCalledTimes(1);
      expect(channel.onControl).toHaveBeenCalledTimes(1);
      const [[welcome]] = channel.setWelcomeService.mock.calls;
      await welcome.handleBotAddedToGroup('group', 'group');
      expect(channel.sendWelcomeMessage).not.toHaveBeenCalled();
      const [[handler]] = channel.onControl.mock.calls;
      const help = await handler({ type: 'help', chatId: 'chat', chatType: 'p2p', actorId: 'actor' });
      expect(help.success).toBe(true);
      expect(help.message).not.toMatch(/\/reset|\/agent|附件|\/trigger/);
      expect(policy).toHaveBeenCalledWith(expect.objectContaining({ actorId: 'actor', chatId: 'chat' }));
    });

    it('enables Goal records only for the user-channel handler, not model-facing REST controls', async () => {
      const channel = createMockFeishuChannel();
      const id = '00000000-0000-4000-8000-000000000000';
      const record = { id, revision: 1, status: 'draft', chatId: 'chat', projectRoot: '/fixture-project',
        objective: 'Deliver', acceptance: ['Verify'], artifacts: [], progress: '' };
      const store = { create: vi.fn().mockResolvedValue(record) } as unknown as NonNullable<ChannelSetupContext['goalStore']>;
      const goalExecution = { start: vi.fn().mockResolvedValue({ record: { ...record, revision: 2, status: 'active' } }), control: vi.fn() };
      const hostContext = { projectManager: { resolveCwd: () => ({}), getWorkspaceDir: () => '/fixture-project' } } as any;
      const globalHandler = createControlHandler(hostContext);
      const context = createFeishuSetupContext({ goalStore: store, goalExecution,
        controlHandler: globalHandler, controlHandlerContext: hostContext });
      await FEISHU_WIRED_DESCRIPTOR.setup!(channel, {}, context);
      const [[userHandler]] = channel.onControl.mock.calls;
      const command = { type: 'goal' as const, chatId: 'chat', actorId: 'actual-user', sourceMessageId: 'om-real',
        data: { args: ['Deliver', '|', 'Verify'] } };
      expect((await userHandler(command)).success).toBe(true);
      expect((await globalHandler(command)).message).toContain('当前不可用');
      expect(store.create).toHaveBeenCalledTimes(1);
    });

    it('exposes Goal execution only to the Feishu user-channel control handler', async () => {
      const channel = createMockFeishuChannel();
      const id = '00000000-0000-4000-8000-000000000000';
      const record = { id, revision: 1, status: 'draft', chatId: 'chat', projectRoot: '/fixture-project',
        objective: 'Deliver', acceptance: ['Verify'], artifacts: [], progress: '' };
      const store = { create: vi.fn().mockResolvedValue(record) } as unknown as NonNullable<ChannelSetupContext['goalStore']>;
      const start = vi.fn().mockResolvedValue({ record: { ...record, revision: 2, status: 'active' } });
      const goalExecution = { start, control: vi.fn() };
      const hostContext = { projectManager: { resolveCwd: () => ({}), getWorkspaceDir: () => '/fixture-project' } } as any;
      const globalHandler = createControlHandler(hostContext);
      const context = createFeishuSetupContext({ goalStore: store, goalExecution,
        controlHandler: globalHandler, controlHandlerContext: hostContext });
      await FEISHU_WIRED_DESCRIPTOR.setup!(channel, {}, context);
      const [[userHandler]] = channel.onControl.mock.calls;
      const command = { type: 'goal' as const, chatId: 'chat', actorId: 'actual-user', sourceMessageId: 'om-real',
        data: { args: ['Deliver', '|', 'Verify'] } };
      expect((await globalHandler(command)).success).toBe(false);
      expect(start).not.toHaveBeenCalled();
      expect((await userHandler(command)).success).toBe(true);
      expect(start).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ goalId: id, expectedRevision: 1, sourceMessageId: 'om-real', actorId: 'actual-user' }), 'activate');
      expect(hostContext).not.toHaveProperty('goalExecution');
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
