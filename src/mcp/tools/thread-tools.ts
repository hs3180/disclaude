/**
 * Thread tools for Feishu topic groups.
 *
 * Implements Issue #873: feat: 话题群扩展 - 群管理操作与发帖跟帖接口
 *
 * Tools provided:
 * - reply_in_thread: Reply to a thread (跟帖)
 * - get_threads: Get list of threads in a chat (获取话题列表)
 * - get_thread_messages: Get messages in a thread (获取话题详情)
 *
 * @module mcp/tools/thread-tools
 */

import * as lark from '@larksuiteoapi/node-sdk';
import { createLogger } from '../../utils/logger.js';
import { Config } from '../../config/index.js';
import { createFeishuClient } from '../../platforms/feishu/create-feishu-client.js';

const logger = createLogger('ThreadTools');

/**
 * Result type for thread operations.
 */
export interface ThreadResult {
  success: boolean;
  message: string;
  error?: string;
}

/**
 * Thread message structure.
 */
export interface ThreadMessage {
  messageId: string;
  threadId?: string;
  senderId?: string;
  senderType?: string;
  content?: string;
  msgType?: string;
  createTime?: string;
}

/**
 * Reply to a thread (跟帖).
 *
 * Uses the reply message API with reply_in_thread=true.
 *
 * @param params - Tool parameters
 * @returns Result with success status
 */
export async function reply_in_thread(params: {
  messageId: string;
  content: string;
  msgType?: 'text' | 'interactive';
  chatId?: string;
}): Promise<ThreadResult & { messageId?: string }> {
  const { messageId, content, msgType = 'text', chatId } = params;

  logger.info({
    messageId,
    msgType,
    chatId,
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
      const errorMsg = 'Feishu credentials not configured. Please set FEISHU_APP_ID and FEISHU_APP_SECRET.';
      logger.error({ messageId }, errorMsg);
      return { success: false, error: errorMsg, message: `❌ ${errorMsg}` };
    }

    const client = createFeishuClient(appId, appSecret, { domain: lark.Domain.Feishu });

    // Prepare message content based on msgType
    const messageContent = msgType === 'text'
      ? JSON.stringify({ text: content })
      : content;

    // Use reply API with reply_in_thread=true
    const response = await client.im.message.reply({
      data: {
        content: messageContent,
        msg_type: msgType,
        reply_in_thread: true,
      },
      path: { message_id: messageId },
    });

    if (response.code !== 0) {
      const errorMsg = response.msg || 'Unknown error from Feishu API';
      logger.error({ messageId, code: response.code, msg: response.msg }, 'Failed to reply in thread');
      return {
        success: false,
        error: errorMsg,
        message: `❌ Failed to reply in thread: ${errorMsg}`,
      };
    }

    logger.debug({ messageId, responseMessageId: response.data?.message_id }, 'Thread reply sent');
    return {
      success: true,
      message: '✅ Thread reply sent successfully',
      messageId: response.data?.message_id,
    };

  } catch (error) {
    logger.error({ err: error, messageId }, 'reply_in_thread FAILED');
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    return { success: false, error: errorMessage, message: `❌ Failed to reply in thread: ${errorMessage}` };
  }
}

/**
 * Get list of threads in a chat (获取话题列表).
 *
 * Uses the get conversation history messages API with container_id_type=chat.
 *
 * @param params - Tool parameters
 * @returns Result with thread list
 */
export async function get_threads(params: {
  chatId: string;
  pageToken?: string;
  pageSize?: number;
}): Promise<ThreadResult & { threads?: ThreadMessage[]; hasMore?: boolean; pageToken?: string }> {
  const { chatId, pageToken, pageSize = 50 } = params;

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
      const errorMsg = 'Feishu credentials not configured. Please set FEISHU_APP_ID and FEISHU_APP_SECRET.';
      logger.error({ chatId }, errorMsg);
      return { success: false, error: errorMsg, message: `❌ ${errorMsg}` };
    }

    const client = createFeishuClient(appId, appSecret, { domain: lark.Domain.Feishu });

    // Get messages from the chat using iterator
    const iterator = await client.im.message.listWithIterator({
      params: {
        container_id_type: 'chat',
        container_id: chatId,
        page_size: pageSize,
        page_token: pageToken,
      },
    });

    // Collect messages with thread_id (these are thread root messages)
    const threads: ThreadMessage[] = [];

    for await (const page of iterator) {
      if (!page?.items) {continue;}

      for (const item of page.items) {
        // Only include messages that have thread_id (thread root messages)
        if (item.thread_id) {
          threads.push({
            messageId: item.message_id || '',
            threadId: item.thread_id,
            senderId: item.sender?.id,
            senderType: item.sender?.sender_type,
            content: item.body?.content,
            msgType: item.msg_type,
            createTime: item.create_time,
          });
        }
      }
    }

    logger.debug({ chatId, threadCount: threads.length }, 'Threads retrieved');
    return {
      success: true,
      message: `✅ Found ${threads.length} threads`,
      threads,
      hasMore: false, // Iterator handles pagination internally
    };

  } catch (error) {
    logger.error({ err: error, chatId }, 'get_threads FAILED');
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    return { success: false, error: errorMessage, message: `❌ Failed to get threads: ${errorMessage}` };
  }
}

/**
 * Get messages in a thread (获取话题详情).
 *
 * Uses the get conversation history messages API with container_id_type=thread.
 *
 * @param params - Tool parameters
 * @returns Result with thread messages
 */
export async function get_thread_messages(params: {
  threadId: string;
  pageToken?: string;
  pageSize?: number;
}): Promise<ThreadResult & { messages?: ThreadMessage[]; hasMore?: boolean; pageToken?: string }> {
  const { threadId, pageToken, pageSize = 50 } = params;

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
      const errorMsg = 'Feishu credentials not configured. Please set FEISHU_APP_ID and FEISHU_APP_SECRET.';
      logger.error({ threadId }, errorMsg);
      return { success: false, error: errorMsg, message: `❌ ${errorMsg}` };
    }

    const client = createFeishuClient(appId, appSecret, { domain: lark.Domain.Feishu });

    // Get messages from the thread using iterator
    const iterator = await client.im.message.listWithIterator({
      params: {
        container_id_type: 'thread',
        container_id: threadId,
        page_size: pageSize,
        page_token: pageToken,
      },
    });

    // Parse messages
    const messages: ThreadMessage[] = [];

    for await (const page of iterator) {
      if (!page?.items) {continue;}

      for (const item of page.items) {
        messages.push({
          messageId: item.message_id || '',
          threadId: item.thread_id,
          senderId: item.sender?.id,
          senderType: item.sender?.sender_type,
          content: item.body?.content,
          msgType: item.msg_type,
          createTime: item.create_time,
        });
      }
    }

    logger.debug({ threadId, messageCount: messages.length }, 'Thread messages retrieved');
    return {
      success: true,
      message: `✅ Found ${messages.length} messages in thread`,
      messages,
      hasMore: false, // Iterator handles pagination internally
    };

  } catch (error) {
    logger.error({ err: error, threadId }, 'get_thread_messages FAILED');
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    return { success: false, error: errorMessage, message: `❌ Failed to get thread messages: ${errorMessage}` };
  }
}
