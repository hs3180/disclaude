/**
 * Filtered Message Forwarder.
 *
 * Forwards filtered messages to a debug chat for visibility.
 * Useful for diagnosing why messages are being filtered in passive mode.
 *
 * @see Issue #597
 * @see Issue #652 - Uses DebugGroupService for memory-based debug group management
 */

import type { FilterReason } from '../config/types.js';
import { getDebugGroupService, type DebugGroupInfo } from '../nodes/debug-group-service.js';
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
 * Uses DebugGroupService for memory-based debug group management.
 * The debug group is set via the `/set-debug` command in a chat.
 *
 * @see Issue #652 - Changed from config-based to memory-based debug group
 * @see Issue #597 - Original filtered message forwarding feature
 */
export class FilteredMessageForwarder {
  private messageSender?: MessageSender;

  /**
   * Set the message sender for forwarding messages.
   */
  setMessageSender(sender: MessageSender): void {
    this.messageSender = sender;
    logger.info('MessageSender configured for FilteredMessageForwarder');
  }

  /**
   * Get the current debug group from DebugGroupService.
   * @returns The current debug group info, or null if not set
   */
  private getDebugGroup(): DebugGroupInfo | null {
    return getDebugGroupService().getDebugGroup();
  }

  /**
   * Check if forwarding is enabled (debug group is set).
   */
  isConfigured(): boolean {
    return this.getDebugGroup() !== null;
  }

  /**
   * Check if a specific filter reason should be forwarded.
   * Always returns true if debug group is set (forwards all reasons).
   */
  shouldForward(_reason: FilterReason): boolean {
    return this.isConfigured();
  }

  /**
   * Forward a filtered message to the debug chat.
   *
   * @param message - The filtered message data
   */
  async forward(message: FilteredMessage): Promise<void> {
    const debugGroup = this.getDebugGroup();

    if (!debugGroup) {
      // Debug group not set, silently skip
      return;
    }

    if (!this.messageSender) {
      logger.warn('MessageSender not configured, cannot forward filtered message');
      return;
    }

    try {
      const formattedMessage = this.formatMessage(message, debugGroup);
      await this.messageSender.sendText(debugGroup.chatId, formattedMessage);
      logger.debug(
        { messageId: message.messageId, reason: message.reason, debugChatId: debugGroup.chatId },
        'Forwarded filtered message to debug group'
      );
    } catch (error) {
      logger.error({ err: error, messageId: message.messageId }, 'Failed to forward filtered message');
    }
  }

  /**
   * Format a filtered message for display.
   * @param message - The filtered message data
   * @param debugGroup - The debug group info (optional, for context)
   */
  private formatMessage(message: FilteredMessage, debugGroup: DebugGroupInfo): string {
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
      ? `${message.content.slice(0, 200)}...`
      : message.content;

    const debugGroupName = debugGroup.name ? ` (${debugGroup.name})` : '';

    return `${emoji} **被过滤消息**

| 字段 | 值 |
|------|-----|
| 原因 | \`${message.reason}\` |
| 时间 | ${timestamp} |
| 消息ID | \`${message.messageId}\` |
| 聊天ID | \`${message.chatId}\` |
| 用户ID | \`${message.userId || 'unknown'}\` |
| 调试群 | \`${debugGroup.chatId}\`${debugGroupName} |

**内容**:
\`\`\`
${truncatedContent}
\`\`\``;
  }
}

// Singleton instance
export const filteredMessageForwarder = new FilteredMessageForwarder();
