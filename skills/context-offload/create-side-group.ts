#!/usr/bin/env tsx
/**
 * skills/context-offload/create-side-group.ts — Create a side group for content offloading.
 *
 * Creates a new Feishu group via lark-cli, invites the requesting user,
 * and returns the new group's chat ID for the agent to send content to.
 *
 * Environment variables:
 *   OFFLOAD_GROUP_NAME       Name for the new group (required)
 *   OFFLOAD_USER_OPEN_ID     Open ID of user to invite (required, ou_xxx format)
 *   OFFLOAD_PARENT_CHAT_ID   Parent chat ID for reference (required, oc_xxx format)
 *   OFFLOAD_SKIP_LARK        Set to '1' to skip lark-cli calls (testing only)
 *
 * Exit codes:
 *   0 — success (outputs JSON to stdout)
 *   1 — validation error or fatal error
 *
 * Issue #2351: Context Offloading - Auto-create side group for long-form content delivery.
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

// ---- Constants ----

const LARK_TIMEOUT_MS = 30_000;
const MAX_GROUP_NAME_LENGTH = 64;

/**
 * Regex for Feishu group chat IDs (oc_xxx).
 */
const GROUP_CHAT_ID_REGEX = /^oc_[a-zA-Z0-9]+$/;

/**
 * Regex for Feishu user open IDs (ou_xxx).
 */
const USER_OPEN_ID_REGEX = /^ou_[a-zA-Z0-9]+$/;

/**
 * Regex for valid group names.
 * Allows letters, numbers, CJK characters, punctuation, and common symbols.
 * Rejects control characters and empty strings.
 */
const GROUP_NAME_REGEX = /^[^\x00-\x1F\x7F]+$/;

// ---- Output helpers ----

interface SuccessResult {
  success: true;
  chatId: string;
  groupName: string;
}

interface FailureResult {
  success: false;
  error: string;
}

type ScriptResult = SuccessResult | FailureResult;

function outputResult(result: ScriptResult): never {
  console.log(JSON.stringify(result));
  process.exit(result.success ? 0 : 1);
}

// ---- Validation ----

function validateGroupName(name: string): string {
  if (!name) {
    outputResult({ success: false, error: 'OFFLOAD_GROUP_NAME environment variable is required' });
  }
  if (!GROUP_NAME_REGEX.test(name)) {
    outputResult({ success: false, error: `Invalid group name — contains control characters or is empty` });
  }
  if (name.trim().length === 0) {
    outputResult({ success: false, error: 'Group name cannot be blank (whitespace only)' });
  }
  return truncateGroupName(name);
}

function validateUserOpenId(openId: string): void {
  if (!openId) {
    outputResult({ success: false, error: 'OFFLOAD_USER_OPEN_ID environment variable is required' });
  }
  if (!USER_OPEN_ID_REGEX.test(openId)) {
    outputResult({ success: false, error: `Invalid user open ID '${openId}' — expected ou_xxxxx format` });
  }
}

function validateParentChatId(chatId: string): void {
  if (!chatId) {
    outputResult({ success: false, error: 'OFFLOAD_PARENT_CHAT_ID environment variable is required' });
  }
  if (!GROUP_CHAT_ID_REGEX.test(chatId)) {
    outputResult({ success: false, error: `Invalid parent chat ID '${chatId}' — expected oc_xxxxx format` });
  }
}

/**
 * Truncate a group name to max length at character boundaries.
 * Handles CJK characters correctly via Array.from (splits by code point).
 */
function truncateGroupName(name: string): string {
  return Array.from(name).slice(0, MAX_GROUP_NAME_LENGTH).join('');
}

// ---- Core logic ----

/**
 * Create a Feishu group via lark-cli and invite a user.
 * Uses `lark-cli im +chat-create` which creates the group and adds members atomically.
 */
async function createSideGroup(
  groupName: string,
  userOpenId: string,
): Promise<{ chatId: string } | { error: string }> {
  try {
    const { stdout } = await execFileAsync(
      'lark-cli',
      ['im', '+chat-create', '--name', groupName, '--users', userOpenId],
      { timeout: LARK_TIMEOUT_MS, maxBuffer: 1024 * 1024 },
    );

    // Parse the response to extract chat_id
    let parsed: unknown;
    try {
      parsed = JSON.parse(stdout);
    } catch {
      return { error: `Failed to parse lark-cli response: ${stdout.substring(0, 200)}` };
    }

    const chatId = (parsed as Record<string, unknown>)?.data
      ? ((parsed as Record<string, unknown>).data as Record<string, unknown>)?.chat_id
      : (parsed as Record<string, unknown>)?.chat_id;

    if (typeof chatId === 'string' && chatId) {
      return { chatId };
    }

    return { error: `No chat_id in lark-cli response: ${stdout.substring(0, 200)}` };
  } catch (err: unknown) {
    const execErr = err as { stderr?: string; stdout?: string; message?: string };
    const errorMsg = (execErr.stderr ?? execErr.stdout ?? execErr.message ?? 'unknown error')
      .replace(/\n/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    return { error: errorMsg };
  }
}

// ---- Main ----

async function main() {
  const groupNameRaw = process.env.OFFLOAD_GROUP_NAME ?? '';
  const userOpenId = process.env.OFFLOAD_USER_OPEN_ID ?? '';
  const parentChatId = process.env.OFFLOAD_PARENT_CHAT_ID ?? '';
  const skipLark = process.env.OFFLOAD_SKIP_LARK === '1';

  // Validate inputs
  const groupName = validateGroupName(groupNameRaw);
  validateUserOpenId(userOpenId);
  validateParentChatId(parentChatId);

  // Check lark-cli availability
  if (!skipLark) {
    try {
      await execFileAsync('lark-cli', ['--version'], { timeout: 5000 });
    } catch {
      outputResult({ success: false, error: 'Missing required dependency: lark-cli not found in PATH' });
    }
  }

  // Dry-run mode for testing
  if (skipLark) {
    outputResult({
      success: true,
      chatId: 'oc_dry_run_side_group_id',
      groupName,
    });
  }

  // Create the side group
  const result = await createSideGroup(groupName, userOpenId);

  if ('chatId' in result) {
    outputResult({
      success: true,
      chatId: result.chatId,
      groupName,
    });
  } else {
    outputResult({
      success: false,
      error: result.error,
    });
  }
}

main().catch((err) => {
  outputResult({
    success: false,
    error: err instanceof Error ? err.message : String(err),
  });
});
