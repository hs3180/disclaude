/**
 * create_side_group tool implementation.
 *
 * Creates a Feishu side group for long-form content delivery (Issue #2351).
 * Uses lark-cli directly for immediate group creation, then optionally
 * registers the chat for lifecycle management via IPC.
 *
 * @module mcp-server/tools/create-side-group
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createLogger, getIpcClient } from '@disclaude/core';
import { isIpcAvailable } from './ipc-utils.js';
import type { CreateSideGroupResult } from './types.js';

const execFileAsync = promisify(execFile);

const logger = createLogger('CreateSideGroup');

/** Default timeout for lark-cli group creation (30s) */
const LARK_CLI_TIMEOUT_MS = 30_000;

/**
 * Create a side group via lark-cli.
 *
 * @param params.name - Group display name
 * @param params.members - Array of member open IDs to invite
 * @param params.registerTempChat - Whether to register for lifecycle management (default: true)
 * @param params.expiresAt - Optional ISO timestamp for auto-dissolution (default: 24h via register_temp_chat)
 * @param params.creatorChatId - Optional originating chat ID (for lifecycle notifications)
 */
export async function create_side_group(params: {
  name: string;
  members: string[];
  registerTempChat?: boolean;
  expiresAt?: string;
  creatorChatId?: string;
}): Promise<CreateSideGroupResult> {
  const {
    name,
    members,
    registerTempChat = true,
    expiresAt,
    creatorChatId,
  } = params;

  logger.info({ name, memberCount: members.length, registerTempChat }, 'create_side_group called');

  // ---- Step 1: Validate inputs ----
  if (!name || typeof name !== 'string') {
    return { success: false, error: 'name is required and must be a non-empty string', message: '❌ 群名称不能为空' };
  }

  if (!Array.isArray(members) || members.length === 0) {
    return { success: false, error: 'members is required and must be a non-empty array', message: '❌ 群成员列表不能为空' };
  }

  for (const member of members) {
    if (typeof member !== 'string' || !/^ou_[a-zA-Z0-9]+$/.test(member)) {
      return {
        success: false,
        error: `Invalid member ID '${member}' — expected ou_xxxxx format`,
        message: `❌ 无效的成员 ID: ${member}`,
      };
    }
  }

  // ---- Step 2: Create group via lark-cli ----
  let chatId: string | null = null;
  let larkError: string | null = null;

  try {
    const membersStr = members.join(',');
    const result = await execFileAsync(
      'lark-cli',
      ['im', '+chat-create', '--name', name, '--users', membersStr],
      { timeout: LARK_CLI_TIMEOUT_MS, maxBuffer: 1024 * 1024 },
    );

    // Parse response to extract chat_id
    try {
      const parsed = JSON.parse(result.stdout);
      chatId = parsed?.data?.chat_id ?? null;
    } catch {
      // lark-cli may return non-JSON output; try to extract chat_id from stdout
      const match = result.stdout.match(/chat_id["\s:]+([a-zA-Z0-9_]+)/);
      if (match) {
        [, chatId] = match;
      }
    }

    if (!chatId) {
      larkError = `Failed to parse chat_id from lark-cli response: ${result.stdout}`;
    }
  } catch (err: unknown) {
    const execErr = err as { stderr?: string; message?: string };
    larkError = execErr.stderr ?? execErr.message ?? 'unknown error';
  }

  if (!chatId) {
    const errorMsg = (larkError ?? 'unknown error').replace(/\n/g, ' ').replace(/\s+/g, ' ').trim();
    logger.error({ name, error: errorMsg }, 'Failed to create side group via lark-cli');
    return {
      success: false,
      error: errorMsg,
      message: `❌ 创建群聊失败: ${errorMsg}`,
    };
  }

  logger.info({ name, chatId }, 'Side group created successfully');

  // ---- Step 3: Optionally register for lifecycle management ----
  if (registerTempChat) {
    try {
      if (await isIpcAvailable()) {
        const ipcClient = getIpcClient();
        const registerResult = await ipcClient.registerTempChat(
          chatId,
          expiresAt,
          creatorChatId,
          { source: 'create_side_group', groupName: name },
          { triggerMode: 'always' },
        );

        if (!registerResult.success) {
          logger.warn(
            { chatId, errorType: registerResult.errorType, error: registerResult.error },
            'Failed to register side group for lifecycle management (group still created)',
          );
          // Non-fatal: group was created, just lifecycle tracking failed
        }
      } else {
        logger.warn({ chatId }, 'IPC unavailable, skipping lifecycle registration (group still created)');
      }
    } catch (err) {
      logger.warn({ err, chatId }, 'Error during lifecycle registration (group still created)');
    }
  }

  return {
    success: true,
    chatId,
    message: `✅ 侧群「${name}」已创建 (chatId: ${chatId})。使用 send_text/send_card 向该群发送内容。`,
  };
}
