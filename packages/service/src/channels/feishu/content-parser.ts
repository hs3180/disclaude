/**
 * Content parser utilities for Feishu messages.
 *
 * Extracted from message-handler.ts (Issue #4126 part 1).
 * Pure functions for parsing various Feishu message content types.
 *
 * @module channels/feishu/content-parser
 */

/**
 * Extract open_id from a Feishu sender object.
 */
export function extractOpenId(
  sender?: { sender_type?: string; sender_id?: unknown },
): string | undefined {
  if (!sender?.sender_id) {
    return undefined;
  }
  if (typeof sender.sender_id === 'object' && sender.sender_id !== null) {
    const senderId = sender.sender_id as { open_id?: string };
    return senderId.open_id;
  }
  if (typeof sender.sender_id === 'string') {
    return sender.sender_id;
  }
  return undefined;
}

/**
 * Parse post message content with support for rich text elements.
 * Issue #846: Add support for code_block, pre, and chat_history tags.
 *
 * Supported tags:
 * - text: Plain text
 * - a: Links
 * - at: Mentions
 * - img: Images (represented as [图片])
 * - code_block: Code blocks (converted to markdown format)
 * - pre: Preformatted text (converted to markdown format)
 * - chat_history: Forwarded chat history
 */
export function parsePostContent(content: unknown[]): string {
  let text = '';

  for (const row of content) {
    if (!Array.isArray(row)) {
      continue;
    }
    for (const segment of row) {
      if (!segment?.tag) {
        continue;
      }

      switch (segment.tag) {
        case 'text':
          text += segment.text || '';
          break;

        case 'a':
          text += segment.text || segment.href || '';
          break;

        case 'at':
          text += `@${segment.text || segment.user_id || 'user'}`;
          break;

        case 'img':
          text += '[图片]';
          break;

        case 'code_block':
        case 'pre': {
          // Extract code content and language
          const lang = segment.language || '';
          const code = segment.text || segment.content || '';
          if (code) {
            text += `\n\`\`\`${lang}\n${code}\n\`\`\`\n`;
          }
          break;
        }

        case 'chat_history': {
          // Parse forwarded chat history content
          const historyContent = parseChatHistoryElement(segment);
          if (historyContent) {
            text += historyContent;
          }
          break;
        }

        default:
          // For unknown tags, try to extract text if available
          if (segment.text) {
            text += segment.text;
          }
      }
    }
  }

  return text.trim();
}

/**
 * Parse chat_history element from post message.
 * Issue #846: Support for forwarded chat history within post messages.
 */
export function parseChatHistoryElement(element: { [key: string]: unknown }): string {
  const messages = element.messages || element.content;
  if (!Array.isArray(messages)) {
    return '';
  }

  let result = '\n--- 转发的聊天记录 ---\n';

  for (const msg of messages) {
    const sender = msg.sender || msg.from || '未知发送者';
    const content = msg.content || msg.text || msg.body || '';
    const time = msg.create_time || msg.timestamp || '';

    if (time) {
      result += `[${time}] `;
    }
    result += `${sender}: ${content}\n`;
  }

  result += '--- 转发结束 ---\n';
  return result;
}

/**
 * Parse share_chat message content (merged/forwarded messages).
 * Issue #846: Support for share_chat message type.
 *
 * share_chat messages contain forwarded chat history with multiple messages.
 */
export function parseShareChatContent(parsed: { [key: string]: unknown }): string {
  // Check for chat_history in the message content
  const chatHistory = parsed.chat_history || parsed.messages || [];
  const title = parsed.title || '转发的聊天记录';

  if (!Array.isArray(chatHistory) || chatHistory.length === 0) {
    // If no structured history, try to extract from body or text
    const body = parsed.body || parsed.text || '';
    if (body) {
      return `[转发消息] ${body}`;
    }
    return '[转发消息] 无法解析内容';
  }

  let result = `\n### 📋 ${title}\n\n`;

  for (const msg of chatHistory) {
    const msgData = msg as { [key: string]: unknown };
    const sender = extractSenderName(msgData);
    const content = extractMessageContent(msgData);
    const time = formatMessageTime(msgData);

    if (time) {
      result += `**[${time}]** `;
    }
    result += `**${sender}**: ${content}\n\n`;
  }

  return result.trim();
}

/**
 * Extract sender name from message data.
 */
export function extractSenderName(msgData: { [key: string]: unknown }): string {
  // Try various possible sender field names
  const sender = msgData.sender
    || msgData.from
    || msgData.sender_name
    || msgData.author
    || msgData.user
    || '未知发送者';

  if (typeof sender === 'string') {
    return sender;
  }

  if (typeof sender === 'object' && sender !== null) {
    const senderObj = sender as { [key: string]: unknown };
    return String(senderObj.name || senderObj.nickname || senderObj.open_id || '未知发送者');
  }

  return '未知发送者';
}

/**
 * Extract message content from message data.
 */
export function extractMessageContent(msgData: { [key: string]: unknown }): string {
  // Try various possible content field names
  const content = msgData.content
    || msgData.body
    || msgData.text
    || msgData.message
    || '';

  if (typeof content === 'string') {
    return content;
  }

  if (typeof content === 'object' && content !== null) {
    // Handle nested content structure
    const contentObj = content as { [key: string]: unknown };
    if (contentObj.text) {
      return String(contentObj.text);
    }
    // For post messages, parse the content
    if (Array.isArray(contentObj.content)) {
      return parsePostContent(contentObj.content);
    }
  }

  return String(content);
}

/**
 * Format message timestamp to readable string.
 */
export function formatMessageTime(msgData: { [key: string]: unknown }): string {
  const timestamp = msgData.create_time
    || msgData.timestamp
    || msgData.time
    || msgData.created_at;

  if (!timestamp) {
    return '';
  }

  try {
    // Handle Unix timestamp (seconds or milliseconds)
    let ms: number;
    if (typeof timestamp === 'number') {
      ms = timestamp > 1e12 ? timestamp : timestamp * 1000;
    } else if (typeof timestamp === 'string') {
      ms = parseInt(timestamp, 10);
      if (ms > 1e12) {
        // Already in milliseconds
      } else {
        ms *= 1000;
      }
    } else {
      return '';
    }

    const date = new Date(ms);
    if (isNaN(date.getTime())) {
      return '';
    }

    // Format as HH:MM
    return date.toLocaleTimeString('zh-CN', {
      hour: '2-digit',
      minute: '2-digit',
    });
  } catch {
    return '';
  }
}
