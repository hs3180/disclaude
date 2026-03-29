/**
 * start_discussion tool implementation.
 *
 * Creates a discussion chat (or uses existing), sends context to ChatAgent,
 * and registers it as a temp chat for lifecycle management.
 * Returns immediately — non-blocking by design.
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
 * Workflow:
 * 1. Create a new group chat (or use existing chatId)
 * 2. Send context message to the chat (triggers ChatAgent)
 * 3. Register as temp chat for automatic lifecycle management
 * 4. Return immediately with chatId
 *
 * @param params.chatId - Use existing chat ID (skip creation)
 * @param params.topic - Discussion topic (used as group name if creating new chat)
 * @param params.context - The context/prompt to send to ChatAgent (required)
 * @param params.memberIds - Members to add when creating new chat
 * @param params.expiresAt - ISO timestamp for temp chat expiry (defaults to 24h)
 * @param params.creatorChatId - Originating chat ID (for notifications)
 */
export async function start_discussion(params: {
  chatId?: string;
  topic?: string;
  context: string;
  memberIds?: string[];
  expiresAt?: string;
  creatorChatId?: string;
}): Promise<StartDiscussionResult> {
  const { chatId: existingChatId, topic, context, memberIds, expiresAt, creatorChatId } = params;

  logger.info({ existingChatId, topic, memberCount: memberIds?.length }, 'start_discussion called');

  try {
    // Validate required params
    if (!context) {
      return {
        success: false,
        error: 'context is required',
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

    // Step 1: Create chat or use existing
    let targetChatId: string;
    if (existingChatId) {
      targetChatId = existingChatId;
      logger.info({ chatId: targetChatId }, 'Using existing chat');
    } else {
      // Use topic as group name, fall back to auto-generated
      const chatName = topic || `讨论: ${context.substring(0, 30)}...`;
      const createResult = await ipcClient.createChat(chatName, undefined, memberIds);

      if (!createResult.success) {
        const errorMsg = getIpcErrorMessage(createResult.errorType, createResult.error);
        logger.error({ errorType: createResult.errorType, error: createResult.error }, 'Failed to create chat');
        return {
          success: false,
          error: createResult.error ?? 'Failed to create chat',
          message: errorMsg,
        };
      }

      targetChatId = createResult.chatId!;
      logger.info({ chatId: targetChatId, name: createResult.name }, 'Chat created for discussion');
    }

    // Step 2: Send context message to trigger ChatAgent
    const sendResult = await ipcClient.sendMessage(targetChatId, context);
    if (!sendResult.success) {
      const errorMsg = getIpcErrorMessage(sendResult.errorType, sendResult.error);
      logger.error({ chatId: targetChatId, errorType: sendResult.errorType, error: sendResult.error }, 'Failed to send context');
      return {
        success: false,
        chatId: targetChatId,
        error: sendResult.error ?? 'Failed to send context',
        message: errorMsg,
      };
    }

    // Step 3: Register as temp chat for lifecycle management
    const registerResult = await ipcClient.registerTempChat(
      targetChatId,
      expiresAt,
      creatorChatId,
      { source: 'start_discussion', topic }
    );
    if (!registerResult.success) {
      // Non-fatal: discussion was already started, just log the warning
      logger.warn(
        { chatId: targetChatId, error: registerResult.error },
        'Failed to register temp chat (non-fatal, discussion already started)'
      );
    }

    logger.info({ chatId: targetChatId, expiresAt: registerResult.expiresAt }, 'Discussion started');
    return {
      success: true,
      chatId: targetChatId,
      expiresAt: registerResult.expiresAt,
      message: `✅ 讨论已发起 (chatId: ${targetChatId})${registerResult.expiresAt ? `，将于 ${registerResult.expiresAt} 过期` : ''}`,
    };

  } catch (error) {
    logger.error({ err: error }, 'start_discussion FAILED');
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    return { success: false, error: errorMessage, message: `❌ 发起讨论失败: ${errorMessage}` };
  }
}
