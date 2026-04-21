#!/usr/bin/env tsx
/**
 * skills/start-discussion/create-group.ts — Create a Feishu group via lark-cli.
 *
 * Creates a new Feishu group chat with the specified name and members,
 * returning the group's chat ID for subsequent message sending via MCP.
 *
 * Environment variables:
 *   DISCUSSION_NAME     (required) Group display name
 *   DISCUSSION_MEMBERS  (required) Comma-separated open IDs (e.g. "ou_xxx,ou_yyy")
 *   DISCUSSION_SKIP_LARK (optional) Set to '1' to skip lark-cli (testing)
 *
 * Exit codes:
 *   0 — success (outputs JSON with chat_id)
 *   1 — validation error or fatal error
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

// ---- Constants ----

const LARK_TIMEOUT_MS = 30_000;
const MAX_GROUP_NAME_LENGTH = 64;

/**
 * Regex for valid group names.
 * Allows letters, numbers, CJK, punctuation, spaces, and common symbols.
 * Rejects control characters and empty strings.
 */
const GROUP_NAME_REGEX = /^[^\x00-\x1F\x7F]+$/;

/** Regex for Feishu open IDs (ou_xxxxx) */
const MEMBER_ID_REGEX = /^ou_[a-zA-Z0-9]+$/;

// ---- Validation ----

function exit(msg: string): never {
  console.error(`ERROR: ${msg}`);
  process.exit(1);
}

function validateGroupName(name: string): void {
  if (!name) {
    exit('DISCUSSION_NAME environment variable is required');
  }
  if (!GROUP_NAME_REGEX.test(name)) {
    exit('Invalid DISCUSSION_NAME — contains control characters or is empty');
  }
  if (name.trim().length === 0) {
    exit('DISCUSSION_NAME cannot be blank (whitespace only)');
  }
}

function validateMembers(membersRaw: string): string[] {
  if (!membersRaw) {
    exit('DISCUSSION_MEMBERS environment variable is required');
  }
  const members = membersRaw.split(',').map((m) => m.trim()).filter((m) => m.length > 0);
  if (members.length === 0) {
    exit('DISCUSSION_MEMBERS must contain at least one open ID');
  }
  for (const member of members) {
    if (!MEMBER_ID_REGEX.test(member)) {
      exit(`Invalid member ID '${member}' — expected ou_xxxxx format`);
    }
  }
  return members;
}

/** Truncate a group name to max length at character boundaries (CJK-safe). */
function truncateGroupName(name: string): string {
  return Array.from(name).slice(0, MAX_GROUP_NAME_LENGTH).join('');
}

// ---- Core logic ----

interface CreateGroupResult {
  success: boolean;
  chatId: string | null;
  error: string | null;
}

async function createGroup(
  groupName: string,
  members: string[],
): Promise<CreateGroupResult> {
  const displayName = truncateGroupName(groupName);
  const membersStr = members.join(',');

  try {
    const result = await execFileAsync(
      'lark-cli',
      ['im', '+chat-create', '--name', displayName, '--users', membersStr],
      { timeout: LARK_TIMEOUT_MS, maxBuffer: 1024 * 1024 },
    );

    // Parse chat_id from lark-cli JSON response
    let chatId: string | null = null;
    try {
      const parsed = JSON.parse(result.stdout);
      chatId = parsed?.data?.chat_id ?? null;
    } catch {
      // Response not JSON — treat as failure
    }

    if (chatId) {
      return { success: true, chatId, error: null };
    }

    return {
      success: false,
      chatId: null,
      error: `lark-cli returned unexpected response: ${(result.stdout || '').substring(0, 200)}`,
    };
  } catch (err: unknown) {
    const execErr = err as { stdout?: string; stderr?: string; message?: string; code?: number | null };
    const errorMsg = (execErr.stderr ?? execErr.message ?? 'unknown error')
      .replace(/\n/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    return { success: false, chatId: null, error: errorMsg };
  }
}

// ---- Main ----

async function main() {
  const groupName = process.env.DISCUSSION_NAME ?? '';
  const membersRaw = process.env.DISCUSSION_MEMBERS ?? '';

  // Validate inputs
  validateGroupName(groupName);
  const members = validateMembers(membersRaw);
  const displayName = truncateGroupName(groupName);

  console.log(`INFO: Creating discussion group '${displayName}' with ${members.length} member(s)`);

  // Check lark-cli availability (skippable for testing)
  if (process.env.DISCUSSION_SKIP_LARK !== '1') {
    try {
      await execFileAsync('lark-cli', ['--version'], { timeout: 5000 });
    } catch {
      exit('Missing required dependency: lark-cli not found in PATH');
    }
  }

  // Dry-run mode for testing
  if (process.env.DISCUSSION_SKIP_LARK === '1') {
    const mockChatId = 'oc_mock_discussion_001';
    console.log(`OK: ${JSON.stringify({ chatId: mockChatId, name: displayName })}`);
    return;
  }

  // Create the group
  const result = await createGroup(groupName, members);

  if (result.success && result.chatId) {
    console.log(`OK: ${JSON.stringify({ chatId: result.chatId, name: displayName })}`);
  } else {
    console.error(`ERROR: Failed to create discussion group: ${result.error}`);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(`ERROR: ${err instanceof Error ? err.message : err}`);
  process.exit(1);
});
