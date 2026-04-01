/**
 * start_discussion tool implementation.
 *
 * Initiates a non-blocking discussion by creating a group chat (or using
 * an existing one) and sending context to a ChatAgent. The tool returns
 * immediately after sending, allowing the agent to continue working.
 *
 * Issue #631: 离线提问 - Agent 不阻塞工作的留言机制
 *
 * @module mcp-server/tools/start-discussion
 */

import { createLogger, getIpcClient } from '@disclaude/core';
import { isIpcAvailable, getIpcErrorMessage } from './ipc-utils.js';
import type { StartDiscussionResult } from './types.js';

const logger = createLogger('StartDiscussion');

/**
 * Start a non-blocking discussion.
 *
 * Creates a new group chat (or uses an existing one) and sends the context
 * as a prompt to a ChatAgent in that chat. Returns immediately after sending.
 *
 * @param params.context - The discussion context/prompt to send (required)
 * @param params.chatId - Use an existing chat ID (optional, creates new if omitted)
 * @param params.topic - Discussion topic for group name (optional, used when creating new chat)
 * @param params.memberIds - Initial member IDs for new group (optional)
 * @param params.registerTemp - Whether to register as temp chat (default: true)
 */
export async function start_discussion(params: {
  context: string;
  chatId?: string;
  topic?: string;
  memberIds?: string[];
  registerTemp?: boolean;
}): Promise<StartDiscussionResult> {
  const { context, chatId, topic, memberIds, registerTemp = true } = params;

  logger.info({
    hasChatId: !!chatId,
    topic,
    memberCount: memberIds?.length,
    registerTemp,
    contextLength: context?.length,
  }, 'start_discussion called');

  try {
    // Validate required parameter
    if (!context || typeof context !== 'string') {
      return {
        success: false,
        error: 'context is required and must be a non-empty string',
        message: '❌ context 参数为必填项，且必须为非空字符串。',
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

    // Step 1: Determine target chat (create new or use existing)
    let targetChatId = chatId;
    let chatName: string | undefined;

    if (!targetChatId) {
      // Create a new group chat
      const groupName = topic || `讨论: ${context.substring(0, 30)}${context.length > 30 ? '...' : ''}`;

      logger.info({ groupName, memberCount: memberIds?.length }, 'Creating new discussion chat');

      const createResult = await ipcClient.createChat(groupName, undefined, memberIds);

      if (!createResult.success || !createResult.chatId) {
        const errorMsg = getIpcErrorMessage(createResult.errorType, createResult.error);
        logger.error({ errorType: createResult.errorType, error: createResult.error }, 'Failed to create discussion chat');
        return {
          success: false,
          error: createResult.error ?? 'Failed to create chat via IPC',
          message: errorMsg,
        };
      }

      targetChatId = createResult.chatId;
      chatName = createResult.name;
      logger.info({ chatId: targetChatId, name: chatName }, 'Discussion chat created');
    }

    // Step 2: Send context to the chat
    logger.info({ chatId: targetChatId, contextLength: context.length }, 'Sending discussion context');

    const sendResult = await ipcClient.sendMessage(targetChatId, context);

    if (!sendResult.success) {
      const errorMsg = getIpcErrorMessage(sendResult.errorType, sendResult.error);
      logger.error({ chatId: targetChatId, errorType: sendResult.errorType, error: sendResult.error }, 'Failed to send discussion context');
      return {
        success: false,
        chatId: targetChatId,
        error: sendResult.error ?? 'Failed to send message via IPC',
        message: errorMsg,
      };
    }

    // Step 3: Optionally register as temp chat for lifecycle management
    if (registerTemp && !chatId) {
      logger.info({ chatId: targetChatId }, 'Registering discussion chat as temp');

      try {
        await ipcClient.registerTempChat(targetChatId);
        logger.info({ chatId: targetChatId }, 'Discussion chat registered as temp');
      } catch (error) {
        // Non-critical: log but don't fail the operation
        logger.warn({ err: error, chatId: targetChatId }, 'Failed to register temp chat (non-critical)');
      }
    }

    const mode = chatId ? 'existing' : 'new';
    logger.info({ chatId: targetChatId, mode, topic }, 'Discussion started successfully');

    return {
      success: true,
      chatId: targetChatId,
      message: chatId
        ? `✅ Discussion started in existing chat (chatId: ${targetChatId})`
        : `✅ Discussion started in new chat "${chatName ?? topic ?? 'untitled'}" (chatId: ${targetChatId})`,
    };

  } catch (error) {
    logger.error({ err: error }, 'start_discussion FAILED');
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    return { success: false, error: errorMessage, message: `❌ Failed to start discussion: ${errorMessage}` };
  }
}
