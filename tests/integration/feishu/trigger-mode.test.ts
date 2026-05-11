/**
 * P3 Integration test: Trigger mode message filtering through real MessageHandler.
 *
 * Tests the full incoming message pipeline:
 *   Feishu Event → MessageHandler → TriggerModeManager → MentionDetector → emitMessage/callback
 *
 * Verifies that group chat message filtering works correctly across trigger modes:
 * - 'mention': Only responds when bot is @mentioned
 * - 'always': Responds to all messages
 * - 'auto': Responds to all in small groups, mention-only in larger groups
 *
 * Uses real TriggerModeManager and MentionDetector instances (not mocked).
 * MentionDetector uses fallback pattern matching (no Feishu API client required).
 * No internal module mocking — only real components wired together.
 *
 * @see Issue #1626 P3
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  TriggerModeManager,
  MentionDetector,
  type MessageCallbacks,
} from '@disclaude/primary-node';
// MessageHandler is a concrete class that conflicts with the core type alias,
// so we import it directly from the compiled dist.
import { MessageHandler } from '@disclaude/primary-node/channels/feishu';
import type { FeishuEventData } from '@disclaude/core';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Bot mention object using fallback pattern.
 * MentionDetector without botInfo (no Feishu API client) uses fallback:
 * open_id starting with 'cli_' → detected as bot mention.
 */
const BOT_MENTION = {
  key: '_bot',
  id: { open_id: 'cli_test_bot_app_id', union_id: '', user_id: '' },
  name: 'TestBot',
  tenant_key: 'tenant',
} as const;

/**
 * Regular user mention (open_id doesn't start with 'cli_', no 'bot' in key).
 * MentionDetector fallback will NOT match this as a bot mention.
 */
const USER_MENTION = {
  key: '_user1',
  id: { open_id: 'ou_regular_user_id', union_id: '', user_id: '' },
  name: 'Alice',
  tenant_key: 'tenant',
} as const;

/** Unique ID counter to prevent deduplication across test messages */
let messageIdCounter = 0;
function nextMessageId(): string {
  return `msg_trigger_test_${Date.now()}_${++messageIdCounter}`;
}

/** Build a Feishu group text message event */
function groupTextEvent(
  text: string,
  overrides: {
    chatId?: string;
    mentions?: Array<{
      key: string;
      id: { open_id: string; union_id: string; user_id: string };
      name: string;
      tenant_key: string;
    }>;
    senderOpenId?: string;
  } = {},
): FeishuEventData {
  return {
    event: {
      message: {
        message_id: nextMessageId(),
        chat_id: overrides.chatId ?? 'oc_group_chat_001',
        chat_type: 'group',
        content: JSON.stringify({ text }),
        message_type: 'text',
        create_time: Date.now(),
        mentions: overrides.mentions,
      },
      sender: {
        sender_type: 'user',
        sender_id: { open_id: overrides.senderOpenId ?? 'ou_sender_001' },
      },
    },
  };
}

/** Build a Feishu p2p text message event */
function p2pTextEvent(text: string, chatId = 'oc_p2p_chat_001'): FeishuEventData {
  return {
    event: {
      message: {
        message_id: nextMessageId(),
        chat_id: chatId,
        chat_type: 'p2p',
        content: JSON.stringify({ text }),
        message_type: 'text',
        create_time: Date.now(),
      },
      sender: {
        sender_type: 'user',
        sender_id: { open_id: 'ou_sender_001' },
      },
    },
  };
}

/** Create a MessageHandler with real TriggerModeManager and MentionDetector */
function createTestHandler() {
  const triggerModeManager = new TriggerModeManager();
  const mentionDetector = new MentionDetector();
  // No lark.Client set → MentionDetector uses fallback pattern matching (no API calls)

  const emitMessage = vi.fn<() => Promise<void>>().mockResolvedValue(undefined);
  const sendMessage = vi.fn<() => Promise<void>>().mockResolvedValue(undefined);

  const callbacks: MessageCallbacks = {
    emitMessage,
    emitControl: vi.fn().mockResolvedValue({ success: false }),
    sendMessage,
  };

  const handler = new MessageHandler({
    triggerModeManager,
    mentionDetector,
    // InteractionManager is not needed for trigger mode filtering — provide a stub
    interactionManager: { handleAction: vi.fn() } as any,
    callbacks,
    isRunning: () => true,
    hasControlHandler: () => false,
  });
  // NOTE: We intentionally do NOT call handler.initialize(client).
  // Without a lark client, file downloads and API calls are skipped,
  // allowing us to test trigger mode filtering in isolation.

  return { handler, triggerModeManager, mentionDetector, emitMessage, sendMessage };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Trigger mode filtering integration (MessageHandler + TriggerModeManager + MentionDetector)', () => {
  let handler: MessageHandler;
  let triggerModeManager: TriggerModeManager;
  let emitMessage: ReturnType<typeof vi.fn>;
  let sendMessage: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    const setup = createTestHandler();
    handler = setup.handler;
    triggerModeManager = setup.triggerModeManager;
    emitMessage = setup.emitMessage;
    sendMessage = setup.sendMessage;
  });

  // -------------------------------------------------------------------------
  // Default mode ('auto') — no small group detected
  // -------------------------------------------------------------------------

  describe('default mode (auto) — non-small group', () => {
    it('should filter group message without @mention', async () => {
      const event = groupTextEvent('Hello everyone');

      await handler.handleMessageReceive(event);

      expect(emitMessage).not.toHaveBeenCalled();
    });

    it('should process group message with bot @mention', async () => {
      const event = groupTextEvent('Hey bot, help me!', {
        mentions: [BOT_MENTION],
      });

      await handler.handleMessageReceive(event);

      expect(emitMessage).toHaveBeenCalledTimes(1);
      const msg = emitMessage.mock.calls[0][0];
      expect(msg.chatId).toBe('oc_group_chat_001');
    });
  });

  // -------------------------------------------------------------------------
  // 'mention' mode — explicit
  // -------------------------------------------------------------------------

  describe('mention mode — explicit setting', () => {
    beforeEach(() => {
      triggerModeManager.setMode('oc_mention_chat', 'mention');
    });

    it('should filter message without @mention in mention mode', async () => {
      const event = groupTextEvent('General chat message', {
        chatId: 'oc_mention_chat',
      });

      await handler.handleMessageReceive(event);

      expect(emitMessage).not.toHaveBeenCalled();
    });

    it('should process message with bot @mention in mention mode', async () => {
      const event = groupTextEvent('Hey bot!', {
        chatId: 'oc_mention_chat',
        mentions: [BOT_MENTION],
      });

      await handler.handleMessageReceive(event);

      expect(emitMessage).toHaveBeenCalledTimes(1);
    });

    it('should NOT process message with only user @mention in mention mode', async () => {
      const event = groupTextEvent('Hey Alice!', {
        chatId: 'oc_mention_chat',
        mentions: [USER_MENTION],
      });

      await handler.handleMessageReceive(event);

      expect(emitMessage).not.toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // 'always' mode
  // -------------------------------------------------------------------------

  describe('always mode', () => {
    beforeEach(() => {
      triggerModeManager.setMode('oc_always_chat', 'always');
    });

    it('should process message without @mention in always mode', async () => {
      const event = groupTextEvent('Hello everyone', {
        chatId: 'oc_always_chat',
      });

      await handler.handleMessageReceive(event);

      expect(emitMessage).toHaveBeenCalledTimes(1);
    });

    it('should process message with bot @mention in always mode', async () => {
      const event = groupTextEvent('Hey bot!', {
        chatId: 'oc_always_chat',
        mentions: [BOT_MENTION],
      });

      await handler.handleMessageReceive(event);

      expect(emitMessage).toHaveBeenCalledTimes(1);
    });

    it('should process multiple messages in always mode', async () => {
      for (let i = 0; i < 3; i++) {
        const event = groupTextEvent(`Message ${i + 1}`, {
          chatId: 'oc_always_chat',
        });
        await handler.handleMessageReceive(event);
      }

      expect(emitMessage).toHaveBeenCalledTimes(3);
    });
  });

  // -------------------------------------------------------------------------
  // 'auto' mode — small group detection
  // -------------------------------------------------------------------------

  describe('auto mode — small group', () => {
    beforeEach(() => {
      triggerModeManager.markAsSmallGroup('oc_small_group');
    });

    it('should process message without @mention in small group', async () => {
      const event = groupTextEvent('Hello', {
        chatId: 'oc_small_group',
      });

      await handler.handleMessageReceive(event);

      expect(emitMessage).toHaveBeenCalledTimes(1);
    });

    it('should continue processing when auto mode is explicit with small group', async () => {
      // Even with explicit 'auto' mode, small group detection should still work
      triggerModeManager.setMode('oc_small_group', 'auto');

      const event = groupTextEvent('Still works', {
        chatId: 'oc_small_group',
      });

      await handler.handleMessageReceive(event);

      expect(emitMessage).toHaveBeenCalledTimes(1);
    });
  });

  // -------------------------------------------------------------------------
  // P2P (direct messages) — trigger mode should not apply
  // -------------------------------------------------------------------------

  describe('p2p chat — trigger mode does not apply', () => {
    it('should always process p2p messages regardless of trigger mode', async () => {
      // Even in mention mode, p2p should work (isGroupChat returns false)
      triggerModeManager.setMode('oc_p2p_chat_001', 'mention');

      const event = p2pTextEvent('Hello in direct message');

      await handler.handleMessageReceive(event);

      expect(emitMessage).toHaveBeenCalledTimes(1);
    });
  });

  // -------------------------------------------------------------------------
  // /trigger command — should bypass trigger mode filtering
  // -------------------------------------------------------------------------

  describe('/trigger command bypasses filtering', () => {
    it('should process /trigger command even in mention mode without mention', async () => {
      triggerModeManager.setMode('oc_trigger_cmd_chat', 'mention');

      const event = groupTextEvent('/trigger always', {
        chatId: 'oc_trigger_cmd_chat',
      });

      await handler.handleMessageReceive(event);

      // /trigger is a command that starts with '/' → goes through command handling.
      // It should NOT be filtered by trigger mode.
      // Since hasControlHandler is false, it falls through to default command handling.
      // The command isn't recognized by default handlers (only /reset, /status, /stop are),
      // so it won't match any default handler. It then continues to emitMessage.
      // The key assertion is that the message reaches emitMessage (not silently dropped).
      expect(emitMessage).toHaveBeenCalledTimes(1);
    });
  });

  // -------------------------------------------------------------------------
  // Mode switching at runtime
  // -------------------------------------------------------------------------

  describe('runtime mode switching', () => {
    it('should respect mode change from mention to always', async () => {
      triggerModeManager.setMode('oc_switch_chat', 'mention');

      // First: message without mention is filtered
      const event1 = groupTextEvent('Filtered', { chatId: 'oc_switch_chat' });
      await handler.handleMessageReceive(event1);
      expect(emitMessage).not.toHaveBeenCalled();

      // Switch to always
      triggerModeManager.setMode('oc_switch_chat', 'always');

      // Second: same message is now processed
      const event2 = groupTextEvent('Now processed', { chatId: 'oc_switch_chat' });
      await handler.handleMessageReceive(event2);
      expect(emitMessage).toHaveBeenCalledTimes(1);
    });

    it('should respect mode change from always to mention', async () => {
      triggerModeManager.setMode('oc_switch_chat2', 'always');

      // First: message without mention is processed
      const event1 = groupTextEvent('Processed', { chatId: 'oc_switch_chat2' });
      await handler.handleMessageReceive(event1);
      expect(emitMessage).toHaveBeenCalledTimes(1);

      // Switch to mention
      triggerModeManager.setMode('oc_switch_chat2', 'mention');

      // Second: same message is now filtered
      emitMessage.mockClear();
      const event2 = groupTextEvent('Now filtered', { chatId: 'oc_switch_chat2' });
      await handler.handleMessageReceive(event2);
      expect(emitMessage).not.toHaveBeenCalled();
    });
  });
});
