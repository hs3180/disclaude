/**
 * MessageSender - Handles all message sending operations for Feishu bot.
 *
 * This module centralizes message sending logic including:
 * - Text messages
 * - Interactive cards
 * - File uploads
 *
 * Responsibilities:
 * - Unified message sending interface
 * - Error handling and logging
 * - Message history tracking
 */

import * as lark from '@larksuiteoapi/node-sdk';
import { buildTextContent } from './content-builder.js';
import { messageLogger } from './message-logger.js';
import { handleError, ErrorCategory } from '../utils/error-handler.js';
import type { Logger } from 'pino';

export interface MessageSenderConfig {
  client: lark.Client;
  logger: Logger;
}

export class MessageSender {
  private client: lark.Client;
  private logger: Logger;

  constructor(config: MessageSenderConfig) {
    this.client = config.client;
    this.logger = config.logger;
  }

  /**
   * Send a text message to Feishu.
   *
   * @param chatId - Target chat ID
   * @param text - Message text content
   */
  async sendText(chatId: string, text: string): Promise<void> {
    try {
      // Always use plain text format
      // Use content builder utility for consistent message formatting
      const response = await this.client.im.message.create({
        params: {
          receive_id_type: 'chat_id',
        },
        data: {
          receive_id: chatId,
          msg_type: 'text',
          content: buildTextContent(text),
        },
      });

      // Track outgoing bot message in history
      // Feishu API returns message_id in response.data.message_id
      const botMessageId = response?.data?.message_id;
      if (botMessageId) {
        // Log to persistent MD file
        await messageLogger.logOutgoingMessage(botMessageId, chatId, text);
      }

      // Defensive: Ensure text is valid before substring
      const safeText = text || '';
      const preview = safeText.length > 100 ? `${safeText.substring(0, 100)}...` : safeText;
      this.logger.debug({ chatId, messageType: 'text', preview, botMessageId }, 'Message sent');
    } catch (error) {
      handleError(error, {
        category: ErrorCategory.API,
        chatId,
        messageType: 'text'
      }, {
        log: true,
        customLogger: this.logger
      });
    }
  }

  /**
   * Send an interactive card message to Feishu.
   * Used for rich content like code diffs, formatted output, etc.
   *
   * @param chatId - Target chat ID
   * @param card - Card JSON structure
   * @param description - Optional description for logging
   */
  async sendCard(
    chatId: string,
    card: Record<string, unknown>,
    description?: string
  ): Promise<void> {
    try {
      await this.client.im.message.create({
        params: {
          receive_id_type: 'chat_id',
        },
        data: {
          receive_id: chatId,
          msg_type: 'interactive',
          content: JSON.stringify(card),
        },
      });

      const desc = description ? ` (${description})` : '';
      this.logger.debug({ chatId, description: desc }, 'Card sent');
    } catch (error) {
      handleError(error, {
        category: ErrorCategory.API,
        chatId,
        description,
        messageType: 'card'
      }, {
        log: true,
        customLogger: this.logger
      });
    }
  }

  /**
   * Send a file to Feishu user as an attachment.
   * Uploads the file and sends it as a file message.
   *
   * @param chatId - Target chat ID
   * @param filePath - Local file path to send
   */
  async sendFile(chatId: string, filePath: string): Promise<void> {
    try {
      const { uploadAndSendFile } = await import('./file-uploader.js');
      const fileSize = await uploadAndSendFile(this.client, filePath, chatId);
      this.logger.info({ chatId, filePath, fileSize }, 'File sent to user');
    } catch (error) {
      this.logger.error({ err: error, filePath, chatId }, 'Failed to send file to user');
      // Don't throw - file sending failure shouldn't break the main flow
    }
  }

  /**
   * Add a reaction emoji to a message.
   * Used to provide instant feedback when the bot starts processing a message.
   *
   * @param messageId - The message ID to add reaction to
   * @param emoji - Emoji type (e.g., 'Keyboard', 'Robot', 'CheckMark')
   * @returns true if successful, false otherwise
   */
  async addReaction(messageId: string, emoji: string): Promise<boolean> {
    try {
      await this.client.im.messageReaction.create({
        path: {
          message_id: messageId,
        },
        data: {
          reaction_type: {
            emoji_type: emoji,
          },
        },
      });

      this.logger.debug({ messageId, emoji }, 'Reaction added');
      return true;
    } catch (error) {
      // Log error but don't throw - reaction failure shouldn't break message processing
      this.logger.warn({ err: error, messageId, emoji }, 'Failed to add reaction');
      return false;
    }
  }
}
