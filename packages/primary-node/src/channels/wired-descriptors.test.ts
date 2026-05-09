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
  BUILTIN_WIRED_DESCRIPTORS,
} from './wired-descriptors.js';
import type {
  ChannelSetupContext,
  WiredContext,
} from '../channel-lifecycle-manager.js';
import type { IChannel, ControlHandler, ChannelCapabilities } from '@disclaude/core';

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
      getChatStore: vi.fn().mockReturnValue({}),
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
      expect(mockAgent.processMessage).toHaveBeenCalledWith('chat-1', 'Hello from WeChat', 'msg-1', 'user-1', undefined, undefined);
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

  describe('FEISHU_WIRED_DESCRIPTOR.setup() (Issue #1594 Phase 2)', () => {
    let mockFeishuChannel: any;
    let mockConfig: any;
    let mockContext: ChannelSetupContext;
    let mockChatStore: any;
    let mockTriggerModeManager: any;

    beforeEach(() => {
      vi.clearAllMocks();

      mockTriggerModeManager = {
        getMode: vi.fn().mockReturnValue('auto'),
        setMode: vi.fn(),
        initFromRecords: vi.fn().mockReturnValue(0),
      };

      mockFeishuChannel = {
        ...createMockChannel('feishu'),
        getTriggerModeManager: vi.fn().mockReturnValue(mockTriggerModeManager),
        uploadImage: vi.fn().mockResolvedValue('img_key'),
        sendMessage: vi.fn().mockResolvedValue('msg_123'),
      };

      mockChatStore = {
        listTempChats: vi.fn().mockResolvedValue([]),
        markTempChatResponded: vi.fn().mockResolvedValue(true),
      };

      mockConfig = { appId: 'test-id', appSecret: 'test-secret' };

      mockContext = createMockContext({
        primaryNode: {
          getInteractiveContextStore: vi.fn().mockReturnValue({
            generatePrompt: vi.fn().mockReturnValue('Generated prompt'),
          }),
          registerFeishuHandlers: vi.fn(),
          getChatStore: vi.fn().mockReturnValue(mockChatStore),
        } as any,
      });
    });

    it('should set up action prompt resolver on config', () => {
      const mockGeneratePrompt = vi.fn().mockReturnValue('[User] selected option');
      (mockContext.primaryNode as any).getInteractiveContextStore = vi.fn().mockReturnValue({
        generatePrompt: mockGeneratePrompt,
      });

      void FEISHU_WIRED_DESCRIPTOR.setup!(mockFeishuChannel, mockConfig, mockContext);

      expect(mockConfig.resolveActionPrompt).toBeDefined();
      const result = mockConfig.resolveActionPrompt('msg-1', 'chat-1', 'action-1', 'Option 1');
      expect(mockGeneratePrompt).toHaveBeenCalledWith('msg-1', 'chat-1', 'action-1', 'Option 1');
      expect(result).toBe('[User] selected option');
    });

    it('should set up trigger mode adapter from channel manager', () => {
      void FEISHU_WIRED_DESCRIPTOR.setup!(mockFeishuChannel, mockConfig, mockContext);

      expect(mockFeishuChannel.getTriggerModeManager).toHaveBeenCalled();
      expect(mockContext.controlHandlerContext.triggerMode).toBeDefined();

      // Test getMode delegates to TriggerModeManager
      const adapter = mockContext.controlHandlerContext.triggerMode!;
      adapter.getMode('chat-1');
      expect(mockTriggerModeManager.getMode).toHaveBeenCalledWith('chat-1');

      // Test setMode delegates to TriggerModeManager
      adapter.setMode('chat-1', 'always');
      expect(mockTriggerModeManager.setMode).toHaveBeenCalledWith('chat-1', 'always');
    });

    it('should initialize trigger mode from chat store records', async () => {
      const records = [
        { chatId: 'chat-1', triggerMode: 'always' as const, passiveMode: false, createdAt: Date.now() },
        { chatId: 'chat-2', triggerMode: undefined, passiveMode: true, createdAt: Date.now() },
      ];
      mockChatStore.listTempChats.mockResolvedValue(records);
      mockTriggerModeManager.initFromRecords.mockReturnValue(2);

      void FEISHU_WIRED_DESCRIPTOR.setup!(mockFeishuChannel, mockConfig, mockContext);

      // Wait for async init to complete
      await new Promise(resolve => setImmediate(resolve));

      expect(mockChatStore.listTempChats).toHaveBeenCalled();
      expect(mockTriggerModeManager.initFromRecords).toHaveBeenCalledWith(
        records.map(r => ({ chatId: r.chatId, triggerMode: r.triggerMode, passiveMode: r.passiveMode }))
      );
    });

    it('should handle chat store init failure gracefully', async () => {
      mockChatStore.listTempChats.mockRejectedValue(new Error('Store unavailable'));

      void FEISHU_WIRED_DESCRIPTOR.setup!(mockFeishuChannel, mockConfig, mockContext);

      // Wait for async init to complete
      await new Promise(resolve => setImmediate(resolve));

      expect(mockLogger.warn).toHaveBeenCalledWith(
        expect.objectContaining({ err: expect.any(Error) }),
        'Failed to initialize trigger mode from chat store'
      );
    });

    it('should register Feishu IPC handlers', () => {
      void FEISHU_WIRED_DESCRIPTOR.setup!(mockFeishuChannel, mockConfig, mockContext);

      const registerMock = (mockContext.primaryNode as any).registerFeishuHandlers;
      const [[handlers]] = registerMock.mock.calls;
      expect(handlers.sendMessage).toBeTypeOf('function');
      expect(handlers.sendCard).toBeTypeOf('function');
      expect(handlers.uploadFile).toBeTypeOf('function');
      expect(handlers.uploadImage).toBeTypeOf('function');
      expect(handlers.sendInteractive).toBeTypeOf('function');
      expect(handlers.listTempChats).toBeTypeOf('function');
      expect(handlers.markChatResponded).toBeTypeOf('function');
      expect(mockLogger.info).toHaveBeenCalledWith('Feishu IPC handlers registered via descriptor setup');
    });

    it('should handle sendInteractive with valid params', async () => {
      void FEISHU_WIRED_DESCRIPTOR.setup!(mockFeishuChannel, mockConfig, mockContext);

      const registerMock = (mockContext.primaryNode as any).registerFeishuHandlers;
      const [[handlers]] = registerMock.mock.calls;

      const result = await handlers.sendInteractive('chat-1', {
        question: 'Which option?',
        options: [
          { text: 'Option A', value: 'a', type: 'primary' as const },
          { text: 'Option B', value: 'b' },
        ],
        title: 'Choose',
      });

      expect(result.messageId).toBe('msg_123');
      expect(result.actionPrompts).toBeDefined();
      expect(Object.keys(result.actionPrompts)).toContain('a');
      expect(Object.keys(result.actionPrompts)).toContain('b');
    });

    it('should use custom actionPrompts when provided in sendInteractive', async () => {
      void FEISHU_WIRED_DESCRIPTOR.setup!(mockFeishuChannel, mockConfig, mockContext);

      const registerMock = (mockContext.primaryNode as any).registerFeishuHandlers;
      const [[handlers]] = registerMock.mock.calls;

      const customPrompts = { 'a': '[User] chose A', 'b': '[User] chose B' };
      const result = await handlers.sendInteractive('chat-1', {
        question: 'Pick one',
        options: [
          { text: 'A', value: 'a' },
          { text: 'B', value: 'b' },
        ],
        actionPrompts: customPrompts,
      });

      expect(result.actionPrompts).toEqual(customPrompts);
    });

    it('should reject sendInteractive with invalid params', async () => {
      void FEISHU_WIRED_DESCRIPTOR.setup!(mockFeishuChannel, mockConfig, mockContext);

      const registerMock = (mockContext.primaryNode as any).registerFeishuHandlers;
      const [[handlers]] = registerMock.mock.calls;

      await expect(
        handlers.sendInteractive('chat-1', {
          question: '',
          options: [],
        })
      ).rejects.toThrow('Invalid interactive params');
    });

    it('should fall back to synthetic messageId when sendMessage returns nothing', async () => {
      mockFeishuChannel.sendMessage.mockResolvedValue(undefined);

      void FEISHU_WIRED_DESCRIPTOR.setup!(mockFeishuChannel, mockConfig, mockContext);
      const registerMock = (mockContext.primaryNode as any).registerFeishuHandlers;
      const [[handlers]] = registerMock.mock.calls;

      const result = await handlers.sendInteractive('chat-1', {
        question: 'Q?',
        options: [{ text: 'OK', value: 'ok' }],
      });

      expect(result.messageId).toMatch(/^interactive_chat-1_\d+$/);
    });

    it('should handle uploadImage IPC handler', async () => {
      void FEISHU_WIRED_DESCRIPTOR.setup!(mockFeishuChannel, mockConfig, mockContext);
      const registerMock = (mockContext.primaryNode as any).registerFeishuHandlers;
      const [[handlers]] = registerMock.mock.calls;

      const result = await handlers.uploadImage('/tmp/test.png');
      expect(mockFeishuChannel.uploadImage).toHaveBeenCalledWith('/tmp/test.png');
      expect(result).toBe('img_key');
    });

    it('should list temp chats via IPC handler', async () => {
      const now = Date.now();
      mockChatStore.listTempChats.mockResolvedValue([
        { chatId: 'chat-1', createdAt: now, expiresAt: now + 3600000, creatorChatId: 'creator-1', response: 'yes' },
        { chatId: 'chat-2', createdAt: now, expiresAt: now + 3600000, creatorChatId: 'creator-2' },
      ]);

      void FEISHU_WIRED_DESCRIPTOR.setup!(mockFeishuChannel, mockConfig, mockContext);
      const registerMock = (mockContext.primaryNode as any).registerFeishuHandlers;
      const [[handlers]] = registerMock.mock.calls;

      const result = await handlers.listTempChats();
      expect(result).toHaveLength(2);
      expect(result[0]).toEqual({
        chatId: 'chat-1',
        createdAt: now,
        expiresAt: now + 3600000,
        creatorChatId: 'creator-1',
        responded: true,
      });
      expect(result[1].responded).toBe(false);
    });

    it('should mark chat as responded via IPC handler', async () => {
      mockChatStore.markTempChatResponded.mockResolvedValue(true);

      void FEISHU_WIRED_DESCRIPTOR.setup!(mockFeishuChannel, mockConfig, mockContext);
      const registerMock = (mockContext.primaryNode as any).registerFeishuHandlers;
      const [[handlers]] = registerMock.mock.calls;

      const result = await handlers.markChatResponded('chat-1', {
        selectedValue: 'option-a',
        responder: 'user-1',
        repliedAt: new Date().toISOString(),
      });

      expect(mockChatStore.markTempChatResponded).toHaveBeenCalled();
      expect(result).toEqual({ success: true });
    });
  });

  describe('BUILTIN_WIRED_DESCRIPTORS', () => {
    it('should contain REST and Feishu descriptors', () => {
      expect(BUILTIN_WIRED_DESCRIPTORS).toHaveLength(2);
      expect(BUILTIN_WIRED_DESCRIPTORS.map(d => d.type)).toContain('rest');
      expect(BUILTIN_WIRED_DESCRIPTORS.map(d => d.type)).toContain('feishu');
    });

    it('should NOT contain WeChat descriptor (Issue #1638: dynamic registration only)', () => {
      expect(BUILTIN_WIRED_DESCRIPTORS.map(d => d.type)).not.toContain('wechat');
    });
  });
});
