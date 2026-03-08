/**
 * Start Discussion tool implementation.
 *
 * This tool provides non-blocking offline discussion capability for agents.
 * Agent can start a discussion in a new or existing chat, and continue working
 * without waiting for responses. When users respond, a callback can trigger
 * follow-up actions.
 *
 * Issue #631: 离线提问 - Agent 不阻塞工作的留言机制
 *
 * @module mcp/tools/start-discussion
 */

import * as lark from '@larksuiteoapi/node-sdk';
import { createLogger } from '../../utils/logger.js';
import { Config } from '../../config/index.js';
import { createFeishuClient } from '../../platforms/feishu/create-feishu-client.js';
import { getGroupService, type GroupInfo } from '../../platforms/feishu/group-service.js';
import { createDiscussionChat } from '../../platforms/feishu/chat-ops.js';
import { send_message, getMessageSentCallback } from './send-message.js';

const logger = createLogger('StartDiscussion');

// ============================================================================
// Type Definitions
// ============================================================================

/**
 * Options for starting a discussion.
 */
export interface StartDiscussionOptions {
  /** Topic/title for the discussion */
  topic: string;
  /** Initial message to send (non-blocking) */
  message: string;
  /** Chat ID to use (optional - if not provided, creates new group) */
  chatId?: string;
  /** Member open_ids to add (for new groups) */
  members?: string[];
  /** Creator open_id (for tracking) */
  creatorId?: string;
  /** Context for follow-up actions when user responds */
  followUpContext?: string;
  /** Whether this is a topic group (BBS mode) */
  isTopicGroup?: boolean;
}

/**
 * Result from start_discussion tool.
 */
export interface StartDiscussionResult {
  success: boolean;
  message: string;
  /** Chat ID where discussion was started */
  chatId?: string;
  /** Whether a new group was created */
  isNewGroup?: boolean;
  /** Group info if new group was created */
  groupInfo?: GroupInfo;
  /** Error details if failed */
  error?: string;
}

/**
 * Callback type for handling user responses to discussions.
 */
export type DiscussionResponseCallback = (
  chatId: string,
  userId: string,
  message: string,
  context?: string
) => Promise<void> | void;

// ============================================================================
// Discussion Response Handling
// ============================================================================

/**
 * Registry for discussion response callbacks.
 * Maps chatId to callback and context.
 */
const discussionCallbacks = new Map<string, {
  callback: DiscussionResponseCallback;
  context?: string;
  createdAt: number;
}>();

/**
 * Register a callback for a discussion.
 *
 * @param chatId - Chat ID where discussion is happening
 * @param callback - Function to call when user responds
 * @param context - Optional context for follow-up actions
 */
export function registerDiscussionCallback(
  chatId: string,
  callback: DiscussionResponseCallback,
  context?: string
): void {
  discussionCallbacks.set(chatId, {
    callback,
    context,
    createdAt: Date.now(),
  });
  logger.debug({ chatId, hasContext: !!context }, 'Discussion callback registered');
}

/**
 * Get discussion callback for a chat.
 *
 * @param chatId - Chat ID to look up
 * @returns Callback info or undefined
 */
export function getDiscussionCallback(chatId: string): {
  callback: DiscussionResponseCallback;
  context?: string;
} | undefined {
  return discussionCallbacks.get(chatId);
}

/**
 * Unregister a discussion callback.
 *
 * @param chatId - Chat ID to unregister
 */
export function unregisterDiscussionCallback(chatId: string): boolean {
  const removed = discussionCallbacks.delete(chatId);
  if (removed) {
    logger.debug({ chatId }, 'Discussion callback unregistered');
  }
  return removed;
}

/**
 * Cleanup expired discussion callbacks (older than 7 days).
 */
export function cleanupExpiredDiscussionCallbacks(): number {
  const maxAge = 7 * 24 * 60 * 60 * 1000; // 7 days
  const now = Date.now();
  let cleaned = 0;

  for (const [chatId, info] of discussionCallbacks) {
    if (now - info.createdAt > maxAge) {
      discussionCallbacks.delete(chatId);
      cleaned++;
    }
  }

  if (cleaned > 0) {
    logger.debug({ count: cleaned }, 'Cleaned up expired discussion callbacks');
  }

  return cleaned;
}

// ============================================================================
// Start Discussion Implementation
// ============================================================================

/**
 * Start a non-blocking discussion.
 *
 * This tool allows an agent to:
 * 1. Create a new discussion group (if chatId not provided)
 * 2. Send an initial message (non-blocking)
 * 3. Continue working without waiting for response
 *
 * When users respond, the registered callback (if any) will be triggered
 * to handle follow-up actions.
 *
 * @example
 * ```typescript
 * // Start a new discussion
 * const result = await start_discussion({
 *   topic: '关于代码风格的讨论',
 *   message: '我发现最近的代码风格有些不一致，想和大家讨论一下...',
 *   members: ['ou_user1', 'ou_user2'],
 *   followUpContext: 'code-style-discussion',
 * });
 *
 * // Start discussion in existing chat
 * const result = await start_discussion({
 *   topic: '每日回顾',
 *   message: '今天的聊天回顾发现了一些重复问题...',
 *   chatId: 'oc_xxx',
 * });
 * ```
 */
export async function start_discussion(params: StartDiscussionOptions): Promise<StartDiscussionResult> {
  const { topic, message, chatId, members, creatorId, followUpContext: _followUpContext, isTopicGroup } = params;

  logger.info({
    topic,
    hasChatId: !!chatId,
    memberCount: members?.length ?? 0,
    isTopicGroup,
  }, 'start_discussion called');

  try {
    // Validate required parameters
    if (!topic) {
      return {
        success: false,
        message: '❌ topic 是必需的',
        error: 'topic is required',
      };
    }

    if (!message) {
      return {
        success: false,
        message: '❌ message 是必需的',
        error: 'message is required',
      };
    }

    // Get Feishu credentials
    const appId = Config.FEISHU_APP_ID;
    const appSecret = Config.FEISHU_APP_SECRET;

    if (!appId || !appSecret) {
      const errorMsg = 'Feishu credentials not configured';
      logger.error(errorMsg);
      return {
        success: false,
        message: '❌ Feishu 凭证未配置',
        error: errorMsg,
      };
    }

    // Create Feishu client
    const client = createFeishuClient(appId, appSecret, { domain: lark.Domain.Feishu });
    const groupService = getGroupService();

    let targetChatId: string;
    let isNewGroup = false;
    let groupInfo: GroupInfo | undefined;

    // Use existing chat or create new group
    if (chatId) {
      targetChatId = chatId;
      logger.debug({ chatId: targetChatId }, 'Using existing chat');
    } else {
      // Create new discussion group
      try {
        logger.info({ topic, memberCount: members?.length ?? 0 }, 'Creating new discussion group');

        const newChatId = await createDiscussionChat(
          client,
          { topic, members },
          creatorId
        );

        targetChatId = newChatId;
        isNewGroup = true;

        // Register the group
        const actualMembers = members && members.length > 0
          ? members
          : (creatorId ? [creatorId] : []);

        groupInfo = {
          chatId: targetChatId,
          name: topic,
          createdAt: Date.now(),
          createdBy: creatorId,
          initialMembers: actualMembers,
          isTopicGroup: isTopicGroup ?? false,
        };

        groupService.registerGroup(groupInfo);

        logger.info({
          chatId: targetChatId,
          topic,
          isNewGroup,
          isTopicGroup,
        }, 'Discussion group created');
      } catch (error) {
        const errorMsg = error instanceof Error ? error.message : String(error);
        logger.error({ err: error, topic }, 'Failed to create discussion group');
        return {
          success: false,
          message: `❌ 创建讨论群失败: ${errorMsg}`,
          error: errorMsg,
        };
      }
    }

    // Send initial message (non-blocking)
    const sendResult = await send_message({
      content: message,
      format: 'text',
      chatId: targetChatId,
    });

    if (!sendResult.success) {
      logger.error({
        chatId: targetChatId,
        error: sendResult.error,
      }, 'Failed to send initial message');

      // If we created a new group but failed to send message, still return success
      // but indicate the message issue
      if (isNewGroup) {
        return {
          success: true,
          message: `⚠️ 讨论群已创建，但初始消息发送失败: ${sendResult.message}`,
          chatId: targetChatId,
          isNewGroup,
          groupInfo,
        };
      }

      return {
        success: false,
        message: `❌ 发送消息失败: ${sendResult.message}`,
        chatId: targetChatId,
        error: sendResult.error,
      };
    }

    // Invoke message sent callback
    const msgCallback = getMessageSentCallback();
    if (msgCallback) {
      try {
        msgCallback(targetChatId);
      } catch (error) {
        logger.error({ err: error }, 'Failed to invoke message sent callback');
      }
    }

    const successMessage = isNewGroup
      ? `✅ 讨论群「${topic}」已创建并发起讨论`
      : '✅ 讨论已在现有群中发起';

    logger.info({
      chatId: targetChatId,
      topic,
      isNewGroup,
    }, 'Discussion started successfully');

    return {
      success: true,
      message: successMessage,
      chatId: targetChatId,
      isNewGroup,
      groupInfo,
    };

  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error);
    logger.error({ err: error }, 'start_discussion failed');
    return {
      success: false,
      message: `❌ 发起讨论失败: ${errorMsg}`,
      error: errorMsg,
    };
  }
}
