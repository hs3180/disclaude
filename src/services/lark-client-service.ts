/**
 * Lark Client Service - Unified Lark SDK Client Management.
 *
 * This service provides a single entry point for all Feishu/Lark API calls,
 * ensuring consistent configuration, logging, and resource management.
 *
 * Issue #1032: Refactor Lark SDK Client management
 */

import * as lark from '@larksuiteoapi/node-sdk';
import { createLogger } from '../utils/logger.js';
import { createFeishuClient, CreateFeishuClientOptions } from '../platforms/feishu/create-feishu-client.js';
import { buildTextContent } from '../platforms/feishu/card-builders/content-builder.js';
import { messageLogger } from '../feishu/message-logger.js';
import { retry } from '../utils/retry.js';
import { handleError, ErrorCategory } from '../utils/error-handler.js';
import path from 'path';

const logger = createLogger('LarkClientService');

/**
 * Bot information returned by getBotInfo.
 */
export interface BotInfo {
  /** Bot's open ID */
  openId: string;
  /** Bot's name */
  name?: string;
  /** Bot's avatar URL */
  avatarUrl?: string;
}

/**
 * File upload result.
 */
export interface FileUploadResult {
  /** File key for message attachment */
  fileKey: string;
  /** File type (image, file, video, audio) */
  fileType: string;
  /** Original file name */
  fileName: string;
  /** File size in bytes */
  fileSize: number;
}

/**
 * Options for sending messages.
 */
export interface SendMessageOptions {
  /** Thread ID for threaded replies */
  threadId?: string;
  /** Description for card messages */
  description?: string;
}

/**
 * LarkClientService Configuration.
 */
export interface LarkClientServiceConfig {
  /** Feishu App ID */
  appId: string;
  /** Feishu App Secret */
  appSecret: string;
  /** Optional client creation options */
  clientOptions?: CreateFeishuClientOptions;
}

/**
 * Lark Client Service.
 *
 * Provides unified access to Lark/Feishu API with:
 * - Single client instance management
 * - Consistent retry logic
 * - Centralized logging
 * - Resource reuse
 */
export class LarkClientService {
  private client: lark.Client;
  private botInfo: BotInfo | null = null;

  constructor(config: LarkClientServiceConfig) {
    logger.info({ appId: config.appId }, 'Initializing LarkClientService');
    this.client = createFeishuClient(config.appId, config.appSecret, config.clientOptions);
  }

  /**
   * Get the underlying Lark Client instance.
   * Use this for advanced operations not covered by the service methods.
   */
  getClient(): lark.Client {
    return this.client;
  }

  /**
   * Send a text message to a chat.
   *
   * @param chatId - Target chat ID
   * @param text - Message text content
   * @param options - Optional send options (threadId)
   */
  async sendMessage(chatId: string, text: string, options?: SendMessageOptions): Promise<void> {
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

      if (options?.threadId) {
        messageData.parent_id = options.threadId;
      }

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
            logger.warn(
              { chatId, attempt, error: error.message },
              'Retrying sendMessage after failure'
            );
          },
        }
      );

      const botMessageId = response?.data?.message_id;
      if (botMessageId) {
        await messageLogger.logOutgoingMessage(botMessageId, chatId, text);
      }

      const safeText = text || '';
      const preview = safeText.length > 100 ? `${safeText.substring(0, 100)}...` : safeText;
      logger.debug(
        { chatId, messageType: 'text', preview, botMessageId, threadId: options?.threadId },
        'Message sent'
      );
    } catch (error) {
      handleError(
        error,
        { category: ErrorCategory.API, chatId, messageType: 'text' },
        { log: true, customLogger: logger }
      );
    }
  }

  /**
   * Send an interactive card message to a chat.
   *
   * @param chatId - Target chat ID
   * @param card - Card JSON object
   * @param options - Optional send options (threadId, description)
   */
  async sendCard(
    chatId: string,
    card: Record<string, unknown>,
    options?: SendMessageOptions
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

      if (options?.threadId) {
        messageData.parent_id = options.threadId;
      }

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
            logger.warn(
              { chatId, attempt, error: error.message },
              'Retrying sendCard after failure'
            );
          },
        }
      );

      const botMessageId = response?.data?.message_id;
      if (botMessageId) {
        const cardContent = options?.description
          ? `[Card] ${options.description}\n\`\`\`json\n${JSON.stringify(card, null, 2)}\n\`\`\``
          : `[Interactive Card]\n\`\`\`json\n${JSON.stringify(card, null, 2)}\n\`\`\``;
        await messageLogger.logOutgoingMessage(botMessageId, chatId, cardContent);
      }

      logger.debug(
        { chatId, description: options?.description, threadId: options?.threadId, botMessageId },
        'Card sent'
      );
    } catch (error) {
      handleError(
        error,
        { category: ErrorCategory.API, chatId, description: options?.description, messageType: 'card' },
        { log: true, customLogger: logger }
      );
    }
  }

  /**
   * Upload a file and send it to a chat.
   *
   * @param chatId - Target chat ID
   * @param filePath - Local file path
   * @param options - Optional send options (threadId)
   * @returns Upload result with file details
   */
  async uploadFile(
    chatId: string,
    filePath: string,
    options?: SendMessageOptions
  ): Promise<FileUploadResult> {
    try {
      // Dynamic import to avoid circular dependencies
      const { uploadAndSendFile } = await import('../file-transfer/outbound/feishu-uploader.js');

      const fileSize = await retry(
        () => uploadAndSendFile(this.client, filePath, chatId, options?.threadId),
        {
          maxRetries: 3,
          initialDelayMs: 1000,
          onRetry: (attempt, error) => {
            logger.warn(
              { chatId, filePath, attempt, error: error.message },
              'Retrying uploadFile after failure'
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

      logger.info({ chatId, filePath, fileSize, threadId: options?.threadId }, 'File sent to user');

      return {
        fileKey: '',
        fileType: 'file',
        fileName,
        fileSize,
      };
    } catch (error) {
      logger.error({ err: error, filePath, chatId, threadId: options?.threadId }, 'Failed to send file to user');
      throw error;
    }
  }

  /**
   * Get bot information.
   * Caches the result after first call.
   *
   * @returns Bot information including openId, name, and avatar
   */
  async getBotInfo(): Promise<BotInfo> {
    if (this.botInfo) {
      return this.botInfo;
    }

    try {
      const response = await retry(
        () => this.client.request({
          method: 'GET',
          url: '/open-apis/bot/v3/info',
        }),
        {
          maxRetries: 3,
          initialDelayMs: 1000,
          onRetry: (attempt, error) => {
            logger.warn({ attempt, error: error.message }, 'Retrying getBotInfo after failure');
          },
        }
      );

      const bot = response.data?.bot;
      if (bot?.open_id) {
        this.botInfo = {
          openId: bot.open_id,
          name: bot.app_name || 'Disclaude Bot',
          avatarUrl: bot.icon_url,
        };
      } else {
        // Fallback to basic bot info
        this.botInfo = {
          openId: 'unknown',
          name: 'Disclaude Bot',
        };
      }

      logger.debug({ botInfo: this.botInfo }, 'Bot info retrieved');
      return this.botInfo;
    } catch (error) {
      logger.error({ err: error }, 'Failed to get bot info');
      throw error;
    }
  }
}
