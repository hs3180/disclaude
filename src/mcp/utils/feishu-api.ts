/**
 * Feishu API utilities for sending messages and thread operations.
 *
 * @module mcp/utils/feishu-api
 * @see Issue #873 - 话题群扩展 - 群管理操作与发帖跟帖接口
 */

import * as lark from '@larksuiteoapi/node-sdk';

/**
 * Result of sending a message to Feishu.
 */
export interface SendMessageResult {
  messageId?: string;
}

/**
 * Thread message item from Feishu API.
 */
export interface ThreadMessage {
  messageId: string;
  threadId?: string;
  msgType: string;
  content: string;
  createTime: string;
  sender?: {
    id: string;
    type: string;
  };
}

/**
 * Result of fetching threads/messages from Feishu.
 */
export interface FetchMessagesResult {
  items: ThreadMessage[];
  hasMore: boolean;
  pageToken?: string;
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
 * Reply to a message in thread mode (creates a follow-up post).
 * Issue #873: Support thread replies for topic groups.
 *
 * @param client - Lark client instance
 * @param messageId - The parent message ID to reply to
 * @param msgType - Message type ('text' or 'interactive')
 * @param content - Message content (JSON string)
 * @returns The reply message ID
 */
export async function replyInThread(
  client: lark.Client,
  messageId: string,
  msgType: 'text' | 'interactive',
  content: string
): Promise<SendMessageResult> {
  const response = await client.im.message.reply({
    path: { message_id: messageId },
    data: {
      msg_type: msgType,
      content,
      reply_in_thread: true,
    },
  });
  return { messageId: response?.data?.message_id };
}

/**
 * Fetch messages from a container (chat or thread).
 * Issue #873: Support listing threads and thread messages.
 *
 * @param client - Lark client instance
 * @param containerIdType - 'chat' for threads list, 'thread' for thread messages
 * @param containerId - Chat ID or thread ID
 * @param pageSize - Number of messages to fetch (default 50)
 * @param pageToken - Pagination token
 */
export async function fetchMessages(
  client: lark.Client,
  containerIdType: 'chat' | 'thread',
  containerId: string,
  pageSize: number = 50,
  pageToken?: string
): Promise<FetchMessagesResult> {
  // Use listWithIterator for paginated results
  const iteratorResult = await client.im.message.listWithIterator({
    params: {
      container_id_type: containerIdType,
      container_id: containerId,
      page_size: pageSize,
      page_token: pageToken,
    },
  });

  const items: ThreadMessage[] = [];

  // Iterate through the async iterator
  for await (const page of iteratorResult) {
    if (page?.items) {
      for (const item of page.items) {
        items.push({
          messageId: item.message_id ?? '',
          threadId: item.thread_id ?? undefined,
          msgType: item.msg_type ?? '',
          content: item.body?.content ?? '',
          createTime: item.create_time ?? '',
          sender: item.sender ? {
            id: item.sender.id ?? '',
            type: item.sender.sender_type ?? '',
          } : undefined,
        });
      }
    }
  }

  // Note: listWithIterator handles pagination internally
  // For simple use cases, we return all fetched items
  return {
    items,
    hasMore: false,
    pageToken: undefined,
  };
}
