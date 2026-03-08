/**
 * Thread operations MCP tools.
 *
 * Issue #873: Support for topic group discussions.
 * Provides tools for replying in threads, getting threads, and getting thread messages.
 *
 * @module mcp/tools/thread-operations
 */

import { existsSync } from 'fs';
import { createLogger } from '../../utils/logger.js';
import { Config } from '../../config/index.js';
import { createFeishuClient } from '../../platforms/feishu/create-feishu-client.js';
import { getIpcClient } from '../../ipc/unix-socket-client.js';
import { DEFAULT_IPC_CONFIG } from '../../ipc/protocol.js';
import * as lark from '@larksuiteoapi/node-sdk';

const logger = createLogger('ThreadOperations');

/**
 * Result type for reply_in_thread tool.
 */
export interface ReplyInThreadResult {
  success: boolean;
  messageId?: string;
  threadId?: string;
  error?: string;
  message?: string;
}

/**
 * Result type for get_threads tool.
 */
export interface GetThreadsResult {
  success: boolean;
  threads?: Array<{
    messageId: string;
    threadId: string;
    content: string;
    senderId: string;
    createTime: string;
  }>;
  hasMore?: boolean;
  pageToken?: string;
  error?: string;
  message?: string;
}

/**
 * Result type for get_thread_messages tool.
 */
export interface GetThreadMessagesResult {
  success: boolean;
  messages?: Array<{
    messageId: string;
    content: string;
    senderId: string;
    createTime: string;
    parent_id?: string;
  }>;
  hasMore?: boolean;
  pageToken?: string;
  error?: string;
  message?: string;
}

/**
 * Check if IPC is available for Feishu API calls.
 */
function isIpcAvailable(): boolean {
  return existsSync(DEFAULT_IPC_CONFIG.socketPath);
}

/**
 * Reply to a message in a thread.
 *
 * Issue #873: Support for topic group discussions.
 * Uses the Feishu reply API with reply_in_thread: true.
 *
 * @param params - Tool parameters
 * @param params.messageId - The message ID to reply to
 * @param params.content - Message content
 * @param params.msgType - Message type (default: 'text')
 * @returns Result with messageId and threadId
 */
export async function reply_in_thread(params: {
  messageId: string;
  content: string;
  msgType?: string;
}): Promise<ReplyInThreadResult> {
  const { messageId, content, msgType = 'text' } = params;

  logger.info({
    messageId,
    msgType,
    contentLength: content.length,
  }, 'reply_in_thread called');

  try {
    if (!messageId) {
      throw new Error('messageId is required');
    }
    if (!content) {
      throw new Error('content is required');
    }

    const appId = Config.FEISHU_APP_ID;
    const appSecret = Config.FEISHU_APP_SECRET;

    if (!appId || !appSecret) {
      const errorMsg = 'Feishu credentials not configured. Please set FEISHU_APP_ID and FEISHU_APP_SECRET in disclaude.config.yaml';
      logger.error({ messageId }, errorMsg);
      return { success: false, error: errorMsg, message: `❌ ${errorMsg}` };
    }

    // Try IPC first if available
    const useIpc = isIpcAvailable();

    if (useIpc) {
      logger.debug({ messageId }, 'Using IPC for reply_in_thread');
      const ipcClient = getIpcClient();
      const result = await ipcClient.feishuReplyInThread(messageId, content, msgType);
      if (result.success) {
        return {
          success: true,
          messageId: result.messageId,
          threadId: result.threadId,
          message: `✅ Reply sent in thread`,
        };
      }
      return {
        success: false,
        error: 'Failed to reply in thread via IPC',
        message: '❌ Failed to reply in thread via IPC.',
      };
    }

    // Fallback: Create client directly and call API
    logger.debug({ messageId }, 'Using direct client for reply_in_thread');
    const client = createFeishuClient(appId, appSecret, { domain: lark.Domain.Feishu });

    const response = await client.im.message.reply({
      path: {
        message_id: messageId,
      },
      data: {
        content: msgType === 'text' ? JSON.stringify({ text: content }) : content,
        msg_type: msgType,
        reply_in_thread: true,
      },
    });

    const newMessageId = response?.data?.message_id;
    const threadId = response?.data?.thread_id || messageId;

    logger.debug({ messageId, newMessageId, threadId }, 'Reply sent in thread');

    return {
      success: true,
      messageId: newMessageId,
      threadId,
      message: `✅ Reply sent in thread`,
    };

  } catch (error) {
    logger.error({ err: error, messageId }, 'reply_in_thread FAILED');
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    return { success: false, error: errorMessage, message: `❌ Failed to reply in thread: ${errorMessage}` };
  }
}

/**
 * Get threads (topics) from a chat.
 *
 * Issue #873: Support for topic group discussions.
 * Uses the Feishu message list API with container_id_type=chat.
 *
 * @param params - Tool parameters
 * @param params.chatId - Chat ID to get threads from
 * @param params.pageToken - Page token for pagination
 * @param params.pageSize - Number of results per page (default: 20)
 * @returns List of threads with pagination info
 */
export async function get_threads(params: {
  chatId: string;
  pageToken?: string;
  pageSize?: number;
}): Promise<GetThreadsResult> {
  const { chatId, pageToken, pageSize = 20 } = params;

  logger.info({
    chatId,
    pageToken,
    pageSize,
  }, 'get_threads called');

  try {
    if (!chatId) {
      throw new Error('chatId is required');
    }

    const appId = Config.FEISHU_APP_ID;
    const appSecret = Config.FEISHU_APP_SECRET;

    if (!appId || !appSecret) {
      const errorMsg = 'Feishu credentials not configured. Please set FEISHU_APP_ID and FEISHU_APP_SECRET in disclaude.config.yaml';
      logger.error({ chatId }, errorMsg);
      return { success: false, error: errorMsg, message: `❌ ${errorMsg}` };
    }

    // Try IPC first if available
    const useIpc = isIpcAvailable();

    if (useIpc) {
      logger.debug({ chatId }, 'Using IPC for get_threads');
      const ipcClient = getIpcClient();
      const result = await ipcClient.feishuGetThreads(chatId, pageToken, pageSize);
      if (result.success) {
        return {
          success: true,
          threads: result.threads,
          hasMore: result.hasMore,
          pageToken: result.pageToken,
          message: `✅ Retrieved ${result.threads?.length || 0} threads`,
        };
      }
      return {
        success: false,
        error: 'Failed to get threads via IPC',
        message: '❌ Failed to get threads via IPC.',
      };
    }

    // Fallback: Create client directly and call API
    logger.debug({ chatId }, 'Using direct client for get_threads');
    const client = createFeishuClient(appId, appSecret, { domain: lark.Domain.Feishu });

    // Build query parameters
    const queryParams = new URLSearchParams({
      container_id_type: 'chat',
      container_id: chatId,
      page_size: String(pageSize),
    });

    if (pageToken) {
      queryParams.set('page_token', pageToken);
    }

    // Use direct API call
    const response = await client.request<{
      data?: {
        items?: Array<{
          message_id?: string;
          thread_id?: string;
          body?: unknown;
          sender?: { id?: string };
          create_time?: string;
        }>;
        has_more?: boolean;
        page_token?: string;
      };
    }>({
      method: 'GET',
      url: `/open-apis/im/v1/messages?${queryParams.toString()}`,
    });

    const threads: GetThreadsResult['threads'] = [];
    const items = response?.data?.items || [];

    for (const item of items) {
      if (item.message_id && item.thread_id) {
        threads.push({
          messageId: item.message_id,
          threadId: item.thread_id,
          content: extractMessageContent(item.body),
          senderId: item.sender?.id || '',
          createTime: item.create_time || '',
        });
      }
    }

    const hasMore = response?.data?.has_more || false;
    const nextPageToken = response?.data?.page_token;

    logger.debug({ chatId, threadCount: threads.length, hasMore }, 'Threads retrieved');

    return {
      success: true,
      threads,
      hasMore,
      pageToken: nextPageToken,
      message: `✅ Retrieved ${threads.length} threads`,
    };

  } catch (error) {
    logger.error({ err: error, chatId }, 'get_threads FAILED');
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    return { success: false, error: errorMessage, message: `❌ Failed to get threads: ${errorMessage}` };
  }
}

/**
 * Get messages from a thread.
 *
 * Issue #873: Support for topic group discussions.
 * Uses the Feishu message list API with container_id_type=thread.
 *
 * @param params - Tool parameters
 * @param params.threadId - Thread ID to get messages from
 * @param params.pageToken - Page token for pagination
 * @param params.pageSize - Number of results per page (default: 20)
 * @returns List of messages with pagination info
 */
export async function get_thread_messages(params: {
  threadId: string;
  pageToken?: string;
  pageSize?: number;
}): Promise<GetThreadMessagesResult> {
  const { threadId, pageToken, pageSize = 20 } = params;

  logger.info({
    threadId,
    pageToken,
    pageSize,
  }, 'get_thread_messages called');

  try {
    if (!threadId) {
      throw new Error('threadId is required');
    }

    const appId = Config.FEISHU_APP_ID;
    const appSecret = Config.FEISHU_APP_SECRET;

    if (!appId || !appSecret) {
      const errorMsg = 'Feishu credentials not configured. Please set FEISHU_APP_ID and FEISHU_APP_SECRET in disclaude.config.yaml';
      logger.error({ threadId }, errorMsg);
      return { success: false, error: errorMsg, message: `❌ ${errorMsg}` };
    }

    // Try IPC first if available
    const useIpc = isIpcAvailable();

    if (useIpc) {
      logger.debug({ threadId }, 'Using IPC for get_thread_messages');
      const ipcClient = getIpcClient();
      const result = await ipcClient.feishuGetThreadMessages(threadId, pageToken, pageSize);
      if (result.success) {
        return {
          success: true,
          messages: result.messages,
          hasMore: result.hasMore,
          pageToken: result.pageToken,
          message: `✅ Retrieved ${result.messages?.length || 0} messages`,
        };
      }
      return {
        success: false,
        error: 'Failed to get thread messages via IPC',
        message: '❌ Failed to get thread messages via IPC.',
      };
    }

    // Fallback: Create client directly and call API
    logger.debug({ threadId }, 'Using direct client for get_thread_messages');
    const client = createFeishuClient(appId, appSecret, { domain: lark.Domain.Feishu });

    // Build query parameters
    const queryParams = new URLSearchParams({
      container_id_type: 'thread',
      container_id: threadId,
      page_size: String(pageSize),
    });

    if (pageToken) {
      queryParams.set('page_token', pageToken);
    }

    // Use direct API call
    const response = await client.request<{
      data?: {
        items?: Array<{
          message_id?: string;
          body?: unknown;
          sender?: { id?: string };
          create_time?: string;
          parent_id?: string;
        }>;
        has_more?: boolean;
        page_token?: string;
      };
    }>({
      method: 'GET',
      url: `/open-apis/im/v1/messages?${queryParams.toString()}`,
    });

    const messages: GetThreadMessagesResult['messages'] = [];
    const items = response?.data?.items || [];

    for (const item of items) {
      if (item.message_id) {
        messages.push({
          messageId: item.message_id,
          content: extractMessageContent(item.body),
          senderId: item.sender?.id || '',
          createTime: item.create_time || '',
          parent_id: item.parent_id,
        });
      }
    }

    const hasMore = response?.data?.has_more || false;
    const nextPageToken = response?.data?.page_token;

    logger.debug({ threadId, messageCount: messages.length, hasMore }, 'Thread messages retrieved');

    return {
      success: true,
      messages,
      hasMore,
      pageToken: nextPageToken,
      message: `✅ Retrieved ${messages.length} messages`,
    };

  } catch (error) {
    logger.error({ err: error, threadId }, 'get_thread_messages FAILED');
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    return { success: false, error: errorMessage, message: `❌ Failed to get thread messages: ${errorMessage}` };
  }
}

/**
 * Extract message content from message body.
 * Helper function for API responses.
 */
function extractMessageContent(body: unknown): string {
  if (!body) return '';

  try {
    const bodyObj = body as Record<string, unknown>;
    if (bodyObj.content) {
      // Try to parse JSON content
      try {
        const parsed = JSON.parse(bodyObj.content as string);
        if (parsed.text) return parsed.text;
        return bodyObj.content as string;
      } catch {
        return bodyObj.content as string;
      }
    }
    return JSON.stringify(body);
  } catch {
    return String(body);
  }
}
