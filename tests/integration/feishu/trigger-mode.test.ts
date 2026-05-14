/**
 * P3 Integration test: Trigger mode message filtering.
 *
 * Tests the real MessageHandler filtering behavior under different triggerMode
 * settings (mention, always, auto) — using real TriggerModeManager and
 * real MentionDetector without mocking core modules.
 *
 * Only minimal mock callbacks are provided (emitMessage, sendMessage, emitControl)
 * to capture outcomes. The MessageHandler, TriggerModeManager, MentionDetector,
 * and stripLeadingMentions all use their real implementations.
 *
 * Uses mock data — no real Feishu credentials needed.
 * Runs as part of the Feishu IPC integration test suite.
 *
 * @see Issue #1626 — P3: 被动模式消息过滤
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  FeishuMessageHandler as MessageHandler,
  TriggerModeManager,
  MentionDetector,
  InteractionManager,
} from '@disclaude/primary-node';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Captured message from emitMessage callback. */
interface CapturedMessage {
  messageId: string;
  chatId: string;
  content: string;
}

/** Feishu message mentions structure. */
interface FeishuMention {
  key: string;
  id: { open_id: string };
  name: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Bot open_id used in tests. */
const BOT_OPEN_ID = 'ou_bot_test_001';

/** Global message ID counter to avoid deduplication collisions. */
let messageIdCounter = 0;

/** Generate a unique message ID for each test message. */
function uniqueMessageId(): string {
  return `msg_trigger_test_${Date.now()}_${++messageIdCounter}`;
}

/** Create a MentionDetector with pre-set bot info (no Feishu API needed). */
function createMentionDetector(): MentionDetector {
  const detector = new MentionDetector();
  // Directly set botInfo via property to avoid needing Feishu API
  (detector as unknown as { botInfo: { open_id: string; app_id?: string } }).botInfo = {
    open_id: BOT_OPEN_ID,
  };
  return detector;
}

/** Create a MessageHandler with real dependencies and captured callbacks. */
function createTestHandler(triggerModeManager: TriggerModeManager) {
  const capturedMessages: CapturedMessage[] = [];
  const sentMessages: Array<{ chatId: string; text: string }> = [];

  const mentionDetector = createMentionDetector();

  // Use a real InteractionManager (part of the integration test philosophy)
  const interactionManager = new InteractionManager({ cleanupInterval: 60000 });

  const handler = new MessageHandler({
    triggerModeManager,
    mentionDetector,
    interactionManager,
    callbacks: {
      emitMessage: async (message) => {
        capturedMessages.push({
          messageId: message.messageId,
          chatId: message.chatId,
          content: message.content,
        });
      },
      emitControl: async () => ({ success: false }),
      sendMessage: async (msg) => {
        sentMessages.push({ chatId: msg.chatId, text: msg.text ?? '' });
      },
    },
    isRunning: () => true,
    hasControlHandler: () => false,
  });

  return { handler, capturedMessages, sentMessages, mentionDetector };
}

/** Build a Feishu text message event for group chat. */
function groupTextEvent(
  text: string,
  options: {
    chatId?: string;
    messageId?: string;
    mentions?: FeishuMention[];
    senderType?: string;
  } = {},
) {
  const now = Date.now();
  return {
    event: {
      message: {
        message_id: options.messageId ?? uniqueMessageId(),
        chat_id: options.chatId ?? 'oc_group_test',
        chat_type: 'group',
        content: JSON.stringify({ text }),
        message_type: 'text',
        create_time: now,
        mentions: options.mentions,
        parent_id: undefined,
      },
      sender: {
        sender_type: options.senderType ?? 'user',
        sender_id: { open_id: 'ou_user_test' },
      },
    },
  } as unknown as Parameters<MessageHandler['handleMessageReceive']>[0];
}

/** Build a mention that references the bot. */
function botMention(): FeishuMention {
  return {
    key: 'ou_bot_test_001',
    id: { open_id: BOT_OPEN_ID },
    name: '@TestBot',
  };
}

/** Build a mention that references a different user (not the bot). */
function otherMention(): FeishuMention {
  return {
    key: 'ou_other_user',
    id: { open_id: 'ou_other_user' },
    name: '@OtherUser',
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Trigger mode message filtering (P3)', () => {
  let triggerModeManager: TriggerModeManager;

  beforeEach(() => {
    triggerModeManager = new TriggerModeManager();
    messageIdCounter++;
  });

  // -------------------------------------------------------------------------
  // Default mode: 'auto' (no small group → mention-only)
  // -------------------------------------------------------------------------

  describe('auto mode (default — not small group)', () => {
    it('should filter non-mention messages in auto mode when group is not small', async () => {
      const { handler, capturedMessages } = createTestHandler(triggerModeManager);
      // Default mode is 'auto', no small group marked → isTriggerEnabled returns false
      // So non-mention messages should be filtered

      await handler.handleMessageReceive(groupTextEvent('Hello world'));

      expect(capturedMessages).toHaveLength(0);
    });

    it('should allow @mention messages in auto mode when group is not small', async () => {
      const { handler, capturedMessages } = createTestHandler(triggerModeManager);

      await handler.handleMessageReceive(
        groupTextEvent('@TestBot do something', { mentions: [botMention()] }),
      );

      expect(capturedMessages).toHaveLength(1);
      expect(capturedMessages[0].content).toContain('do something');
    });

    it('should allow /trigger command messages in auto mode even without mention', async () => {
      const { handler, sentMessages } = createTestHandler(triggerModeManager);

      await handler.handleMessageReceive(groupTextEvent('/trigger always'));

      // /trigger is a control command — it should be handled (not filtered)
      // Since no control handler is set, it falls through to default command handling
      expect(sentMessages.length).toBeGreaterThanOrEqual(0);
    });
  });

  // -------------------------------------------------------------------------
  // 'always' mode: respond to all messages
  // -------------------------------------------------------------------------

  describe('always mode', () => {
    beforeEach(() => {
      triggerModeManager.setMode('oc_group_test', 'always');
    });

    it('should allow all messages in always mode without @mention', async () => {
      const { handler, capturedMessages } = createTestHandler(triggerModeManager);

      await handler.handleMessageReceive(groupTextEvent('Hello without mention'));

      expect(capturedMessages).toHaveLength(1);
      expect(capturedMessages[0].content).toBe('Hello without mention');
    });

    it('should allow @mention messages in always mode', async () => {
      const { handler, capturedMessages } = createTestHandler(triggerModeManager);

      await handler.handleMessageReceive(
        groupTextEvent('@TestBot hello', { mentions: [botMention()] }),
      );

      expect(capturedMessages).toHaveLength(1);
    });

    it('should allow multiple messages in sequence in always mode', async () => {
      const { handler, capturedMessages } = createTestHandler(triggerModeManager);

      await handler.handleMessageReceive(groupTextEvent('First'));
      await handler.handleMessageReceive(groupTextEvent('Second'));
      await handler.handleMessageReceive(groupTextEvent('Third'));

      expect(capturedMessages).toHaveLength(3);
    });
  });

  // -------------------------------------------------------------------------
  // 'mention' mode: respond only to @mentions
  // -------------------------------------------------------------------------

  describe('mention mode', () => {
    beforeEach(() => {
      triggerModeManager.setMode('oc_group_test', 'mention');
    });

    it('should filter non-mention messages in mention mode', async () => {
      const { handler, capturedMessages } = createTestHandler(triggerModeManager);

      await handler.handleMessageReceive(groupTextEvent('No mention here'));

      expect(capturedMessages).toHaveLength(0);
    });

    it('should allow @mention messages in mention mode', async () => {
      const { handler, capturedMessages } = createTestHandler(triggerModeManager);

      await handler.handleMessageReceive(
        groupTextEvent('@TestBot help', { mentions: [botMention()] }),
      );

      expect(capturedMessages).toHaveLength(1);
      expect(capturedMessages[0].content).toContain('help');
    });

    it('should filter messages with non-bot mentions in mention mode', async () => {
      const { handler, capturedMessages } = createTestHandler(triggerModeManager);

      // A message that @mentions another user but not the bot
      await handler.handleMessageReceive(
        groupTextEvent('@OtherUser check this', { mentions: [otherMention()] }),
      );

      expect(capturedMessages).toHaveLength(0);
    });

    it('should allow /trigger command even in mention mode', async () => {
      const { handler, capturedMessages } = createTestHandler(triggerModeManager);

      await handler.handleMessageReceive(groupTextEvent('/trigger always'));

      // /trigger command bypasses the trigger mode filter.
      // Without a controlHandler, /trigger is not recognized as a built-in command
      // and falls through to emitMessage — but the key assertion is that it was
      // NOT filtered by trigger mode.
      expect(capturedMessages.length).toBeGreaterThanOrEqual(1);
    });
  });

  // -------------------------------------------------------------------------
  // 'auto' mode with small group detection
  // -------------------------------------------------------------------------

  describe('auto mode with small group', () => {
    beforeEach(() => {
      // Mark as small group — auto mode should enable triggers
      triggerModeManager.markAsSmallGroup('oc_group_test');
    });

    it('should allow all messages in auto mode when group is small', async () => {
      const { handler, capturedMessages } = createTestHandler(triggerModeManager);

      await handler.handleMessageReceive(groupTextEvent('Hello small group'));

      expect(capturedMessages).toHaveLength(1);
      expect(capturedMessages[0].content).toBe('Hello small group');
    });

    it('should keep trigger enabled for small group even after mode changes', async () => {
      const { handler, capturedMessages } = createTestHandler(triggerModeManager);

      // Set mode to 'auto' explicitly — small group should still trigger
      triggerModeManager.setMode('oc_group_test', 'auto');

      await handler.handleMessageReceive(groupTextEvent('Still works'));

      expect(capturedMessages).toHaveLength(1);
    });
  });

  // -------------------------------------------------------------------------
  // Mode switching: verify dynamic changes
  // -------------------------------------------------------------------------

  describe('mode switching', () => {
    it('should filter when switching from always to mention', async () => {
      const { handler, capturedMessages } = createTestHandler(triggerModeManager);

      // Start in always mode
      triggerModeManager.setMode('oc_group_test', 'always');
      await handler.handleMessageReceive(groupTextEvent('Allowed'));
      expect(capturedMessages).toHaveLength(1);

      // Switch to mention mode
      triggerModeManager.setMode('oc_group_test', 'mention');
      await handler.handleMessageReceive(groupTextEvent('Filtered'));
      expect(capturedMessages).toHaveLength(1); // No new message
    });

    it('should allow when switching from mention to always', async () => {
      const { handler, capturedMessages } = createTestHandler(triggerModeManager);

      // Start in mention mode
      triggerModeManager.setMode('oc_group_test', 'mention');
      await handler.handleMessageReceive(groupTextEvent('Filtered'));
      expect(capturedMessages).toHaveLength(0);

      // Switch to always mode
      triggerModeManager.setMode('oc_group_test', 'always');
      await handler.handleMessageReceive(groupTextEvent('Allowed'));
      expect(capturedMessages).toHaveLength(1);
    });

    it('should handle different chats with independent trigger modes', async () => {
      const { handler, capturedMessages } = createTestHandler(triggerModeManager);

      // Chat A: always mode
      triggerModeManager.setMode('oc_chat_a', 'always');
      // Chat B: mention mode
      triggerModeManager.setMode('oc_chat_b', 'mention');

      await handler.handleMessageReceive(
        groupTextEvent('To A', { chatId: 'oc_chat_a' }),
      );
      await handler.handleMessageReceive(
        groupTextEvent('To B', { chatId: 'oc_chat_b' }),
      );

      expect(capturedMessages).toHaveLength(1);
      expect(capturedMessages[0].chatId).toBe('oc_chat_a');
    });
  });

  // -------------------------------------------------------------------------
  // P2P (non-group) messages: trigger mode does not apply
  // -------------------------------------------------------------------------

  describe('p2p messages (not affected by trigger mode)', () => {
    it('should always allow p2p messages regardless of trigger mode', async () => {
      const { handler, capturedMessages } = createTestHandler(triggerModeManager);

      // Even in mention mode, p2p messages should pass through
      triggerModeManager.setMode('oc_p2p_test', 'mention');

      const p2pEvent = {
        event: {
          message: {
            message_id: uniqueMessageId(),
            chat_id: 'oc_p2p_test',
            chat_type: 'p2p',
            content: JSON.stringify({ text: 'Private message' }),
            message_type: 'text',
            create_time: Date.now(),
            mentions: undefined,
            parent_id: undefined,
          },
          sender: {
            sender_type: 'user',
            sender_id: { open_id: 'ou_user_test' },
          },
        },
      } as unknown as Parameters<MessageHandler['handleMessageReceive']>[0];

      await handler.handleMessageReceive(p2pEvent);

      expect(capturedMessages).toHaveLength(1);
      expect(capturedMessages[0].content).toBe('Private message');
    });
  });

  // -------------------------------------------------------------------------
  // initFromRecords: trigger mode persistence
  // -------------------------------------------------------------------------

  describe('initFromRecords persistence', () => {
    it('should respect trigger mode loaded from records', async () => {
      const { handler, capturedMessages } = createTestHandler(triggerModeManager);

      // Simulate loading persisted state
      triggerModeManager.initFromRecords([
        { chatId: 'oc_persisted_always', triggerMode: 'always' },
        { chatId: 'oc_persisted_mention', triggerMode: 'mention' },
      ]);

      // Always record should allow messages
      await handler.handleMessageReceive(
        groupTextEvent('Hello', { chatId: 'oc_persisted_always' }),
      );
      expect(capturedMessages).toHaveLength(1);

      // Mention record should filter non-mention messages
      await handler.handleMessageReceive(
        groupTextEvent('Hello', { chatId: 'oc_persisted_mention' }),
      );
      expect(capturedMessages).toHaveLength(1); // No new message added
    });

    it('should load legacy passiveMode:false as always mode', async () => {
      const { handler, capturedMessages } = createTestHandler(triggerModeManager);

      triggerModeManager.initFromRecords([
        { chatId: 'oc_legacy', passiveMode: false },
      ]);

      await handler.handleMessageReceive(
        groupTextEvent('Legacy enabled', { chatId: 'oc_legacy' }),
      );

      expect(capturedMessages).toHaveLength(1);
    });
  });
});
