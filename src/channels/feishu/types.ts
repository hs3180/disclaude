/**
 * Feishu Channel Types.
 *
 * Type definitions specific to Feishu channel implementation.
 * Extracted from feishu-channel.ts for Issue #694.
 */

import type { FeishuMessageEvent } from '../../types/platform.js';

/**
 * Bot information for mention detection.
 * Issue #600: Correctly identify bot mentions in group chats
 * Issue #681: 群聊被动模式 @机器人检测不可靠问题
 */
export interface BotInfo {
  open_id: string;
  app_id: string;
}

/**
 * Message context passed to message handler.
 */
export interface MessageContext {
  messageId: string;
  chatId: string;
  chatType?: string;
  content: string;
  messageType: string;
  createTime?: number;
  mentions?: FeishuMessageEvent['message']['mentions'];
  threadId: string;
  senderOpenId?: string;
}

/**
 * Card action context.
 */
export interface CardActionContext {
  messageId: string;
  chatId: string;
  action: {
    type: string;
    value: string;
    text?: string;
    trigger?: string;
  };
  userId?: string;
}

/**
 * Dependencies for message handler.
 */
export interface MessageHandlerDeps {
  isRunning: boolean;
  getClient: () => unknown;
  extractOpenId: (sender?: { sender_type?: string; sender_id?: unknown }) => string | undefined;
  addTypingReaction: (messageId: string) => Promise<void>;
  sendMessage: (message: { chatId: string; type: string; text?: string; card?: unknown }) => Promise<void>;
  emitMessage: (message: {
    messageId: string;
    chatId: string;
    userId?: string;
    content: string;
    messageType: string;
    timestamp?: number;
    threadId?: string;
    metadata?: Record<string, unknown>;
    attachments?: Array<{ fileName: string; filePath: string; mimeType?: string }>;
  }) => Promise<void>;
  emitControl: (control: { type: string; chatId: string; data: unknown }) => Promise<{ success: boolean; message?: string }>;
  forwardFilteredMessage: (
    reason: string,
    messageId: string,
    chatId: string,
    content: string,
    userId?: string,
    metadata?: Record<string, unknown>
  ) => Promise<void>;
  getChatHistoryContext: (chatId: string) => Promise<string | undefined>;
  isGroupChat: (chatType?: string) => boolean;
  isPassiveModeDisabled: (chatId: string) => boolean;
  isBotMentioned: (mentions?: FeishuMessageEvent['message']['mentions']) => boolean;
  controlHandler?: unknown;
}

/**
 * Dependencies for card action handler.
 */
export interface CardActionHandlerDeps {
  isRunning: boolean;
  sendMessage: (message: { chatId: string; type: string; text: string }) => Promise<void>;
  emitMessage: (message: {
    messageId: string;
    chatId: string;
    userId?: string;
    content: string;
    messageType: string;
    timestamp: number;
    metadata?: Record<string, unknown>;
  }) => Promise<void>;
  interactionManager: {
    handleAction: (
      event: unknown,
      defaultHandler: (event: unknown) => Promise<void>
    ) => Promise<boolean>;
  };
}
