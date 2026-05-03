#!/usr/bin/env tsx
/**
 * skills/chat/create-chat.ts — Create a Feishu group chat via lark-cli.
 *
 * Creates a new Feishu group chat, optionally with initial members,
 * and registers it as a temporary chat in ChatStore for lifecycle management.
 *
 * Uses lark-cli direct API call — NOT through IPC Channel.
 *
 * Environment variables:
 *   CHAT_NAME       Name for the new group chat (required)
 *   CHAT_USERS      Comma-separated open_id list of initial members (optional)
 *   CHAT_CONTEXT    JSON string of context data to attach (optional)
 *   CHAT_TTL_MINUTES Minutes until chat expires (default: 1440 = 24h)
 *   CHAT_CREATOR    Creator chat ID for tracking (optional)
 *   CHAT_SKIP_LARK  Set to '1' to skip lark-cli check and API call (for testing)
 *
 * Output (stdout, JSON):
 *   { "ok": true, "chatId": "oc_xxx", "name": "..." }
 *   { "ok": false, "error": "..." }
 *
 * Exit codes:
 *   0 — success
 *   1 — validation error or fatal error
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';

const execFileAsync = promisify(execFile);

// ---- Constants ----

const LARK_TIMEOUT_MS = 30_000;
const DEFAULT_TTL_MINUTES = 1440; // 24 hours
const MAX_GROUP_NAME_LENGTH = 64;

/** Regex for Feishu group chat IDs. */
const GROUP_CHAT_ID_REGEX = /^oc_[a-zA-Z0-9]+$/;

/** Regex for valid group names (no control characters). */
const GROUP_NAME_REGEX = /^[^\x00-\x1F\x7F]+$/;

/** Regex for open_id format. */
const OPEN_ID_REGEX = /^ou_[a-zA-Z0-9]+$/;

// ---- Helpers ----

function exit(msg: string): never {
  console.log(JSON.stringify({ ok: false, error: msg }));
  process.exit(1);
}

function validateChatName(name: string): void {
  if (!name) {
    exit('CHAT_NAME environment variable is required');
  }
  if (!GROUP_NAME_REGEX.test(name)) {
    exit('Invalid CHAT_NAME — contains control characters or is empty');
  }
  if (name.trim().length === 0) {
    exit('CHAT_NAME cannot be blank (whitespace only)');
  }
}

function validateUsers(usersStr: string): string[] {
  if (!usersStr) return [];
  const users = usersStr.split(',').map(u => u.trim()).filter(Boolean);
  for (const u of users) {
    if (!OPEN_ID_REGEX.test(u)) {
      exit(`Invalid open_id format: '${u}' — must match ou_xxxxx`);
    }
  }
  return users;
}

function validateTTL(ttlStr: string): number {
  const ttl = parseInt(ttlStr, 10);
  if (isNaN(ttl) || ttl <= 0) {
    exit('CHAT_TTL_MINUTES must be a positive integer');
  }
  return ttl;
}

/**
 * Truncate a group name to max length at character boundaries.
 */
function truncateGroupName(name: string): string {
  return Array.from(name).slice(0, MAX_GROUP_NAME_LENGTH).join('');
}

// ---- Core logic ----

interface CreateChatResult {
  ok: boolean;
  chatId?: string;
  name?: string;
  error?: string;
}

/**
 * Create a Feishu group via lark-cli.
 * Uses `lark-cli im +chat-create --name <name> [--users <users>]`.
 */
async function createChat(
  name: string,
  users: string[],
): Promise<CreateChatResult> {
  const truncatedName = truncateGroupName(name);
  const args = ['im', '+chat-create', '--name', truncatedName, '--as', 'bot'];

  if (users.length > 0) {
    args.push('--users', users.join(','));
  }

  try {
    const { stdout } = await execFileAsync('lark-cli', args, {
      timeout: LARK_TIMEOUT_MS,
      maxBuffer: 1024 * 1024,
    });

    // Parse chat ID from lark-cli output
    // Output format varies; try to extract oc_xxx pattern
    const chatIdMatch = stdout.match(/(oc_[a-zA-Z0-9]+)/);
    if (!chatIdMatch) {
      return { ok: false, error: `Could not parse chat ID from lark-cli output: ${stdout.trim()}` };
    }

    return { ok: true, chatId: chatIdMatch[1], name: truncatedName };
  } catch (err: unknown) {
    const execErr = err as { stderr?: string; message?: string };
    const errorMsg = (execErr.stderr ?? execErr.message ?? 'unknown error')
      .replace(/\n/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    return { ok: false, error: errorMsg };
  }
}

/**
 * Register a temporary chat in ChatStore.
 * Writes a JSON file to workspace/schedules/.temp-chats/{chatId}.json
 */
async function registerTempChat(
  chatId: string,
  options: {
    creatorChatId?: string;
    context?: Record<string, unknown>;
    ttlMinutes: number;
  },
): Promise<void> {
  const storeDir = path.join('workspace', 'schedules', '.temp-chats');
  await fs.mkdir(storeDir, { recursive: true });

  const now = new Date();
  const expiresAt = new Date(now.getTime() + options.ttlMinutes * 60_000);

  const record = {
    chatId,
    createdAt: now.toISOString(),
    expiresAt: expiresAt.toISOString(),
    ...(options.creatorChatId && { creatorChatId: options.creatorChatId }),
    ...(options.context && { context: options.context }),
    triggerMode: 'always' as const,
  };

  const safeId = chatId.replace(/[^a-zA-Z0-9_-]/g, '_');
  const filePath = path.join(storeDir, `${safeId}.json`);
  await fs.writeFile(filePath, JSON.stringify(record, null, 2), 'utf-8');
}

// ---- Main ----

async function main() {
  const chatName = process.env.CHAT_NAME ?? '';
  const usersStr = process.env.CHAT_USERS ?? '';
  const contextStr = process.env.CHAT_CONTEXT ?? '';
  const ttlStr = process.env.CHAT_TTL_MINUTES ?? String(DEFAULT_TTL_MINUTES);
  const creatorChatId = process.env.CHAT_CREATOR ?? '';
  const skipLark = process.env.CHAT_SKIP_LARK === '1';

  // Validate inputs
  validateChatName(chatName);
  const users = validateUsers(usersStr);
  const ttlMinutes = validateTTL(ttlStr);

  // Parse context JSON
  let context: Record<string, unknown> | undefined;
  if (contextStr) {
    try {
      context = JSON.parse(contextStr);
    } catch {
      exit('CHAT_CONTEXT must be valid JSON');
    }
  }

  const displayName = truncateGroupName(chatName);

  // Dry-run mode
  if (skipLark) {
    const fakeChatId = `oc_dryrun${Date.now()}`;
    await registerTempChat(fakeChatId, {
      creatorChatId: creatorChatId || undefined,
      context,
      ttlMinutes,
    });
    console.log(JSON.stringify({ ok: true, chatId: fakeChatId, name: displayName }));
    return;
  }

  // Check lark-cli availability
  try {
    await execFileAsync('lark-cli', ['--version'], { timeout: 5000 });
  } catch {
    exit('Missing required dependency: lark-cli not found in PATH');
  }

  // Create group
  const result = await createChat(chatName, users);

  if (!result.ok) {
    console.log(JSON.stringify(result));
    process.exit(1);
  }

  // Register in ChatStore
  await registerTempChat(result.chatId!, {
    creatorChatId: creatorChatId || undefined,
    context,
    ttlMinutes,
  });

  console.log(JSON.stringify({ ok: true, chatId: result.chatId, name: result.name }));
}

main().catch((err) => {
  console.log(JSON.stringify({ ok: false, error: err instanceof Error ? err.message : String(err) }));
  process.exit(1);
});
