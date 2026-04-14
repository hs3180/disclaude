/**
 * create_side_chat tool implementation.
 *
 * Creates a new Feishu group chat for content offloading (side group).
 * The agent can then use send_text/send_card to deliver long-form content
 * to the new group, keeping the main conversation clean.
 *
 * Issue #2351: Context Offloading - Auto-create side group for long-form content delivery.
 *
 * @module mcp-server/tools/create-side-chat
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createLogger } from '@disclaude/core';

const execFileAsync = promisify(execFile);
const logger = createLogger('CreateSideChat');

/** Maximum group name length (Feishu API limit) */
const MAX_GROUP_NAME_LENGTH = 64;

/** Timeout for lark-cli commands in milliseconds */
const LARK_CLI_TIMEOUT_MS = 30_000;

/** Regex for validating member open IDs */
const MEMBER_ID_REGEX = /^ou_[a-zA-Z0-9]+$/;

/** Regex for allowed characters in group names */
const GROUP_NAME_REGEX = /^[a-zA-Z0-9_\-.#:/ ()（）【】\u4e00-\u9fff]+$/;

/**
 * Result type for create_side_chat tool.
 */
export interface CreateSideChatResult {
  success: boolean;
  message: string;
  chatId?: string;
  error?: string;
}

/**
 * Truncate a group name to max length at character boundaries.
 */
function truncateGroupName(name: string): string {
  return Array.from(name).slice(0, MAX_GROUP_NAME_LENGTH).join('');
}

/**
 * Validate a member open ID format.
 */
function isValidMemberId(id: string): boolean {
  return MEMBER_ID_REGEX.test(id);
}

/**
 * Validate a group name.
 */
function isValidGroupName(name: string): boolean {
  return GROUP_NAME_REGEX.test(name);
}

/**
 * Create a side group chat for content offloading.
 *
 * Uses lark-cli to synchronously create a Feishu group chat.
 * Returns the new chat_id so the agent can send content via send_text/send_card.
 *
 * @param params.name - Group name (required, max 64 chars)
 * @param params.members - Array of member open IDs to invite (required, at least 1)
 * @param params.parentChatId - Optional originating chat ID for reference
 */
export async function create_side_chat(params: {
  name: string;
  members: string[];
  parentChatId?: string;
}): Promise<CreateSideChatResult> {
  const { name, members, parentChatId } = params;

  logger.info({ name, memberCount: members?.length, parentChatId }, 'create_side_chat called');

  try {
    // ---- Validate name ----
    if (!name || typeof name !== 'string') {
      return {
        success: false,
        error: 'name is required and must be a non-empty string',
        message: '❌ 群名称不能为空',
      };
    }
    if (!isValidGroupName(name)) {
      return {
        success: false,
        error: `Invalid group name '${name}' — contains unsafe characters`,
        message: `❌ 群名称包含不安全字符: "${name.length > 20 ? `${name.slice(0, 20)}...` : name}"`,
      };
    }

    // ---- Validate members ----
    if (!Array.isArray(members) || members.length === 0) {
      return {
        success: false,
        error: 'members must be a non-empty array of open IDs (ou_xxxxx format)',
        message: '❌ 必须提供至少一个成员 ID（格式: ou_xxxxx）',
      };
    }

    const invalidMembers = members.filter((m) => !isValidMemberId(m));
    if (invalidMembers.length > 0) {
      return {
        success: false,
        error: `Invalid member IDs: ${invalidMembers.join(', ')} — expected ou_xxxxx format`,
        message: `❌ 成员 ID 格式错误: ${invalidMembers[0]}（期望格式: ou_xxxxx）`,
      };
    }

    // ---- Create group via lark-cli ----
    const truncatedName = truncateGroupName(name);
    const membersStr = members.join(',');

    logger.debug({ truncatedName, membersStr }, 'Creating group via lark-cli');

    let stdout: string;
    let stderr: string | null = null;

    try {
      const result = await execFileAsync(
        'lark-cli',
        ['im', '+chat-create', '--name', truncatedName, '--users', membersStr],
        { timeout: LARK_CLI_TIMEOUT_MS, maxBuffer: 1024 * 1024 },
      );
      ({ stdout } = result);
    } catch (err: unknown) {
      const execErr = err as { stdout?: string; stderr?: string; message?: string };
      stdout = execErr.stdout ?? '';
      stderr = execErr.stderr ?? execErr.message ?? '';
      logger.error({ stderr, stdout }, 'lark-cli group creation failed');
      return {
        success: false,
        error: `lark-cli failed: ${(stderr || stdout).replace(/\n/g, ' ').trim()}`,
        message: `❌ 创建群聊失败: ${(stderr || '未知错误').replace(/\n/g, ' ').substring(0, 100)}`,
      };
    }

    // ---- Parse response ----
    let newChatId: string | null = null;
    try {
      const parsed = JSON.parse(stdout);
      newChatId = parsed?.data?.chat_id ?? null;
    } catch {
      logger.error({ stdout }, 'Failed to parse lark-cli response as JSON');
    }

    if (!newChatId) {
      logger.error({ stdout, stderr }, 'No chat_id in lark-cli response');
      return {
        success: false,
        error: `No chat_id returned from lark-cli. Response: ${stdout.substring(0, 200)}`,
        message: '❌ 创建群聊失败：未获得群聊 ID',
      };
    }

    logger.info({ newChatId, truncatedName }, 'Side group created successfully');

    return {
      success: true,
      chatId: newChatId,
      message: `✅ 群聊「${truncatedName}」已创建 (chatId: ${newChatId})。你可以使用 send_text 或 send_card 向该群发送内容。`,
    };

  } catch (error) {
    logger.error({ err: error, name }, 'create_side_chat FAILED');
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    return { success: false, error: errorMessage, message: `❌ 创建群聊失败: ${errorMessage}` };
  }
}

// Export validation helpers for testing
export const _internal = {
  isValidMemberId,
  isValidGroupName,
  truncateGroupName,
  MAX_GROUP_NAME_LENGTH,
};
