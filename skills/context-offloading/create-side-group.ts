#!/usr/bin/env tsx
/**
 * context-offloading/create-side-group.ts — Create a Feishu side group for content offloading.
 *
 * Creates a Feishu group chat synchronously via lark-cli and returns the new chat ID.
 * Used by the context-offloading skill to deliver long-form content to a separate group.
 *
 * Environment variables:
 *   SIDE_GROUP_NAME           (required) Display name for the new group (max 64 chars)
 *   SIDE_GROUP_MEMBERS        (required) JSON array of Feishu open IDs (e.g. '["ou_xxx","ou_yyy"]')
 *   SIDE_GROUP_PARENT_CHAT_ID (optional) Parent chat ID for metadata tracking
 *   SIDE_GROUP_SKIP_LARK      (optional) Set to '1' to skip lark-cli API call (for testing)
 *
 * Exit codes:
 *   0 — success (prints the new chat ID on stdout)
 *   1 — validation error or group creation failure
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

// ---- Constants ----

const LARK_TIMEOUT_MS = 30_000;
const MAX_GROUP_NAME_LENGTH = 64;

/**
 * Regex for valid group names.
 * Allows letters, numbers, CJK characters, punctuation, and common symbols.
 * Rejects control characters and empty strings.
 */
const GROUP_NAME_REGEX = /^[^\x00-\x1F\x7F]+$/;

/**
 * Regex for Feishu open IDs (ou_xxxxx format).
 */
const OPEN_ID_REGEX = /^ou_[a-zA-Z0-9]+$/;

/**
 * Regex for Feishu group chat IDs (oc_xxxxx format).
 */
const GROUP_CHAT_ID_REGEX = /^oc_[a-zA-Z0-9]+$/;

// ---- Validation ----

function exit(msg: string): never {
  console.error(`ERROR: ${msg}`);
  process.exit(1);
}

function validateGroupName(name: string): string {
  if (!name) {
    exit('SIDE_GROUP_NAME environment variable is required');
  }
  if (!GROUP_NAME_REGEX.test(name)) {
    exit('SIDE_GROUP_NAME contains control characters or is empty');
  }
  if (name.trim().length === 0) {
    exit('SIDE_GROUP_NAME cannot be blank (whitespace only)');
  }
  return truncateGroupName(name);
}

function validateMembers(raw: string): string[] {
  if (!raw) {
    exit('SIDE_GROUP_MEMBERS environment variable is required');
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    exit(`SIDE_GROUP_MEMBERS must be valid JSON: ${raw}`);
  }

  if (!Array.isArray(parsed) || parsed.length === 0) {
    exit('SIDE_GROUP_MEMBERS must be a non-empty JSON array of open IDs');
  }

  for (const member of parsed) {
    if (typeof member !== 'string' || !OPEN_ID_REGEX.test(member)) {
      exit(`Invalid member ID '${member}' — expected ou_xxxxx format`);
    }
  }

  return parsed as string[];
}

function validateParentChatId(chatId: string | undefined): void {
  if (chatId !== undefined && chatId !== '' && !GROUP_CHAT_ID_REGEX.test(chatId)) {
    exit(`Invalid SIDE_GROUP_PARENT_CHAT_ID '${chatId}' — must match oc_xxxxx format`);
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
 * Create a Feishu group via lark-cli.
 * Uses: lark-cli im +chat-create --name <name> --users <members>
 * Returns the parsed chat_id from the JSON response.
 */
async function createSideGroup(
  groupName: string,
  members: string[],
): Promise<{ chatId: string; error?: never } | { chatId?: never; error: string }> {
  const membersStr = members.join(',');

  try {
    const { stdout } = await execFileAsync(
      'lark-cli',
      ['im', '+chat-create', '--name', groupName, '--users', membersStr],
      { timeout: LARK_TIMEOUT_MS, maxBuffer: 1024 * 1024 },
    );

    // Parse the JSON response to extract chat_id
    try {
      const parsed = JSON.parse(stdout);
      const chatId = parsed?.data?.chat_id;
      if (chatId && typeof chatId === 'string') {
        return { chatId };
      }
      return { error: `No chat_id in lark-cli response: ${stdout.replace(/\n/g, ' ').trim()}` };
    } catch {
      return { error: `Failed to parse lark-cli response: ${stdout.replace(/\n/g, ' ').trim()}` };
    }
  } catch (err: unknown) {
    const execErr = err as { stdout?: string; stderr?: string; message?: string };
    const errorMsg = (execErr.stderr ?? execErr.message ?? 'unknown error')
      .replace(/\n/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    return { error: errorMsg };
  }
}

// ---- Main ----

async function main() {
  // Validate inputs
  const rawName = process.env.SIDE_GROUP_NAME ?? '';
  const rawMembers = process.env.SIDE_GROUP_MEMBERS ?? '';
  const parentChatId = process.env.SIDE_GROUP_PARENT_CHAT_ID;

  const groupName = validateGroupName(rawName);
  const members = validateMembers(rawMembers);
  validateParentChatId(parentChatId);

  console.error(`INFO: Creating side group '${groupName}' with ${members.length} member(s)`);
  if (parentChatId) {
    console.error(`INFO: Parent chat: ${parentChatId}`);
  }

  // Check lark-cli availability (skippable for testing)
  if (process.env.SIDE_GROUP_SKIP_LARK !== '1') {
    try {
      await execFileAsync('lark-cli', ['--version'], { timeout: 5000 });
    } catch {
      exit('Missing required dependency: lark-cli not found in PATH');
    }
  }

  // Dry-run mode for testing
  if (process.env.SIDE_GROUP_SKIP_LARK === '1') {
    const fakeChatId = `oc_dryrun_${Date.now()}`;
    console.log(`OK: ${fakeChatId}`);
    return;
  }

  // Create the group
  const result = await createSideGroup(groupName, members);

  if ('chatId' in result && result.chatId) {
    // Output ONLY the chat ID on stdout (machine-readable)
    console.log(`OK: ${result.chatId}`);
  } else {
    console.error(`ERROR: Failed to create side group: ${result.error}`);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(`ERROR: ${err instanceof Error ? err.message : err}`);
  process.exit(1);
});
