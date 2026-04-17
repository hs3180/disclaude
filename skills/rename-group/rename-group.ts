#!/usr/bin/env tsx
/**
 * skills/rename-group/rename-group.ts — Rename a Feishu group chat via lark-cli.
 *
 * Takes a Feishu group chat ID and a new name, renames the group
 * using lark-cli direct API call (not through IPC Channel).
 *
 * Environment variables:
 *   RENAME_CHAT_ID    Feishu group chat ID (oc_xxx format)
 *   RENAME_GROUP_NAME New name for the group
 *   RENAME_SKIP_LARK  Set to '1' to skip lark-cli check and API call (for testing)
 *
 * Exit codes:
 *   0 — success
 *   1 — validation error or fatal error
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

// ---- Constants ----

const LARK_TIMEOUT_MS = 30_000;
const MAX_GROUP_NAME_LENGTH = 64;

/**
 * Regex for Feishu group chat IDs.
 * Group chat IDs start with 'oc_' followed by alphanumeric characters.
 */
const GROUP_CHAT_ID_REGEX = /^oc_[a-zA-Z0-9]+$/;

/**
 * Regex for valid group names.
 * Allows letters, numbers, CJK characters, punctuation, and common symbols.
 * Rejects control characters and empty strings.
 */
const GROUP_NAME_REGEX = /^[^\x00-\x1F\x7F]+$/;

// ---- Validation ----

function exit(msg: string): never {
  console.error(`ERROR: ${msg}`);
  process.exit(1);
}

function validateChatId(chatId: string): void {
  if (!chatId) {
    exit('RENAME_CHAT_ID environment variable is required');
  }
  if (!GROUP_CHAT_ID_REGEX.test(chatId)) {
    exit(`Invalid RENAME_CHAT_ID '${chatId}' — must match oc_xxxxx format`);
  }
}

function validateGroupName(name: string): void {
  if (!name) {
    exit('RENAME_GROUP_NAME environment variable is required');
  }
  if (!GROUP_NAME_REGEX.test(name)) {
    exit(`Invalid RENAME_GROUP_NAME — contains control characters or is empty`);
  }
  if (name.trim().length === 0) {
    exit('RENAME_GROUP_NAME cannot be blank (whitespace only)');
  }
}

/**
 * Truncate a group name to max length at character boundaries.
 * Handles CJK characters correctly via Array.from (splits by code point, not UTF-16 unit).
 */
function truncateGroupName(name: string): string {
  return Array.from(name).slice(0, MAX_GROUP_NAME_LENGTH).join('');
}

// ---- Core logic ----

/**
 * Rename a Feishu group via lark-cli.
 * Uses the raw API call: PUT /open-apis/im/v1/chats/{chatId}
 */
async function renameGroup(
  chatId: string,
  newName: string,
): Promise<{ success: boolean; error: string | null }> {
  const truncatedName = truncateGroupName(newName);

  try {
    await execFileAsync(
      'lark-cli',
      ['api', 'PUT', `/open-apis/im/v1/chats/${chatId}`, '-d', JSON.stringify({ name: truncatedName })],
      { timeout: LARK_TIMEOUT_MS, maxBuffer: 1024 * 1024 },
    );
    return { success: true, error: null };
  } catch (err: unknown) {
    const execErr = err as { stderr?: string; message?: string; code?: number | null };
    const errorMsg = (execErr.stderr ?? execErr.message ?? 'unknown error')
      .replace(/\n/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    return { success: false, error: errorMsg };
  }
}

// ---- Main ----

async function main() {
  const chatId = process.env.RENAME_CHAT_ID ?? '';
  const groupName = process.env.RENAME_GROUP_NAME ?? '';

  // Validate inputs
  validateChatId(chatId);
  validateGroupName(groupName);

  const displayName = truncateGroupName(groupName);
  console.log(`INFO: Renaming group ${chatId} to '${displayName}'`);

  // Check lark-cli availability (skippable for testing)
  if (process.env.RENAME_SKIP_LARK !== '1') {
    try {
      await execFileAsync('lark-cli', ['--version'], { timeout: 5000 });
    } catch {
      exit('Missing required dependency: lark-cli not found in PATH');
    }
  }

  // Skip actual API call in dry-run mode (for testing)
  if (process.env.RENAME_SKIP_LARK === '1') {
    console.log(`OK: Group ${chatId} renamed to '${displayName}' (dry-run)`);
    return;
  }

  // Execute rename
  const result = await renameGroup(chatId, groupName);

  if (result.success) {
    console.log(`OK: Group ${chatId} renamed to '${displayName}'`);
  } else {
    console.error(`ERROR: Failed to rename group ${chatId}: ${result.error}`);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(`ERROR: ${err instanceof Error ? err.message : err}`);
  process.exit(1);
});
