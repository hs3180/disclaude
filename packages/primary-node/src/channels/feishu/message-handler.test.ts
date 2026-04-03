/**
 * Tests for MessageHandler command processing.
 *
 * Issue #1868: Verifies that system commands (e.g., /passive) do NOT fall through
 * to the AI agent when the control handler is unavailable. Without the fallback,
 * the agent would hallucinate a confirmation response without actually executing
 * the command.
 *
 * Does NOT mock the @larksuiteoapi/node-sdk directly (per CLAUDE.md rules),
 * instead uses dependency-injected mocks via constructor.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { MessageHandler, type MessageCallbacks } from './message-handler.js';
import type { PassiveModeManager } from './passive-mode.js';
import type { MentionDetector } from './mention-detector.js';
import { InteractionManager } from '../../platforms/feishu/interaction-manager.js';

// ─── Mock helpers ──────────────────────────────────────────────────────────

function createMockPassiveModeManager(): PassiveModeManager {
  return {
    isPassiveModeDisabled: vi.fn().mockReturnValue(false),
    setPassiveModeDisabled: vi.fn(),
    getPassiveModeDisabledChats: vi.fn().mockReturnValue([]),
  } as unknown as PassiveModeManager;
}

function createMockMentionDetector(botMentioned = false): MentionDetector {
  return {
    isBotMentioned: vi.fn().mockReturnValue(botMentioned),
    setClient: vi.fn(),
    fetchBotInfo: vi.fn(),
    getBotInfo: vi.fn().mockReturnValue(null),
  } as unknown as MentionDetector;
}

function createMockInteractionManager(): InteractionManager {
  return {
    handleAction: vi.fn().mockResolvedValue(undefined),
    dispose: vi.fn(),
  } as unknown as InteractionManager;
}

interface SentMessage {
  chatId: string;
  type: string;
  text?: string;
  card?: Record<string, unknown>;
}

interface EmittedMessage {
  messageId: string;
  chatId: string;
  content: string;
  messageType: string;
}

function createTestFixtures() {
  const sentMessages: SentMessage[] = [];
  const emittedMessages: EmittedMessage[] = [];

  const callbacks: MessageCallbacks = {
    emitMessage: vi.fn().mockImplementation(async (msg: EmittedMessage) => {
      emittedMessages.push(msg);
    }),
    emitControl: vi.fn().mockResolvedValue({ success: false }),
    sendMessage: vi.fn().mockImplementation(async (msg: SentMessage) => {
      sentMessages.push(msg);
    }),
  };

  return {
    callbacks,
    sentMessages,
    emittedMessages,
    getSentText: () => sentMessages.map((m) => m.text).join('\n'),
    getEmittedContent: () => emittedMessages.map((m) => m.content).join('\n'),
  };
}

/**
 * Build a minimal Feishu message event for testing command processing.
 */
function createMessageEvent(overrides: {
  text?: string;
  chatType?: string;
  chatId?: string;
  messageId?: string;
  mentions?: Array<{ key: string; id: { open_id: string }; name: string }>;
  createTime?: number;
} = {}) {
  const {
    text = '/passive off',
    chatType = 'group',
    chatId = 'test-chat-id',
    messageId = 'test-msg-id',
    mentions,
    createTime = Date.now(),
  } = overrides;

  const mentionList = mentions ?? (chatType === 'group' ? [
    {
      key: '@_user_1',
      id: { open_id: 'bot-open-id' },
      name: 'Bot',
    },
  ] : []);

  return {
    sender: { sender_type: 'user', sender_id: { open_id: 'user-open-id' } },
    message: {
      message_id: messageId,
      chat_id: chatId,
      chat_type: chatType,
      content: JSON.stringify({ text }),
      message_type: 'text',
      create_time: createTime,
      mentions: mentionList,
      parent_id: undefined,
    },
  };
}

// ─── Tests ─────────────────────────────────────────────────────────────────

describe('MessageHandler command processing', () => {
  let passiveModeManager: PassiveModeManager;
  let mentionDetector: MentionDetector;
  let interactionManager: InteractionManager;
  let fixtures: ReturnType<typeof createTestFixtures>;
  let messageIdCounter: number;

  beforeEach(() => {
    vi.clearAllMocks();
    messageIdCounter = 0;
    passiveModeManager = createMockPassiveModeManager();
    mentionDetector = createMockMentionDetector(true);
    interactionManager = createMockInteractionManager();
    fixtures = createTestFixtures();
  });

  /** Generate a unique message ID to avoid dedup filtering across tests */
  function uniqueMessageId(): string {
    return `test-msg-${Date.now()}-${++messageIdCounter}-${Math.random().toString(36).slice(2, 6)}`;
  }

  function createHandler(
    hasControlHandler = false,
    botMentioned = true,
  ): MessageHandler {
    mentionDetector = createMockMentionDetector(botMentioned);
    const handler = new MessageHandler({
      passiveModeManager,
      mentionDetector,
      interactionManager,
      callbacks: fixtures.callbacks,
      isRunning: () => true,
      hasControlHandler: () => hasControlHandler,
    });
    // Initialize with a mock client (required for typing reactions, etc.)
    handler.initialize({} as Parameters<MessageHandler['initialize']>[0]);
    return handler;
  }

  describe('/passive command fallback (Issue #1868)', () => {
    it('should NOT fall through to agent when controlHandler is unavailable', async () => {
      const handler = createHandler(false, true);
      const event = createMessageEvent({ text: '@Bot /passive off', messageId: uniqueMessageId() });

      await handler.handleMessageReceive(event as any);

      // Should send a fallback message, NOT emit to agent
      expect(fixtures.callbacks.sendMessage).toHaveBeenCalled();
      expect(fixtures.getSentText()).toContain('不可用');
      expect(fixtures.callbacks.emitMessage).not.toHaveBeenCalled();
    });

    it('should fall through to agent for non-command text', async () => {
      const handler = createHandler(false, true);
      const event = createMessageEvent({ text: '@Bot hello world', messageId: uniqueMessageId() });

      await handler.handleMessageReceive(event as any);

      // Non-command text should be emitted to agent
      expect(fixtures.callbacks.emitMessage).toHaveBeenCalled();
      expect(fixtures.getEmittedContent()).toContain('hello world');
    });

    it('should delegate to controlHandler when available', async () => {
      const handler = createHandler(true, true);
      fixtures.callbacks.emitControl = vi.fn().mockResolvedValue({
        success: true,
        message: '🔔 被动模式已关闭',
      });

      const event = createMessageEvent({ text: '@Bot /passive off', messageId: uniqueMessageId() });
      await handler.handleMessageReceive(event as any);

      // Should use control handler, not fallback
      expect(fixtures.callbacks.emitControl).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'passive' }),
      );
      expect(fixtures.callbacks.sendMessage).toHaveBeenCalled();
      expect(fixtures.getSentText()).toContain('被动模式已关闭');
      expect(fixtures.callbacks.emitMessage).not.toHaveBeenCalled();
    });

    it('should handle /passive on via fallback', async () => {
      const handler = createHandler(false, true);
      const event = createMessageEvent({ text: '@Bot /passive on', messageId: uniqueMessageId() });

      await handler.handleMessageReceive(event as any);

      expect(fixtures.callbacks.sendMessage).toHaveBeenCalled();
      expect(fixtures.getSentText()).toContain('不可用');
      expect(fixtures.callbacks.emitMessage).not.toHaveBeenCalled();
    });

    it('should handle /passive (no args) via fallback', async () => {
      const handler = createHandler(false, true);
      const event = createMessageEvent({ text: '@Bot /passive', messageId: uniqueMessageId() });

      await handler.handleMessageReceive(event as any);

      expect(fixtures.callbacks.sendMessage).toHaveBeenCalled();
      expect(fixtures.getSentText()).toContain('不可用');
      expect(fixtures.callbacks.emitMessage).not.toHaveBeenCalled();
    });
  });

  describe('existing fallback commands', () => {
    it('should handle /reset via fallback when controlHandler unavailable', async () => {
      const handler = createHandler(false, true);
      const event = createMessageEvent({ text: '@Bot /reset', messageId: uniqueMessageId() });

      await handler.handleMessageReceive(event as any);

      expect(fixtures.callbacks.sendMessage).toHaveBeenCalled();
      expect(fixtures.getSentText()).toContain('重置');
      expect(fixtures.callbacks.emitMessage).not.toHaveBeenCalled();
    });

    it('should handle /status via fallback when controlHandler unavailable', async () => {
      const handler = createHandler(false, true);
      const event = createMessageEvent({ text: '@Bot /status', messageId: uniqueMessageId() });

      await handler.handleMessageReceive(event as any);

      expect(fixtures.callbacks.sendMessage).toHaveBeenCalled();
      expect(fixtures.getSentText()).toContain('状态');
      expect(fixtures.callbacks.emitMessage).not.toHaveBeenCalled();
    });

    it('should handle /stop via fallback when controlHandler unavailable', async () => {
      const handler = createHandler(false, true);
      const event = createMessageEvent({ text: '@Bot /stop', messageId: uniqueMessageId() });

      await handler.handleMessageReceive(event as any);

      expect(fixtures.callbacks.sendMessage).toHaveBeenCalled();
      expect(fixtures.getSentText()).toContain('停止');
      expect(fixtures.callbacks.emitMessage).not.toHaveBeenCalled();
    });
  });
});
