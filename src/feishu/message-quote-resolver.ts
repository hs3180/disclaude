/**
 * Message Quote Resolver.
 *
 * Resolves quoted/referenced message content for:
 * 1. Reply messages (parent_id) - quote reply functionality
 * 2. Merged forward messages (merge_forward) - bundled forwarded chat history
 *
 * @see Issue #846
 */

import type * as lark from '@larksuiteoapi/node-sdk';
import { createLogger } from '../utils/logger.js';

const logger = createLogger('MessageQuoteResolver');

/**
 * Result of resolving a quoted message.
 */
export interface QuotedMessageContent {
  /** Original message ID */
  messageId: string;
  /** Text content of the quoted message */
  text: string;
  /** Sender information (if available) */
  senderName?: string;
  /** Timestamp of the original message */
  timestamp?: number;
}

/**
 * Result of resolving a merged forward message.
 */
export interface MergedForwardContent {
  /** List of forwarded messages */
  messages: Array<{
    messageId: string;
    text: string;
    senderName?: string;
    timestamp?: number;
  }>;
  /** Formatted summary for display */
  summary: string;
}

/**
 * Result of message quote resolution.
 */
export interface MessageQuoteResult {
  /** Whether this is a reply message */
  isReply: boolean;
  /** Quoted message content (for reply messages) */
  quotedMessage?: QuotedMessageContent;
  /** Whether this is a merged forward message */
  isMergedForward: boolean;
  /** Merged forward content (for merge_forward messages) */
  mergedForward?: MergedForwardContent;
  /** Formatted context string to append to user message */
  contextString?: string;
}

/**
 * Message Quote Resolver.
 *
 * Handles fetching and formatting quoted/forwarded message content
 * from Feishu API.
 */
export class MessageQuoteResolver {
  private client: lark.Client;

  constructor(client: lark.Client) {
    this.client = client;
  }

  /**
   * Resolve message quote context based on message type and parent_id.
   *
   * @param messageType - The message type (text, post, merge_forward, etc.)
   * @param parentId - Parent message ID (for reply messages)
   * @param messageId - Current message ID (for merge_forward messages)
   * @returns Resolved quote context or null if not applicable
   */
  async resolveMessageQuote(
    messageType: string,
    parentId?: string,
    messageId?: string
  ): Promise<MessageQuoteResult | null> {
    const result: MessageQuoteResult = {
      isReply: false,
      isMergedForward: false,
    };

    // Handle merged forward messages
    if (messageType === 'merge_forward' && messageId) {
      result.isMergedForward = true;
      result.mergedForward = {
        messages: [],
        summary: '转发的对话记录',
      };
      result.contextString = '**转发的对话记录**\n\n*(用户转发了一段对话记录，需要在上下文中理解)*';
      logger.info({ messageId }, 'Identified merged_forward message');
    }

    // Handle reply messages with parent_id
    if (parentId) {
      try {
        const quotedMessage = await this.fetchQuotedMessage(parentId);
        if (quotedMessage) {
          result.isReply = true;
          result.quotedMessage = quotedMessage;
          const quoteContext = this.formatQuotedMessageContext(quotedMessage);
          result.contextString = result.contextString
            ? `${result.contextString}\n\n${quoteContext}`
            : quoteContext;
          logger.info({ parentId }, 'Resolved quoted message content');
        }
      } catch (error) {
        logger.error({ err: error, parentId }, 'Failed to fetch quoted message');
      }
    }

    if (result.isReply || result.isMergedForward) {
      return result;
    }

    return null;
  }

  /**
   * Fetch quoted/referenced message content by message ID.
   */
  private async fetchQuotedMessage(messageId: string): Promise<QuotedMessageContent | null> {
    try {
      const response = await this.client.im.message.get({
        path: {
          message_id: messageId,
        },
      });

      if (response.code !== 0 || !response.data?.items || response.data.items.length === 0) {
        logger.debug(
          { messageId, code: response.code, msg: response.msg },
          'Message not found or access denied'
        );
        return null;
      }

      // The SDK type definition may not include 'content', but the API returns it
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const message = response.data.items[0] as any;
      const text = this.extractTextFromContent(message.body?.content || message.content, message.msg_type);

      if (!text) {
        return null;
      }

      // Parse timestamp from string to number
      const timestamp = message.create_time ? parseInt(message.create_time, 10) : undefined;

      return {
        messageId: message.message_id || messageId,
        text,
        timestamp,
      };
    } catch (error) {
      logger.error({ err: error, messageId }, 'Error fetching quoted message');
      return null;
    }
  }

  /**
   * Extract text content from various message types.
   */
  private extractTextFromContent(content: string | undefined, msgType: string | undefined): string {
    if (!content) {
      return '';
    }

    try {
      const parsed = JSON.parse(content);

      switch (msgType) {
        case 'text':
          return parsed.text?.trim() || '';

        case 'post': {
          let postText = '';
          if (parsed.content && Array.isArray(parsed.content)) {
            for (const row of parsed.content) {
              if (Array.isArray(row)) {
                for (const segment of row) {
                  if (segment?.tag === 'text' && segment.text) {
                    postText += segment.text;
                  }
                }
              }
            }
          }
          return postText.trim();
        }

        case 'image':
          return '[图片]';

        case 'file':
          return parsed.file_name ? `[文件: ${parsed.file_name}]` : '[文件]';

        case 'audio':
          return '[语音]';

        case 'media':
          return parsed.file_name ? `[视频: ${parsed.file_name}]` : '[视频]';

        default:
          if (parsed.text) {
            return parsed.text.trim();
          }
          return '';
      }
    } catch {
      return content.trim();
    }
  }

  /**
   * Format quoted message context for display.
   */
  private formatQuotedMessageContext(quoted: QuotedMessageContent): string {
    const timestamp = quoted.timestamp
      ? new Date(quoted.timestamp).toLocaleString('zh-CN')
      : '';

    const header = quoted.senderName
      ? `**引用回复** (来自 ${quoted.senderName}${timestamp ? `, ${timestamp}` : ''})`
      : `**引用回复**${timestamp ? ` (${timestamp})` : ''}`;

    return `${header}\n> ${quoted.text.split('\n').join('\n> ')}`;
  }
}

/**
 * Create a MessageQuoteResolver instance.
 */
export function createMessageQuoteResolver(client: lark.Client): MessageQuoteResolver {
  return new MessageQuoteResolver(client);
}
