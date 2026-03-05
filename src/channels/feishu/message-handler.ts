/**
 * Message Handler Helpers for Feishu Channel.
 *
 * Provides utility functions for processing Feishu messages,
 * including content parsing, user ID extraction, and chat history context.
 */

import { createLogger } from '../../utils/logger.js';
import { CHAT_HISTORY } from '../../config/constants.js';
import { messageLogger } from '../../feishu/message-logger.js';
import type { FeishuMessageEvent } from '../../types/platform.js';

const logger = createLogger('MessageHandler');

/**
 * Extract open_id from sender object.
 *
 * @param sender - Sender object from Feishu message event
 * @returns User's open_id or undefined
 */
export function extractOpenId(
  sender?: { sender_type?: string; sender_id?: unknown }
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
 * Check if the chat is a group chat.
 * Uses chat_type field from message event.
 *
 * @param chatType - Chat type from message event ('p2p', 'group', 'topic')
 * @returns true if it's a group chat
 */
export function isGroupChat(chatType?: string): boolean {
  return chatType === 'group' || chatType === 'topic';
}

/**
 * Parse text content from Feishu message.
 * Handles both 'text' and 'post' message types.
 *
 * @param content - Raw content string from Feishu
 * @param messageType - Type of message ('text' or 'post')
 * @returns Parsed text content or empty string
 */
export function parseTextContent(content: string, messageType: string): string {
  try {
    const parsed = JSON.parse(content);
    if (messageType === 'text') {
      return parsed.text?.trim() || '';
    }
    if (messageType === 'post' && parsed.content && Array.isArray(parsed.content)) {
      let text = '';
      for (const row of parsed.content) {
        if (Array.isArray(row)) {
          for (const segment of row) {
            if (segment?.tag === 'text' && segment.text) {
              text += segment.text;
            }
          }
        }
      }
      return text.trim();
    }
  } catch {
    logger.error('Failed to parse content');
  }
  return '';
}

/**
 * Get formatted chat history context for passive mode.
 * Issue #517: Include recent chat history when bot is mentioned in group chats.
 *
 * @param chatId - Chat ID to get history for
 * @returns Formatted chat history string, or undefined if no history
 */
export async function getChatHistoryContext(chatId: string): Promise<string | undefined> {
  try {
    const rawHistory = await messageLogger.getChatHistory(chatId);

    if (!rawHistory || rawHistory.length === 0) {
      return undefined;
    }

    // Truncate if too long (keep the most recent content)
    let history = rawHistory;
    if (history.length > CHAT_HISTORY.MAX_CONTEXT_LENGTH) {
      // Try to truncate at a reasonable point (e.g., at a message boundary)
      const truncatePoint = history.lastIndexOf('## [', history.length - CHAT_HISTORY.MAX_CONTEXT_LENGTH);
      if (truncatePoint > 0) {
        history = `...(earlier messages truncated)...\n\n${history.slice(truncatePoint)}`;
      } else {
        // Fallback: just truncate from the end
        history = history.slice(-CHAT_HISTORY.MAX_CONTEXT_LENGTH);
        history = `...(earlier messages truncated)...\n\n${history.slice(history.indexOf('## ['))}`;
      }
    }

    return history;
  } catch (error) {
    logger.error({ err: error, chatId }, 'Failed to get chat history context');
    return undefined;
  }
}

/**
 * Result of parsing a Feishu message event.
 */
export interface ParsedMessageEvent {
  messageId: string;
  chatId: string;
  chatType?: string;
  content: string;
  messageType: string;
  createTime?: number;
  threadId: string;
  mentions?: FeishuMessageEvent['message']['mentions'];
  userId?: string;
}

/**
 * Parse a Feishu message event into structured data.
 *
 * @param event - Raw Feishu message event
 * @returns Parsed message data or undefined if invalid
 */
export function parseMessageEvent(event: FeishuMessageEvent): ParsedMessageEvent | undefined {
  const { message, sender } = event;

  if (!message) {
    return undefined;
  }

  const { message_id, chat_id, chat_type, content, message_type, create_time, mentions } = message;

  if (!message_id || !chat_id || !content || !message_type) {
    logger.warn('Missing required message fields');
    return undefined;
  }

  return {
    messageId: message_id,
    chatId: chat_id,
    chatType: chat_type,
    content,
    messageType: message_type,
    createTime: create_time,
    threadId: message_id, // Bot replies set parent_id = message_id
    mentions,
    userId: extractOpenId(sender),
  };
}
