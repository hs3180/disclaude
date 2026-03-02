/**
 * Channel Message Service - Unified message sending abstraction.
 *
 * This service provides a unified interface for sending messages across
 * different channels (Feishu, REST, CLI, etc.). It handles channel detection
 * and routing based on chatId format, so MCP tools don't need to know about
 * specific channels.
 *
 * Architecture:
 * ```
 * MCP Tools (send_user_feedback, etc.)
 *     │
 *     ▼
 * ChannelMessageService (unified interface)
 *     │
 *     ├── CLI Adapter (cli-* chatIds)
 *     ├── REST Adapter (UUID chatIds)
 *     └── Feishu Adapter (oc_*, ou_* chatIds)
 * ```
 *
 * @see Issue #445
 */

import { createLogger } from '../utils/logger.js';
import type { IChannel, OutgoingMessage } from '../channels/types.js';
import type { IMessageSender } from '../channels/adapters/types.js';
import { Config } from '../config/index.js';
import * as lark from '@larksuiteoapi/node-sdk';

const logger = createLogger('ChannelMessageService');

/**
 * ChatId format patterns for channel detection.
 */
const CHAT_ID_PATTERNS = {
  /** CLI channel: starts with "cli-" */
  CLI: /^cli-/,
  /** REST channel: UUID format */
  REST: /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
  /** Feishu channel: starts with "oc_" (group) or "ou_" (user) */
  FEISHU: /^(oc_|ou_)/,
} as const;

/**
 * Detected channel type based on chatId format.
 */
export type DetectedChannelType = 'cli' | 'rest' | 'feishu' | 'unknown';

/**
 * Detect channel type from chatId format.
 *
 * @param chatId - Chat ID to detect
 * @returns Detected channel type
 */
export function detectChannelType(chatId: string): DetectedChannelType {
  if (CHAT_ID_PATTERNS.CLI.test(chatId)) {
    return 'cli';
  }
  if (CHAT_ID_PATTERNS.REST.test(chatId)) {
    return 'rest';
  }
  if (CHAT_ID_PATTERNS.FEISHU.test(chatId)) {
    return 'feishu';
  }
  // Default to feishu for backward compatibility
  return 'unknown';
}

/**
 * Message sent callback type.
 * Called when a message is successfully sent to track user communication.
 */
export type MessageSentCallback = (chatId: string) => void;

/**
 * ChannelMessageService options.
 */
export interface ChannelMessageServiceOptions {
  /** Callback when message is sent successfully */
  onMessageSent?: MessageSentCallback;
  /** Feishu credentials (optional, uses Config if not provided) */
  feishuCredentials?: {
    appId: string;
    appSecret: string;
  };
}

/**
 * Channel Message Service - Unified message sending abstraction.
 *
 * This service provides a unified interface for sending messages across
 * different channels. It automatically detects the channel type based on
 * chatId format and routes messages accordingly.
 *
 * Usage:
 * ```typescript
 * const service = new ChannelMessageService();
 *
 * // Send to Feishu chat
 * await service.sendText('oc_xxx', 'Hello!');
 *
 * // Send to CLI (logs to console)
 * await service.sendText('cli-xxx', 'Hello!');
 * ```
 */
export class ChannelMessageService implements IMessageSender {
  private readonly options: ChannelMessageServiceOptions;
  private readonly channels = new Map<string, IChannel>();
  private feishuClient?: lark.Client;

  constructor(options: ChannelMessageServiceOptions = {}) {
    this.options = options;
    logger.info('ChannelMessageService created');
  }

  /**
   * Register a channel for message routing.
   *
   * @param channel - Channel to register
   */
  registerChannel(channel: IChannel): void {
    this.channels.set(channel.id, channel);
    logger.info({ channelId: channel.id, channelName: channel.name }, 'Channel registered');
  }

  /**
   * Unregister a channel.
   *
   * @param channelId - Channel ID to unregister
   */
  unregisterChannel(channelId: string): void {
    this.channels.delete(channelId);
    logger.info({ channelId }, 'Channel unregistered');
  }

  /**
   * Get a registered channel by ID.
   *
   * @param channelId - Channel ID
   * @returns Channel if found, undefined otherwise
   */
  getChannel(channelId: string): IChannel | undefined {
    return this.channels.get(channelId);
  }

  /**
   * Get all registered channels.
   *
   * @returns Array of registered channels
   */
  getChannels(): IChannel[] {
    return Array.from(this.channels.values());
  }

  /**
   * Send a text message.
   *
   * @param chatId - Target chat ID
   * @param text - Message text content
   * @param threadId - Optional thread ID for threaded replies
   */
  async sendText(chatId: string, text: string, threadId?: string): Promise<void> {
    const channelType = detectChannelType(chatId);
    logger.debug({ chatId, channelType, textLength: text.length }, 'sendText called');

    switch (channelType) {
      case 'cli':
        await this.sendToCli(text);
        break;

      case 'rest':
        await this.sendToChannel('rest', {
          chatId,
          type: 'text',
          text,
          threadId,
        });
        break;

      case 'feishu':
      case 'unknown':
      default:
        await this.sendToFeishu(chatId, 'text', JSON.stringify({ text }), threadId);
        break;
    }

    this.notifyMessageSent(chatId);
  }

  /**
   * Send an interactive card message.
   *
   * @param chatId - Target chat ID
   * @param card - Platform-specific card structure
   * @param description - Optional description for logging
   * @param threadId - Optional thread ID for threaded replies
   */
  async sendCard(
    chatId: string,
    card: Record<string, unknown>,
    description?: string,
    threadId?: string
  ): Promise<void> {
    const channelType = detectChannelType(chatId);
    logger.debug(
      { chatId, channelType, hasCard: !!card, description },
      'sendCard called'
    );

    switch (channelType) {
      case 'cli':
        await this.sendToCli(description || JSON.stringify(card, null, 2));
        break;

      case 'rest':
        await this.sendToChannel('rest', {
          chatId,
          type: 'card',
          card,
          description,
          threadId,
        });
        break;

      case 'feishu':
      case 'unknown':
      default:
        await this.sendToFeishu(chatId, 'interactive', JSON.stringify(card), threadId);
        break;
    }

    this.notifyMessageSent(chatId);
  }

  /**
   * Send a file attachment.
   *
   * @param chatId - Target chat ID
   * @param filePath - Local file path to send
   * @param threadId - Optional thread ID for threaded replies
   */
  async sendFile(chatId: string, filePath: string, threadId?: string): Promise<void> {
    const channelType = detectChannelType(chatId);
    logger.debug({ chatId, channelType, filePath }, 'sendFile called');

    switch (channelType) {
      case 'cli':
        await this.sendToCli(`[File: ${filePath}]`);
        break;

      case 'rest':
        await this.sendToChannel('rest', {
          chatId,
          type: 'file',
          filePath,
          threadId,
        });
        break;

      case 'feishu':
      case 'unknown':
      default:
        // For Feishu, we need to use the file upload API
        // This is handled separately in send_file_to_feishu
        throw new Error('File sending to Feishu requires send_file_to_feishu tool');
    }

    this.notifyMessageSent(chatId);
  }

  // ============================================================================
  // Private Methods
  // ============================================================================

  /**
   * Send message to CLI (log to console).
   */
  private async sendToCli(content: string): Promise<void> {
    logger.info({ contentPreview: content.substring(0, 100) }, 'CLI mode: User feedback');
    console.log(`\n${content}\n`);
  }

  /**
   * Send message through a registered channel.
   */
  private async sendToChannel(channelId: string, message: OutgoingMessage): Promise<void> {
    const channel = this.channels.get(channelId);
    if (!channel) {
      logger.warn({ channelId }, 'Channel not found, falling back to Feishu');
      // Fallback to Feishu if channel not found
      await this.sendToFeishu(
        message.chatId,
        message.type === 'card' ? 'interactive' : 'text',
        message.type === 'text'
          ? JSON.stringify({ text: message.text })
          : JSON.stringify(message.card),
        message.threadId
      );
      return;
    }

    await channel.sendMessage(message);
  }

  /**
   * Send message to Feishu.
   */
  private async sendToFeishu(
    chatId: string,
    msgType: 'text' | 'interactive',
    content: string,
    parentId?: string
  ): Promise<void> {
    const client = await this.getFeishuClient();

    const messageData: {
      receive_id_type?: string;
      msg_type: string;
      content: string;
    } = {
      msg_type: msgType,
      content,
    };

    if (parentId) {
      await client.im.message.reply({
        path: {
          message_id: parentId,
        },
        data: messageData,
      });
    } else {
      await client.im.message.create({
        params: {
          receive_id_type: 'chat_id',
        },
        data: {
          receive_id: chatId,
          ...messageData,
        },
      });
    }

    logger.debug({ chatId, msgType, parentId }, 'Message sent to Feishu');
  }

  /**
   * Get or create Feishu client.
   */
  private async getFeishuClient(): Promise<lark.Client> {
    if (!this.feishuClient) {
      const appId =
        this.options.feishuCredentials?.appId || Config.FEISHU_APP_ID;
      const appSecret =
        this.options.feishuCredentials?.appSecret || Config.FEISHU_APP_SECRET;

      if (!appId || !appSecret) {
        throw new Error(
          'Feishu credentials not configured. Set FEISHU_APP_ID and FEISHU_APP_SECRET.'
        );
      }

      this.feishuClient = new lark.Client({
        appId,
        appSecret,
        domain: lark.Domain.Feishu,
      });
    }

    return this.feishuClient;
  }

  /**
   * Notify callback that a message was sent.
   */
  private notifyMessageSent(chatId: string): void {
    if (this.options.onMessageSent) {
      try {
        this.options.onMessageSent(chatId);
      } catch (error) {
        logger.error({ err: error, chatId }, 'Failed to invoke message sent callback');
      }
    }
  }
}

// ============================================================================
// Singleton Instance for MCP Tools
// ============================================================================

let globalInstance: ChannelMessageService | null = null;

/**
 * Get the global ChannelMessageService instance.
 * Creates one if it doesn't exist.
 *
 * @returns Global ChannelMessageService instance
 */
export function getChannelMessageService(): ChannelMessageService {
  if (!globalInstance) {
    globalInstance = new ChannelMessageService();
  }
  return globalInstance;
}

/**
 * Set the global ChannelMessageService instance.
 * Used for testing or when custom configuration is needed.
 *
 * @param service - Service instance to set
 */
export function setChannelMessageService(service: ChannelMessageService | null): void {
  globalInstance = service;
}

/**
 * Reset the global instance.
 * Useful for testing.
 */
export function resetChannelMessageService(): void {
  globalInstance = null;
}
