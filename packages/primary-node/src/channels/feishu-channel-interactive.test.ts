/**
 * Tests for FeishuChannel.buildInteractiveCard().
 *
 * Issue #1571: Phase 2 — Primary Node owns the full card building lifecycle.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock @disclaude/core before importing FeishuChannel
vi.mock('@disclaude/core', () => ({
  Config: {
    FEISHU_APP_ID: 'test-app-id',
    FEISHU_APP_SECRET: 'test-app-secret',
  },
  WS_HEALTH: {
    OFFLINE_QUEUE: { MAX_SIZE: 100, MAX_MESSAGE_AGE_MS: 300000 },
  },
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    trace: vi.fn(),
  }),
  BaseChannel: class {
    id = 'test-channel';
    isRunning = true;
    constructor() {}
    async start() {}
    async stop() {}
    sendMessage() { return Promise.resolve(); }
  },
  attachmentManager: { cleanupOldAttachments: vi.fn() },
  // Card building utilities (Issue #1571: Phase 2)
  buildQuestionCard: vi.fn((question, options, title) => ({
    config: { wide_screen_mode: true },
    header: { title: { tag: 'plain_text', content: title || '🤖 Agent 提问' }, template: 'blue' },
    elements: [
      { tag: 'markdown', content: question },
      { tag: 'action', actions: options.map((opt: { text: string; value?: string }, i: number) => ({
        tag: 'button',
        text: { tag: 'plain_text', content: opt.text },
        value: opt.value || `option_${i}`,
        type: 'default',
      })) },
    ],
  })),
  buildActionPrompts: vi.fn((options) => {
    const prompts: Record<string, string> = {};
    for (let i = 0; i < options.length; i++) {
      const opt = options[i];
      const value = opt.value || `option_${i}`;
      prompts[value] = `[用户操作] 用户选择了「${opt.text}」`;
    }
    return prompts;
  }),
}));

// Mock platform-specific modules
vi.mock('../platforms/feishu/index.js', () => ({
  InteractionManager: class {
    register = vi.fn((ctx) => ({ ...ctx, createdAt: Date.now(), expiresAt: Date.now() + 300000 }));
    unregister = vi.fn(() => false);
    dispose = vi.fn();
  },
  WelcomeService: class {},
  createFeishuClient: vi.fn(() => ({})),
}));

vi.mock('./feishu/index.js', () => ({
  PassiveModeManager: class {},
  MentionDetector: class {
    setClient() {}
    fetchBotInfo() { return Promise.resolve(); }
    getBotInfo() { return { open_id: 'test-bot' }; }
  },
  WelcomeHandler: class {},
  MessageHandler: class {
    initialize() {}
    clearClient() {}
    handleMessageReceive() { return Promise.resolve(); }
    handleCardAction() { return Promise.resolve(); }
  },
  messageLogger: { init: vi.fn() },
  WsConnectionManager: class {
    on() {}
    start() { return Promise.resolve(); }
    stop() { return Promise.resolve(); }
    isHealthy() { return true; }
    getMetrics() { return {}; }
  },
}));

import { FeishuChannel } from './feishu-channel.js';

describe('FeishuChannel.buildInteractiveCard', () => {
  let channel: FeishuChannel;

  beforeEach(() => {
    channel = new FeishuChannel({
      appId: 'test-app-id',
      appSecret: 'test-app-secret',
    });
  });

  it('should build and send an interactive card', async () => {
    const sendMessageSpy = vi.spyOn(channel, 'sendMessage').mockResolvedValue(undefined);

    const result = await channel.buildInteractiveCard({
      chatId: 'oc_test_chat',
      question: 'What is your choice?',
      options: [
        { text: 'Option A', value: 'a' },
        { text: 'Option B', value: 'b' },
      ],
      title: 'Test Question',
      context: 'Test context',
    });

    expect(result.success).toBe(true);
    expect(result.messageId).toMatch(/^interactive_oc_test_chat_\d+$/);

    // Verify sendMessage was called with correct card structure
    expect(sendMessageSpy).toHaveBeenCalledOnce();
    const call = sendMessageSpy.mock.calls[0][0] as unknown as Record<string, unknown>;
    expect(call.chatId).toBe('oc_test_chat');
    expect(call.type).toBe('card');
    expect(call.card).toBeDefined();
    expect((call.card as Record<string, unknown>).header).toBeDefined();

    sendMessageSpy.mockRestore();
  });

  it('should register action prompts in InteractionManager', async () => {
    vi.spyOn(channel, 'sendMessage').mockResolvedValue(undefined);

    await channel.buildInteractiveCard({
      chatId: 'oc_test_chat',
      question: 'Pick one',
      options: [
        { text: 'Yes', value: 'yes' },
        { text: 'No', value: 'no' },
      ],
    });

    const interactionManager = (channel as unknown as { interactionManager: { register: ReturnType<typeof vi.fn> } }).interactionManager;
    expect(interactionManager.register).toHaveBeenCalledOnce();
    const registeredCtx = interactionManager.register.mock.calls[0][0] as Record<string, unknown>;
    expect(registeredCtx.chatId).toBe('oc_test_chat');
    expect(registeredCtx.expectedActions).toEqual(['yes', 'no']);
    expect(registeredCtx.metadata).toBeDefined();
    expect((registeredCtx.metadata as Record<string, unknown>).actionPrompts).toBeDefined();
  });

  it('should use default title when not provided', async () => {
    const sendMessageSpy = vi.spyOn(channel, 'sendMessage').mockResolvedValue(undefined);

    await channel.buildInteractiveCard({
      chatId: 'oc_test_chat',
      question: 'Question?',
      options: [{ text: 'OK', value: 'ok' }],
    });

    expect(sendMessageSpy).toHaveBeenCalledOnce();
    const call = sendMessageSpy.mock.calls[0][0] as unknown as Record<string, unknown>;
    // buildQuestionCard mock should have been called with default title
    expect(call).toBeDefined();
    expect(call.type).toBe('card');

    sendMessageSpy.mockRestore();
  });

  it('should pass threadId to sendMessage', async () => {
    const sendMessageSpy = vi.spyOn(channel, 'sendMessage').mockResolvedValue(undefined);

    await channel.buildInteractiveCard({
      chatId: 'oc_test_chat',
      question: 'Threaded question?',
      options: [{ text: 'Reply', value: 'reply' }],
      threadId: 'parent_msg_123',
    });

    const call = sendMessageSpy.mock.calls[0][0] as unknown as Record<string, unknown>;
    expect(call.threadId).toBe('parent_msg_123');

    sendMessageSpy.mockRestore();
  });

  it('should handle empty options', async () => {
    vi.spyOn(channel, 'sendMessage').mockResolvedValue(undefined);

    const result = await channel.buildInteractiveCard({
      chatId: 'oc_test_chat',
      question: 'No options',
      options: [],
    });

    expect(result.success).toBe(true);
    expect(result.messageId).toBeDefined();

    // Should not register prompts for empty options
    const interactionManager = (channel as unknown as { interactionManager: { register: ReturnType<typeof vi.fn> } }).interactionManager;
    expect(interactionManager.register).not.toHaveBeenCalled();
  });
});
