/**
 * create_group tool implementation.
 *
 * Creates a group chat via IPC to Primary Node.
 * Issue #2351: Context Offloading — auto-create side group for long-form content.
 *
 * @module mcp-server/tools/create-group
 */

import { createLogger, getIpcClient } from '@disclaude/core';
import { isIpcAvailable, getIpcErrorMessage } from './ipc-utils.js';
import type { CreateGroupResult } from './types.js';

const logger = createLogger('CreateGroup');

/**
 * Create a group chat.
 *
 * @param params.name - Group name (required)
 * @param params.description - Optional group description
 * @param params.members - Optional array of open_id strings to add as members
 */
export async function create_group(params: {
  name: string;
  description?: string;
  members?: string[];
}): Promise<CreateGroupResult> {
  const { name, description, members } = params;

  logger.info({ name, memberCount: members?.length ?? 0 }, 'create_group called');

  try {
    if (!name) {
      throw new Error('name is required');
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
    const result = await ipcClient.createGroup(name, { description, members });

    if (!result.success) {
      const errorMsg = getIpcErrorMessage(result.errorType, result.error);
      logger.error({ name, errorType: result.errorType, error: result.error }, 'create_group failed');
      return {
        success: false,
        error: result.error ?? 'Failed to create group via IPC',
        message: errorMsg,
      };
    }

    logger.info({ chatId: result.chatId, name }, 'Group created');
    return {
      success: true,
      chatId: result.chatId,
      message: `✅ Group created (chatId: ${result.chatId}, name: ${name})`,
    };
  } catch (error) {
    logger.error({ err: error, name }, 'create_group FAILED');
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    return { success: false, error: errorMessage, message: `❌ Failed to create group: ${errorMessage}` };
  }
}
