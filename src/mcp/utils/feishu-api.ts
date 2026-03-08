/**
 * Feishu API utilities for sending messages and thread operations.
 *
 * @module mcp/utils/feishu-api
 */

import * as lark from '@larksuiteoapi/node-sdk';

/**
 * Result of sending a message to Feishu.
 */
export interface SendMessageResult {
  messageId?: string;
}

/**
 * Result of replying in a thread.
 */
export interface ReplyInThreadResult {
  success: boolean;
  messageId?: string;
  error?: string;
}

/**
 * Thread item from getThreads.
 */
export interface ThreadItem {
  messageId: string;
  threadId: string;
  contentType: string;
  content: string;
  createTime: string;
  senderId?: string;
  senderType?: string;
}

/**
 * Result of getting threads.
 */
export interface GetThreadsResult {
  success: boolean;
  threads: ThreadItem[];
  hasMore: boolean;
  pageToken?: string;
  error?: string;
}

/**
 * Message item in a thread.
 */
export interface ThreadMessageItem {
  messageId: string;
  parentMessageId?: string;
  threadId?: string;
  contentType: string;
  content: string;
  createTime: string;
  senderId?: string;
  senderType?: string;
}

/**
 * Result of getting thread messages.
 */
export interface GetThreadMessagesResult {
  success: boolean;
  messages: ThreadMessageItem[];
  hasMore: boolean;
  pageToken?: string;
  error?: string;
}

/**
 * Send a message to Feishu chat.
 */
export async function sendMessageToFeishu(
  client: lark.Client,
  chatId: string,
  msgType: 'text' | 'interactive',
  content: string,
  parentId?: string
): Promise<SendMessageResult> {
  const messageData: {
    receive_id_type?: string;
    msg_type: string;
    content: string;
  } = {
    msg_type: msgType,
    content,
  };

  if (parentId) {
    const response = await client.im.message.reply({
      path: { message_id: parentId },
      data: messageData,
    });
    return { messageId: response?.data?.message_id };
  } else {
    const response = await client.im.message.create({
      params: { receive_id_type: 'chat_id' },
      data: { receive_id: chatId, ...messageData },
    });
    return { messageId: response?.data?.message_id };
  }
}

/**
 * Reply to a message in a thread (follow-up post).
 * Issue #873: Thread reply with reply_in_thread option.
 *
 * @param client - Lark client instance
 * @param messageId - The message ID to reply to (root message of the thread)
 * @param msgType - Message type ('text' or 'interactive')
 * @param content - Message content
 * @returns Result with success status and message ID
 */
export async function replyInThread(
  client: lark.Client,
  messageId: string,
  msgType: 'text' | 'interactive',
  content: string
): Promise<ReplyInThreadResult> {
  try {
    // Note: reply_in_thread should be in data, not params
    const response = await client.im.message.reply({
      path: { message_id: messageId },
      data: {
        msg_type: msgType,
        content,
        reply_in_thread: true,
      },
    });

    if (response?.data?.message_id) {
      return {
        success: true,
        messageId: response.data.message_id,
      };
    }

    return {
      success: false,
      error: 'No message ID returned from API',
    };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    return {
      success: false,
      error: errorMessage,
    };
  }
}

/**
 * Get threads (topic list) from a chat.
 * Issue #873: Retrieve thread list from a topic-mode chat.
 *
 * @param client - Lark client instance
 * @param chatId - Chat ID to get threads from
 * @param pageSize - Number of threads to retrieve (default: 20, max: 50)
 * @param pageToken - Page token for pagination
 * @returns Result with thread list and pagination info
 */
export async function getThreads(
  client: lark.Client,
  chatId: string,
  pageSize: number = 20,
  pageToken?: string
): Promise<GetThreadsResult> {
  try {
    // Use list method instead of listWithIterator for simpler Promise-based API
    const response = await client.im.message.list({
      params: {
        container_id_type: 'chat',
        container_id: chatId,
        page_size: Math.min(pageSize, 50),
        page_token: pageToken,
      },
    });

    const threads: ThreadItem[] = [];
    const items = response?.data?.items || [];

    for (const item of items) {
      // Each message in a topic-mode chat is a thread root
      if (item.message_id && item.thread_id) {
        threads.push({
          messageId: item.message_id,
          threadId: item.thread_id,
          contentType: item.msg_type || 'text',
          content: item.body?.content || '',
          createTime: item.create_time || '',
          senderId: item.sender?.id,
          senderType: item.sender?.sender_type,
        });
      }
    }

    return {
      success: true,
      threads,
      hasMore: response?.data?.has_more || false,
      pageToken: response?.data?.page_token,
    };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    return {
      success: false,
      threads: [],
      hasMore: false,
      error: errorMessage,
    };
  }
}

/**
 * Get messages in a thread (thread detail).
 * Issue #873: Retrieve all messages in a specific thread.
 *
 * @param client - Lark client instance
 * @param threadId - Thread ID to get messages from
 * @param pageSize - Number of messages to retrieve (default: 20, max: 50)
 * @param pageToken - Page token for pagination
 * @returns Result with message list and pagination info
 */
export async function getThreadMessages(
  client: lark.Client,
  threadId: string,
  pageSize: number = 20,
  pageToken?: string
): Promise<GetThreadMessagesResult> {
  try {
    // Use list method instead of listWithIterator for simpler Promise-based API
    const response = await client.im.message.list({
      params: {
        container_id_type: 'thread',
        container_id: threadId,
        page_size: Math.min(pageSize, 50),
        page_token: pageToken,
      },
    });

    const messages: ThreadMessageItem[] = [];
    const items = response?.data?.items || [];

    for (const item of items) {
      messages.push({
        messageId: item.message_id || '',
        parentMessageId: item.parent_id,
        threadId: item.thread_id,
        contentType: item.msg_type || 'text',
        content: item.body?.content || '',
        createTime: item.create_time || '',
        senderId: item.sender?.id,
        senderType: item.sender?.sender_type,
      });
    }

    return {
      success: true,
      messages,
      hasMore: response?.data?.has_more || false,
      pageToken: response?.data?.page_token,
    };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    return {
      success: false,
      messages: [],
      hasMore: false,
      error: errorMessage,
    };
  }
}
