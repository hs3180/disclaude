/**
 * Thread operations MCP tools for topic groups.
 *
 * Implements topic group features:
 * - Reply in thread (跟帖)
 * - Get threads list (获取话题列表)
 * - Get thread messages (获取话题详情)
 *
 * @see Issue #873 - 话题群扩展 - 群管理操作与发帖跟帖接口
 * @see https://open.larksuite.com/document/uAjLw4CM/ukTMukTMukTM/reference/im-v1/message/thread-introduction
 *
 * @module mcp/tools/thread-operations
 */

import * as lark from '@larksuiteoapi/node-sdk';
import { existsSync } from 'fs';
import { createLogger } from '../../utils/logger.js';
import { Config } from '../../config/index.js';
import { createFeishuClient } from '../../platforms/feishu/create-feishu-client.js';
import { getIpcClient } from '../../ipc/unix-socket-client.js';
import { DEFAULT_IPC_CONFIG } from '../../ipc/protocol.js';

const logger = createLogger('ThreadOperations');

// ============================================================================
// Types
// ============================================================================

/**
 * Thread info from Feishu API.
 */
export interface ThreadInfo {
  /** Thread ID (message ID of the root message) */
  threadId: string;
  /** Root message ID */
  messageId: string;
  /** Message content (text) */
  content?: string;
  /** Sender open_id */
  senderId?: string;
  /** Create time (Unix timestamp in seconds) */
  createTime?: number;
  /** Reply count */
  replyCount?: number;
}

/**
 * Thread message info.
 */
export interface ThreadMessageInfo {
  /** Message ID */
  messageId: string;
  /** Thread ID */
  threadId?: string;
  /** Message content (text) */
  content?: string;
  /** Sender open_id */
  senderId?: string;
  /** Create time (Unix timestamp in seconds) */
  createTime?: number;
  /** Message type */
  msgType?: string;
}

/**
 * Result type for reply_in_thread tool.
 */
export interface ReplyInThreadResult {
  success: boolean;
  message: string;
  messageId?: string;
  error?: string;
}

/**
 * Result type for get_threads tool.
 */
export interface GetThreadsResult {
  success: boolean;
  message: string;
  threads?: ThreadInfo[];
  hasMore?: boolean;
  pageToken?: string;
  error?: string;
}

/**
 * Result type for get_thread_messages tool.
 */
export interface GetThreadMessagesResult {
  success: boolean;
  message: string;
  messages?: ThreadMessageInfo[];
  hasMore?: boolean;
  pageToken?: string;
  error?: string;
}

// ============================================================================
// IPC Support
// ============================================================================

/**
 * Check if IPC is available for Feishu API calls.
 */
function isIpcAvailable(): boolean {
  return existsSync(DEFAULT_IPC_CONFIG.socketPath);
}

/**
 * Get Feishu client - either via IPC or directly.
 */
function getClient(): lark.Client | null {
  const appId = Config.FEISHU_APP_ID;
  const appSecret = Config.FEISHU_APP_SECRET;

  if (!appId || !appSecret) {
    return null;
  }

  return createFeishuClient(appId, appSecret, { domain: lark.Domain.Feishu });
}

// ============================================================================
// Tool Implementations
// ============================================================================

/**
 * Reply to a thread (跟帖).
 *
 * Uses Feishu's reply API with reply_in_thread parameter to create
 * a threaded reply in topic groups.
 *
 * @param params - Reply parameters
 * @returns Result with message ID
 *
 * @see https://open.larksuite.com/document/server-docs/im-v1/message/reply
 */
export async function reply_in_thread(params: {
  messageId: string;
  content: string;
  msgType?: 'text' | 'post' | 'image' | 'file' | 'audio' | 'media';
}): Promise<ReplyInThreadResult> {
  const { messageId, content, msgType = 'text' } = params;

  logger.info({
    messageId,
    msgType,
    contentLength: content.length,
  }, 'reply_in_thread called');

  try {
    if (!messageId) {
      return { success: false, message: '❌ messageId is required', error: 'messageId is required' };
    }
    if (!content) {
      return { success: false, message: '❌ content is required', error: 'content is required' };
    }

    // Try IPC first if available
    if (isIpcAvailable()) {
      const ipcClient = getIpcClient();
      const result = await ipcClient.request('feishuReplyInThread', {
        messageId,
        content,
        msgType,
      });

      if (result.success) {
        logger.info({ messageId, replyId: result.messageId }, 'Thread reply sent via IPC');
        return {
          success: true,
          message: '✅ Thread reply sent successfully',
          messageId: result.messageId,
        };
      }

      return {
        success: false,
        message: '❌ Failed to send thread reply via IPC',
        error: 'IPC request failed',
      };
    }

    // Fallback: Use Feishu client directly
    const client = getClient();
    if (!client) {
      return {
        success: false,
        message: '❌ Feishu credentials not configured',
        error: 'Feishu credentials not configured',
      };
    }

    // Prepare content based on message type
    let messageContent: string;
    if (msgType === 'text') {
      messageContent = JSON.stringify({ text: content });
    } else {
      // For other types, content should be the raw content
      messageContent = content;
    }

    const response = await client.im.message.reply({
      path: { message_id: messageId },
      data: {
        msg_type: msgType,
        content: messageContent,
      },
    });

    const replyId = response?.data?.message_id;
    if (!replyId) {
      return {
        success: false,
        message: '❌ Failed to get message_id from response',
        error: 'No message_id in response',
      };
    }

    logger.info({ messageId, replyId }, 'Thread reply sent');
    return {
      success: true,
      message: '✅ Thread reply sent successfully',
      messageId: replyId,
    };

  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    logger.error({ err: error, messageId }, 'reply_in_thread FAILED');
    return {
      success: false,
      message: `❌ Failed to send thread reply: ${errorMessage}`,
      error: errorMessage,
    };
  }
}

/**
 * Get threads (topics) from a topic group chat.
 *
 * Retrieves the list of thread root messages from a chat.
 * In topic groups, each message is a thread root.
 *
 * @param params - Get threads parameters
 * @returns Result with thread list
 *
 * @see https://open.larksuite.com/document/server-docs/im-v1/message/list
 */
export async function get_threads(params: {
  chatId: string;
  pageToken?: string;
  pageSize?: number;
}): Promise<GetThreadsResult> {
  const { chatId, pageToken, pageSize = 50 } = params;

  logger.info({
    chatId,
    pageToken,
    pageSize,
  }, 'get_threads called');

  try {
    if (!chatId) {
      return { success: false, message: '❌ chatId is required', error: 'chatId is required' };
    }

    // Try IPC first if available
    if (isIpcAvailable()) {
      const ipcClient = getIpcClient();
      const result = await ipcClient.request('feishuGetThreads', {
        chatId,
        pageToken,
        pageSize,
      });

      if (result.success) {
        logger.info({ chatId, threadCount: result.threads?.length || 0 }, 'Threads retrieved via IPC');
        return {
          success: true,
          message: `✅ Retrieved ${result.threads?.length || 0} threads`,
          threads: result.threads,
          hasMore: result.hasMore,
          pageToken: result.pageToken,
        };
      }

      return {
        success: false,
        message: '❌ Failed to get threads via IPC',
        error: 'IPC request failed',
      };
    }

    // Fallback: Use Feishu client directly
    const client = getClient();
    if (!client) {
      return {
        success: false,
        message: '❌ Feishu credentials not configured',
        error: 'Feishu credentials not configured',
      };
    }

    const response = await client.im.message.list({
      params: {
        container_id_type: 'chat',
        container_id: chatId,
        page_size: pageSize,
        page_token: pageToken,
      },
    });

    const items = response?.data?.items || [];
    const threads: ThreadInfo[] = items.map((item) => ({
      threadId: item.thread_id || item.message_id || '',
      messageId: item.message_id || '',
      content: item.body?.content,
      senderId: item.sender?.id,
      createTime: item.create_time ? parseInt(item.create_time, 10) : undefined,
    }));

    const hasMore = response?.data?.has_more || false;
    const nextPageToken = response?.data?.page_token;

    logger.info({ chatId, threadCount: threads.length, hasMore }, 'Threads retrieved');
    return {
      success: true,
      message: `✅ Retrieved ${threads.length} threads`,
      threads,
      hasMore,
      pageToken: nextPageToken,
    };

  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    logger.error({ err: error, chatId }, 'get_threads FAILED');
    return {
      success: false,
      message: `❌ Failed to get threads: ${errorMessage}`,
      error: errorMessage,
    };
  }
}

/**
 * Get messages from a specific thread.
 *
 * Retrieves all messages within a thread, including the root message
 * and all replies.
 *
 * @param params - Get thread messages parameters
 * @returns Result with message list
 *
 * @see https://open.larksuite.com/document/server-docs/im-v1/message/list
 */
export async function get_thread_messages(params: {
  threadId: string;
  pageToken?: string;
  pageSize?: number;
}): Promise<GetThreadMessagesResult> {
  const { threadId, pageToken, pageSize = 50 } = params;

  logger.info({
    threadId,
    pageToken,
    pageSize,
  }, 'get_thread_messages called');

  try {
    if (!threadId) {
      return { success: false, message: '❌ threadId is required', error: 'threadId is required' };
    }

    // Try IPC first if available
    if (isIpcAvailable()) {
      const ipcClient = getIpcClient();
      const result = await ipcClient.request('feishuGetThreadMessages', {
        threadId,
        pageToken,
        pageSize,
      });

      if (result.success) {
        logger.info({ threadId, messageCount: result.messages?.length || 0 }, 'Thread messages retrieved via IPC');
        return {
          success: true,
          message: `✅ Retrieved ${result.messages?.length || 0} messages`,
          messages: result.messages,
          hasMore: result.hasMore,
          pageToken: result.pageToken,
        };
      }

      return {
        success: false,
        message: '❌ Failed to get thread messages via IPC',
        error: 'IPC request failed',
      };
    }

    // Fallback: Use Feishu client directly
    const client = getClient();
    if (!client) {
      return {
        success: false,
        message: '❌ Feishu credentials not configured',
        error: 'Feishu credentials not configured',
      };
    }

    const response = await client.im.message.list({
      params: {
        container_id_type: 'thread',
        container_id: threadId,
        page_size: pageSize,
        page_token: pageToken,
      },
    });

    const items = response?.data?.items || [];
    const messages: ThreadMessageInfo[] = items.map((item) => ({
      messageId: item.message_id || '',
      threadId: item.thread_id,
      content: item.body?.content,
      senderId: item.sender?.id,
      createTime: item.create_time ? parseInt(item.create_time, 10) : undefined,
      msgType: item.msg_type,
    }));

    const hasMore = response?.data?.has_more || false;
    const nextPageToken = response?.data?.page_token;

    logger.info({ threadId, messageCount: messages.length, hasMore }, 'Thread messages retrieved');
    return {
      success: true,
      message: `✅ Retrieved ${messages.length} messages`,
      messages,
      hasMore,
      pageToken: nextPageToken,
    };

  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    logger.error({ err: error, threadId }, 'get_thread_messages FAILED');
    return {
      success: false,
      message: `❌ Failed to get thread messages: ${errorMessage}`,
      error: errorMessage,
    };
  }
}
