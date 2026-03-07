/**
 * Message Content Parser.
 *
 * Parses special Feishu message types:
 * - Quote replies (messages with parent_id)
 * - Merge forward messages (packed conversation history)
 *
 * Issue #846: Support for reading packed conversation records and quote replies
 */

import { createLogger } from '../../utils/logger.js';

const logger = createLogger('MessageContentParser');

/**
 * Parsed result for a quoted/referenced message.
 */
export interface QuotedMessage {
  /** The original message ID that was quoted */
  messageId: string;
  /** The text content of the quoted message (if available) */
  text?: string;
  /** Sender information (if available) */
  sender?: {
    openId?: string;
    name?: string;
  };
}

/**
 * Parsed result for a merge forward message (packed conversation history).
 */
export interface MergeForwardMessage {
  /** Title of the forwarded conversation */
  title?: string;
  /** List of messages in the forwarded conversation */
  messages: Array<{
    /** Sender name */
    sender?: string;
    /** Timestamp (if available) */
    timestamp?: string;
    /** Message content */
    content: string;
    /** Original message type */
    messageType?: string;
  }>;
}

/**
 * Parsed content result with optional quote and merge forward data.
 */
export interface ParsedMessageContent {
  /** The main text content of the message */
  text: string;
  /** Quoted message info (if this is a quote reply) */
  quotedMessage?: QuotedMessage;
  /** Merge forward data (if this is a packed conversation) */
  mergeForward?: MergeForwardMessage;
  /** Whether this message contains special content that needs processing */
  hasSpecialContent: boolean;
}

/**
 * Parse text message content.
 * Handles both plain text and text with quote references.
 */
export function parseTextMessage(content: string): { text: string; quote?: { text: string } } {
  try {
    const parsed = JSON.parse(content);
    const text = parsed.text?.trim() || '';

    // Check for quote content in the message
    // Feishu text messages may include quoted content in specific fields
    if (parsed.quote) {
      return {
        text,
        quote: {
          text: parsed.quote,
        },
      };
    }

    return { text };
  } catch {
    logger.debug({ content }, 'Failed to parse text message content');
    return { text: content };
  }
}

/**
 * Parse post (rich text) message content.
 * Extracts text from rich text segments.
 */
export function parsePostMessage(content: string): string {
  try {
    const parsed = JSON.parse(content);
    let text = '';

    if (parsed.content && Array.isArray(parsed.content)) {
      for (const row of parsed.content) {
        if (Array.isArray(row)) {
          for (const segment of row) {
            if (segment?.tag === 'text' && segment.text) {
              text += segment.text;
            }
          }
        }
      }
    }

    return text.trim();
  } catch {
    logger.debug({ content }, 'Failed to parse post message content');
    return '';
  }
}

/**
 * Parse merge forward message content (packed conversation history).
 *
 * Feishu merge forward messages have message_type "merge_forward" and contain
 * a list of messages that were forwarded together.
 *
 * Content structure (example):
 * {
 *   "mergedTitle": "聊天记录",
 *   "mergedMessageList": [
 *     {
 *       "createTime": "1234567890",
 *       "sender": { "id": "...", "name": "..." },
 *       "body": { "content": "...", "type": "text" }
 *     }
 *   ]
 * }
 */
export function parseMergeForwardMessage(content: string): MergeForwardMessage | null {
  try {
    const parsed = JSON.parse(content);

    // Check for merge forward structure
    if (!parsed.mergedMessageList || !Array.isArray(parsed.mergedMessageList)) {
      return null;
    }

    const messages: MergeForwardMessage['messages'] = [];

    for (const msg of parsed.mergedMessageList) {
      let messageContent = '';

      // Extract content based on message type
      if (msg.body?.content) {
        try {
          const bodyContent = JSON.parse(msg.body.content);
          if (bodyContent.text) {
            messageContent = bodyContent.text;
          } else if (bodyContent.content) {
            // For rich text posts
            messageContent = parsePostMessage(msg.body.content);
          }
        } catch {
          messageContent = msg.body.content;
        }
      }

      messages.push({
        sender: msg.sender?.name,
        timestamp: msg.createTime,
        content: messageContent,
        messageType: msg.body?.type,
      });
    }

    return {
      title: parsed.mergedTitle || '聊天记录',
      messages,
    };
  } catch (error) {
    logger.debug({ err: error, content }, 'Failed to parse merge forward message');
    return null;
  }
}

/**
 * Format merge forward messages into a readable text.
 */
export function formatMergeForwardAsText(mergeForward: MergeForwardMessage): string {
  const lines: string[] = [];

  lines.push(`📝 **${mergeForward.title || '聊天记录'}**`);
  lines.push('');

  for (const msg of mergeForward.messages) {
    const sender = msg.sender || '未知';
    const timestamp = msg.timestamp ? `[${new Date(parseInt(msg.timestamp)).toLocaleString('zh-CN')}]` : '';
    lines.push(`**${sender}** ${timestamp}:`);
    lines.push(`> ${msg.content}`);
    lines.push('');
  }

  return lines.join('\n');
}

/**
 * Build a prompt context for messages with quoted content.
 *
 * When a user replies with a quote, this function generates context
 * that helps the agent understand what the user is referring to.
 */
export function buildQuoteContextPrompt(
  userMessage: string,
  quotedMessage?: QuotedMessage,
  mergeForward?: MergeForwardMessage
): string {
  const contextParts: string[] = [];

  // Add merge forward context
  if (mergeForward && mergeForward.messages.length > 0) {
    contextParts.push('📋 **用户转发了以下聊天记录：**');
    contextParts.push(formatMergeForwardAsText(mergeForward));
    contextParts.push('');
  }

  // Add quoted message context
  if (quotedMessage?.text) {
    contextParts.push('💬 **用户引用了以下消息：**');
    if (quotedMessage.sender?.name) {
      contextParts.push(`> 来自 ${quotedMessage.sender.name}:`);
    }
    contextParts.push(`> ${quotedMessage.text}`);
    contextParts.push('');
  }

  // Add user's actual message
  contextParts.push('📝 **用户的消息：**');
  contextParts.push(userMessage);

  return contextParts.join('\n');
}

/**
 * Check if a message type needs special content parsing.
 */
export function needsSpecialParsing(messageType: string): boolean {
  return messageType === 'merge_forward';
}

/**
 * Parse message content and extract all relevant information.
 *
 * This is the main entry point for parsing Feishu message content.
 * It handles text, post, and merge_forward message types.
 */
export function parseMessageContent(
  content: string,
  messageType: string,
  parentId?: string
): ParsedMessageContent {
  let text = '';
  let mergeForward: MergeForwardMessage | undefined;
  let quotedMessage: QuotedMessage | undefined;

  // Parse based on message type
  if (messageType === 'text') {
    const result = parseTextMessage(content);
    text = result.text;
    if (result.quote) {
      quotedMessage = {
        messageId: parentId || '',
        text: result.quote.text,
      };
    }
  } else if (messageType === 'post') {
    text = parsePostMessage(content);
  } else if (messageType === 'merge_forward') {
    const parsed = parseMergeForwardMessage(content);
    if (parsed) {
      mergeForward = parsed;
      // Also generate a summary text
      text = `[转发了 ${parsed.messages.length} 条聊天记录]`;
    }
  } else {
    // Try to parse as JSON and extract text
    try {
      const parsed = JSON.parse(content);
      text = parsed.text?.trim() || content;
    } catch {
      text = content;
    }
  }

  // If there's a parent_id but no quote was extracted from content,
  // mark that we have a quoted message (will need to fetch content via API)
  if (parentId && !quotedMessage) {
    quotedMessage = {
      messageId: parentId,
    };
  }

  const hasSpecialContent = !!(mergeForward || quotedMessage);

  return {
    text,
    quotedMessage,
    mergeForward,
    hasSpecialContent,
  };
}

/**
 * Fetch quoted message content via API.
 *
 * This function retrieves the original message content when the user
 * has quoted/replied to a previous message.
 *
 * Note: This requires the lark client to call the API.
 */
export async function fetchQuotedMessageContent(
  client: { im: { message: { get: (params: unknown) => Promise<unknown> } } },
  messageId: string
): Promise<string | null> {
  try {
    const response = await client.im.message.get({
      path: {
        message_id: messageId,
      },
    });

    // Type guard for response
    const data = response as { data?: { message?: { content?: string; body?: { content?: string } } } };
    if (data.data?.message?.content) {
      return data.data.message.content;
    }
    if (data.data?.message?.body?.content) {
      return data.data.message.body.content;
    }

    return null;
  } catch (error) {
    logger.debug({ err: error, messageId }, 'Failed to fetch quoted message content');
    return null;
  }
}
