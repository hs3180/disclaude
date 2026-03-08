/**
 * Thread tools for topic-mode chat operations.
 *
 * Implements Issue #873: Topic group extension - post/reply and thread management.
 *
 * Tools provided:
 * - reply_in_thread: Reply to a thread (follow-up post)
 * - get_threads: Get thread list from a chat
 * - get_thread_messages: Get messages in a thread
 *
 * @module mcp/tools/thread-tools
 */

import * as lark from '@larksuiteoapi/node-sdk';
import { createLogger } from '../../utils/logger.js';
import { Config } from '../../config/index.js';
import { createFeishuClient } from '../../platforms/feishu/create-feishu-client.js';
import {
  replyInThread,
  getThreads,
  getThreadMessages,
} from '../utils/feishu-api.js';

const logger = createLogger('ThreadTools');

/**
 * Result type for reply_in_thread tool.
 */
export interface ReplyInThreadToolResult {
  success: boolean;
  message: string;
  messageId?: string;
  error?: string;
}

/**
 * Result type for get_threads tool.
 */
export interface GetThreadsToolResult {
  success: boolean;
  message: string;
  threads?: Array<{
    messageId: string;
    threadId: string;
    contentType: string;
    content: string;
    createTime: string;
    senderId?: string;
  }>;
  hasMore?: boolean;
  pageToken?: string;
  error?: string;
}

/**
 * Result type for get_thread_messages tool.
 */
export interface GetThreadMessagesToolResult {
  success: boolean;
  message: string;
  messages?: Array<{
    messageId: string;
    parentMessageId?: string;
    threadId?: string;
    contentType: string;
    content: string;
    createTime: string;
    senderId?: string;
  }>;
  hasMore?: boolean;
  pageToken?: string;
  error?: string;
}

/**
 * Reply to a message in a thread (follow-up post).
 *
 * In a topic-mode chat, this creates a reply to a thread.
 * The message will appear as a follow-up post in the thread.
 *
 * @param params - Tool parameters
 * @returns Result with success status
 */
export async function reply_in_thread(params: {
  /** The message ID to reply to (root message of the thread) */
  messageId: string;
  /** Message content (text or card JSON) */
  content: string;
  /** Message format: 'text' or 'card' */
  format: 'text' | 'card';
}): Promise<ReplyInThreadToolResult> {
  const { messageId, content, format } = params;

  logger.info({
    messageId,
    format,
    contentLength: content?.length ?? 0,
  }, 'reply_in_thread called');

  try {
    // Validate required parameters
    if (!messageId) {
      return {
        success: false,
        message: '❌ messageId is required',
        error: 'messageId is required',
      };
    }

    if (!content) {
      return {
        success: false,
        message: '❌ content is required',
        error: 'content is required',
      };
    }

    // Get Feishu credentials
    const appId = Config.FEISHU_APP_ID;
    const appSecret = Config.FEISHU_APP_SECRET;

    if (!appId || !appSecret) {
      const errorMsg = 'Feishu credentials not configured. Please set FEISHU_APP_ID and FEISHU_APP_SECRET in disclaude.config.yaml';
      logger.error({ messageId }, errorMsg);
      return { success: false, message: `❌ ${errorMsg}`, error: errorMsg };
    }

    // Create client
    const client = createFeishuClient(appId, appSecret, { domain: lark.Domain.Feishu });

    // Prepare content based on format
    const msgType = format === 'card' ? 'interactive' : 'text';
    const messageContent = format === 'text'
      ? JSON.stringify({ text: content })
      : content;

    // Send reply in thread
    const result = await replyInThread(client, messageId, msgType as 'text' | 'interactive', messageContent);

    if (result.success) {
      logger.info({ messageId, replyId: result.messageId }, 'Reply sent successfully');
      return {
        success: true,
        message: `✅ Reply sent to thread`,
        messageId: result.messageId,
      };
    } else {
      logger.error({ messageId, error: result.error }, 'Reply failed');
      return {
        success: false,
        message: `❌ Failed to send reply: ${result.error}`,
        error: result.error,
      };
    }
  } catch (error) {
    logger.error({ err: error, messageId }, 'reply_in_thread FAILED');
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    return {
      success: false,
      message: `❌ Failed to send reply: ${errorMessage}`,
      error: errorMessage,
    };
  }
}

/**
 * Get threads (topic list) from a chat.
 *
 * Retrieves the list of threads in a topic-mode chat.
 * Each thread is represented by its root message.
 *
 * @param params - Tool parameters
 * @returns Result with thread list
 */
export async function get_threads(params: {
  /** Chat ID to get threads from */
  chatId: string;
  /** Number of threads to retrieve (default: 20, max: 50) */
  pageSize?: number;
  /** Page token for pagination */
  pageToken?: string;
}): Promise<GetThreadsToolResult> {
  const { chatId, pageSize = 20, pageToken } = params;

  logger.info({
    chatId,
    pageSize,
    hasPageToken: !!pageToken,
  }, 'get_threads called');

  try {
    // Validate required parameters
    if (!chatId) {
      return {
        success: false,
        message: '❌ chatId is required',
        error: 'chatId is required',
      };
    }

    // Get Feishu credentials
    const appId = Config.FEISHU_APP_ID;
    const appSecret = Config.FEISHU_APP_SECRET;

    if (!appId || !appSecret) {
      const errorMsg = 'Feishu credentials not configured. Please set FEISHU_APP_ID and FEISHU_APP_SECRET in disclaude.config.yaml';
      logger.error({ chatId }, errorMsg);
      return { success: false, message: `❌ ${errorMsg}`, error: errorMsg };
    }

    // Create client
    const client = createFeishuClient(appId, appSecret, { domain: lark.Domain.Feishu });

    // Get threads
    const result = await getThreads(client, chatId, pageSize, pageToken);

    if (result.success) {
      logger.info({ chatId, threadCount: result.threads.length, hasMore: result.hasMore }, 'Threads retrieved');
      return {
        success: true,
        message: `✅ Retrieved ${result.threads.length} threads`,
        threads: result.threads,
        hasMore: result.hasMore,
        pageToken: result.pageToken,
      };
    } else {
      logger.error({ chatId, error: result.error }, 'Get threads failed');
      return {
        success: false,
        message: `❌ Failed to get threads: ${result.error}`,
        error: result.error,
      };
    }
  } catch (error) {
    logger.error({ err: error, chatId }, 'get_threads FAILED');
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    return {
      success: false,
      message: `❌ Failed to get threads: ${errorMessage}`,
      error: errorMessage,
    };
  }
}

/**
 * Get messages in a thread (thread detail).
 *
 * Retrieves all messages in a specific thread.
 * The first message is the root message, followed by replies.
 *
 * @param params - Tool parameters
 * @returns Result with message list
 */
export async function get_thread_messages(params: {
  /** Thread ID to get messages from */
  threadId: string;
  /** Number of messages to retrieve (default: 20, max: 50) */
  pageSize?: number;
  /** Page token for pagination */
  pageToken?: string;
}): Promise<GetThreadMessagesToolResult> {
  const { threadId, pageSize = 20, pageToken } = params;

  logger.info({
    threadId,
    pageSize,
    hasPageToken: !!pageToken,
  }, 'get_thread_messages called');

  try {
    // Validate required parameters
    if (!threadId) {
      return {
        success: false,
        message: '❌ threadId is required',
        error: 'threadId is required',
      };
    }

    // Get Feishu credentials
    const appId = Config.FEISHU_APP_ID;
    const appSecret = Config.FEISHU_APP_SECRET;

    if (!appId || !appSecret) {
      const errorMsg = 'Feishu credentials not configured. Please set FEISHU_APP_ID and FEISHU_APP_SECRET in disclaude.config.yaml';
      logger.error({ threadId }, errorMsg);
      return { success: false, message: `❌ ${errorMsg}`, error: errorMsg };
    }

    // Create client
    const client = createFeishuClient(appId, appSecret, { domain: lark.Domain.Feishu });

    // Get thread messages
    const result = await getThreadMessages(client, threadId, pageSize, pageToken);

    if (result.success) {
      logger.info({ threadId, messageCount: result.messages.length, hasMore: result.hasMore }, 'Thread messages retrieved');
      return {
        success: true,
        message: `✅ Retrieved ${result.messages.length} messages`,
        messages: result.messages,
        hasMore: result.hasMore,
        pageToken: result.pageToken,
      };
    } else {
      logger.error({ threadId, error: result.error }, 'Get thread messages failed');
      return {
        success: false,
        message: `❌ Failed to get thread messages: ${result.error}`,
        error: result.error,
      };
    }
  } catch (error) {
    logger.error({ err: error, threadId }, 'get_thread_messages FAILED');
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    return {
      success: false,
      message: `❌ Failed to get thread messages: ${errorMessage}`,
      error: errorMessage,
    };
  }
}
