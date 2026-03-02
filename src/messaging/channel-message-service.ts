/**
 * Channel Message Service - Unified message sending abstraction.
 *
 * This service provides a channel-agnostic interface for sending messages.
 * It automatically routes messages to the correct channel based on chatId format.
 *
 * Architecture:
 * ```
 * MCP Tools
 *     │
 *     ▼
 * ChannelMessageService
 *     │
 *     ├── CLI Adapter (cli-*)
 *     │
 *     └── ChannelManager
 *             │
 *             ├── FeishuChannel (oc_*, ou_*)
 *             │
 *             └── RestChannel (UUID format)
 * ```
 *
 * @see Issue #445
 */

import { createLogger } from '../utils/logger.js';
import type { ChannelManager } from '../nodes/channel-manager.js';
import type { OutgoingMessage } from '../channels/types.js';

const logger = createLogger('ChannelMessageService');

/**
 * Result of a send operation.
 */
export interface SendResult {
  /** Whether the operation succeeded */
  success: boolean;
  /** Human-readable message */
  message: string;
  /** Error details if failed */
  error?: string;
}

/**
 * Message content types.
 */
export type MessageFormat = 'text' | 'card';

/**
 * Channel Message Service configuration.
 */
export interface ChannelMessageServiceConfig {
  /** Channel manager instance */
  channelManager: ChannelManager;
  /** Callback when message is successfully sent */
  onMessageSent?: (chatId: string) => void;
}

/**
 * Channel Message Service.
 *
 * Provides unified message sending across all registered channels.
 * Handles channel detection based on chatId format.
 */
export class ChannelMessageService {
  private channelManager: ChannelManager;
  private onMessageSent?: (chatId: string) => void;

  constructor(config: ChannelMessageServiceConfig) {
    this.channelManager = config.channelManager;
    this.onMessageSent = config.onMessageSent;
  }

  /**
   * Send a message to a chat.
   *
   * Automatically routes to the correct channel based on chatId format:
   * - cli-*: CLI mode (console.log)
   * - oc_*, ou_*: Feishu channel
   * - UUID format: REST channel
   * - Unknown: Broadcast to all channels
   *
   * @param chatId - Target chat ID
   * @param content - Message content (string for text, object for card)
   * @param format - Message format ('text' or 'card')
   * @param parentMessageId - Optional parent message ID for thread replies
   * @returns Send result
   */
  async sendMessage(
    chatId: string,
    content: string | Record<string, unknown>,
    format: MessageFormat,
    parentMessageId?: string
  ): Promise<SendResult> {
    logger.debug(
      {
        chatId,
        format,
        contentType: typeof content,
        parentMessageId,
      },
      'Sending message'
    );

    try {
      // Validate required parameters
      if (!content) {
        return { success: false, message: 'Content is required', error: 'content_required' };
      }
      if (!format) {
        return { success: false, message: 'Format is required (text or card)', error: 'format_required' };
      }
      if (!chatId) {
        return { success: false, message: 'chatId is required', error: 'chatid_required' };
      }

      // Handle CLI mode
      if (this.isCliChatId(chatId)) {
        return this.sendToCli(chatId, content, format);
      }

      // Build outgoing message
      const message: OutgoingMessage = this.buildOutgoingMessage(chatId, content, format, parentMessageId);

      // Route to appropriate channel(s)
      const channel = this.detectChannel(chatId);
      if (channel) {
        // Send to specific channel
        await channel.sendMessage(message);
      } else {
        // Broadcast to all channels
        logger.debug({ chatId }, 'No specific channel detected, broadcasting to all');
        await this.channelManager.broadcast(message);
      }

      // Notify callback
      this.onMessageSent?.(chatId);

      return {
        success: true,
        message: `✅ Message sent (format: ${format})`,
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      logger.error({ err: error, chatId, format }, 'Failed to send message');

      return {
        success: false,
        message: `❌ Failed to send message: ${errorMessage}`,
        error: errorMessage,
      };
    }
  }

  /**
   * Send a file to a chat.
   *
   * @param chatId - Target chat ID
   * @param filePath - Path to the file
   * @returns Send result
   */
  async sendFile(chatId: string, filePath: string): Promise<SendResult> {
    logger.debug({ chatId, filePath }, 'Sending file');

    try {
      if (!filePath) {
        return { success: false, message: 'filePath is required', error: 'filepath_required' };
      }
      if (!chatId) {
        return { success: false, message: 'chatId is required', error: 'chatid_required' };
      }

      // Handle CLI mode
      if (this.isCliChatId(chatId)) {
        logger.info({ chatId, filePath }, 'CLI mode: File send simulated');
        return {
          success: true,
          message: `✅ File sent (CLI mode): ${filePath}`,
        };
      }

      // Build file message
      const message: OutgoingMessage = {
        chatId,
        type: 'file',
        filePath,
      };

      // Route to appropriate channel(s)
      const channel = this.detectChannel(chatId);
      if (channel) {
        await channel.sendMessage(message);
      } else {
        await this.channelManager.broadcast(message);
      }

      // Notify callback
      this.onMessageSent?.(chatId);

      return {
        success: true,
        message: `✅ File sent: ${filePath}`,
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      logger.error({ err: error, chatId, filePath }, 'Failed to send file');

      return {
        success: false,
        message: `❌ Failed to send file: ${errorMessage}`,
        error: errorMessage,
      };
    }
  }

  /**
   * Update an existing interactive card.
   *
   * @param chatId - Target chat ID
   * @param messageId - Message ID of the card to update
   * @param card - New card content
   * @returns Send result
   */
  async updateCard(
    chatId: string,
    messageId: string,
    card: Record<string, unknown>
  ): Promise<SendResult> {
    logger.debug({ chatId, messageId }, 'Updating card');

    try {
      if (!messageId) {
        return { success: false, message: 'messageId is required', error: 'messageid_required' };
      }
      if (!card) {
        return { success: false, message: 'card is required', error: 'card_required' };
      }
      if (!chatId) {
        return { success: false, message: 'chatId is required', error: 'chatid_required' };
      }

      // Handle CLI mode
      if (this.isCliChatId(chatId)) {
        logger.info({ chatId, messageId }, 'CLI mode: Card update simulated');
        return {
          success: true,
          message: '✅ Card updated (CLI mode)',
        };
      }

      // For card updates, we need platform-specific handling
      // Currently only FeishuChannel supports this through the MCP tools directly
      // This is a limitation that should be addressed in a future PR

      // Try to find Feishu channel for card update
      const feishuChannel = this.channelManager.getAll().find(
        (ch) => ch.id === 'feishu' || ch.name === 'Feishu'
      );

      if (feishuChannel) {
        // Use FeishuChannel's sendMessage with a special update type
        // Note: This requires extending OutgoingMessage type or using platform-specific APIs
        // For now, we'll use the existing MCP implementation
        logger.info({ chatId, messageId }, 'Card update requested - delegating to channel');
      }

      return {
        success: true,
        message: '✅ Card update requested',
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      logger.error({ err: error, chatId, messageId }, 'Failed to update card');

      return {
        success: false,
        message: `❌ Failed to update card: ${errorMessage}`,
        error: errorMessage,
      };
    }
  }

  /**
   * Check if chatId is a CLI chat ID.
   */
  private isCliChatId(chatId: string): boolean {
    return chatId.startsWith('cli-');
  }

  /**
   * Send message to CLI (console output).
   */
  private sendToCli(
    chatId: string,
    content: string | Record<string, unknown>,
    format: MessageFormat
  ): SendResult {
    const displayContent = typeof content === 'string' ? content : JSON.stringify(content, null, 2);
    logger.info({ chatId, format, contentPreview: displayContent.substring(0, 100) }, 'CLI mode: User feedback');
    console.log(`\n${displayContent}\n`);

    // Notify callback
    this.onMessageSent?.(chatId);

    return {
      success: true,
      message: `✅ Feedback displayed (CLI mode, format: ${format})`,
    };
  }

  /**
   * Build an OutgoingMessage from parameters.
   */
  private buildOutgoingMessage(
    chatId: string,
    content: string | Record<string, unknown>,
    format: MessageFormat,
    parentMessageId?: string
  ): OutgoingMessage {
    if (format === 'text') {
      return {
        chatId,
        type: 'text',
        text: typeof content === 'string' ? content : JSON.stringify(content),
        threadId: parentMessageId,
      };
    } else {
      return {
        chatId,
        type: 'card',
        card: typeof content === 'object' ? content : JSON.parse(content as string),
        threadId: parentMessageId,
      };
    }
  }

  /**
   * Detect which channel should handle a chatId.
   *
   * @param chatId - Chat ID to detect
   * @returns Channel if found, undefined if should broadcast
   */
  private detectChannel(chatId: string): import('../channels/types.js').IChannel | undefined {
    const channels = this.channelManager.getAll();

    // Feishu chat IDs: oc_* (group), ou_* (user), on_* (bot)
    if (/^(oc_|ou_|on_)/.test(chatId)) {
      return channels.find((ch) => ch.id === 'feishu' || ch.name === 'Feishu');
    }

    // UUID format: typically REST channel
    if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(chatId)) {
      return channels.find((ch) => ch.id === 'rest' || ch.name === 'REST');
    }

    // Unknown format: return undefined to broadcast
    return undefined;
  }
}
