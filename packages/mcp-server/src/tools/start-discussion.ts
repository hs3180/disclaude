/**
 * start_discussion tool implementation.
 *
 * Provides a non-blocking mechanism for agents to initiate discussions
 * in group chats. Can create new groups or use existing ones.
 *
 * @module mcp-server/tools/start-discussion
 * @see Issue #631 - 离线提问机制
 */

import { createLogger, getIpcClient } from '@disclaude/core';
import { send_text } from './send-message.js';
import type { StartDiscussionResult } from './types.js';

const logger = createLogger('StartDiscussion');

/**
 * Start a discussion in a group chat (non-blocking).
 *
 * This tool creates a new group chat (or uses an existing one) and sends
 * a context prompt to initiate a discussion. The tool returns immediately
 * without waiting for user responses - the ChatAgent in the group will
 * handle the discussion asynchronously.
 *
 * @example
 * ```typescript
 * // Create a new discussion group
 * await start_discussion({
 *   topic: '代码格式化方案讨论',
 *   members: ['ou_xxx', 'ou_yyy'],
 *   context: '用户希望讨论是否应该自动化代码格式化...',
 * });
 *
 * // Use an existing group
 * await start_discussion({
 *   chatId: 'oc_existing',
 *   context: '继续之前的讨论：是否采用 Prettier？',
 * });
 * ```
 */
export async function start_discussion(params: {
  /** Existing chat ID to use (mutually exclusive with members) */
  chatId?: string;
  /** Member open_ids for creating a new group (mutually exclusive with chatId) */
  members?: string[];
  /** Discussion topic (used as group name for new groups) */
  topic?: string;
  /** Context information to send to the ChatAgent */
  context: string;
}): Promise<StartDiscussionResult> {
  const { chatId, members, topic, context } = params;

  logger.info({
    chatId,
    hasMembers: !!members,
    memberCount: members?.length ?? 0,
    hasTopic: !!topic,
    contextLength: context?.length ?? 0,
  }, 'start_discussion called');

  try {
    // Validate required parameter
    if (!context || typeof context !== 'string') {
      return {
        success: false,
        error: 'context is required and must be a string',
        message: '❌ 讨论上下文不能为空',
      };
    }

    // Validate that either chatId or members is provided
    if (!chatId && (!members || members.length === 0)) {
      return {
        success: false,
        error: 'Either chatId or members must be provided',
        message: '❌ 必须提供 chatId 或 members',
      };
    }

    // Cannot use both chatId and members
    if (chatId && members && members.length > 0) {
      return {
        success: false,
        error: 'Cannot specify both chatId and members',
        message: '❌ 不能同时指定 chatId 和 members',
      };
    }

    let targetChatId = chatId;

    // If no chatId provided, create a new group
    if (!targetChatId) {
      const ipcClient = getIpcClient();
      const groupResult = await ipcClient.feishuCreateGroup(topic, members);

      if (!groupResult.success) {
        const errorDetail = groupResult.error || 'Unknown error';
        logger.error({ err: errorDetail }, 'Failed to create discussion group');
        return {
          success: false,
          error: errorDetail,
          message: `❌ 创建讨论群失败: ${errorDetail}`,
        };
      }

      targetChatId = groupResult.chatId;
      logger.info({ chatId: targetChatId, topic }, 'Discussion group created');
    }

    if (!targetChatId) {
      return {
        success: false,
        error: 'Failed to determine target chat ID',
        message: '❌ 无法确定目标群聊',
      };
    }

    // Send the context message to the group
    const sendResult = await send_text({
      text: context,
      chatId: targetChatId,
    });

    if (!sendResult.success) {
      return {
        success: false,
        error: sendResult.error,
        message: `❌ 发送讨论内容失败: ${sendResult.message}`,
      };
    }

    logger.info({
      chatId: targetChatId,
      isNewGroup: !chatId,
      topic,
    }, 'Discussion started successfully');

    return {
      success: true,
      message: `✅ 讨论已发起${!chatId ? '（新群聊）' : ''}${topic ? ` - ${topic}` : ''}`,
      chatId: targetChatId,
      isNewGroup: !chatId,
    };
  } catch (error) {
    logger.error({ err: error }, 'start_discussion failed');
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    return {
      success: false,
      error: errorMessage,
      message: `❌ 发起讨论失败: ${errorMessage}`,
    };
  }
}
