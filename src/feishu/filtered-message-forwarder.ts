/**
 * Filtered Message Forwarder.
 *
 * Forwards filtered messages to a debug chat for visibility.
 * Useful for diagnosing why messages are being filtered in passive mode.
 *
 * @see Issue #597
 */

import { Config } from '../config/index.js';
import type { FilterReason, DebugConfig } from '../config/types.js';
import { createLogger } from '../utils/logger.js';

const logger = createLogger('FilteredMessageForwarder');

/**
 * Filtered message data.
 */
export interface FilteredMessage {
  /** Original message ID */
  messageId: string;
  /** Chat ID where message was sent */
  chatId: string;
  /** User ID who sent the message */
  userId?: string;
  /** Message content (truncated for display) */
  content: string;
  /** Reason the message was filtered */
  reason: FilterReason;
  /** Additional metadata */
  metadata?: Record<string, unknown>;
  /** Timestamp of the message */
  timestamp: number;
}

/**
 * Message sender interface for forwarding messages.
 */
export interface MessageSender {
  sendText(chatId: string, text: string): Promise<void>;
}

/**
 * FilteredMessageForwarder handles forwarding filtered messages to a debug chat.
 *
 * Configuration (in disclaude.config.yaml):
 * ```yaml
 * messaging:
 *   debug:
 *     enabled: true
 *     filterForwardChatId: "oc_xxx"  # Chat to forward filtered messages to
 *     includeReasons:                # Only forward these reasons (empty = all)
 *       - passive_mode
 *       - duplicate
 * ```
 */
export class FilteredMessageForwarder {
  private enabled: boolean;
  private forwardChatId?: string;
  private includeReasons: Set<FilterReason>;
  private messageSender?: MessageSender;

  /**
   * Create a new FilteredMessageForwarder.
   * @param debugConfig - Optional debug config for testing (uses Config.getDebugConfig() by default)
   */
  constructor(debugConfig?: DebugConfig) {
    const config = debugConfig ?? Config.getDebugConfig() ?? {};
    this.enabled = config.enabled ?? false;
    this.forwardChatId = config.filterForwardChatId;
    this.includeReasons = new Set(config.includeReasons || []);

    if (this.enabled && this.forwardChatId) {
      logger.info(
        { forwardChatId: this.forwardChatId, includeReasons: [...this.includeReasons] },
        'FilteredMessageForwarder initialized'
      );
    }
  }

  /**
   * Set the message sender for forwarding messages.
   */
  setMessageSender(sender: MessageSender): void {
    this.messageSender = sender;
  }

  /**
   * Check if forwarding is enabled and configured.
   */
  isConfigured(): boolean {
    return this.enabled && !!this.forwardChatId;
  }

  /**
   * Check if a specific filter reason should be forwarded.
   */
  shouldForward(reason: FilterReason): boolean {
    if (!this.isConfigured()) {
      return false;
    }
    // If includeReasons is empty, forward all reasons
    if (this.includeReasons.size === 0) {
      return true;
    }
    return this.includeReasons.has(reason);
  }

  /**
   * Forward a filtered message to the debug chat.
   *
   * @param message - The filtered message data
   */
  async forward(message: FilteredMessage): Promise<void> {
    if (!this.shouldForward(message.reason)) {
      return;
    }

    if (!this.messageSender || !this.forwardChatId) {
      logger.warn('MessageSender or forwardChatId not configured');
      return;
    }

    try {
      const formattedMessage = this.formatMessage(message);
      await this.messageSender.sendText(this.forwardChatId, formattedMessage);
      logger.debug({ messageId: message.messageId, reason: message.reason }, 'Forwarded filtered message');
    } catch (error) {
      logger.error({ err: error, messageId: message.messageId }, 'Failed to forward filtered message');
    }
  }

  /**
   * Format a filtered message for display.
   */
  private formatMessage(message: FilteredMessage): string {
    const reasonEmoji: Record<FilterReason, string> = {
      duplicate: '🔄',
      bot: '🤖',
      old: '⏰',
      unsupported: '❓',
      empty: '📭',
      passive_mode: '🔇',
    };

    const emoji = reasonEmoji[message.reason] || '🚫';
    const timestamp = new Date(message.timestamp).toISOString();
    const truncatedContent = message.content.length > 200
      ? message.content.slice(0, 200) + '...'
      : message.content;

    return `${emoji} **被过滤消息**

| 字段 | 值 |
|------|-----|
| 原因 | \`${message.reason}\` |
| 时间 | ${timestamp} |
| 消息ID | \`${message.messageId}\` |
| 聊天ID | \`${message.chatId}\` |
| 用户ID | \`${message.userId || 'unknown'}\` |

**内容**:
\`\`\`
${truncatedContent}
\`\`\``;
  }
}

// Singleton instance
export const filteredMessageForwarder = new FilteredMessageForwarder();
