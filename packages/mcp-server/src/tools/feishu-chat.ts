/**
 * feishu_create_chat / feishu_dissolve_chat tool implementations.
 *
 * These tools enable Agent and Schedule to manage Feishu group chats
 * (create/dissolve) via IPC, following the MCP→IPC→Primary Node→Lark SDK path.
 *
 * @module mcp-server/tools/feishu-chat
 * @see Issue #1546
 */

import { createLogger, getIpcClient } from '@disclaude/core';
import { isIpcAvailable, getIpcErrorMessage } from './ipc-utils.js';
import { getFeishuCredentials } from './credentials.js';
import type { SendMessageResult } from './types.js';

const logger = createLogger('FeishuChatOps');

/**
 * Create a Feishu group chat via IPC.
 *
 * Issue #1546: Part of temporary session management system.
 * Architecture: Agent → MCP tool → IPC → Primary Node → GroupService → Lark SDK → Feishu API
 *
 * @param params.name - Group name (required)
 * @param params.description - Group description (optional)
 * @param params.members - Initial member open_id list (optional)
 * @returns Operation result
 */
export async function feishu_create_chat(params: {
  name: string;
  description?: string;
  members?: string[];
}): Promise<SendMessageResult> {
  const { name, description, members } = params;

  logger.info({ name, memberCount: members?.length }, 'feishu_create_chat called');

  try {
    if (!name) {
      throw new Error('name is required');
    }

    const { appId, appSecret } = getFeishuCredentials();
    if (!appId || !appSecret) {
      const errorMsg = 'Feishu credentials not configured. Please set FEISHU_APP_ID and FEISHU_APP_SECRET in disclaude.config.yaml';
      logger.error(errorMsg);
      return { success: false, error: errorMsg, message: `❌ ${errorMsg}` };
    }

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
    const result = await ipcClient.feishuCreateGroup(name, description, members);

    if (!result.success) {
      const errorMsg = getIpcErrorMessage(result.errorType, result.error);
      logger.error({ errorType: result.errorType, error: result.error }, 'IPC create group failed');
      return {
        success: false,
        error: result.error ?? 'Failed to create group via IPC',
        message: errorMsg,
      };
    }

    logger.info({ chatId: result.chatId, name }, 'Group created successfully');
    return {
      success: true,
      message: `✅ Group "${name}" created (chatId: ${result.chatId})`,
    };
  } catch (error) {
    logger.error({ err: error, name }, 'feishu_create_chat FAILED');
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    return { success: false, error: errorMessage, message: `❌ Failed to create group: ${errorMessage}` };
  }
}

/**
 * Dissolve a Feishu group chat via IPC.
 *
 * Issue #1546: Part of temporary session management system.
 * Architecture: Agent → MCP tool → IPC → Primary Node → dissolveChat → Lark SDK → Feishu API
 *
 * @param params.chatId - The chatId of the group to dissolve (required)
 * @returns Operation result
 */
export async function feishu_dissolve_chat(params: {
  chatId: string;
}): Promise<SendMessageResult> {
  const { chatId } = params;

  logger.info({ chatId }, 'feishu_dissolve_chat called');

  try {
    if (!chatId) {
      throw new Error('chatId is required');
    }

    const { appId, appSecret } = getFeishuCredentials();
    if (!appId || !appSecret) {
      const errorMsg = 'Feishu credentials not configured. Please set FEISHU_APP_ID and FEISHU_APP_SECRET in disclaude.config.yaml';
      logger.error(errorMsg);
      return { success: false, error: errorMsg, message: `❌ ${errorMsg}` };
    }

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
    const result = await ipcClient.feishuDissolveGroup(chatId);

    if (!result.success) {
      const errorMsg = getIpcErrorMessage(result.errorType, result.error);
      logger.error({ chatId, errorType: result.errorType, error: result.error }, 'IPC dissolve group failed');
      return {
        success: false,
        error: result.error ?? 'Failed to dissolve group via IPC',
        message: errorMsg,
      };
    }

    logger.info({ chatId }, 'Group dissolved successfully');
    return {
      success: true,
      message: `✅ Group dissolved (chatId: ${chatId})`,
    };
  } catch (error) {
    logger.error({ err: error, chatId }, 'feishu_dissolve_chat FAILED');
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    return { success: false, error: errorMessage, message: `❌ Failed to dissolve group: ${errorMessage}` };
  }
}
