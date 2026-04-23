/**
 * create_group tool implementation.
 *
 * Creates a new Feishu group chat for context offloading — delivering
 * long-form content to a dedicated side group while keeping the main
 * conversation clean.
 *
 * Issue #2351: Context Offloading — side group creation.
 *
 * @module mcp-server/tools/create-group
 */

import { createLogger, getIpcClient } from '@disclaude/core';
import { isIpcAvailable, getIpcErrorMessage } from './ipc-utils.js';
import type { CreateGroupResult } from './types.js';

const logger = createLogger('CreateGroup');

/**
 * Create a new Feishu group chat.
 *
 * @param params.name - Group name
 * @param params.description - Optional group description
 * @param params.members - Optional list of open IDs to add as initial members
 */
export async function create_group(params: {
  name: string;
  description?: string;
  members?: string[];
}): Promise<CreateGroupResult> {
  const { name, description, members } = params;

  logger.info({ name, description, memberCount: members?.length }, 'create_group called');

  try {
    if (!name || typeof name !== 'string') {
      return { success: false, error: 'name is required', message: '❌ Group name is required' };
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
    const result = await ipcClient.createGroup(name, description, members);

    if (!result.success) {
      const errorMsg = getIpcErrorMessage(result.errorType, result.error);
      logger.error({ name, errorType: result.errorType, error: result.error }, 'create_group failed');
      return {
        success: false,
        error: result.error ?? 'Failed to create group via IPC',
        message: errorMsg,
      };
    }

    logger.info({ name, chatId: result.chatId }, 'Group created');
    const memberInfo = members && members.length > 0 ? `, ${members.length} member(s)` : '';
    return {
      success: true,
      chatId: result.chatId,
      message: `✅ Group「${name}」created (chatId: ${result.chatId}${memberInfo}). Use send_text or send_card to deliver content to this group.`,
    };

  } catch (error) {
    logger.error({ err: error, name }, 'create_group FAILED');
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    return { success: false, error: errorMessage, message: `❌ Failed to create group: ${errorMessage}` };
  }
}
