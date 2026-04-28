#!/usr/bin/env tsx
/**
 * skills/create-pr-discussion/create-pr-discussion.ts
 *
 * Create a Feishu group chat for PR review discussion.
 *
 * Issue #2984: PR Scanner discussion group creation logic.
 *
 * Creates a group with a parseable name, writes the mapping to
 * bot-chat-mapping.json (compatible with BotChatMappingStore),
 * and outputs the chatId for the caller.
 *
 * Environment variables:
 *   CREATE_PR_NUMBER    PR number (required)
 *   CREATE_PR_TITLE     PR title (required, truncated to 30 chars in group name)
 *   CREATE_BOT_ID       Bot ID for group creation (optional, uses lark-cli default)
 *   CREATE_MAPPING_FILE Path to mapping JSON file (default: workspace/bot-chat-mapping.json)
 *   CREATE_SKIP_LARK    Set to '1' to skip lark-cli API calls (for testing)
 *   CREATE_DRY_RUN      Set to '1' to skip group creation + mapping write (preview only)
 *
 * Output (JSON on stdout):
 *   { "ok": true, "chatId": "oc_xxx", "created": true, "groupName": "PR #123 · Title" }
 *   { "ok": true, "chatId": "oc_xxx", "created": false, "key": "pr-123" }  (already existed)
 *   { "ok": false, "error": "error message" }
 *
 * Exit codes:
 *   0 — success (created or already existed)
 *   1 — validation error or fatal error
 */

import { execFile } from 'node:child_process';
import { existsSync, readFileSync, renameSync, writeFileSync, unlinkSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { promisify } from 'node:util';
import { tmpdir } from 'node:os';

const execFileAsync = promisify(execFile);

// ---- Constants ----

const LARK_TIMEOUT_MS = 30_000;
const MAX_TITLE_LENGTH = 30;

/**
 * Regex for Feishu group chat IDs.
 * Group chat IDs start with 'oc_' followed by alphanumeric characters.
 */
const GROUP_CHAT_ID_REGEX = /^oc_[a-zA-Z0-9]+$/;

/**
 * Regex to validate PR number (positive integer).
 */
const PR_NUMBER_REGEX = /^\d+$/;

// ---- Types ----

interface MappingEntry {
  chatId: string;
  createdAt: string;
  purpose: string;
}

interface MappingTable {
  [key: string]: MappingEntry;
}

interface SuccessResult {
  ok: true;
  chatId: string;
  created: boolean;
  key: string;
  groupName?: string;
}

interface ErrorResult {
  ok: false;
  error: string;
}

type CreateResult = SuccessResult | ErrorResult;

// ---- Helpers ----

function output(result: CreateResult): never {
  console.log(JSON.stringify(result));
  process.exit(result.ok ? 0 : 1);
}

function errorExit(msg: string): never {
  output({ ok: false, error: msg });
}

/**
 * Truncate a string to max length at character boundaries (CJK-safe).
 */
function truncate(str: string, maxLen: number): string {
  if (str.length <= maxLen) { return str; }
  const chars = Array.from(str);
  return chars.slice(0, maxLen).join('') + '...';
}

/**
 * Generate the group name for a PR review discussion.
 * Format: `PR #{number} · {title前30字}`
 */
function makeGroupName(prNumber: number, prTitle: string): string {
  const truncatedTitle = truncate(prTitle, MAX_TITLE_LENGTH);
  return `PR #${prNumber} · ${truncatedTitle}`;
}

/**
 * Generate the mapping key for a PR.
 */
function makeMappingKey(prNumber: number): string {
  return `pr-${prNumber}`;
}

/**
 * Read the mapping table from disk.
 * Returns empty table if file doesn't exist or is invalid.
 */
function readMappingTable(filePath: string): MappingTable {
  try {
    if (!existsSync(filePath)) {
      return {};
    }
    const content = readFileSync(filePath, 'utf-8');
    const parsed = JSON.parse(content);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as MappingTable;
    }
    return {};
  } catch {
    return {};
  }
}

/**
 * Write the mapping table to disk atomically.
 */
function writeMappingTable(filePath: string, table: MappingTable): void {
  const dir = dirname(filePath);
  const content = JSON.stringify(table, null, 2) + '\n';

  // Atomic write: write to temp file then rename
  const tmpDir = existsSync(dir) ? dir : tmpdir();
  const tmpFile = join(tmpDir, `mapping-${Date.now()}.tmp`);
  try {
    writeFileSync(tmpFile, content, 'utf-8');
    // Use rename for atomicity
    renameSync(tmpFile, filePath);
  } catch (err) {
    try { unlinkSync(tmpFile); } catch {}
    throw err;
  }
}

// ---- Core Logic ----

/**
 * Create a Feishu group chat via lark-cli.
 */
async function createGroup(
  groupName: string,
  botId?: string,
): Promise<{ chatId: string }> {
  const body: Record<string, string> = {
    name: groupName,
    chat_mode: 'group',
    chat_type: 'private',
  };

  if (botId) {
    body.user_id_type = 'open_id';
  }

  const args = ['api', 'POST', '/open-apis/im/v1/chats', '-d', JSON.stringify(body)];

  if (botId) {
    args.push('--as', botId);
  }

  const { stdout } = await execFileAsync('lark-cli', args, {
    timeout: LARK_TIMEOUT_MS,
    maxBuffer: 1024 * 1024,
  });

  // Parse the response to extract chatId
  // Expected Feishu API response: { "data": { "chat_id": "oc_xxx" } }
  try {
    const response = JSON.parse(stdout);
    const chatId = response?.data?.chat_id;
    if (!chatId || typeof chatId !== 'string') {
      throw new Error(`No chat_id in response: ${stdout.trim()}`);
    }
    return { chatId };
  } catch (parseErr) {
    if (parseErr instanceof SyntaxError) {
      throw new Error(`Invalid JSON response from lark-cli: ${stdout.trim()}`);
    }
    throw parseErr;
  }
}

/**
 * Delete a Feishu group chat via lark-cli (cleanup on error).
 */
async function deleteGroup(chatId: string): Promise<void> {
  try {
    await execFileAsync(
      'lark-cli',
      ['api', 'DELETE', `/open-apis/im/v1/chats/${chatId}`, '-d', '{}'],
      { timeout: LARK_TIMEOUT_MS, maxBuffer: 1024 * 1024 },
    );
  } catch {
    // Best effort cleanup — log but don't fail
    console.error(`WARN: Failed to cleanup group ${chatId} after mapping write error`);
  }
}

// ---- Main ----

async function main() {
  const prNumberStr = process.env.CREATE_PR_NUMBER ?? '';
  const prTitle = process.env.CREATE_PR_TITLE ?? '';
  const botId = process.env.CREATE_BOT_ID || undefined;
  const mappingFile = process.env.CREATE_MAPPING_FILE || 'workspace/bot-chat-mapping.json';
  const skipLark = process.env.CREATE_SKIP_LARK === '1';
  const dryRun = process.env.CREATE_DRY_RUN === '1';

  // ---- Validate inputs ----

  if (!prNumberStr) {
    errorExit('CREATE_PR_NUMBER environment variable is required');
  }

  if (!PR_NUMBER_REGEX.test(prNumberStr)) {
    errorExit(`Invalid CREATE_PR_NUMBER '${prNumberStr}' — must be a positive integer`);
  }

  const prNumber = parseInt(prNumberStr, 10);

  if (!prTitle) {
    errorExit('CREATE_PR_TITLE environment variable is required');
  }

  if (prTitle.trim().length === 0) {
    errorExit('CREATE_PR_TITLE cannot be blank (whitespace only)');
  }

  const key = makeMappingKey(prNumber);
  const groupName = makeGroupName(prNumber, prTitle);

  // ---- Dry run (preview only) ----

  if (dryRun) {
    output({ ok: true, chatId: '', created: false, key, groupName });
  }

  // ---- Check existing mapping (idempotency) ----

  const table = readMappingTable(mappingFile);
  if (table[key]) {
    // Mapping already exists — return existing chatId
    output({ ok: true, chatId: table[key].chatId, created: false, key });
  }

  // ---- Create group ----

  let chatId: string;

  if (skipLark) {
    // Testing mode — generate a fake chatId
    chatId = `oc_test_${prNumber}`;
  } else {
    // Check lark-cli availability
    try {
      await execFileAsync('lark-cli', ['--version'], { timeout: 5000 });
    } catch {
      errorExit('Missing required dependency: lark-cli not found in PATH');
    }

    // Create the group
    try {
      const result = await createGroup(groupName, botId);
      chatId = result.chatId;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      errorExit(`Failed to create group: ${msg}`);
    }
  }

  // ---- Write mapping ----

  const entry: MappingEntry = {
    chatId,
    createdAt: new Date().toISOString(),
    purpose: 'pr-review',
  };

  table[key] = entry;

  try {
    writeMappingTable(mappingFile, table);
  } catch (writeErr) {
    // Mapping write failed — cleanup the group we just created
    const msg = writeErr instanceof Error ? writeErr.message : String(writeErr);
    console.error(`ERROR: Failed to write mapping: ${msg}`);

    if (!skipLark) {
      await deleteGroup(chatId);
    }

    errorExit(`Failed to write mapping (group cleaned up): ${msg}`);
  }

  // ---- Success ----

  output({ ok: true, chatId, created: true, key, groupName });
}

main().catch((err) => {
  errorExit(err instanceof Error ? err.message : String(err));
});
