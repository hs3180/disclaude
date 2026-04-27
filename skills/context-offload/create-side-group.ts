#!/usr/bin/env tsx
/**
 * skills/context-offload/create-side-group.ts — Create a Feishu side group via lark-cli.
 *
 * Creates a dedicated Feishu group for long-form content delivery.
 * Returns the new group's chat ID for subsequent content sending via MCP tools.
 *
 * Environment variables:
 *   SIDE_GROUP_NAME         (required) Group display name
 *   SIDE_GROUP_MEMBERS      (required) JSON array of member open IDs (e.g. '["ou_xxx"]')
 *   SIDE_GROUP_DESCRIPTION  (optional) Group description
 *   SIDE_GROUP_SKIP_LARK    (optional) Set to '1' to skip lark-cli calls (testing)
 *
 * Exit codes:
 *   0 — success (outputs "OK: oc_xxxxx")
 *   1 — validation error or fatal error
 *
 * @module skills/context-offload/create-side-group
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

// ---- Constants ----

const LARK_TIMEOUT_MS = 30_000;
const MAX_GROUP_NAME_LENGTH = 64;
const MAX_DESCRIPTION_LENGTH = 256;

/**
 * Regex for valid group names.
 * Allows letters, numbers, CJK characters, punctuation, and common symbols.
 * Rejects control characters and empty strings.
 */
const GROUP_NAME_REGEX = /^[^\x00-\x1F\x7F]+$/;

/**
 * Regex for Feishu open IDs (ou_xxxxx format).
 */
const MEMBER_ID_REGEX = /^ou_[a-zA-Z0-9]+$/;

// ---- Validation ----

function exit(msg: string): never {
  console.error(`ERROR: ${msg}`);
  process.exit(1);
}

function validateGroupName(name: string): void {
  if (!name) {
    exit('SIDE_GROUP_NAME environment variable is required');
  }
  if (!GROUP_NAME_REGEX.test(name)) {
    exit(`Invalid SIDE_GROUP_NAME '${name}' — contains control characters or is empty`);
  }
  if (name.trim().length === 0) {
    exit('SIDE_GROUP_NAME cannot be blank (whitespace only)');
  }
}

function validateMembers(raw: string): string[] {
  if (!raw) {
    exit('SIDE_GROUP_MEMBERS environment variable is required');
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    exit(`SIDE_GROUP_MEMBERS must be valid JSON array, got: ${raw}`);
  }

  if (!Array.isArray(parsed) || parsed.length === 0) {
    exit('SIDE_GROUP_MEMBERS must be a non-empty JSON array of open IDs');
  }

  for (const member of parsed) {
    if (typeof member !== 'string' || !MEMBER_ID_REGEX.test(member)) {
      exit(`Invalid member ID '${member}' — expected ou_xxxxx format`);
    }
  }

  return parsed;
}

function validateDescription(desc: string): void {
  if (desc.length > MAX_DESCRIPTION_LENGTH) {
    exit(`SIDE_GROUP_DESCRIPTION too long (${desc.length} chars, max ${MAX_DESCRIPTION_LENGTH})`);
  }
}

/**
 * Truncate a group name to max length at character boundaries.
 * Handles CJK characters correctly via Array.from (splits by code point, not UTF-16 unit).
 */
function truncateGroupName(name: string): string {
  return Array.from(name).slice(0, MAX_GROUP_NAME_LENGTH).join('');
}

/**
 * Truncate a description to max length at character boundaries.
 */
function truncateDescription(desc: string): string {
  return Array.from(desc).slice(0, MAX_DESCRIPTION_LENGTH).join('');
}

// ---- Core logic ----

interface CreateGroupResult {
  success: boolean;
  chatId: string | null;
  error: string | null;
}

/**
 * Create a Feishu group via lark-cli.
 * Uses the same command pattern as chats-activation.ts:
 *   lark-cli im +chat-create --name <name> --users <member1,member2,...>
 */
async function createGroup(
  groupName: string,
  members: string[],
  description?: string,
): Promise<CreateGroupResult> {
  const truncatedName = truncateGroupName(groupName);
  const membersStr = members.join(',');

  const args = [
    'im', '+chat-create',
    '--name', truncatedName,
    '--users', membersStr,
  ];

  // Add description if provided (via -d flag for description)
  // Note: lark-cli im +chat-create doesn't natively support description,
  // so we only set the name and members. Description can be sent as first message.

  try {
    const result = await execFileAsync(
      'lark-cli',
      args,
      { timeout: LARK_TIMEOUT_MS, maxBuffer: 1024 * 1024 },
    );

    // Parse the response to extract chat_id
    // Expected format: {"data":{"chat_id":"oc_xxxxx"}}
    let chatId: string | null = null;
    try {
      const parsed = JSON.parse(result.stdout);
      chatId = parsed?.data?.chat_id ?? null;
    } catch {
      // If stdout is not valid JSON, check if it contains an oc_ ID
      const match = result.stdout.match(/(oc_[a-zA-Z0-9]+)/);
      if (match) {
        chatId = match[1];
      }
    }

    if (chatId) {
      return { success: true, chatId, error: null };
    }

    return {
      success: false,
      chatId: null,
      error: `lark-cli returned no chat_id: ${result.stdout.substring(0, 200)}`,
    };
  } catch (err: unknown) {
    const execErr = err as { stderr?: string; message?: string; code?: number | null };
    const errorMsg = (execErr.stderr ?? execErr.message ?? 'unknown error')
      .replace(/\n/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    return { success: false, chatId: null, error: errorMsg };
  }
}

// ---- Main ----

async function main() {
  const groupName = process.env.SIDE_GROUP_NAME ?? '';
  const membersRaw = process.env.SIDE_GROUP_MEMBERS ?? '';
  const description = process.env.SIDE_GROUP_DESCRIPTION ?? '';
  const skipLark = process.env.SIDE_GROUP_SKIP_LARK === '1';

  // ---- Validate inputs ----
  validateGroupName(groupName);
  const members = validateMembers(membersRaw);
  if (description) {
    validateDescription(description);
  }

  const displayName = truncateGroupName(groupName);
  console.log(`INFO: Creating side group '${displayName}' with ${members.length} member(s)`);

  // ---- Check lark-cli availability ----
  if (!skipLark) {
    try {
      await execFileAsync('lark-cli', ['--version'], { timeout: 5000 });
    } catch {
      exit('Missing required dependency: lark-cli not found in PATH');
    }
  }

  // ---- Dry run mode ----
  if (skipLark) {
    const dryRunId = 'oc_dryrun_side_group';
    console.log(`OK: ${dryRunId}`);
    return;
  }

  // ---- Create the group ----
  const result = await createGroup(groupName, members, description || undefined);

  if (result.success && result.chatId) {
    console.log(`OK: ${result.chatId}`);
  } else {
    console.error(`ERROR: Failed to create group: ${result.error}`);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(`ERROR: ${err instanceof Error ? err.message : err}`);
  process.exit(1);
});
