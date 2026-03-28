/**
 * start_discussion tool implementation.
 *
 * Starts a non-blocking discussion by creating a group chat (or using existing)
 * and sending a context prompt to the ChatAgent in that chat.
 *
 * The ChatAgent (managed by AgentPool) automatically listens for messages in
 * every chat and will respond to the context prompt asynchronously.
 *
 * Issue #631: feat: 离线提问 - Agent 不阻塞工作的留言机制
 *
 * @module mcp-server/tools/start-discussion
 */

import { createLogger, getIpcClient } from '@disclaude/core';
import { isIpcAvailable, getIpcErrorMessage } from './ipc-utils.js';
import { getMessageSentCallback } from './callback-manager.js';
import type { StartDiscussionResult } from './types.js';

const logger = createLogger('StartDiscussion');

/**
 * Start a non-blocking discussion.
 *
 * Creates a new group chat (if chatId not provided) and sends the context
 * as a message to the chat. The ChatAgent will automatically pick up the
 * message and respond asynchronously.
 *
 * @param params.chatId - Existing chat ID (optional, creates new if not provided)
 * @param params.members - Member IDs for new group chat (optional)
 * @param params.topic - Discussion topic, used as group name (optional)
 * @param params.context - The context/prompt to send to the ChatAgent (required)
 */
export async function start_discussion(params: {
  chatId?: string;
  members?: string[];
  topic?: string;
  context: string;
}): Promise<StartDiscussionResult> {
  const { chatId: existingChatId, members, topic, context } = params;

  logger.info({
    hasChatId: !!existingChatId,
    memberCount: members?.length,
    hasTopic: !!topic,
    contextLength: context?.length,
  }, 'start_discussion called');

  try {
    // Validate required parameters
    if (!context || typeof context !== 'string' || context.trim().length === 0) {
      return {
        success: false,
        error: 'context is required and must be a non-empty string',
        message: '❌ context 参数不能为空',
      };
    }

    // Check IPC availability
    if (!(await isIpcAvailable())) {
      const errorMsg = 'IPC service unavailable. Please ensure Primary Node is running.';
      logger.error(errorMsg);
      return {
        success: false,
        error: errorMsg,
        message: '❌ IPC 服务不可用。请检查 Primary Node 服务是否正在运行。',
      };
    }

    const ipcClient = getIpcClient();
    let targetChatId = existingChatId;
    let chatName: string | undefined;

    // Step 1: Create chat if chatId not provided
    if (!targetChatId) {
      logger.info({ topic, memberCount: members?.length }, 'Creating new group chat for discussion');
      const createResult = await ipcClient.createChat(topic, undefined, members);

      if (!createResult.success) {
        const errorMsg = getIpcErrorMessage(createResult.errorType, createResult.error);
        logger.error({ errorType: createResult.errorType, error: createResult.error }, 'Failed to create chat');
        return {
          success: false,
          error: createResult.error ?? 'Failed to create chat via IPC',
          message: errorMsg,
        };
      }

      targetChatId = createResult.chatId;
      chatName = createResult.name;
      logger.info({ chatId: targetChatId, name: chatName }, 'Group chat created for discussion');
    }

    // Guard: targetChatId must be defined at this point
    if (!targetChatId) {
      return {
        success: false,
        error: 'No chatId available',
        message: '❌ 无法确定目标群聊 ID',
      };
    }

    // Step 2: Send context as message to the chat (non-blocking for the caller)
    logger.info({ chatId: targetChatId }, 'Sending discussion context to chat');
    const sendResult = await ipcClient.sendMessage(targetChatId, context);

    if (!sendResult.success) {
      const errorMsg = getIpcErrorMessage(sendResult.errorType, sendResult.error);
      logger.error({ chatId: targetChatId, errorType: sendResult.errorType, error: sendResult.error }, 'Failed to send context');
      return {
        success: false,
        chatId: targetChatId,
        error: sendResult.error ?? 'Failed to send message via IPC',
        message: errorMsg,
      };
    }

    // Invoke message sent callback
    const callback = getMessageSentCallback();
    if (callback) {
      try {
        callback(targetChatId);
      } catch (error) {
        logger.error({ err: error }, 'Failed to invoke message sent callback');
      }
    }

    logger.info({ chatId: targetChatId }, 'Discussion started successfully');
    return {
      success: true,
      chatId: targetChatId,
      message: targetChatId !== existingChatId
        ? `✅ Discussion started in new group "${chatName ?? 'auto'}" (chatId: ${targetChatId})`
        : `✅ Discussion started in existing chat (chatId: ${targetChatId})`,
    };

  } catch (error) {
    logger.error({ err: error }, 'start_discussion FAILED');
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    return { success: false, error: errorMessage, message: `❌ Failed to start discussion: ${errorMessage}` };
  }
}
