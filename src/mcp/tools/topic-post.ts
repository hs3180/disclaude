/**
 * Topic Post tools for topic groups (BBS mode).
 *
 * These tools allow agents to create posts and reply to posts in topic groups.
 * In Feishu, topic groups use a thread-based message structure where:
 * - A "post" is a root message (thread starter)
 * - A "reply" is a message in a thread
 *
 * @module mcp/tools/topic-post
 * @see Issue #873 - 话题群扩展 - 群管理操作与发帖跟帖接口
 */

import * as lark from '@larksuiteoapi/node-sdk';
import { createLogger } from '../../utils/logger.js';
import { Config } from '../../config/index.js';
import { createFeishuClient } from '../../platforms/feishu/create-feishu-client.js';

const logger = createLogger('TopicPost');

/**
 * Result of post operations.
 */
export interface PostResult {
  success: boolean;
  messageId?: string;
  threadId?: string;
  error?: string;
  message: string;
}

/**
 * Post information from Feishu API.
 */
export interface PostInfo {
  messageId: string;
  threadId?: string;
  rootId?: string;
  content: string;
  contentType: string;
  createTime: number;
  senderId?: string;
}

/**
 * Options for listing posts.
 */
export interface ListPostsOptions {
  /** Maximum number of posts to return (default: 20, max: 50) */
  pageSize?: number;
  /** Page token for pagination */
  pageToken?: string;
  /** Start time (Unix timestamp in seconds) */
  startTime?: number;
  /** End time (Unix timestamp in seconds) */
  endTime?: number;
}

/**
 * Result of listing posts.
 */
export interface ListPostsResult {
  success: boolean;
  posts?: PostInfo[];
  hasMore?: boolean;
  pageToken?: string;
  error?: string;
  message: string;
}

/**
 * Create a post in a topic group.
 *
 * In topic groups, a "post" is simply a root message (message without parent).
 * This is the equivalent of creating a new topic/thread.
 *
 * @param chatId - Topic group chat ID
 * @param content - Post content (text)
 * @returns Post creation result with message ID
 */
export async function create_post(params: {
  chatId: string;
  content: string;
}): Promise<PostResult> {
  const { chatId, content } = params;

  logger.info({ chatId, contentLength: content.length }, 'create_post called');

  try {
    if (!chatId) {
      return { success: false, error: 'chatId is required', message: '❌ chatId 参数必填' };
    }
    if (!content) {
      return { success: false, error: 'content is required', message: '❌ content 参数必填' };
    }

    const appId = Config.FEISHU_APP_ID;
    const appSecret = Config.FEISHU_APP_SECRET;

    if (!appId || !appSecret) {
      const errorMsg = 'Feishu credentials not configured';
      logger.error({ chatId }, errorMsg);
      return { success: false, error: errorMsg, message: `❌ ${errorMsg}` };
    }

    const client = createFeishuClient(appId, appSecret, { domain: lark.Domain.Feishu });

    // Send message to create a post (root message without parent)
    const response = await client.im.message.create({
      params: { receive_id_type: 'chat_id' },
      data: {
        receive_id: chatId,
        msg_type: 'text',
        content: JSON.stringify({ text: content }),
      },
    });

    const messageId = response?.data?.message_id;
    const threadId = response?.data?.thread_id;

    if (!messageId) {
      throw new Error('Failed to get message_id from response');
    }

    logger.info({ chatId, messageId, threadId }, 'Post created successfully');

    return {
      success: true,
      messageId,
      threadId,
      message: `✅ 帖子创建成功\n消息ID: ${messageId}`,
    };
  } catch (error) {
    logger.error({ err: error, chatId }, 'create_post FAILED');
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    return { success: false, error: errorMessage, message: `❌ 创建帖子失败: ${errorMessage}` };
  }
}

/**
 * Reply to a post in a topic group.
 *
 * In topic groups, replies are messages with a parent_id (thread reply).
 * Use the root message ID (postId) to reply to a post.
 *
 * @param chatId - Topic group chat ID
 * @param postId - The post (root message) ID to reply to
 * @param content - Reply content (text)
 * @returns Reply creation result with message ID
 */
export async function reply_post(params: {
  chatId: string;
  postId: string;
  content: string;
}): Promise<PostResult> {
  const { chatId, postId, content } = params;

  logger.info({ chatId, postId, contentLength: content.length }, 'reply_post called');

  try {
    if (!chatId) {
      return { success: false, error: 'chatId is required', message: '❌ chatId 参数必填' };
    }
    if (!postId) {
      return { success: false, error: 'postId is required', message: '❌ postId 参数必填' };
    }
    if (!content) {
      return { success: false, error: 'content is required', message: '❌ content 参数必填' };
    }

    const appId = Config.FEISHU_APP_ID;
    const appSecret = Config.FEISHU_APP_SECRET;

    if (!appId || !appSecret) {
      const errorMsg = 'Feishu credentials not configured';
      logger.error({ chatId }, errorMsg);
      return { success: false, error: errorMsg, message: `❌ ${errorMsg}` };
    }

    const client = createFeishuClient(appId, appSecret, { domain: lark.Domain.Feishu });

    // Reply to the post using reply API with reply_in_thread
    const response = await client.im.message.reply({
      path: { message_id: postId },
      data: {
        msg_type: 'text',
        content: JSON.stringify({ text: content }),
        reply_in_thread: true,
      },
    });

    const messageId = response?.data?.message_id;

    if (!messageId) {
      throw new Error('Failed to get message_id from response');
    }

    logger.info({ chatId, postId, messageId }, 'Reply posted successfully');

    return {
      success: true,
      messageId,
      threadId: postId, // In topic groups, thread_id is the root message ID
      message: `✅ 回复成功\n消息ID: ${messageId}\n帖子ID: ${postId}`,
    };
  } catch (error) {
    logger.error({ err: error, chatId, postId }, 'reply_post FAILED');
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    return { success: false, error: errorMessage, message: `❌ 回复失败: ${errorMessage}` };
  }
}

/**
 * Get posts (root messages) from a topic group.
 *
 * This retrieves messages from the chat. In topic groups, root messages
 * (messages without root_id) represent posts.
 *
 * Note: Feishu API pagination and filtering may be limited.
 *
 * @param chatId - Topic group chat ID
 * @param options - List options (pagination, time range)
 * @returns List of posts
 */
export async function get_posts(params: {
  chatId: string;
  pageSize?: number;
  pageToken?: string;
}): Promise<ListPostsResult> {
  const { chatId, pageSize = 20, pageToken } = params;

  logger.info({ chatId, pageSize, pageToken }, 'get_posts called');

  try {
    if (!chatId) {
      return { success: false, error: 'chatId is required', message: '❌ chatId 参数必填' };
    }

    const appId = Config.FEISHU_APP_ID;
    const appSecret = Config.FEISHU_APP_SECRET;

    if (!appId || !appSecret) {
      const errorMsg = 'Feishu credentials not configured';
      logger.error({ chatId }, errorMsg);
      return { success: false, error: errorMsg, message: `❌ ${errorMsg}` };
    }

    const client = createFeishuClient(appId, appSecret, { domain: lark.Domain.Feishu });

    // Get chat messages
    const response = await client.im.message.list({
      params: {
        container_id_type: 'chat_id',
        container_id: chatId,
        page_size: Math.min(pageSize, 50),
        page_token: pageToken,
      },
    });

    const items = response?.data?.items || [];
    const posts: PostInfo[] = [];

    for (const item of items) {
      // In topic groups, root messages (posts) have no root_id
      // or have root_id equal to message_id
      const isRootMessage = !item.root_id || item.root_id === item.message_id;

      if (isRootMessage && item.message_id) {
        const createTimeStr = item.create_time || '0';
        const createTimeNum = typeof createTimeStr === 'string' ? parseInt(createTimeStr, 10) : createTimeStr;
        posts.push({
          messageId: item.message_id,
          threadId: item.thread_id || undefined,
          rootId: item.root_id || undefined,
          content: item.body?.content || '', // Note: content is in body.content
          contentType: item.msg_type || 'text',
          createTime: createTimeNum || 0,
          senderId: item.sender?.id || undefined,
        });
      }
    }

    const hasMore = response?.data?.has_more || false;
    const nextPageToken = response?.data?.page_token;

    logger.info({ chatId, postCount: posts.length, hasMore }, 'Posts retrieved');

    return {
      success: true,
      posts,
      hasMore,
      pageToken: nextPageToken,
      message: `✅ 获取到 ${posts.length} 个帖子`,
    };
  } catch (error) {
    logger.error({ err: error, chatId }, 'get_posts FAILED');
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    return { success: false, error: errorMessage, message: `❌ 获取帖子失败: ${errorMessage}` };
  }
}

/**
 * Get a specific post by message ID.
 *
 * @param chatId - Topic group chat ID
 * @param postId - The post (message) ID
 * @returns Post details
 */
export async function get_post(params: {
  chatId: string;
  postId: string;
}): Promise<{ success: boolean; post?: PostInfo; error?: string; message: string }> {
  const { chatId, postId } = params;

  logger.info({ chatId, postId }, 'get_post called');

  try {
    if (!chatId) {
      return { success: false, error: 'chatId is required', message: '❌ chatId 参数必填' };
    }
    if (!postId) {
      return { success: false, error: 'postId is required', message: '❌ postId 参数必填' };
    }

    const appId = Config.FEISHU_APP_ID;
    const appSecret = Config.FEISHU_APP_SECRET;

    if (!appId || !appSecret) {
      const errorMsg = 'Feishu credentials not configured';
      logger.error({ chatId }, errorMsg);
      return { success: false, error: errorMsg, message: `❌ ${errorMsg}` };
    }

    const client = createFeishuClient(appId, appSecret, { domain: lark.Domain.Feishu });

    // Get message by ID
    const response = await client.im.message.get({
      path: { message_id: postId },
    });

    // The response data structure may vary - check for both 'items' array and direct object
    const data = response?.data;
    const item = data?.items?.[0] || (data as unknown as Record<string, unknown>);

    if (!item || typeof item !== 'object' || !('message_id' in item) || !item.message_id) {
      return { success: false, error: 'Post not found', message: '❌ 帖子不存在' };
    }

    const msgItem = item as {
      message_id?: string;
      thread_id?: string;
      root_id?: string;
      body?: { content?: string };
      msg_type?: string;
      create_time?: string | number;
      sender?: { id?: string };
    };

    const createTimeStr = msgItem.create_time || '0';
    const createTimeNum = typeof createTimeStr === 'string' ? parseInt(createTimeStr, 10) : createTimeStr;

    const post: PostInfo = {
      messageId: msgItem.message_id || '',
      threadId: msgItem.thread_id || undefined,
      rootId: msgItem.root_id || undefined,
      content: msgItem.body?.content || '',
      contentType: msgItem.msg_type || 'text',
      createTime: createTimeNum || 0,
      senderId: msgItem.sender?.id || undefined,
    };

    logger.info({ chatId, postId }, 'Post retrieved');

    return {
      success: true,
      post,
      message: `✅ 获取帖子成功\n消息ID: ${post.messageId}\n创建时间: ${new Date(post.createTime * 1000).toLocaleString('zh-CN')}`,
    };
  } catch (error) {
    logger.error({ err: error, chatId, postId }, 'get_post FAILED');
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    return { success: false, error: errorMessage, message: `❌ 获取帖子失败: ${errorMessage}` };
  }
}
