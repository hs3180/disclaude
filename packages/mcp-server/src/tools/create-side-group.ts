/**
 * create_side_group tool implementation.
 *
 * Creates a Feishu group chat for context offloading — delivering long-form
 * content (code blocks, config files, architecture docs) to a dedicated side
 * group while keeping the main conversation clean.
 *
 * Issue #2351: Context Offloading — Auto-create side group for long-form content.
 *
 * @module mcp-server/tools/create-side-group
 */

import { createLogger, getIpcClient } from '@disclaude/core';
import { isIpcAvailable, getIpcErrorMessage } from './ipc-utils.js';
import { getFeishuCredentials } from './credentials.js';
import type { CreateSideGroupResult } from './types.js';

const logger = createLogger('CreateSideGroup');

/**
 * Create a side group for context offloading.
 *
 * @param params.name - Group display name
 * @param params.members - Initial member open IDs (e.g. ["ou_xxx"])
 * @param params.description - Optional group description
 */
export async function create_side_group(params: {
  name: string;
  members: string[];
  description?: string;
}): Promise<CreateSideGroupResult> {
  const { name, members, description } = params;

  logger.info({ name, memberCount: members.length }, 'create_side_group called');

  try {
    if (!name) {
      throw new Error('name is required');
    }
    if (!Array.isArray(members) || members.length === 0) {
      throw new Error('members must be a non-empty array of open IDs');
    }

    const { appId, appSecret } = getFeishuCredentials();

    if (!appId || !appSecret) {
      const errorMsg = 'Feishu credentials not configured. Please set FEISHU_APP_ID and FEISHU_APP_SECRET in disclaude.config.yaml';
      logger.error(errorMsg);
      return { success: false, error: errorMsg, message: `❌ ${errorMsg}` };
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
    const result = await ipcClient.createGroup({ name, members, description });

    if (!result.success) {
      const errorMsg = getIpcErrorMessage(
        (result as { errorType?: string }).errorType as 'ipc_unavailable' | 'ipc_timeout' | 'ipc_request_failed' | undefined,
        result.error
      );
      logger.error({ name, error: result.error }, 'create_side_group failed');
      return {
        success: false,
        error: result.error ?? 'Failed to create group via IPC',
        message: errorMsg,
      };
    }

    const {chatId} = result;
    if (!chatId) {
      return {
        success: false,
        error: 'No chat ID returned from group creation',
        message: '❌ 群聊创建成功但未返回 chat ID',
      };
    }
    logger.info({ chatId, name }, 'Side group created');

    return {
      success: true,
      chatId,
      message: `✅ 群聊「${name}」已创建 (chatId: ${chatId})。你可以使用 send_text 或 send_card 向该群发送内容。`,
    };

  } catch (error) {
    logger.error({ err: error, name }, 'create_side_group FAILED');
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    return { success: false, error: errorMessage, message: `❌ 创建群聊失败: ${errorMessage}` };
  }
}
