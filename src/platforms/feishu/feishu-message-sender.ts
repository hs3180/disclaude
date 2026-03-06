/**
 * Feishu Message Sender Implementation.
 *
 * Implements IMessageSender interface for Feishu/Lark platform.
 * Handles text, card, and file messages via Feishu API.
 */

import * as lark from '@larksuiteoapi/node-sdk';
import path from 'path';
import type { Logger } from 'pino';
import type { IMessageSender } from '../../channels/adapters/types.js';
import { handleError, ErrorCategory } from '../../utils/error-handler.js';
import { buildTextContent } from './card-builders/content-builder.js';
import { messageLogger } from '../../feishu/message-logger.js';
import { retry } from '../../utils/retry.js';
import { ttfrMetrics } from '../../utils/ttfr-metrics.js';

/**
 * Feishu Message Sender Configuration.
 */
export interface FeishuMessageSenderConfig {
  /** Feishu API client */
  client: lark.Client;
  /** Logger instance */
  logger: Logger;
}

/**
 * Feishu Message Sender.
 *
 * Implements platform-agnostic IMessageSender interface for Feishu.
 */
export class FeishuMessageSender implements IMessageSender {
  private client: lark.Client;
  private logger: Logger;

  constructor(config: FeishuMessageSenderConfig) {
    this.client = config.client;
    this.logger = config.logger;
  }

  async sendText(chatId: string, text: string, threadId?: string): Promise<void> {
    try {
      const messageData: {
        receive_id: string;
        msg_type: string;
        content: string;
        parent_id?: string;
      } = {
        receive_id: chatId,
        msg_type: 'text',
        content: buildTextContent(text),
      };

      if (threadId) {
        messageData.parent_id = threadId;
      }

      // Use retry for network resilience (Issue #498)
      const response = await retry(
        () => this.client.im.message.create({
          params: {
            receive_id_type: 'chat_id',
          },
          data: messageData,
        }),
        {
          maxRetries: 3,
          initialDelayMs: 1000,
          onRetry: (attempt, error) => {
            this.logger.warn(
              { chatId, attempt, error: error.message },
              'Retrying sendText after failure'
            );
          },
        }
      );

      const botMessageId = response?.data?.message_id;
      if (botMessageId) {
        await messageLogger.logOutgoingMessage(botMessageId, chatId, text);
      }

      // Record TTFR metric (Issue #855)
      ttfrMetrics.recordResponse(chatId, botMessageId);

      const safeText = text || '';
      const preview = safeText.length > 100 ? `${safeText.substring(0, 100)}...` : safeText;
      this.logger.debug(
        { chatId, messageType: 'text', preview, botMessageId, threadId },
        'Message sent'
      );
    } catch (error) {
      handleError(
        error,
        { category: ErrorCategory.API, chatId, messageType: 'text' },
        { log: true, customLogger: this.logger }
      );
    }
  }

  async sendCard(
    chatId: string,
    card: Record<string, unknown>,
    description?: string,
    threadId?: string
  ): Promise<void> {
    try {
      const messageData: {
        receive_id: string;
        msg_type: string;
        content: string;
        parent_id?: string;
      } = {
        receive_id: chatId,
        msg_type: 'interactive',
        content: JSON.stringify(card),
      };

      if (threadId) {
        messageData.parent_id = threadId;
      }

      // Use retry for network resilience (Issue #498)
      const response = await retry(
        () => this.client.im.message.create({
          params: {
            receive_id_type: 'chat_id',
          },
          data: messageData,
        }),
        {
          maxRetries: 3,
          initialDelayMs: 1000,
          onRetry: (attempt, error) => {
            this.logger.warn(
              { chatId, attempt, error: error.message },
              'Retrying sendCard after failure'
            );
          },
        }
      );

      const botMessageId = response?.data?.message_id;
      if (botMessageId) {
        const cardContent = description
          ? `[Card] ${description}\n\`\`\`json\n${JSON.stringify(card, null, 2)}\n\`\`\``
          : `[Interactive Card]\n\`\`\`json\n${JSON.stringify(card, null, 2)}\n\`\`\``;
        await messageLogger.logOutgoingMessage(botMessageId, chatId, cardContent);
      }

      // Record TTFR metric (Issue #855)
      ttfrMetrics.recordResponse(chatId, botMessageId);

      const desc = description ? ` (${description})` : '';
      this.logger.debug({ chatId, description: desc, threadId, botMessageId }, 'Card sent');
    } catch (error) {
      handleError(
        error,
        { category: ErrorCategory.API, chatId, description, messageType: 'card' },
        { log: true, customLogger: this.logger }
      );
    }
  }

  async sendFile(chatId: string, filePath: string, threadId?: string): Promise<void> {
    try {
      const { uploadAndSendFile } = await import('../../file-transfer/outbound/feishu-uploader.js');

      // Use retry for network resilience (Issue #498)
      const fileSize = await retry(
        () => uploadAndSendFile(this.client, filePath, chatId, threadId),
        {
          maxRetries: 3,
          initialDelayMs: 1000,
          onRetry: (attempt, error) => {
            this.logger.warn(
              { chatId, filePath, attempt, error: error.message },
              'Retrying sendFile after failure'
            );
          },
        }
      );

      const fileName = path.basename(filePath);
      const fileContent = `[File] ${fileName}\nPath: ${filePath}`;
      await messageLogger.logOutgoingMessage(
        `file_${Date.now()}`,
        chatId,
        fileContent
      );

      // Record TTFR metric (Issue #855)
      ttfrMetrics.recordResponse(chatId);

      this.logger.info({ chatId, filePath, fileSize, threadId }, 'File sent to user');
    } catch (error) {
      this.logger.error({ err: error, filePath, chatId, threadId }, 'Failed to send file to user');
    }
  }

  async addReaction(messageId: string, emoji: string): Promise<boolean> {
    try {
      // Use retry for network resilience (Issue #498)
      await retry(
        () => this.client.im.messageReaction.create({
          path: {
            message_id: messageId,
          },
          data: {
            reaction_type: {
              emoji_type: emoji,
            },
          },
        }),
        {
          maxRetries: 3,
          initialDelayMs: 500, // Shorter delay for reactions
          onRetry: (attempt, error) => {
            this.logger.warn(
              { messageId, emoji, attempt, error: error.message },
              'Retrying addReaction after failure'
            );
          },
        }
      );

      this.logger.debug({ messageId, emoji }, 'Reaction added');
      return true;
    } catch (error) {
      this.logger.warn({ err: error, messageId, emoji }, 'Failed to add reaction');
      return false;
    }
  }
}
