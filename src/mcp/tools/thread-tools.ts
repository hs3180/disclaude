/**
 * Thread Tools - MCP tools for topic group thread operations.
 *
 * Provides tools for:
 * - reply_in_thread - Reply to a message in thread mode (follow-up post)
 * - get_threads - Get list of threads (topics) in a chat
 * - get_thread_messages - Get messages in a specific thread
 *
 * @module mcp/tools/thread-tools
 * @see Issue #873 - 话题群扩展 - 群管理操作与发帖跟帖接口
 */

import * as lark from '@larksuiteoapi/node-sdk';
import { createLogger } from '../../utils/logger.js';
import { Config } from '../../config/index.js';
import { createFeishuClient } from '../../platforms/feishu/create-feishu-client.js';
import {
  replyInThread,
  fetchMessages,
  type ThreadMessage,
} from '../utils/feishu-api.js';

const logger = createLogger('ThreadTools');

/**
 * Result type for thread tools.
 */
interface ThreadToolResult {
  success: boolean;
  message?: string;
  error?: string;
  data?: unknown;
}

/**
 * Format a thread message for display.
 */
function formatThreadMessage(msg: ThreadMessage): string {
  const lines: string[] = [];
  lines.push(`- **Message ID**: ${msg.messageId}`);
  if (msg.threadId) {
    lines.push(`  **Thread ID**: ${msg.threadId}`);
  }
  lines.push(`  **Type**: ${msg.msgType}`);
  lines.push(`  **Time**: ${msg.createTime}`);
  if (msg.sender) {
    lines.push(`  **Sender**: ${msg.sender.id} (${msg.sender.type})`);
  }
  // Truncate content for display
  const contentPreview = msg.content.length > 100
    ? msg.content.substring(0, 100) + '...'
    : msg.content;
  lines.push(`  **Content**: ${contentPreview}`);
  return lines.join('\n');
}

/**
 * reply_in_thread tool - Reply to a message in thread mode.
 *
 * This creates a follow-up post in a topic group, where each message
 * is a topic and replies become follow-up posts.
 *
 * @param params - Tool parameters
 * @param params.messageId - The parent message ID to reply to
 * @param params.content - Message content (text or card JSON)
 * @param params.format - 'text' or 'card'
 */
export async function reply_in_thread(params: {
  messageId: string;
  content: string | Record<string, unknown>;
  format: 'text' | 'card';
}): Promise<ThreadToolResult> {
  const { messageId, content, format } = params;

  logger.info({
    messageId,
    format,
    contentPreview: typeof content === 'string' ? content.substring(0, 100) : JSON.stringify(content).substring(0, 100),
  }, 'reply_in_thread called');

  try {
    if (!messageId) {
      return { success: false, error: 'messageId is required' };
    }
    if (!content) {
      return { success: false, error: 'content is required' };
    }

    const appId = Config.FEISHU_APP_ID;
    const appSecret = Config.FEISHU_APP_SECRET;

    if (!appId || !appSecret) {
      const errorMsg = 'Feishu credentials not configured';
      logger.error({ messageId }, errorMsg);
      return { success: false, error: errorMsg };
    }

    const client = createFeishuClient(appId, appSecret, { domain: lark.Domain.Feishu });

    const msgType = format === 'card' ? 'interactive' : 'text';
    const contentStr = typeof content === 'string' ? content : JSON.stringify(content);

    const result = await replyInThread(client, messageId, msgType, contentStr);

    if (result.messageId) {
      logger.info({ messageId: result.messageId, parentMessageId: messageId }, 'Thread reply sent');
      return {
        success: true,
        message: `✅ Thread reply sent. Message ID: ${result.messageId}`,
        data: { replyMessageId: result.messageId },
      };
    } else {
      return { success: false, error: 'Failed to send thread reply' };
    }
  } catch (error) {
    logger.error({ err: error, messageId }, 'reply_in_thread FAILED');
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    return { success: false, error: errorMessage };
  }
}

/**
 * get_threads tool - Get list of threads (topics) in a chat.
 *
 * In a topic group, each root message is a thread/topic.
 * This tool fetches all root messages in the chat.
 *
 * @param params - Tool parameters
 * @param params.chatId - The chat ID to fetch threads from
 * @param params.pageSize - Number of threads to fetch (default 20)
 * @param params.pageToken - Pagination token for next page
 */
export async function get_threads(params: {
  chatId: string;
  pageSize?: number;
  pageToken?: string;
}): Promise<ThreadToolResult> {
  const { chatId, pageSize = 20, pageToken } = params;

  logger.info({ chatId, pageSize, pageToken: !!pageToken }, 'get_threads called');

  try {
    if (!chatId) {
      return { success: false, error: 'chatId is required' };
    }

    const appId = Config.FEISHU_APP_ID;
    const appSecret = Config.FEISHU_APP_SECRET;

    if (!appId || !appSecret) {
      const errorMsg = 'Feishu credentials not configured';
      logger.error({ chatId }, errorMsg);
      return { success: false, error: errorMsg };
    }

    const client = createFeishuClient(appId, appSecret, { domain: lark.Domain.Feishu });

    const result = await fetchMessages(client, 'chat', chatId, pageSize, pageToken);

    // Filter to only include messages with thread_id (root messages in topics)
    const threads = result.items.filter(msg => msg.threadId);

    const formattedThreads = threads.map(formatThreadMessage);

    logger.info({ chatId, threadCount: threads.length, hasMore: result.hasMore }, 'Threads fetched');

    return {
      success: true,
      message: `📋 Found ${threads.length} threads${result.hasMore ? ' (more available)' : ''}`,
      data: {
        threads: threads.map(t => ({
          messageId: t.messageId,
          threadId: t.threadId,
          msgType: t.msgType,
          createTime: t.createTime,
        })),
        hasMore: result.hasMore,
        pageToken: result.pageToken,
        formatted: formattedThreads.join('\n\n'),
      },
    };
  } catch (error) {
    logger.error({ err: error, chatId }, 'get_threads FAILED');
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    return { success: false, error: errorMessage };
  }
}

/**
 * get_thread_messages tool - Get messages in a specific thread.
 *
 * Fetches all messages (posts) within a specific thread/topic.
 *
 * @param params - Tool parameters
 * @param params.threadId - The thread ID (starts with 'omt_')
 * @param params.pageSize - Number of messages to fetch (default 50)
 * @param params.pageToken - Pagination token for next page
 */
export async function get_thread_messages(params: {
  threadId: string;
  pageSize?: number;
  pageToken?: string;
}): Promise<ThreadToolResult> {
  const { threadId, pageSize = 50, pageToken } = params;

  logger.info({ threadId, pageSize, pageToken: !!pageToken }, 'get_thread_messages called');

  try {
    if (!threadId) {
      return { success: false, error: 'threadId is required' };
    }

    const appId = Config.FEISHU_APP_ID;
    const appSecret = Config.FEISHU_APP_SECRET;

    if (!appId || !appSecret) {
      const errorMsg = 'Feishu credentials not configured';
      logger.error({ threadId }, errorMsg);
      return { success: false, error: errorMsg };
    }

    const client = createFeishuClient(appId, appSecret, { domain: lark.Domain.Feishu });

    const result = await fetchMessages(client, 'thread', threadId, pageSize, pageToken);

    const formattedMessages = result.items.map(formatThreadMessage);

    logger.info({ threadId, messageCount: result.items.length, hasMore: result.hasMore }, 'Thread messages fetched');

    return {
      success: true,
      message: `📋 Found ${result.items.length} messages in thread${result.hasMore ? ' (more available)' : ''}`,
      data: {
        messages: result.items.map(m => ({
          messageId: m.messageId,
          msgType: m.msgType,
          content: m.content,
          createTime: m.createTime,
          sender: m.sender,
        })),
        hasMore: result.hasMore,
        pageToken: result.pageToken,
        formatted: formattedMessages.join('\n\n'),
      },
    };
  } catch (error) {
    logger.error({ err: error, threadId }, 'get_thread_messages FAILED');
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    return { success: false, error: errorMessage };
  }
}
