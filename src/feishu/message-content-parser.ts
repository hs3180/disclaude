/**
 * Message Content Parser.
 *
 * Parses special message types like quote replies and forwarded chat history.
 * @see Issue #846 - Support for quote replies and forwarded chat history
 */

import type * as lark from '@larksuiteoapi/node-sdk';
import { createLogger } from '../utils/logger.js';

const logger = createLogger('MessageContentParser');

/**
 * Quote reply information extracted from a message.
 */
export interface QuoteReplyInfo {
  /** The message ID being quoted/replied to */
  parentMessageId: string;
  /** The content of the quoted message (if available) */
  parentContent?: string;
  /** The sender of the quoted message (if available) */
  parentSender?: string;
  /** Timestamp of the quoted message (if available) */
  parentTimestamp?: number;
}

/**
 * Forwarded chat history information.
 */
export interface ForwardedHistoryInfo {
  /** Whether this is a forwarded message */
  isForwarded: boolean;
  /** The original messages in the forwarded history (if available) */
  messages?: Array<{
    content: string;
    sender?: string;
    timestamp?: number;
  }>;
  /** Raw content for debugging */
  rawContent?: string;
}

/**
 * Parsed message context containing special message information.
 */
export interface ParsedMessageContext {
  /** Quote reply information (if this is a reply to another message) */
  quoteReply?: QuoteReplyInfo;
  /** Forwarded chat history information (if this contains forwarded messages) */
  forwardedHistory?: ForwardedHistoryInfo;
}

/**
 * Format a context prompt for the agent based on parsed message context.
 */
export function formatContextPrompt(context: ParsedMessageContext): string | undefined {
  const parts: string[] = [];

  if (context.quoteReply?.parentContent) {
    parts.push(`**引用的消息**:
> ${context.quoteReply.parentContent}
${context.quoteReply.parentSender ? `— ${context.quoteReply.parentSender}` : ''}`);
  }

  if (context.forwardedHistory?.isForwarded && context.forwardedHistory.messages?.length) {
    const historyLines = context.forwardedHistory.messages
      .map((msg, i) => {
        const sender = msg.sender ? `[${msg.sender}]` : '[未知]';
        return `${i + 1}. ${sender}: ${msg.content}`;
      })
      .join('\n');
    parts.push(`**转发的对话记录**:
${historyLines}`);
  }

  return parts.length > 0 ? parts.join('\n\n') : undefined;
}

/**
 * Fetch the content of a quoted/referenced message.
 * Uses the Feishu API to get message details by message ID.
 */
export async function fetchQuotedMessage(
  client: lark.Client,
  parentMessageId: string
): Promise<QuoteReplyInfo | undefined> {
  try {
    logger.debug({ parentMessageId }, 'Fetching quoted message');

    // Use the Feishu API to get message details
    const response = await client.im.message.get({
      path: { message_id: parentMessageId },
    });

    if (response.code !== 0 || !response.data?.items?.[0]) {
      logger.warn(
        { parentMessageId, code: response.code, msg: response.msg },
        'Failed to fetch quoted message'
      );
      return undefined;
    }

    const messageItem = response.data.items[0];
    let content = '';

    // Parse message content based on type
    if (messageItem.body?.content) {
      try {
        const parsed = JSON.parse(messageItem.body.content);

        if (messageItem.msg_type === 'text') {
          content = parsed.text || '';
        } else if (messageItem.msg_type === 'post' && parsed.content) {
          // Extract text from post (rich text) message
          for (const row of parsed.content) {
            if (Array.isArray(row)) {
              for (const segment of row) {
                if (segment?.tag === 'text' && segment.text) {
                  content += segment.text;
                }
              }
            }
          }
        } else {
          // For other message types, try to get text representation
          content = parsed.text || messageItem.body.content;
        }
      } catch {
        // If JSON parsing fails, use raw content
        const { content: rawContent } = messageItem.body;
        content = rawContent;
      }
    }

    return {
      parentMessageId,
      parentContent: content.trim(),
      parentSender: messageItem.sender?.id || undefined,
      parentTimestamp: messageItem.create_time ? Number(messageItem.create_time) * 1000 : undefined,
    };
  } catch (error) {
    logger.error({ err: error, parentMessageId }, 'Error fetching quoted message');
    return undefined;
  }
}

/**
 * Parse forwarded chat history from message content.
 *
 * Feishu supports several types of forwarded messages:
 * 1. `merge_forward` - Merged forward of multiple messages
 * 2. `text` with special content structure for forwarded history
 *
 * @see https://open.feishu.cn/document/server-docs/im-v1/message/merge_forward
 */
export function parseForwardedHistory(
  content: string,
  messageType: string
): ForwardedHistoryInfo {
  try {
    const parsed = JSON.parse(content);

    // Check for merge_forward message type
    // Note: The actual message type might be 'text' but with forwarded content
    // We need to check the content structure

    // Check for forwarded content indicators in text messages
    if (messageType === 'text' && parsed.text) {
      // Pattern 1: Check for "转发消息" or similar indicators
      const forwardPatterns = [
        /【转发消息】/,
        /转发自.*/,
        /Forwarded message/i,
      ];

      const hasForwardIndicator = forwardPatterns.some(p => p.test(parsed.text));
      if (hasForwardIndicator) {
        return {
          isForwarded: true,
          messages: [{ content: parsed.text }],
          rawContent: content,
        };
      }
    }

    // Check for post (rich text) with forwarded content
    if (messageType === 'post' && parsed.content) {
      // Look for special tags or structures that indicate forwarded content
      const contentStr = JSON.stringify(parsed.content);

      // Check for quote/forward indicators in post content
      if (contentStr.includes('forward') || contentStr.includes('转发')) {
        let extractedText = '';
        for (const row of parsed.content) {
          if (Array.isArray(row)) {
            for (const segment of row) {
              if (segment?.tag === 'text' && segment.text) {
                extractedText += segment.text;
              }
            }
          }
        }
        return {
          isForwarded: true,
          messages: [{ content: extractedText }],
          rawContent: content,
        };
      }
    }

    // No forwarded content detected
    return { isForwarded: false };
  } catch (error) {
    logger.debug({ err: error, messageType }, 'Failed to parse message content for forwarded history');
    return { isForwarded: false };
  }
}

/**
 * Parse message context including quote replies and forwarded history.
 */
export async function parseMessageContext(
  client: lark.Client,
  parentId: string | undefined,
  content: string,
  messageType: string
): Promise<ParsedMessageContext> {
  const context: ParsedMessageContext = {};

  // Handle quote reply
  if (parentId) {
    const quoteReply = await fetchQuotedMessage(client, parentId);
    if (quoteReply) {
      context.quoteReply = quoteReply;
      logger.info(
        { parentId, hasContent: !!quoteReply.parentContent },
        'Parsed quote reply context'
      );
    }
  }

  // Handle forwarded history
  const forwardedHistory = parseForwardedHistory(content, messageType);
  if (forwardedHistory.isForwarded) {
    context.forwardedHistory = forwardedHistory;
    logger.info({ messageType }, 'Detected forwarded chat history');
  }

  return context;
}
