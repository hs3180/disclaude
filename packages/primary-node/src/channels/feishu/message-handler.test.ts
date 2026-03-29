/**
 * Tests for MessageHandler bot message filtering.
 *
 * Issue #1742: Allow bot-to-bot @mention conversations.
 * Tests that bot messages are filtered unless the bot is @mentioned.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { MessageHandler, type MessageCallbacks } from './message-handler.js';
import type { PassiveModeManager } from './passive-mode.js';
import type { MentionDetector } from './mention-detector.js';
import type { InteractionManager } from '../../platforms/feishu/interaction-manager.js';

// ============================================================================
// Helpers
// ============================================================================

function createMockMentionDetector(isBotMentionedResult: boolean = false): MentionDetector {
  return {
    isBotMentioned: vi.fn().mockReturnValue(isBotMentionedResult),
    fetchBotInfo: vi.fn(),
    setClient: vi.fn(),
    getBotInfo: vi.fn(),
  } as unknown as MentionDetector;
}

function createMockPassiveModeManager(): PassiveModeManager {
  return {
    isPassiveModeDisabled: vi.fn().mockReturnValue(false),
    setPassiveModeDisabled: vi.fn(),
    getPassiveModeDisabledChats: vi.fn().mockReturnValue([]),
  } as unknown as PassiveModeManager;
}

function createMockInteractionManager(): InteractionManager {
  return {
    handleAction: vi.fn().mockResolvedValue(undefined),
    dispose: vi.fn(),
  } as unknown as InteractionManager;
}

function createMockCallbacks(): MessageCallbacks {
  return {
    emitMessage: vi.fn().mockResolvedValue(undefined),
    emitControl: vi.fn().mockResolvedValue({ success: false }),
    sendMessage: vi.fn().mockResolvedValue(undefined),
  };
}

let messageIdCounter = 0;

function createBotMessageEvent(overrides?: Record<string, unknown>) {
  messageIdCounter++;
  return {
    event: {
      sender: {
        sender_type: 'app',
        sender_id: { open_id: 'bot_open_id', union_id: 'bot_union_id' },
      },
      message: {
        message_id: `msg_bot_${messageIdCounter}`,
        chat_id: 'oc_bot_chat',
        // Feishu post (rich text) content format expected by MessageHandler.parsePostContent
        content: JSON.stringify({
          content: [[
            { tag: 'at', user_id: 'self_bot_open_id', text: 'SelfBot' },
            { tag: 'text', text: ' hello' },
          ]],
        }),
        message_type: 'post',
        create_time: Date.now(),
        mentions: [
          {
            key: '@_user_1',
            id: { open_id: 'self_bot_open_id', union_id: 'self_bot_union_id' },
            name: 'SelfBot',
            tenant_key: 'tenant_001',
          },
        ],
        parent_id: undefined,
      },
    },
    ...overrides,
  };
}

function createHumanMessageEvent(overrides?: Record<string, unknown>) {
  messageIdCounter++;
  return {
    event: {
      sender: {
        sender_type: 'user',
        sender_id: { open_id: 'user_open_id', union_id: 'user_union_id' },
      },
      message: {
        message_id: `msg_human_${messageIdCounter}`,
        chat_id: 'oc_human_chat',
        content: '{"text":"hello"}',
        message_type: 'text',
        create_time: Date.now(),
        mentions: [],
        parent_id: undefined,
      },
    },
    ...overrides,
  };
}

// ============================================================================
// Tests: Bot message filtering
// ============================================================================

describe('MessageHandler - Bot message filtering (Issue #1742)', () => {
  let mentionDetector: MentionDetector;
  let passiveModeManager: PassiveModeManager;
  let interactionManager: InteractionManager;
  let callbacks: MessageCallbacks;

  beforeEach(() => {
    vi.clearAllMocks();
    passiveModeManager = createMockPassiveModeManager();
    interactionManager = createMockInteractionManager();
    callbacks = createMockCallbacks();
  });

  it('should filter bot message when bot is NOT @mentioned', async () => {
    mentionDetector = createMockMentionDetector(false);

    const handler = new MessageHandler({
      passiveModeManager,
      mentionDetector,
      interactionManager,
      callbacks,
      isRunning: () => true,
      hasControlHandler: () => false,
    });

    const data = createBotMessageEvent();
    await handler.handleMessageReceive(data as any);

    // Message should be filtered — emitMessage should NOT be called
    expect(callbacks.emitMessage).not.toHaveBeenCalled();
  });

  it('should allow bot message when bot IS @mentioned', async () => {
    mentionDetector = createMockMentionDetector(true);

    const handler = new MessageHandler({
      passiveModeManager,
      mentionDetector,
      interactionManager,
      callbacks,
      isRunning: () => true,
      hasControlHandler: () => false,
    });

    const data = createBotMessageEvent();
    await handler.handleMessageReceive(data as any);

    // Message should NOT be filtered — emitMessage should be called
    expect(callbacks.emitMessage).toHaveBeenCalledTimes(1);
    const emittedMsg = (callbacks.emitMessage as any).mock.calls[0][0];
    expect(emittedMsg.chatId).toBe('oc_bot_chat');
    expect(emittedMsg.messageId).toMatch(/^msg_bot_\d+$/);
  });

  it('should check isBotMentioned with mentions from the message', async () => {
    mentionDetector = createMockMentionDetector(true);

    const handler = new MessageHandler({
      passiveModeManager,
      mentionDetector,
      interactionManager,
      callbacks,
      isRunning: () => true,
      hasControlHandler: () => false,
    });

    const data = createBotMessageEvent();
    await handler.handleMessageReceive(data as any);

    // Verify that isBotMentioned was called with the correct mentions
    expect(mentionDetector.isBotMentioned).toHaveBeenCalledWith(
      data.event.message.mentions,
    );
  });

  it('should still process human messages normally', async () => {
    mentionDetector = createMockMentionDetector(false);

    const handler = new MessageHandler({
      passiveModeManager,
      mentionDetector,
      interactionManager,
      callbacks,
      isRunning: () => true,
      hasControlHandler: () => false,
    });

    const data = createHumanMessageEvent();
    await handler.handleMessageReceive(data as any);

    // Human messages should always be processed
    expect(callbacks.emitMessage).toHaveBeenCalledTimes(1);
  });

  it('should not crash when mentions is undefined for bot message', async () => {
    mentionDetector = createMockMentionDetector(false);

    const handler = new MessageHandler({
      passiveModeManager,
      mentionDetector,
      interactionManager,
      callbacks,
      isRunning: () => true,
      hasControlHandler: () => false,
    });

    const data = createBotMessageEvent();
    // Remove mentions to simulate edge case
    delete (data.event as any).message.mentions;

    // Should not throw
    await expect(handler.handleMessageReceive(data as any)).resolves.not.toThrow();
    expect(callbacks.emitMessage).not.toHaveBeenCalled();
  });

  it('should not crash when mentions is empty array for bot message', async () => {
    mentionDetector = createMockMentionDetector(false);

    const handler = new MessageHandler({
      passiveModeManager,
      mentionDetector,
      interactionManager,
      callbacks,
      isRunning: () => true,
      hasControlHandler: () => false,
    });

    const data = createBotMessageEvent();
    (data.event as any).message.mentions = [];

    await expect(handler.handleMessageReceive(data as any)).resolves.not.toThrow();
    expect(callbacks.emitMessage).not.toHaveBeenCalled();
  });
});
