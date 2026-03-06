/**
 * Message Quote Resolver.
 *
 * Resolves quoted/referenced message content for:
 * 1. Reply messages (parent_id) - quote reply functionality
 * 2. Merged forward messages (merge_forward) - bundled forwarded chat history
 *
 * Key improvement over PR #847:
 * - Quote content is formatted to be APPENDED to the user's prompt (not just in metadata)
 * - Merged forward messages fetch the actual sub-messages (not just a placeholder)
 * - Long merged forward content is truncated with head/tail preserved
 *
 * @see Issue #846
 */

import type * as lark from '@larksuiteoapi/node-sdk';
import { createLogger } from '../utils/logger.js';

const logger = createLogger('MessageQuoteResolver');

/** Maximum total length for merged forward content (characters) */
const MAX_MERGED_FORWARD_LENGTH = 4000;
/** Maximum length for head portion when truncating */
const MAX_HEAD_LENGTH = 2000;

/**
 * Result of resolving a quoted message.
 */
export interface QuotedMessageContent {
  /** Original message ID */
  messageId: string;
  /** Text content of the quoted message */
  text: string;
  /** Timestamp of the original message */
  timestamp?: number;
}

/**
 * Result of message quote resolution.
 */
export interface MessageQuoteResult {
  /** Formatted context string to APPEND to user's prompt */
  contextString: string;
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
   * @returns Resolved quote context formatted for appending to prompt
   */
  async resolveMessageQuote(
    messageType: string,
    parentId?: string,
    messageId?: string
  ): Promise<MessageQuoteResult | null> {
    const parts: string[] = [];

    // Handle reply messages with parent_id
    if (parentId) {
      try {
        const quotedMessage = await this.fetchQuotedMessage(parentId);
        if (quotedMessage) {
          const quoteContext = this.formatQuotedMessageContext(quotedMessage);
          parts.push(quoteContext);
          logger.info({ parentId }, 'Resolved quoted message content');
        }
      } catch (error) {
        logger.error({ err: error, parentId }, 'Failed to fetch quoted message');
      }
    }

    // Handle merged forward messages
    if (messageType === 'merge_forward' && messageId) {
      try {
        const mergedContent = await this.fetchMergedForwardContent(messageId);
        if (mergedContent) {
          parts.push(mergedContent);
          logger.info({ messageId }, 'Resolved merged forward content');
        }
      } catch (error) {
        logger.error({ err: error, messageId }, 'Failed to fetch merged forward content');
      }
    }

    if (parts.length === 0) {
      return null;
    }

    return {
      contextString: '\n\n---\n' + parts.join('\n\n'),
    };
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
   * Fetch merged forward message content.
   *
   * According to Feishu API, calling im.message.get on a merge_forward message
   * returns the sub-messages contained in it.
   */
  private async fetchMergedForwardContent(messageId: string): Promise<string | null> {
    try {
      const response = await this.client.im.message.get({
        path: {
          message_id: messageId,
        },
      });

      if (response.code !== 0 || !response.data?.items) {
        logger.debug(
          { messageId, code: response.code, msg: response.msg },
          'Merged forward message not found or access denied'
        );
        // Fallback: return a placeholder indicating we couldn't fetch the content
        return '**[转发的对话记录]**\n\n*(无法获取转发内容的详情)*';
      }

      // The API returns sub-messages in the items array
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const items = response.data.items as any[];

      if (!items || items.length === 0) {
        return '**[转发的对话记录]**\n\n*(转发内容为空)*';
      }

      // Build formatted content from sub-messages
      const messages: string[] = [];
      let totalLength = 0;

      for (const msg of items) {
        // Skip the parent merge_forward message itself, only process sub-messages
        if (msg.upper_message_id !== messageId) {
          continue;
        }

        const text = this.extractTextFromContent(msg.body?.content || msg.content, msg.msg_type);
        if (!text) {
          continue;
        }

        const timestamp = msg.create_time
          ? new Date(parseInt(msg.create_time, 10)).toLocaleString('zh-CN')
          : '';

        const formatted = timestamp
          ? `[${timestamp}] ${text}`
          : text;

        messages.push(formatted);
        totalLength += formatted.length;
      }

      if (messages.length === 0) {
        // If no sub-messages found, return a simple placeholder
        return '**[转发的对话记录]**\n\n*(用户转发了一段对话记录)*';
      }

      // Truncate if too long
      let content: string;
      if (totalLength > MAX_MERGED_FORWARD_LENGTH) {
        content = this.truncateMessages(messages);
      } else {
        content = messages.join('\n');
      }

      return `**[转发的对话记录]**\n\n${content}`;
    } catch (error) {
      logger.error({ err: error, messageId }, 'Error fetching merged forward content');
      return '**[转发的对话记录]**\n\n*(获取转发内容时出错)*';
    }
  }

  /**
   * Truncate messages to fit within length limit.
   * Preserves head and tail portions.
   */
  private truncateMessages(messages: string[]): string {
    const headMessages: string[] = [];
    const tailMessages: string[] = [];
    let headLength = 0;
    let tailLength = 0;

    // Collect head messages
    for (const msg of messages) {
      if (headLength + msg.length > MAX_HEAD_LENGTH) {
        break;
      }
      headMessages.push(msg);
      headLength += msg.length + 1; // +1 for newline
    }

    // Collect tail messages (from the end)
    for (let i = messages.length - 1; i >= 0; i--) {
      const msg = messages[i];
      if (headMessages.includes(msg)) {
        break; // Don't duplicate messages
      }
      if (tailLength + msg.length > MAX_MERGED_FORWARD_LENGTH - MAX_HEAD_LENGTH - 100) {
        break;
      }
      tailMessages.unshift(msg);
      tailLength += msg.length + 1;
    }

    // Combine with truncation indicator
    const parts: string[] = [];
    if (headMessages.length > 0) {
      parts.push(headMessages.join('\n'));
    }
    parts.push('\n... (中间内容已省略) ...\n');
    if (tailMessages.length > 0) {
      parts.push(tailMessages.join('\n'));
    }

    return parts.join('');
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
   * Format quoted message context for appending to prompt.
   */
  private formatQuotedMessageContext(quoted: QuotedMessageContent): string {
    const timestamp = quoted.timestamp
      ? new Date(quoted.timestamp).toLocaleString('zh-CN')
      : '';

    const header = timestamp
      ? `**[引用的原消息]** (${timestamp})`
      : '**[引用的原消息]**';

    const quotedText = quoted.text.split('\n').map(line => `> ${line}`).join('\n');

    return `${header}\n${quotedText}`;
  }
}

/**
 * Create a MessageQuoteResolver instance.
 */
export function createMessageQuoteResolver(client: lark.Client): MessageQuoteResolver {
  return new MessageQuoteResolver(client);
}
