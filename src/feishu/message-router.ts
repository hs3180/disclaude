/**
 * MessageContext - Encapsulates Feishu message data.
 *
 * Provides a clean interface for message validation and routing.
 */

import { messageLogger } from './message-logger.js';
import { DEDUPLICATION } from '../config/constants.js';
import type { Logger } from 'pino';

export interface MessageContext {
  readonly messageId: string;
  readonly chatId: string;
  readonly messageType: string;
  readonly content: string;
  readonly sender?: {
    sender_type?: string;
    sender_id?: {
      open_id?: string;
      union_id?: string;
      user_id?: string;
    };
  };
  readonly createTime: number;
}

export interface MessageValidationResult {
  valid: boolean;
  reason?: string;
}

export class MessageContextFactory {
  /**
   * Create MessageContext from Feishu WebSocket message data.
   */
  static fromFeishuMessage(data: any, logger: Logger): MessageContext | null {
    const { message } = data;
    if (!message) {
      logger.warn('Missing message object');
      return null;
    }

    const { message_id, chat_id, content, message_type, sender, create_time } = message;

    return {
      messageId: message_id,
      chatId: chat_id,
      messageType: message_type,
      content: content || '',
      sender: sender,
      createTime: create_time || Date.now(),
    };
  }

  /**
   * Validate message context.
   */
  static validate(ctx: MessageContext, logger: Logger): MessageValidationResult {
    if (!ctx.messageId) {
      logger.warn('Missing message_id in message');
      return { valid: false, reason: 'Missing message_id' };
    }

    if (!ctx.chatId) {
      logger.warn('Missing chat_id in message');
      return { valid: false, reason: 'Missing chat_id' };
    }

    if (!ctx.content) {
      logger.warn('Missing content in message');
      return { valid: false, reason: 'Missing content' };
    }

    if (!ctx.messageType) {
      logger.warn('Missing message_type in message');
      return { valid: false, reason: 'Missing message_type' };
    }

    return { valid: true };
  }
}

export class MessageRouter {
  private logger: Logger;
  private maxMessageAge: number;

  constructor(logger: Logger) {
    this.logger = logger;
    this.maxMessageAge = DEDUPLICATION.MAX_MESSAGE_AGE;
  }

  /**
   * Route message to appropriate handler based on validation and type checks.
   * Returns handler type: 'task' | 'direct' | 'file' | 'skip'
   */
  async route(
    ctx: MessageContext,
    _handlers: {
      handleTaskFlow: (chatId: string, text: string, messageId: string, sender?: any) => Promise<void>;
      handleDirectChat: (chatId: string, text: string, messageId: string) => Promise<void>;
      handleFileMessage: (chatId: string, messageType: string, content: string, messageId: string, sender?: any) => Promise<void>;
    }
  ): Promise<'task' | 'direct' | 'file' | 'skip'> {
    const { messageId, messageType, sender, createTime } = ctx;

    // Log message structure
    this.logger.debug({ keys: ['messageId', 'chatId', 'messageType'], messageId, createTime }, 'Message keys');

    // Deduplication check
    this.logger.debug({ messageId }, 'Checking deduplication');
    if (messageLogger.isMessageProcessed(messageId)) {
      this.logger.debug({ messageId }, 'Skipped duplicate message');
      return 'skip';
    }

    // Sender check - ignore bot's own messages
    this.logger.debug('Checking sender type');
    if (sender?.sender_type === 'app') {
      this.logger.debug({ senderType: sender.sender_type }, 'Skipped bot message');
      return 'skip';
    }

    // Message age check
    this.logger.debug('Checking message age');
    const messageAge = Date.now() - createTime;
    this.logger.debug({ ageMs: messageAge, maxAgeMs: this.maxMessageAge }, 'Message age');

    if (messageAge > this.maxMessageAge) {
      const ageSeconds = Math.floor(messageAge / 1000);
      this.logger.debug({ messageId, ageSeconds }, 'Skipped old message');
      return 'skip';
    }

    // File/image messages
    if (messageType === 'image' || messageType === 'file' || messageType === 'media') {
      return 'file';
    }

    // Text and post messages only
    if (messageType !== 'text' && messageType !== 'post') {
      this.logger.debug({ messageType }, 'Skipped unsupported message type');
      return 'skip';
    }

    return 'direct' as const;
  }
}
