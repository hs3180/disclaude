/**
 * create_group tool implementation.
 *
 * Creates a new Feishu group chat via lark-cli.
 * Used for Context Offloading (Issue #2351) — Agent creates a side group
 * for delivering long-form content, keeping the main conversation clean.
 *
 * The Agent can then use existing tools (send_text, send_card, send_file)
 * to deliver content to the new group, and register_temp_chat for auto-expiry.
 *
 * @module mcp-server/tools/create-group
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createLogger } from '@disclaude/core';
import type { CreateGroupResult } from './types.js';

const logger = createLogger('CreateGroup');

const execFileAsync = promisify(execFile);

/** Timeout for lark-cli commands (ms). */
const LARK_CLI_TIMEOUT_MS = 30_000;

/** Maximum group name length (Feishu limit). */
const MAX_GROUP_NAME_LENGTH = 100;

/** Regex for valid group names (allow CJK, alphanumeric, spaces, common punctuation). */
const GROUP_NAME_REGEX = /^[\p{L}\p{N}\s\-_.·\-(\)\[\]【】、，。！？…]+$/u;

/** Regex for valid Feishu open_id format. */
const MEMBER_ID_REGEX = /^ou_[a-zA-Z0-9]+$/;

/**
 * Create a new Feishu group chat.
 *
 * @param params.name - Group name (required, 1-100 chars)
 * @param params.memberIds - Array of Feishu open_ids to add as initial members (required, ou_xxxxx format)
 * @param params.description - Optional group description
 */
export async function create_group(params: {
  name: string;
  memberIds: string[];
  description?: string;
}): Promise<CreateGroupResult> {
  const { name, memberIds, description } = params;

  logger.info({ name, memberCount: memberIds?.length }, 'create_group called');

  try {
    // Validate name
    if (!name || typeof name !== 'string') {
      return { success: false, message: '❌ Group name is required.' };
    }
    const trimmedName = name.trim();
    if (trimmedName.length === 0) {
      return { success: false, message: '❌ Group name cannot be empty.' };
    }
    if (trimmedName.length > MAX_GROUP_NAME_LENGTH) {
      return { success: false, message: `❌ Group name too long (${trimmedName.length} chars, max ${MAX_GROUP_NAME_LENGTH}).` };
    }
    if (!GROUP_NAME_REGEX.test(trimmedName)) {
      return { success: false, message: '❌ Group name contains invalid characters. Use letters, numbers, spaces, and common punctuation.' };
    }

    // Validate memberIds
    if (!Array.isArray(memberIds) || memberIds.length === 0) {
      return { success: false, message: '❌ At least one member ID (open_id) is required.' };
    }
    const invalidMember = memberIds.find((id) => !MEMBER_ID_REGEX.test(id));
    if (invalidMember !== undefined) {
      return { success: false, message: `❌ Invalid member ID '${invalidMember}'. Expected ou_xxxxx format.` };
    }

    // Build lark-cli arguments
    const args = ['im', '+chat-create', '--name', trimmedName, '--users', memberIds.join(',')];

    logger.debug({ args: args.map((a, i) => i === args.indexOf(memberIds.join(',')) ? `${memberIds.length} members` : a) }, 'Calling lark-cli');

    // Call lark-cli
    let stdout: string;
    let stderr: string;
    try {
      const result = await execFileAsync('lark-cli', args, {
        timeout: LARK_CLI_TIMEOUT_MS,
        maxBuffer: 1024 * 1024,
      });
      ({ stdout, stderr } = result);
    } catch (err: unknown) {
      const execErr = err as { stdout?: string; stderr?: string; code?: number | string | null; message?: string };
      const errorOutput = execErr.stderr ?? execErr.message ?? 'Unknown error';

      // Detect missing lark-cli
      if (execErr.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' || (execErr.message && execErr.message.includes('ENOENT'))) {
        logger.error('lark-cli not found in PATH');
        return { success: false, message: '❌ lark-cli not found. Please ensure @larksuite/cli is installed globally.' };
      }

      logger.error({ err: errorOutput, exitCode: execErr.code }, 'lark-cli failed');
      return {
        success: false,
        message: `❌ Failed to create group: ${errorOutput.replace(/\n/g, ' ').trim()}`,
      };
    }

    // Parse response — lark-cli returns JSON with data.chat_id
    let chatId: string | null = null;
    try {
      const parsed = JSON.parse(stdout);
      chatId = parsed?.data?.chat_id ?? null;
    } catch {
      // Not valid JSON — try to extract from raw output
      logger.debug({ stdout }, 'Non-JSON response from lark-cli');
    }

    if (!chatId) {
      logger.error({ stdout, stderr }, 'Failed to extract chat_id from lark-cli response');
      return {
        success: false,
        message: `❌ Group created but failed to extract chat ID from response. Raw output: ${(stdout || '').substring(0, 200)}`,
      };
    }

    logger.info({ chatId, name: trimmedName }, 'Group created successfully');
    const desc = description ? ` (${description})` : '';
    return {
      success: true,
      chatId,
      name: trimmedName,
      message: `✅ Group "${trimmedName}" created${desc}. chatId: ${chatId}. Use send_text/send_card to deliver content, register_temp_chat for auto-expiry.`,
    };
  } catch (error) {
    logger.error({ err: error, name }, 'create_group FAILED');
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    return { success: false, message: `❌ Failed to create group: ${errorMessage}` };
  }
}
