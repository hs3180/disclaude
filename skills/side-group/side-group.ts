#!/usr/bin/env tsx
/**
 * skills/side-group/side-group.ts — Create a side group for long-form content delivery.
 *
 * Creates a pending chat file that the chats-activation schedule will pick up
 * to create a Feishu group. The agent then sends content to the created group.
 *
 * This skill reuses the existing chat lifecycle:
 * - Group creation: handled by chats-activation schedule (lark-cli)
 * - Group dissolution: handled by chat-timeout skill (lark-cli)
 * - Content delivery: handled by the agent after activation
 *
 * Environment variables:
 *   SIDE_GROUP_NAME      (required) Group display name
 *   SIDE_GROUP_MEMBERS   (required) JSON array of member open IDs
 *   SIDE_GROUP_CONTEXT   (optional) JSON object for consumer use (default: '{}')
 *   SIDE_GROUP_EXPIRES_AT (optional) ISO 8601 Z-suffix expiry (default: 24h from now)
 *   SIDE_GROUP_SKIP_LARK (optional) Set to '1' to skip lark-cli check (testing only)
 *
 * Exit codes:
 *   0 — success (chat file created)
 *   1 — validation error or fatal error
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash, randomBytes } from 'node:crypto';

const execFileAsync = promisify(execFile);

// ---- Constants ----

const LARK_TIMEOUT_MS = 30_000;
const DEFAULT_TTL_HOURS = 24;

// ---- Types ----

export interface SideGroupResult {
  success: boolean;
  chatId: string;
  groupName: string;
  expiresAt: string;
  error?: string;
}

// ---- Validation ----

function exit(msg: string): never {
  console.error(`ERROR: ${msg}`);
  process.exit(1);
}

/**
 * Validate group name is non-empty and doesn't contain control characters.
 */
function validateGroupName(name: string): void {
  if (!name) {
    exit('SIDE_GROUP_NAME environment variable is required');
  }
  if (!/^[^\x00-\x1F\x7F]+$/.test(name)) {
    exit('Invalid SIDE_GROUP_NAME — contains control characters');
  }
  if (name.trim().length === 0) {
    exit('SIDE_GROUP_NAME cannot be blank (whitespace only)');
  }
}

/**
 * Validate members is a non-empty JSON array of valid open IDs.
 */
function validateMembers(members: unknown): string[] {
  if (!Array.isArray(members) || members.length === 0) {
    exit('SIDE_GROUP_MEMBERS must be a non-empty JSON array of open IDs');
  }
  const memberRegex = /^ou_[a-zA-Z0-9]+$/;
  for (const member of members) {
    if (typeof member !== 'string' || !memberRegex.test(member)) {
      exit(`Invalid member ID '${member}' — expected ou_xxxxx format`);
    }
  }
  return members as string[];
}

/**
 * Validate optional context is a JSON object.
 */
function validateContext(context: unknown): Record<string, unknown> {
  if (context === undefined || context === null) {
    return {};
  }
  if (typeof context !== 'object' || Array.isArray(context)) {
    exit('SIDE_GROUP_CONTEXT must be a JSON object');
  }
  const size = JSON.stringify(context).length;
  if (size > 4096) {
    exit(`SIDE_GROUP_CONTEXT too large (${size} bytes, max 4096)`);
  }
  return context as Record<string, unknown>;
}

/**
 * Validate optional expiresAt is a valid ISO 8601 Z-suffix timestamp.
 * Accepts both with and without milliseconds (e.g., 2026-04-28T10:00:00Z and 2026-04-28T10:00:00.123Z).
 */
function validateExpiresAt(expiresAt: string): void {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{3})?Z$/.test(expiresAt)) {
    exit('SIDE_GROUP_EXPIRES_AT must be UTC Z-suffix format (e.g. 2026-04-28T10:00:00Z)');
  }
}

/**
 * Truncate a group name to max 64 characters at code-point boundaries.
 */
function truncateGroupName(name: string): string {
  return Array.from(name).slice(0, 64).join('');
}

/**
 * Generate a unique chat ID for the side group.
 * Format: side-{timestamp}-{short-hash}
 */
function generateChatId(): string {
  const timestamp = Date.now().toString(36);
  const hash = createHash('sha256')
    .update(randomBytes(8))
    .digest('hex')
    .slice(0, 6);
  return `side-${timestamp}-${hash}`;
}

/**
 * Calculate default expiry time (24 hours from now).
 * Returns ISO 8601 Z-suffix format without milliseconds
 * to match the chat schema's UTC_DATETIME_REGEX.
 */
function defaultExpiresAt(): string {
  const d = new Date();
  d.setHours(d.getHours() + DEFAULT_TTL_HOURS);
  return d.toISOString().replace(/\.\d{3}Z$/, 'Z');
}

// ---- Core logic ----

/**
 * Create a side group by delegating to the chat skill's create script.
 *
 * This reuses the existing chat lifecycle: the created pending chat file
 * will be picked up by the chats-activation schedule, which creates the
 * actual Feishu group via lark-cli.
 */
async function createSideGroup(params: {
  name: string;
  members: string[];
  context: Record<string, unknown>;
  expiresAt: string;
}): Promise<SideGroupResult> {
  const chatId = generateChatId();
  const truncatedName = truncateGroupName(params.name);

  // Build environment for chat create script
  const createEnv: Record<string, string> = {
    ...process.env,
    CHAT_ID: chatId,
    CHAT_EXPIRES_AT: params.expiresAt,
    CHAT_GROUP_NAME: truncatedName,
    CHAT_MEMBERS: JSON.stringify(params.members),
    CHAT_CONTEXT: JSON.stringify(params.context),
    CHAT_TRIGGER_MODE: 'always',
  };

  try {
    const result = await execFileAsync(
      'npx',
      ['tsx', 'skills/chat/create.ts'],
      {
        timeout: LARK_TIMEOUT_MS,
        maxBuffer: 1024 * 1024,
        env: createEnv,
        cwd: resolveProjectRoot(),
      },
    );

    // Check for errors in stdout (chat create outputs errors to stderr but success to stdout)
    if (result.stderr && !result.stdout.startsWith('OK:')) {
      return {
        success: false,
        chatId,
        groupName: truncatedName,
        expiresAt: params.expiresAt,
        error: result.stderr.trim(),
      };
    }

    return {
      success: true,
      chatId,
      groupName: truncatedName,
      expiresAt: params.expiresAt,
    };
  } catch (err: unknown) {
    const execErr = err as { stderr?: string; message?: string };
    const errorMsg = (execErr.stderr ?? execErr.message ?? 'unknown error')
      .replace(/\n/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    return {
      success: false,
      chatId,
      groupName: truncatedName,
      expiresAt: params.expiresAt,
      error: errorMsg,
    };
  }
}

/**
 * Resolve the project root directory.
 * Walks up from __dirname to find the directory containing package.json.
 */
function resolveProjectRoot(): string {
  // When running via tsx from the project root, use cwd
  return process.cwd();
}

// ---- Main ----

async function main() {
  const groupName = process.env.SIDE_GROUP_NAME ?? '';
  const membersRaw = process.env.SIDE_GROUP_MEMBERS;
  const contextRaw = process.env.SIDE_GROUP_CONTEXT;
  const expiresAtRaw = process.env.SIDE_GROUP_EXPIRES_AT;

  // Step 1: Validate inputs
  validateGroupName(groupName);

  let members: string[];
  try {
    const parsed = membersRaw ? JSON.parse(membersRaw) : undefined;
    members = validateMembers(parsed);
  } catch (err) {
    if (err instanceof Error && err.message.startsWith('SIDE_GROUP_MEMBERS')) {
      exit(err.message);
    }
    exit(`SIDE_GROUP_MEMBERS must be valid JSON: ${membersRaw}`);
  }

  let context: Record<string, unknown>;
  try {
    const parsed = contextRaw ? JSON.parse(contextRaw) : undefined;
    context = validateContext(parsed);
  } catch (err) {
    if (err instanceof Error && err.message.startsWith('SIDE_GROUP_CONTEXT')) {
      exit(err.message);
    }
    exit(`SIDE_GROUP_CONTEXT must be valid JSON: ${contextRaw}`);
  }

  let expiresAt: string;
  if (expiresAtRaw) {
    validateExpiresAt(expiresAtRaw);
    expiresAt = expiresAtRaw;
  } else {
    expiresAt = defaultExpiresAt();
  }

  // Step 2: Check lark-cli availability (skippable for testing)
  if (process.env.SIDE_GROUP_SKIP_LARK !== '1') {
    try {
      await execFileAsync('lark-cli', ['--version'], { timeout: 5000 });
    } catch {
      exit('Missing required dependency: lark-cli not found in PATH');
    }
  }

  // Step 3: Create the side group
  const result = await createSideGroup({
    name: groupName,
    members,
    context,
    expiresAt,
  });

  if (result.success) {
    // Output result as JSON for programmatic consumption
    const output = {
      status: 'ok',
      chatId: result.chatId,
      groupName: result.groupName,
      expiresAt: result.expiresAt,
      message: `Side group chat '${result.groupName}' created (id: ${result.chatId}). ` +
        `The chats-activation schedule will create the Feishu group shortly.`,
    };
    console.log(JSON.stringify(output, null, 2));
  } else {
    console.error(`ERROR: Failed to create side group: ${result.error}`);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(`ERROR: ${err instanceof Error ? err.message : err}`);
  process.exit(1);
});
