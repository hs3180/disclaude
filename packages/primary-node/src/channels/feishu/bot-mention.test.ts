/**
 * Tests for bot-to-bot @mention support.
 *
 * Issue #1742: Support bot-to-bot @mention conversations.
 *
 * Tests cover:
 * 1. MessageHandler: Bot messages with @mention to this bot should pass through
 * 2. MessageHandler: Bot messages without @mention should still be filtered
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { MessageHandler } from './message-handler.js';
import { MentionDetector } from './mention-detector.js';

// ============================================================================
// Helpers
// ============================================================================

let messageIdCounter = 0;

function createMockMessageHandlerOptions(mentionDetector?: MentionDetector) {
  const detector = mentionDetector ?? new MentionDetector();

  return {
    passiveModeManager: {
      isPassiveModeDisabled: vi.fn().mockReturnValue(false),
    } as any,
    mentionDetector: detector,
    interactionManager: {
      handleAction: vi.fn().mockResolvedValue(undefined),
    } as any,
    callbacks: {
      emitMessage: vi.fn().mockResolvedValue(undefined),
      emitControl: vi.fn().mockResolvedValue({ success: false }),
      sendMessage: vi.fn().mockResolvedValue(undefined),
    },
    isRunning: vi.fn().mockReturnValue(true),
    hasControlHandler: vi.fn().mockReturnValue(false),
  };
}

function createBotMessageEvent(mentions?: Array<{ key: string; id: { open_id: string; union_id: string; user_id: string }; name: string; tenant_key: string }>) {
  messageIdCounter++;
  const id = `msg_bot_${Date.now()}_${messageIdCounter}`;
  return {
    sender: {
      sender_type: 'app',
      sender_id: {
        open_id: 'cli_bot_sender',
        union_id: '',
        user_id: '',
      },
    },
    message: {
      message_id: id,
      chat_id: 'oc_test_group',
      chat_type: 'group',
      content: JSON.stringify({ text: '@BotA hello' }),
      message_type: 'text',
      create_time: Date.now(),
      mentions: mentions ?? [],
      parent_id: '',
    },
  };
}

function createUserMessageEvent() {
  messageIdCounter++;
  const id = `msg_user_${Date.now()}_${messageIdCounter}`;
  return {
    sender: {
      sender_type: 'user',
      sender_id: {
        open_id: 'ou_user_001',
        union_id: '',
        user_id: '',
      },
    },
    message: {
      message_id: id,
      chat_id: 'oc_test_p2p',
      chat_type: 'p2p',
      content: JSON.stringify({ text: 'Hello' }),
      message_type: 'text',
      create_time: Date.now(),
      mentions: [],
      parent_id: '',
    },
  };
}

// ============================================================================
// Tests: MessageHandler bot message filtering
// ============================================================================

describe('MessageHandler - Bot message filtering (Issue #1742)', () => {
  let handler: MessageHandler;
  let mentionDetector: MentionDetector;
  let emitMessageSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.clearAllMocks();
    messageIdCounter = 0;
    mentionDetector = new MentionDetector();
    const options = createMockMessageHandlerOptions(mentionDetector);
    handler = new MessageHandler(options);
    handler.initialize({} as any);
    emitMessageSpy = options.callbacks.emitMessage;
  });

  it('should filter out bot messages without mentions', async () => {
    const event = createBotMessageEvent();
    await handler.handleMessageReceive(event as any);

    expect(emitMessageSpy).not.toHaveBeenCalled();
  });

  it('should allow bot messages when this bot is @mentioned', async () => {
    // Set up mentionDetector to recognize this bot's open_id
    mentionDetector.setClient({} as any);
    // Mock fetchBotInfo to set bot info
    mentionDetector['botInfo'] = {
      open_id: 'ou_this_bot',
      app_id: 'cli_this_bot',
    };

    const event = createBotMessageEvent([
      {
        key: '@_user_1',
        id: { open_id: 'ou_other_user', union_id: '', user_id: '' },
        name: 'Other User',
        tenant_key: 'tenant1',
      },
      {
        key: '@_user_2',
        id: { open_id: 'ou_this_bot', union_id: '', user_id: '' },
        name: 'This Bot',
        tenant_key: 'tenant1',
      },
    ]);

    await handler.handleMessageReceive(event as any);

    expect(emitMessageSpy).toHaveBeenCalledTimes(1);
    const emittedMessage = emitMessageSpy.mock.calls[0][0] as any;
    expect(emittedMessage.chatId).toBe('oc_test_group');
  });

  it('should allow bot messages when this bot app_id is mentioned', async () => {
    mentionDetector['botInfo'] = {
      open_id: 'ou_this_bot',
      app_id: 'cli_this_bot',
    };

    const event = createBotMessageEvent([
      {
        key: '@_user_1',
        id: { open_id: 'cli_this_bot', union_id: '', user_id: '' },
        name: 'This Bot',
        tenant_key: 'tenant1',
      },
    ]);

    await handler.handleMessageReceive(event as any);

    expect(emitMessageSpy).toHaveBeenCalledTimes(1);
  });

  it('should still filter bot messages when mentioned user is not this bot', async () => {
    mentionDetector['botInfo'] = {
      open_id: 'ou_this_bot',
      app_id: 'cli_this_bot',
    };

    const event = createBotMessageEvent([
      {
        key: '@_user_1',
        id: { open_id: 'ou_another_bot', union_id: '', user_id: '' },
        name: 'Another Bot',
        tenant_key: 'tenant1',
      },
    ]);

    await handler.handleMessageReceive(event as any);

    expect(emitMessageSpy).not.toHaveBeenCalled();
  });

  it('should still allow regular user messages in P2P chat', async () => {
    const event = createUserMessageEvent();
    await handler.handleMessageReceive(event as any);

    expect(emitMessageSpy).toHaveBeenCalledTimes(1);
  });

  it('should filter bot messages with empty mentions array', async () => {
    const event = createBotMessageEvent([]);
    await handler.handleMessageReceive(event as any);

    expect(emitMessageSpy).not.toHaveBeenCalled();
  });

  it('should filter bot messages with undefined mentions', async () => {
    const event = createBotMessageEvent();
    (event.message as any).mentions = undefined;

    await handler.handleMessageReceive(event as any);

    expect(emitMessageSpy).not.toHaveBeenCalled();
  });
});
