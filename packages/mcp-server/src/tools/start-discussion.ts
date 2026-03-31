/**
 * start_discussion tool implementation.
 *
 * High-level convenience tool that orchestrates group creation,
 * context delivery, and optional lifecycle management for offline discussions.
 *
 * Combines: create_chat + send_text + register_temp_chat
 *
 * Issue #631: 离线提问 - Agent 不阻塞工作的留言机制
 *
 * @module mcp-server/tools/start-discussion
 */

import { createLogger } from '@disclaude/core';
import { isIpcAvailable } from './ipc-utils.js';
import { create_chat } from './create-chat.js';
import { send_text } from './send-message.js';
import { register_temp_chat } from './register-temp-chat.js';
import type { StartDiscussionResult } from './types.js';

const logger = createLogger('StartDiscussion');

/**
 * Start an offline discussion.
 *
 * Creates a new group chat (or uses an existing one), sends the discussion
 * context as a message, and optionally registers the chat for automatic
 * lifecycle management. Returns immediately (non-blocking).
 *
 * @param params.chatId - Use an existing group chat ID (optional)
 * @param params.members - Member IDs for creating a new group chat (optional)
 * @param params.topic - Discussion topic, used as group name (optional)
 * @param params.context - Context information to send to ChatAgent (required)
 * @param params.expiresAt - ISO timestamp for automatic chat dissolution (optional)
 */
export async function start_discussion(params: {
  chatId?: string;
  members?: string[];
  topic?: string;
  context: string;
  expiresAt?: string;
}): Promise<StartDiscussionResult> {
  const { chatId, members, topic, context, expiresAt } = params;

  logger.info({ chatId, memberCount: members?.length, topic, hasExpiresAt: !!expiresAt }, 'start_discussion called');

  try {
    // Validate required parameter
    if (!context || typeof context !== 'string') {
      return {
        success: false,
        error: 'context is required and must be a non-empty string',
        message: '❌ 参数错误：context 为必填项，且必须是非空字符串。',
      };
    }

    // Validate chat configuration: must provide chatId OR (members/topic)
    if (!chatId && !members?.length && !topic) {
      return {
        success: false,
        error: 'Must provide chatId or members/topic to create a new group',
        message: '❌ 参数错误：请提供 chatId（使用现有群聊）或 members+topic（创建新群聊）。',
      };
    }

    // Check IPC availability
    if (!(await isIpcAvailable())) {
      return {
        success: false,
        error: 'IPC service unavailable',
        message: '❌ IPC 服务不可用。请检查 Primary Node 服务是否正在运行。',
      };
    }

    // Step 1: Resolve or create the chat
    let targetChatId = chatId;
    let chatName: string | undefined;

    if (!targetChatId) {
      // Create a new group chat
      const chatResult = await create_chat({
        name: topic,
        description: `讨论: ${topic ?? '离线讨论'}`,
        memberIds: members,
      });

      if (!chatResult.success) {
        logger.error({ error: chatResult.error }, 'Failed to create chat for discussion');
        return {
          success: false,
          error: chatResult.error,
          message: `❌ 创建讨论群聊失败: ${chatResult.message}`,
        };
      }

      targetChatId = chatResult.chatId;
      chatName = chatResult.name;
      logger.info({ chatId: targetChatId, name: chatName }, 'Discussion chat created');
    }

    // Step 2: Send context as a message to the chat
    const contextMessage = topic
      ? `📋 **讨论主题**: ${topic}\n\n${context}`
      : context;

    const sendResult = await send_text({
      text: contextMessage,
      chatId: targetChatId!,
    });

    if (!sendResult.success) {
      logger.error({ chatId: targetChatId, error: sendResult.error }, 'Failed to send context to discussion chat');
      return {
        success: false,
        chatId: targetChatId,
        error: sendResult.error,
        message: `❌ 群聊已创建但发送讨论内容失败: ${sendResult.message}`,
      };
    }

    // Step 3: Optionally register for automatic lifecycle management
    if (expiresAt) {
      const registerResult = await register_temp_chat({
        chatId: targetChatId!,
        expiresAt,
        context: { topic, source: 'start_discussion' },
      });

      if (!registerResult.success) {
        // Non-fatal: discussion is already started, just log the warning
        logger.warn(
          { chatId: targetChatId, error: registerResult.error },
          'Failed to register temp chat (non-fatal)'
        );
      }
    }

    logger.info({ chatId: targetChatId, topic }, 'Discussion started successfully');
    return {
      success: true,
      chatId: targetChatId!,
      topic,
      message: targetChatId === chatId
        ? `✅ 讨论已发起 (chatId: ${targetChatId}, topic: ${topic ?? 'N/A'})`
        : `✅ 讨论群聊已创建并发起讨论 (chatId: ${targetChatId}, name: ${chatName ?? 'auto'}, topic: ${topic ?? 'N/A'})`,
    };
  } catch (error) {
    logger.error({ err: error }, 'start_discussion FAILED');
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    return {
      success: false,
      error: errorMessage,
      message: `❌ 发起讨论失败: ${errorMessage}`,
    };
  }
}
