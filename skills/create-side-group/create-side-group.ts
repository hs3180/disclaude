#!/usr/bin/env tsx
/**
 * skills/create-side-group/create-side-group.ts — Create a Feishu side group via lark-cli.
 *
 * Creates a dedicated group for long-form content delivery, keeping the
 * main conversation clean. Optionally registers as a temp chat for lifecycle
 * management (auto-dissolution via chat-timeout skill).
 *
 * Environment variables:
 *   SIDE_GROUP_NAME            (required) Group display name
 *   SIDE_GROUP_MEMBERS         (required) JSON array of member open IDs (e.g. '["ou_xxx"]')
 *   SIDE_GROUP_PARENT_CHAT_ID  (optional) Parent chat ID for tracking (oc_xxx format)
 *   SIDE_GROUP_EXPIRES_HOURS   (optional) Auto-expiry in hours (default: 24, set to '0' to disable)
 *   SIDE_GROUP_SKIP_LARK       (optional) Set to '1' to skip lark-cli check and API call (for testing)
 *
 * Exit codes:
 *   0 — success
 *   1 — validation error or fatal error
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const execFileAsync = promisify(execFile);

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = resolve(__dirname, '../..');

// ---- Constants ----

const LARK_TIMEOUT_MS = 30_000;
const MAX_GROUP_NAME_LENGTH = 64;
const DEFAULT_EXPIRES_HOURS = 24;

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

/**
 * Regex for member open IDs (ou_xxx format).
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
    exit('Invalid SIDE_GROUP_NAME — contains control characters or is empty');
  }
  if (name.trim().length === 0) {
    exit('SIDE_GROUP_NAME cannot be blank (whitespace only)');
  }
}

function validateMembers(membersRaw: string): string[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(membersRaw);
  } catch {
    exit(`SIDE_GROUP_MEMBERS must be valid JSON: ${membersRaw}`);
  }

  if (!Array.isArray(parsed) || parsed.length === 0) {
    exit('SIDE_GROUP_MEMBERS must be a non-empty JSON array of open IDs');
  }

  for (const member of parsed) {
    if (typeof member !== 'string' || !MEMBER_ID_REGEX.test(member)) {
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

function validateExpiresHours(hours: string | undefined): number {
  if (hours === undefined || hours === '') {
    return DEFAULT_EXPIRES_HOURS;
  }
  const parsed = parseInt(hours, 10);
  if (!Number.isFinite(parsed) || parsed < 0) {
    exit(`Invalid SIDE_GROUP_EXPIRES_HOURS '${hours}' — must be a non-negative integer`);
  }
  return parsed;
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
 * Create a Feishu group via lark-cli.
 * Uses the im +chat-create command.
 */
async function createGroup(
  groupName: string,
  members: string[],
): Promise<{ chatId: string | null; error: string | null }> {
  const truncatedName = truncateGroupName(groupName);
  const membersStr = members.join(',');

  try {
    const result = await execFileAsync(
      'lark-cli',
      ['im', '+chat-create', '--name', truncatedName, '--users', membersStr],
      { timeout: LARK_TIMEOUT_MS, maxBuffer: 1024 * 1024 },
    );

    // Parse chat_id from JSON response
    let parsed: { data?: { chat_id?: string } };
    try {
      parsed = JSON.parse(result.stdout);
    } catch {
      return { chatId: null, error: `Invalid JSON response from lark-cli: ${result.stdout.slice(0, 200)}` };
    }

    const chatId = parsed?.data?.chat_id ?? null;
    if (!chatId) {
      return { chatId: null, error: `No chat_id in lark-cli response: ${result.stdout.slice(0, 200)}` };
    }

    return { chatId, error: null };
  } catch (err: unknown) {
    const execErr = err as { stderr?: string; message?: string; code?: number | null };
    const errorMsg = (execErr.stderr ?? execErr.message ?? 'unknown error')
      .replace(/\n/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    return { chatId: null, error: errorMsg };
  }
}

/**
 * Register the side group as a temp chat for lifecycle management.
 * Uses the chat skill's create.ts to create a pending chat file.
 * The chats-activation schedule will then pick it up and set it to active
 * (since the group already exists, it will recover to active immediately).
 */
async function registerTempChat(
  chatId: string,
  groupName: string,
  members: string[],
  parentChatId: string | undefined,
  expiresHours: number,
): Promise<void> {
  // Calculate expiry timestamp
  const expiresAt = new Date(Date.now() + expiresHours * 3600_000);
  const expiresAtStr = expiresAt.toISOString().replace(/\.\d{3}Z$/, 'Z');

  // Build a unique ID for the temp chat file
  const tempChatId = `side-group-${chatId}`;

  const env: Record<string, string> = {
    CHAT_ID: tempChatId,
    CHAT_EXPIRES_AT: expiresAtStr,
    CHAT_GROUP_NAME: groupName,
    CHAT_MEMBERS: JSON.stringify(members),
    CHAT_CONTEXT: JSON.stringify({
      type: 'side-group',
      source: 'create-side-group',
      ...(parentChatId ? { parentChatId } : {}),
    }),
    CHAT_TRIGGER_MODE: 'always',
  };

  const scriptPath = resolve(PROJECT_ROOT, 'skills/chat/create.ts');

  try {
    await execFileAsync('npx', ['tsx', scriptPath], {
      env: { ...process.env, ...env },
      maxBuffer: 1024 * 1024,
      cwd: PROJECT_ROOT,
      timeout: 15_000,
    });
    console.log(`INFO: Registered temp chat for lifecycle management (expires in ${expiresHours}h)`);
  } catch (err: unknown) {
    // Non-fatal: group was created, just lifecycle tracking failed
    const execErr = err as { stderr?: string; message?: string };
    const errorMsg = (execErr.stderr ?? execErr.message ?? 'unknown error')
      .replace(/\n/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    console.error(`WARN: Failed to register temp chat (group still created): ${errorMsg}`);
  }
}

// ---- Main ----

async function main() {
  const groupName = process.env.SIDE_GROUP_NAME ?? '';
  const membersRaw = process.env.SIDE_GROUP_MEMBERS ?? '';
  const parentChatId = process.env.SIDE_GROUP_PARENT_CHAT_ID;
  const expiresHoursRaw = process.env.SIDE_GROUP_EXPIRES_HOURS;
  const skipLark = process.env.SIDE_GROUP_SKIP_LARK === '1';

  // Validate inputs
  validateGroupName(groupName);
  const members = validateMembers(membersRaw);
  validateParentChatId(parentChatId);
  const expiresHours = validateExpiresHours(expiresHoursRaw);

  const displayName = truncateGroupName(groupName);
  const wasTruncated = displayName !== groupName;

  console.log(`INFO: Creating side group '${displayName}' with ${members.length} member(s)`);

  // Check lark-cli availability (skippable for testing)
  if (!skipLark) {
    try {
      await execFileAsync('lark-cli', ['--version'], { timeout: 5000 });
    } catch {
      exit('Missing required dependency: lark-cli not found in PATH');
    }
  }

  // Skip actual API call in dry-run mode (for testing)
  if (skipLark) {
    console.log('OK: Side group created');
    console.log('CHAT_ID: oc_test_dry_run');
    if (wasTruncated) {
      console.log(`GROUP_NAME: ${displayName} (truncated from ${Array.from(groupName).length} chars)`);
    }
    return;
  }

  // Execute group creation
  const result = await createGroup(groupName, members);

  if (!result.chatId) {
    exit(`Failed to create side group: ${result.error}`);
  }

  console.log('OK: Side group created');
  console.log(`CHAT_ID: ${result.chatId}`);
  if (wasTruncated) {
    console.log(`GROUP_NAME: ${displayName} (truncated from ${Array.from(groupName).length} chars)`);
  }

  // Register as temp chat for lifecycle management (if expiry enabled)
  if (expiresHours > 0) {
    await registerTempChat(
      result.chatId,
      displayName,
      members,
      parentChatId,
      expiresHours,
    );
  }
}

main().catch((err) => {
  console.error(`ERROR: ${err instanceof Error ? err.message : err}`);
  process.exit(1);
});
