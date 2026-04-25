/**
 * create_side_group tool implementation.
 *
 * Creates a Feishu group chat, invites members, and optionally sends content
 * to the new group. Used for Context Offloading — automatically routing
 * long-form content to a dedicated side group.
 *
 * Issue #2351: Context Offloading — auto-create side group for long-form content.
 *
 * @module mcp-server/tools/create-side-group
 */

import { createLogger, getIpcClient } from '@disclaude/core';
import { isIpcAvailable, getIpcErrorMessage } from './ipc-utils.js';
import { getChatIdValidationError } from '../utils/chat-id-validator.js';
import type { CreateSideGroupResult } from './types.js';

const logger = createLogger('CreateSideGroup');

/** Maximum length for group names (consistent with chat schema) */
const MAX_GROUP_NAME_LENGTH = 64;

/** Regex for valid member open IDs */
const MEMBER_ID_REGEX = /^ou_[a-zA-Z0-9]+$/;

/**
 * Truncate a group name to max length at character boundaries.
 */
function truncateGroupName(name: string): string {
  return Array.from(name).slice(0, MAX_GROUP_NAME_LENGTH).join('');
}

/**
 * Create a side group for context offloading.
 *
 * Creates a Feishu group, invites specified members, optionally sends content
 * to the new group, and optionally registers it as a temp chat for lifecycle
 * management.
 *
 * @param params.name - Group display name
 * @param params.members - Array of member open IDs to invite
 * @param params.description - Optional group description
 * @param params.messages - Optional array of text messages to send after creation
 * @param params.parentChatId - Optional originating chat ID (for temp chat registration)
 * @param params.expiresAt - Optional ISO timestamp for group expiry (requires parentChatId)
 * @param params.triggerMode - Optional trigger mode for the new group ('mention' | 'always')
 */
export async function create_side_group(params: {
  name: string;
  members: string[];
  description?: string;
  messages?: string[];
  parentChatId?: string;
  expiresAt?: string;
  triggerMode?: 'mention' | 'always';
}): Promise<CreateSideGroupResult> {
  const { name, members, description, messages, parentChatId, expiresAt, triggerMode } = params;

  logger.info({
    name,
    memberCount: members.length,
    hasMessages: !!messages?.length,
    parentChatId,
  }, 'create_side_group called');

  try {
    // ---- Validate inputs ----
    if (!name || typeof name !== 'string') {
      return { success: false, message: '❌ Group name is required', error: 'name is required' };
    }
    if (!Array.isArray(members) || members.length === 0) {
      return { success: false, message: '❌ At least one member is required', error: 'members must be a non-empty array' };
    }

    // Validate member IDs
    for (const member of members) {
      if (typeof member !== 'string' || !MEMBER_ID_REGEX.test(member)) {
        return {
          success: false,
          message: `❌ Invalid member ID '${member}' — expected ou_xxxxx format`,
          error: `Invalid member ID: ${member}`,
        };
      }
    }

    // Validate parentChatId if provided
    if (parentChatId) {
      const chatIdError = getChatIdValidationError(parentChatId);
      if (chatIdError) {
        return { success: false, message: `❌ Invalid parentChatId: ${chatIdError}`, error: chatIdError };
      }
    }

    const truncatedName = truncateGroupName(name);

    // ---- Check IPC availability ----
    if (!(await isIpcAvailable())) {
      const errorMsg = 'IPC service unavailable. Please ensure Primary Node is running.';
      logger.error(errorMsg);
      return {
        success: false,
        error: errorMsg,
        message: '❌ IPC 服务不可用。请检查 Primary Node 服务是否正在运行。',
      };
    }

    // ---- Step 1: Create the group via IPC ----
    logger.info({ name: truncatedName, memberCount: members.length }, 'Creating group via IPC');
    const ipcClient = getIpcClient();
    const createResult = await ipcClient.createGroup(truncatedName, members, description);

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
    logger.info({ newChatId }, 'Group created successfully');

    // ---- Step 2: Send content messages (if provided) ----
    if (messages && messages.length > 0) {
      for (let i = 0; i < messages.length; i++) {
        const text = messages[i];
        if (!text) {continue;}

        const sendResult = await ipcClient.sendMessage(newChatId, text);
        if (!sendResult.success) {
          logger.warn({
            chatId: newChatId,
            messageIndex: i,
            error: sendResult.error,
          }, 'Failed to send message to new group (group was created)');
          // Continue sending remaining messages even if one fails
        }
      }
    }

    // ---- Step 3: Register as temp chat (if parentChatId is provided) ----
    if (parentChatId && expiresAt) {
      try {
        const registerResult = await ipcClient.registerTempChat(
          newChatId,
          expiresAt,
          parentChatId,
          { type: 'context_offload', parentChatId },
          { triggerMode: triggerMode ?? 'always' },
        );
        if (registerResult.success) {
          logger.info({ newChatId, expiresAt: registerResult.expiresAt }, 'Registered as temp chat');
        } else {
          logger.warn({ error: registerResult.error }, 'Failed to register temp chat (group was created)');
        }
      } catch (err) {
        logger.warn({ err }, 'Failed to register temp chat (group was created)');
      }
    }

    return {
      success: true,
      chatId: newChatId,
      message: `✅ 群聊「${truncatedName}」已创建 (chatId: ${newChatId})`,
    };

  } catch (error) {
    logger.error({ err: error, name }, 'create_side_group FAILED');
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    return { success: false, error: errorMessage, message: `❌ 创建群聊失败: ${errorMessage}` };
  }
}
