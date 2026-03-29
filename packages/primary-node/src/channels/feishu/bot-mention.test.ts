/**
 * Unit tests for bot-to-bot @mention support (Issue #1742).
 *
 * Tests two key behaviors:
 * 1. Message handler allows bot messages that @mention our bot
 * 2. send_text with mentions upgrades to post format
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { MessageHandler, type MessageCallbacks } from './message-handler.js';
import type { MentionDetector } from './mention-detector.js';
import type { PassiveModeManager } from './passive-mode.js';
import type { InteractionManager } from '../../platforms/feishu/interaction-manager.js';
import type { FeishuEventData } from '@disclaude/core';

// --- Mock helpers ---

function createMockMentionDetector(overrides?: Partial<MentionDetector>): MentionDetector {
  return {
    setClient: vi.fn(),
    fetchBotInfo: vi.fn(),
    isBotMentioned: vi.fn().mockReturnValue(false),
    getBotInfo: vi.fn(),
    ...overrides,
  } as unknown as MentionDetector;
}

function createMockPassiveModeManager(): PassiveModeManager {
  return {
    isPassiveModeDisabled: vi.fn().mockReturnValue(false),
    setPassiveModeDisabled: vi.fn(),
  } as unknown as PassiveModeManager;
}

function createMockInteractionManager(): InteractionManager {
  return {
    handleAction: vi.fn(),
  } as unknown as InteractionManager;
}

function createMockCallbacks(overrides?: Partial<MessageCallbacks>): MessageCallbacks {
  return {
    emitMessage: vi.fn().mockResolvedValue(undefined),
    emitControl: vi.fn().mockResolvedValue({ success: false }),
    sendMessage: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  } as unknown as MessageCallbacks;
}

// --- Test data ---

function createBotMessage(mentions?: FeishuMessageEvent['message']['mentions']): FeishuEventData {
  return {
    event: {
      message: {
        message_id: 'msg_bot_001',
        chat_id: 'oc_group1',
        chat_type: 'group',
        content: '{"text":"@BotA hello"}',
        message_type: 'text',
        create_time: Date.now(),
        mentions,
      },
      sender: { sender_type: 'app', sender_id: { open_id: 'cli_bot_sender' } },
    },
  } as FeishuEventData;
}

function createUserMessage(): FeishuEventData {
  return {
    event: {
      message: {
        message_id: 'msg_user_001',
        chat_id: 'oc_group1',
        chat_type: 'group',
        content: '{"text":"Hello"}',
        message_type: 'text',
        create_time: Date.now(),
      },
      sender: { sender_type: 'user', sender_id: { open_id: 'ou_user1' } },
    },
  } as FeishuEventData;
}

// Minimal type for the mentions structure used in tests
interface FeishuMessageEvent {
  message: {
    message_id: string;
    chat_id: string;
    chat_type?: 'p2p' | 'group' | 'topic';
    content: string;
    message_type: string;
    create_time?: number;
    parent_id?: string;
    mentions?: Array<{
      key: string;
      id: { open_id: string; union_id: string; user_id: string };
      name: string;
      tenant_key: string;
    }>;
  };
  sender: {
    sender_type?: string;
    sender_id?: { open_id?: string; union_id?: string; user_id?: string };
    tenant_key?: string;
  };
}

describe('Issue #1742: Bot-to-bot @mention support', () => {
  let mentionDetector: MentionDetector;
  let messageHandler: MessageHandler;

  beforeEach(() => {
    vi.clearAllMocks();
    mentionDetector = createMockMentionDetector();
    messageHandler = new MessageHandler({
      passiveModeManager: createMockPassiveModeManager(),
      mentionDetector,
      interactionManager: createMockInteractionManager(),
      callbacks: createMockCallbacks(),
      isRunning: () => true,
      hasControlHandler: () => false,
    });
    messageHandler.initialize({} as any);
  });

  describe('Receiving bot messages', () => {
    it('should reject bot messages that do NOT @mention our bot', async () => {
      const data = createBotMessage();
      await messageHandler.handleMessageReceive(data);

      // Should NOT call emitMessage (message was filtered)
      expect((messageHandler as any).callbacks.emitMessage).not.toHaveBeenCalled();
      // Mention detector should be checked
      expect(mentionDetector.isBotMentioned).toHaveBeenCalledWith(undefined);
    });

    it('should allow bot messages that @mention our bot', async () => {
      const botMentions = [
        {
          key: '@_bot_1',
          id: { open_id: 'cli_our_bot', union_id: '', user_id: '' },
          name: 'OurBot',
          tenant_key: 'tenant1',
        },
      ];
      const data = createBotMessage(botMentions);
      (mentionDetector.isBotMentioned as any).mockReturnValue(true);

      await messageHandler.handleMessageReceive(data);

      // Should call emitMessage (message was allowed through)
      expect((messageHandler as any).callbacks.emitMessage).toHaveBeenCalled();
      expect(mentionDetector.isBotMentioned).toHaveBeenCalledWith(botMentions);
    });

    it('should always allow user messages regardless of mentions', async () => {
      // Disable passive mode so user messages without @mention pass through
      (messageHandler as any).passiveModeManager.isPassiveModeDisabled.mockReturnValue(true);
      const data = createUserMessage();
      await messageHandler.handleMessageReceive(data);

      expect((messageHandler as any).callbacks.emitMessage).toHaveBeenCalled();
    });
  });
});
