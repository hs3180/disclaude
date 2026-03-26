/**
 * create_chat tool implementation.
 *
 * Creates a new group chat via IPC to Primary Node.
 * Platform-agnostic: works with any channel that supports group creation.
 *
 * Issue #1228: Added `soul` parameter for discussion personality injection.
 * When a soul profile is specified, the chat agent will use the corresponding
 * personality profile to maintain discussion focus.
 *
 * @module mcp-server/tools/create-chat
 */

import path from 'path';
import os from 'os';
import { createLogger, getIpcClient } from '@disclaude/core';
import { isIpcAvailable, getIpcErrorMessage } from './ipc-utils.js';
import type { CreateChatResult } from './types.js';

const logger = createLogger('CreateChat');

/**
 * Get the directory where built-in soul profiles are stored.
 * Souls are stored in the project root's souls/ directory.
 */
function getBuiltinSoulsDir(): string {
  return path.resolve(import.meta.dirname, '../../../../souls');
}

/**
 * Resolve a soul parameter to a file path.
 *
 * Supports:
 * - Built-in profile names: "discussion" → resolves to bundled souls/discussion.md
 * - Absolute paths: used as-is
 * - Relative paths: resolved against workspace directory
 * - Tilde paths: expanded to home directory
 *
 * @param soul - Soul parameter value
 * @param workspaceDir - Workspace directory for resolving relative paths
 * @returns Resolved absolute file path
 */
export function resolveSoulPath(soul: string, workspaceDir?: string): string {
  // Built-in profile: "discussion"
  if (soul === 'discussion') {
    return path.join(getBuiltinSoulsDir(), 'discussion.md');
  }

  // Tilde expansion
  if (soul.startsWith('~')) {
    return path.join(os.homedir(), soul.slice(1));
  }

  // Absolute path
  if (path.isAbsolute(soul)) {
    return soul;
  }

  // Relative path: resolve against workspace
  if (workspaceDir) {
    return path.resolve(workspaceDir, soul);
  }

  return path.resolve(soul);
}

/**
 * Create a new group chat.
 *
 * @param params.name - Group name (optional, auto-generated if not provided)
 * @param params.description - Group description (optional)
 * @param params.memberIds - Initial member IDs (optional, platform decides ID format)
 * @param params.soul - Soul profile for the chat agent (optional).
 *   - Use "discussion" for the built-in discussion focus profile.
 *   - Use a file path for a custom soul profile.
 *   Issue #1228: Discussion focus via SOUL.md personality injection.
 */
export async function create_chat(params: {
  name?: string;
  description?: string;
  memberIds?: string[];
  soul?: string;
}): Promise<CreateChatResult> {
  const { name, description, memberIds, soul } = params;

  logger.info({ name, description, memberCount: memberIds?.length, soul }, 'create_chat called');

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
    const result = await ipcClient.createChat(name, description, memberIds, soul);

    if (!result.success) {
      const errorMsg = getIpcErrorMessage(result.errorType, result.error);
      logger.error({ errorType: result.errorType, error: result.error }, 'create_chat failed');
      return {
        success: false,
        error: result.error ?? 'Failed to create chat via IPC',
        message: errorMsg,
      };
    }

    logger.info({ chatId: result.chatId, name: result.name, soul }, 'Group chat created');
    return {
      success: true,
      chatId: result.chatId,
      name: result.name,
      message: `✅ Group chat created (chatId: ${result.chatId}, name: ${result.name ?? 'auto'}${soul ? `, soul: ${soul}` : ''})`,
    };

  } catch (error) {
    logger.error({ err: error }, 'create_chat FAILED');
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    return { success: false, error: errorMessage, message: `❌ Failed to create chat: ${errorMessage}` };
  }
}
