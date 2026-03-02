/**
 * Message Adapter Service - Multi-channel message sending.
 *
 * This service provides a unified interface for sending messages
 * across different channels (Feishu, CLI, REST). It uses the
 * ChatChannelRegistry to determine the correct adapter for each chatId.
 *
 * @see Issue #445
 */

import * as lark from '@larksuiteoapi/node-sdk';
import { createLogger } from '../utils/logger.js';
import { Config } from '../config/index.js';
import { ChatChannelRegistry, type ChannelType } from './chat-channel-registry.js';

const logger = createLogger('MessageAdapterService');

/**
 * Result of a message send operation.
 */
export interface MessageSendResult {
  success: boolean;
  message: string;
  error?: string;
  /** Additional data (e.g., messageId for cards) */
  data?: Record<string, unknown>;
}

/**
 * Message content types.
 */
export type MessageFormat = 'text' | 'card';

/**
 * Channel adapter interface for message sending.
 */
export interface IChannelMessageAdapter {
  /** Channel type this adapter handles */
  readonly channelType: ChannelType;

  /**
   * Send a text message.
   */
  sendText(chatId: string, content: string, parentId?: string): Promise<MessageSendResult>;

  /**
   * Send a card message.
   */
  sendCard(chatId: string, card: Record<string, unknown>, parentId?: string): Promise<MessageSendResult>;

  /**
   * Send a file.
   */
  sendFile?(chatId: string, filePath: string): Promise<MessageSendResult>;

  /**
   * Update an existing card.
   */
  updateCard?(chatId: string, messageId: string, card: Record<string, unknown>): Promise<MessageSendResult>;

  /**
   * Check if this adapter supports the given operation.
   */
  supports?(operation: 'file' | 'card' | 'cardUpdate'): boolean;
}

/**
 * CLI Channel Adapter - Handles CLI mode messages.
 */
export class CliChannelAdapter implements IChannelMessageAdapter {
  readonly channelType: ChannelType = 'cli';

  async sendText(chatId: string, content: string, _parentId?: string): Promise<MessageSendResult> {
    logger.info({ chatId, contentPreview: content.substring(0, 100) }, 'CLI: Text message');
    console.log(`\n${content}\n`);
    return { success: true, message: '✅ Message displayed (CLI mode)' };
  }

  async sendCard(chatId: string, card: Record<string, unknown>, _parentId?: string): Promise<MessageSendResult> {
    const cardStr = JSON.stringify(card, null, 2);
    logger.info({ chatId, cardPreview: cardStr.substring(0, 100) }, 'CLI: Card message');
    console.log(`\n[Card]\n${cardStr}\n`);
    return { success: true, message: '✅ Card displayed (CLI mode)' };
  }

  async sendFile(chatId: string, filePath: string): Promise<MessageSendResult> {
    logger.info({ chatId, filePath }, 'CLI: File (simulated)');
    console.log(`\n[File] ${filePath}\n`);
    return { success: true, message: `✅ File noted (CLI mode): ${filePath}` };
  }

  async updateCard(chatId: string, messageId: string, _card: Record<string, unknown>): Promise<MessageSendResult> {
    logger.info({ chatId, messageId }, 'CLI: Card update (simulated)');
    return { success: true, message: '✅ Card updated (CLI mode)' };
  }

  supports(_operation: 'file' | 'card' | 'cardUpdate'): boolean {
    return true; // CLI supports all operations in simulation mode
  }
}

/**
 * REST Channel Adapter - Handles REST API messages.
 *
 * Note: REST channel handles message routing internally via RestChannel.
 * This adapter provides a compatible interface but actual message delivery
 * is managed by the RestChannel's response mechanism.
 */
export class RestChannelAdapter implements IChannelMessageAdapter {
  readonly channelType: ChannelType = 'rest';

  async sendText(chatId: string, content: string, _parentId?: string): Promise<MessageSendResult> {
    // REST channel handles responses through the sync/stream mechanism
    // This adapter is mainly for compatibility
    logger.debug({ chatId, contentPreview: content.substring(0, 100) }, 'REST: Text message');
    return {
      success: true,
      message: '✅ Message queued (REST channel handles delivery)',
    };
  }

  async sendCard(chatId: string, _card: Record<string, unknown>, _parentId?: string): Promise<MessageSendResult> {
    logger.debug({ chatId }, 'REST: Card message');
    return {
      success: true,
      message: '✅ Card queued (REST channel handles delivery)',
    };
  }

  async sendFile(chatId: string, filePath: string): Promise<MessageSendResult> {
    logger.debug({ chatId, filePath }, 'REST: File');
    return {
      success: true,
      message: '✅ File queued (REST channel handles delivery)',
    };
  }

  supports(_operation: 'file' | 'card' | 'cardUpdate'): boolean {
    return true; // REST supports all operations
  }
}

/**
 * Feishu Channel Adapter - Handles Feishu API messages.
 */
export class FeishuChannelAdapter implements IChannelMessageAdapter {
  readonly channelType: ChannelType = 'feishu';
  private client: lark.Client;

  constructor() {
    const appId = Config.FEISHU_APP_ID;
    const appSecret = Config.FEISHU_APP_SECRET;

    if (!appId || !appSecret) {
      throw new Error('FEISHU_APP_ID and FEISHU_APP_SECRET must be configured');
    }

    this.client = new lark.Client({
      appId,
      appSecret,
      domain: lark.Domain.Feishu,
    });
  }

  /**
   * Check if content is a valid Feishu interactive card structure.
   */
  private isValidFeishuCard(content: Record<string, unknown>): boolean {
    return (
      typeof content === 'object' &&
      content !== null &&
      'config' in content &&
      'header' in content &&
      'elements' in content &&
      Array.isArray(content.elements) &&
      typeof content.header === 'object' &&
      content.header !== null &&
      'title' in content.header
    );
  }

  /**
   * Get detailed validation error for an invalid card.
   */
  private getCardValidationError(content: unknown): string {
    if (content === null) {
      return 'content is null';
    }
    if (typeof content !== 'object') {
      return `content is ${typeof content}, expected object`;
    }
    if (Array.isArray(content)) {
      return 'content is array, expected object with config/header/elements';
    }

    const obj = content as Record<string, unknown>;
    const missing: string[] = [];

    if (!('config' in obj)) { missing.push('config'); }
    if (!('header' in obj)) { missing.push('header'); }
    if (!('elements' in obj)) { missing.push('elements'); }

    if (missing.length > 0) {
      return `missing required fields: ${missing.join(', ')}`;
    }

    if (typeof obj.header !== 'object' || obj.header === null) {
      return 'header must be an object';
    }
    if (!('title' in (obj.header as Record<string, unknown>))) {
      return 'header.title is missing';
    }

    if (!Array.isArray(obj.elements)) {
      return 'elements must be an array';
    }

    return 'unknown validation error';
  }

  /**
   * Internal helper: Send a message to Feishu chat.
   */
  private async sendMessageToFeishu(
    chatId: string,
    msgType: 'text' | 'interactive',
    content: string,
    parentId?: string
  ): Promise<void> {
    const messageData: {
      receive_id_type?: string;
      msg_type: string;
      content: string;
    } = {
      msg_type: msgType,
      content,
    };

    if (parentId) {
      await this.client.im.message.reply({
        path: { message_id: parentId },
        data: messageData,
      });
    } else {
      await this.client.im.message.create({
        params: { receive_id_type: 'chat_id' },
        data: { receive_id: chatId, ...messageData },
      });
    }
  }

  async sendText(chatId: string, content: string, parentId?: string): Promise<MessageSendResult> {
    try {
      await this.sendMessageToFeishu(chatId, 'text', JSON.stringify({ text: content }), parentId);
      logger.debug({ chatId, messageLength: content.length, parentId }, 'Text message sent');
      return { success: true, message: '✅ Text message sent' };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      logger.error({ err: error, chatId }, 'Failed to send text message');
      return { success: false, message: `❌ Failed to send: ${errorMessage}`, error: errorMessage };
    }
  }

  async sendCard(chatId: string, card: Record<string, unknown>, parentId?: string): Promise<MessageSendResult> {
    try {
      if (!this.isValidFeishuCard(card)) {
        const validationError = this.getCardValidationError(card);
        return {
          success: false,
          message: `❌ Invalid card: ${validationError}`,
          error: validationError,
        };
      }

      await this.sendMessageToFeishu(chatId, 'interactive', JSON.stringify(card), parentId);
      logger.debug({ chatId, parentId }, 'Card message sent');
      return { success: true, message: '✅ Card message sent' };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      logger.error({ err: error, chatId }, 'Failed to send card');
      return { success: false, message: `❌ Failed to send card: ${errorMessage}`, error: errorMessage };
    }
  }

  async sendFile(chatId: string, filePath: string): Promise<MessageSendResult> {
    try {
      const { uploadAndSendFile } = await import('../file-transfer/outbound/feishu-uploader.js');
      const fileSize = await uploadAndSendFile(this.client, filePath, chatId);
      const sizeMB = (fileSize / 1024 / 1024).toFixed(2);
      const fileName = filePath.split('/').pop() || filePath;

      logger.info({ fileName, fileSize, chatId }, 'File sent');
      return {
        success: true,
        message: `✅ File sent: ${fileName} (${sizeMB} MB)`,
        data: { fileName, fileSize, sizeMB },
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      logger.error({ err: error, filePath, chatId }, 'Failed to send file');
      return { success: false, message: `❌ Failed to send file: ${errorMessage}`, error: errorMessage };
    }
  }

  async updateCard(chatId: string, messageId: string, card: Record<string, unknown>): Promise<MessageSendResult> {
    try {
      if (!this.isValidFeishuCard(card)) {
        const validationError = this.getCardValidationError(card);
        return {
          success: false,
          message: `❌ Invalid card: ${validationError}`,
          error: validationError,
        };
      }

      await this.client.im.message.patch({
        path: { message_id: messageId },
        data: { content: JSON.stringify(card) },
      });

      logger.debug({ messageId, chatId }, 'Card updated');
      return { success: true, message: '✅ Card updated' };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      logger.error({ err: error, messageId, chatId }, 'Failed to update card');
      return { success: false, message: `❌ Failed to update card: ${errorMessage}`, error: errorMessage };
    }
  }

  supports(_operation: 'file' | 'card' | 'cardUpdate'): boolean {
    return true; // Feishu supports all operations
  }
}

/**
 * Message Adapter Service - Routes messages to the correct channel adapter.
 *
 * This service provides a unified interface for sending messages across
 * different channels. It automatically detects the channel type based on
 * the chatId and routes to the appropriate adapter.
 *
 * Usage:
 * ```typescript
 * const service = new MessageAdapterService();
 * await service.sendText('cli-test', 'Hello!'); // Routes to CLI adapter
 * await service.sendText('oc_xxx', 'Hello!');   // Routes to Feishu adapter
 * ```
 */
export class MessageAdapterService {
  private registry: ChatChannelRegistry;
  private adapters: Map<ChannelType, IChannelMessageAdapter> = new Map();
  private messageSentCallback?: (chatId: string) => void;

  constructor() {
    this.registry = ChatChannelRegistry.getInstance();

    // Register default adapters
    this.registerAdapter(new CliChannelAdapter());
    this.registerAdapter(new RestChannelAdapter());

    // Feishu adapter is registered lazily (requires credentials)
  }

  /**
   * Register a channel adapter.
   */
  registerAdapter(adapter: IChannelMessageAdapter): void {
    this.adapters.set(adapter.channelType, adapter);
    logger.debug({ channelType: adapter.channelType }, 'Adapter registered');
  }

  /**
   * Set callback for message sent events.
   */
  setMessageSentCallback(callback: ((chatId: string) => void) | null): void {
    this.messageSentCallback = callback ?? undefined;
  }

  /**
   * Get the adapter for a chatId.
   * Creates Feishu adapter lazily if needed.
   */
  private getAdapter(chatId: string): IChannelMessageAdapter {
    const channelType = this.registry.lookup(chatId);

    // Lazy initialization of Feishu adapter
    if (channelType === 'feishu' && !this.adapters.has('feishu')) {
      try {
        this.adapters.set('feishu', new FeishuChannelAdapter());
      } catch (error) {
        logger.error({ err: error }, 'Failed to initialize Feishu adapter');
        throw new Error('Feishu credentials not configured. Set FEISHU_APP_ID and FEISHU_APP_SECRET.');
      }
    }

    const adapter = this.adapters.get(channelType);
    if (!adapter) {
      throw new Error(`No adapter registered for channel type: ${channelType}`);
    }

    return adapter;
  }

  /**
   * Send a text message.
   */
  async sendText(chatId: string, content: string, parentId?: string): Promise<MessageSendResult> {
    try {
      const adapter = this.getAdapter(chatId);
      const result = await adapter.sendText(chatId, content, parentId);

      if (result.success && this.messageSentCallback) {
        this.messageSentCallback(chatId);
      }

      return result;
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      return { success: false, message: `❌ ${errorMessage}`, error: errorMessage };
    }
  }

  /**
   * Send a card message.
   */
  async sendCard(chatId: string, card: Record<string, unknown>, parentId?: string): Promise<MessageSendResult> {
    try {
      const adapter = this.getAdapter(chatId);
      const result = await adapter.sendCard(chatId, card, parentId);

      if (result.success && this.messageSentCallback) {
        this.messageSentCallback(chatId);
      }

      return result;
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      return { success: false, message: `❌ ${errorMessage}`, error: errorMessage };
    }
  }

  /**
   * Send a file.
   */
  async sendFile(chatId: string, filePath: string): Promise<MessageSendResult> {
    try {
      const adapter = this.getAdapter(chatId);

      if (!adapter.sendFile) {
        return {
          success: false,
          message: '❌ File sending not supported on this channel',
          error: 'Unsupported operation',
        };
      }

      const result = await adapter.sendFile(chatId, filePath);

      if (result.success && this.messageSentCallback) {
        this.messageSentCallback(chatId);
      }

      return result;
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      return { success: false, message: `❌ ${errorMessage}`, error: errorMessage };
    }
  }

  /**
   * Update an existing card.
   */
  async updateCard(chatId: string, messageId: string, card: Record<string, unknown>): Promise<MessageSendResult> {
    try {
      const adapter = this.getAdapter(chatId);

      if (!adapter.updateCard) {
        return {
          success: false,
          message: '❌ Card update not supported on this channel',
          error: 'Unsupported operation',
        };
      }

      return await adapter.updateCard(chatId, messageId, card);
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      return { success: false, message: `❌ ${errorMessage}`, error: errorMessage };
    }
  }

  /**
   * Get the channel type for a chatId.
   */
  getChannelType(chatId: string): ChannelType {
    return this.registry.lookup(chatId);
  }
}

/**
 * Global message adapter service instance.
 */
let messageAdapterService: MessageAdapterService | null = null;

/**
 * Get the global message adapter service instance.
 */
export function getMessageAdapterService(): MessageAdapterService {
  if (!messageAdapterService) {
    messageAdapterService = new MessageAdapterService();
  }
  return messageAdapterService;
}

/**
 * Reset the global service instance (for testing).
 */
export function resetMessageAdapterService(): void {
  messageAdapterService = null;
}
