/**
 * create_chat tool implementation.
 *
 * Creates a new group chat via IPC to Primary Node.
 * Platform-agnostic: works with any channel that supports group creation.
 *
 * @module mcp-server/tools/create-chat
 */

import { createLogger, getIpcClient } from '@disclaude/core';
import { isIpcAvailable, getIpcErrorMessage } from './ipc-utils.js';
import type { CreateChatResult } from './types.js';

const logger = createLogger('CreateChat');

/**
 * Create a new group chat.
 *
 * @param params.name - Group name (optional, auto-generated if not provided)
 * @param params.description - Group description (optional)
 * @param params.memberIds - Initial member IDs (optional, platform decides ID format)
 */
export async function create_chat(params: {
  name?: string;
  description?: string;
  memberIds?: string[];
}): Promise<CreateChatResult> {
  const { name, description, memberIds } = params;

  logger.info({ name, description, memberCount: memberIds?.length }, 'create_chat called');

  try {
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
    const result = await ipcClient.createChat(name, description, memberIds);

    if (!result.success) {
      const errorMsg = getIpcErrorMessage(result.errorType, result.error);
      logger.error({ errorType: result.errorType, error: result.error }, 'create_chat failed');
      return {
        success: false,
        error: result.error ?? 'Failed to create chat via IPC',
        message: errorMsg,
      };
    }

    logger.info({ chatId: result.chatId, name: result.name }, 'Group chat created');
    return {
      success: true,
      chatId: result.chatId,
      name: result.name,
      message: `✅ Group chat created (chatId: ${result.chatId}, name: ${result.name ?? 'auto'})`,
    };

  } catch (error) {
    logger.error({ err: error }, 'create_chat FAILED');
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    return { success: false, error: errorMessage, message: `❌ Failed to create chat: ${errorMessage}` };
  }
}
