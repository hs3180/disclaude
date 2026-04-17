/**
 * create_side_group tool implementation.
 *
 * Creates a side group chat for context offloading — delivering long-form
 * content to a dedicated group while keeping the main conversation clean.
 *
 * Issue #2351: Context Offloading - Auto-create side group for long-form content delivery.
 *
 * @module mcp-server/tools/create-side-group
 */

import { createLogger, getIpcClient } from '@disclaude/core';
import { isIpcAvailable, getIpcErrorMessage } from './ipc-utils.js';
import { getFeishuCredentials } from './credentials.js';
import type { CreateSideGroupResult } from './types.js';

const logger = createLogger('CreateSideGroup');

/** Max group name length (same as chat schema) */
const MAX_GROUP_NAME_LENGTH = 64;

/** Validate member IDs are in ou_xxx format */
function isValidMember(m: string): boolean {
  return /^ou_[a-zA-Z0-9]+$/.test(m);
}

/**
 * Create a side group and optionally send content to it.
 *
 * Workflow:
 * 1. Create group via IPC (Primary Node calls lark-cli)
 * 2. Send content to the new group via IPC
 * 3. Register the group as a temp chat for lifecycle management
 *
 * @param params.name - Group name (max 64 chars)
 * @param params.members - Array of member open IDs (ou_xxx format)
 * @param params.content - Optional text content to send to the new group
 * @param params.description - Optional group description
 * @param params.parentChatId - Optional originating chat ID for temp chat tracking
 * @param params.expiresInHours - Optional expiry time in hours (default: 24)
 */
export async function create_side_group(params: {
  name: string;
  members: string[];
  content?: string;
  description?: string;
  parentChatId?: string;
  expiresInHours?: number;
}): Promise<CreateSideGroupResult> {
  const { name, members, content, description, parentChatId, expiresInHours } = params;

  logger.info({ name, memberCount: members?.length, hasContent: !!content }, 'create_side_group called');

  try {
    // Validate name
    if (!name || typeof name !== 'string') {
      throw new Error('name is required');
    }
    // Name will be truncated before IPC call (no hard rejection for long names)

    // Validate members
    if (!Array.isArray(members) || members.length === 0) {
      throw new Error('members must be a non-empty array of open IDs (ou_xxx format)');
    }
    const invalidMembers = members.filter(m => !isValidMember(m));
    if (invalidMembers.length > 0) {
      throw new Error(`Invalid member IDs: ${invalidMembers.join(', ')} — expected ou_xxx format`);
    }

    // Check Feishu credentials
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

    // Step 1: Create group via IPC
    const truncatedName = Array.from(name).slice(0, MAX_GROUP_NAME_LENGTH).join('');
    const createResult = await ipcClient.createSideGroup(truncatedName, members, description);

    if (!createResult.success || !createResult.chatId) {
      const errorMsg = getIpcErrorMessage(createResult.errorType, createResult.error);
      logger.error({ errorType: createResult.errorType, error: createResult.error }, 'Group creation failed');
      return {
        success: false,
        error: createResult.error ?? 'Failed to create group via IPC',
        message: `❌ 群聊创建失败: ${errorMsg}`,
      };
    }

    const newChatId = createResult.chatId;
    logger.info({ chatId: newChatId, name: createResult.name }, 'Side group created');

    // Step 2: Send content to the new group (if provided)
    if (content) {
      const sendResult = await ipcClient.sendMessage(newChatId, content);
      if (!sendResult.success) {
        logger.warn({ chatId: newChatId, error: sendResult.error }, 'Failed to send content to side group');
        // Don't fail — group was created successfully, content delivery is secondary
      } else {
        logger.info({ chatId: newChatId }, 'Content sent to side group');
      }
    }

    // Step 3: Register as temp chat for lifecycle management
    const expiresInMs = (expiresInHours ?? 24) * 60 * 60 * 1000;
    const expiresAt = new Date(Date.now() + expiresInMs).toISOString();
    const registerResult = await ipcClient.registerTempChat(
      newChatId,
      expiresAt,
      parentChatId,
      { source: 'side-group', name: truncatedName },
      { triggerMode: 'always' },
    );

    if (!registerResult.success) {
      logger.warn({ chatId: newChatId, error: registerResult.error }, 'Failed to register side group as temp chat');
      // Don't fail — group was created, temp chat registration is secondary
    } else {
      logger.info({ chatId: newChatId, expiresAt: registerResult.expiresAt }, 'Side group registered as temp chat');
    }

    return {
      success: true,
      chatId: newChatId,
      name: createResult.name ?? truncatedName,
      message: `✅ 已创建群聊「${createResult.name ?? truncatedName}」(chatId: ${newChatId})${content ? '，内容已发送' : ''}`,
    };

  } catch (error) {
    logger.error({ err: error, name }, 'create_side_group FAILED');
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    return { success: false, error: errorMessage, message: `❌ Failed to create side group: ${errorMessage}` };
  }
}
