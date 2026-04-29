#!/usr/bin/env tsx
/**
 * skills/create-pr-group/create-pr-group.ts
 *
 * Create a Feishu group chat for PR review discussion.
 *
 * Issue #2984: PR Scanner discussion group creation logic.
 *
 * Creates a Feishu group via lark-cli API, writes the mapping entry
 * to bot-chat-mapping.json (compatible with BotChatMappingStore format),
 * and returns the chatId for the caller to use.
 *
 * Environment variables:
 *   PR_NUMBER       GitHub PR number (required, positive integer)
 *   PR_TITLE        PR title (required, used for group naming)
 *   MAPPING_FILE    Path to bot-chat-mapping.json (default: workspace/bot-chat-mapping.json)
 *   CREATE_SKIP_LARK Set to '1' to skip lark-cli calls (testing only)
 *
 * Exit codes:
 *   0 — success (group created or mapping already existed)
 *   1 — validation error or fatal error
 */

import { execFile } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync, renameSync, unlinkSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

// ---- Constants ----

const LARK_TIMEOUT_MS = 30_000;
const MAX_GROUP_NAME_LENGTH = 64;
const TITLE_DISPLAY_LENGTH = 30;

/**
 * Feishu group chat ID format: oc_ followed by alphanumeric chars.
 */
const CHAT_ID_REGEX = /^oc_[a-zA-Z0-9]+$/;

// ---- Types ----

interface MappingEntry {
  chatId: string;
  createdAt: string;
  purpose: string;
}

interface MappingTable {
  [key: string]: MappingEntry;
}

/**
 * Feishu API response for creating a group chat.
 * The actual response may vary; we try multiple paths to extract chatId.
 */
interface FeishuCreateChatResponse {
  code?: number;
  msg?: string;
  data?: {
    chat_id?: string;
    chats?: Array<{ chat_id: string }>;
    [key: string]: unknown;
  };
  chat_id?: string;
}

// ---- Helpers ----

function exit(msg: string): never {
  console.error(`ERROR: ${msg}`);
  process.exit(1);
}

/**
 * Validate and parse PR_NUMBER as a positive integer.
 */
function validatePrNumber(raw: string): number {
  if (!raw) {
    exit('PR_NUMBER environment variable is required');
  }
  const num = parseInt(raw, 10);
  if (isNaN(num) || num <= 0 || String(num) !== raw.trim()) {
    exit(`Invalid PR_NUMBER '${raw}' — must be a positive integer`);
  }
  return num;
}

/**
 * Validate PR_TITLE is non-empty.
 */
function validatePrTitle(raw: string): string {
  if (!raw) {
    exit('PR_TITLE environment variable is required');
  }
  if (raw.trim().length === 0) {
    exit('PR_TITLE cannot be blank (whitespace only)');
  }
  return raw;
}

/**
 * Generate the mapping key for a PR review group.
 * Format: "pr-{number}" (matches BotChatMappingStore.makeMappingKey).
 */
function makeMappingKey(prNumber: number): string {
  return `pr-${prNumber}`;
}

/**
 * Generate the Feishu group name for a PR.
 * Format: "PR #{number} · {title前30字}"
 *
 * Rules:
 * - Must start with "PR #" (used for rebuild regex matching)
 * - Title is truncated to 30 characters, with "..." appended if truncated
 * - Overall name must not exceed 64 characters (Feishu API limit)
 */
function generateGroupName(prNumber: number, prTitle: string): string {
  const prefix = `PR #${prNumber} · `;

  // Truncate title to TITLE_DISPLAY_LENGTH characters at code-point boundaries
  const titleChars = Array.from(prTitle);
  let displayTitle: string;
  if (titleChars.length > TITLE_DISPLAY_LENGTH) {
    displayTitle = titleChars.slice(0, TITLE_DISPLAY_LENGTH).join('') + '...';
  } else {
    displayTitle = prTitle;
  }

  const fullName = `${prefix}${displayTitle}`;

  // Truncate to Feishu max length if needed
  const nameChars = Array.from(fullName);
  if (nameChars.length > MAX_GROUP_NAME_LENGTH) {
    return nameChars.slice(0, MAX_GROUP_NAME_LENGTH).join('');
  }

  return fullName;
}

/**
 * Read the mapping file and parse as MappingTable.
 * Returns empty table if file doesn't exist or is invalid.
 */
function readMappingFile(filePath: string): MappingTable {
  const resolvedPath = resolve(filePath);
  if (!existsSync(resolvedPath)) {
    return {};
  }

  try {
    const content = readFileSync(resolvedPath, 'utf-8');
    const parsed = JSON.parse(content);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as MappingTable;
    }
    console.error(`WARN: Mapping file has invalid structure, starting fresh`);
    return {};
  } catch (err) {
    console.error(`WARN: Failed to read mapping file: ${err instanceof Error ? err.message : err}`);
    return {};
  }
}

/**
 * Atomically write the mapping file.
 * Writes to a temp file first, then renames (same pattern as BotChatMappingStore).
 */
function writeMappingFile(filePath: string, table: MappingTable): void {
  const resolvedPath = resolve(filePath);
  const dir = dirname(resolvedPath);

  // Ensure directory exists
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }

  const content = `${JSON.stringify(table, null, 2)}\n`;
  const tmpFile = `${resolvedPath}.${Date.now()}.tmp`;

  try {
    writeFileSync(tmpFile, content, 'utf-8');
    renameSync(tmpFile, resolvedPath);
  } catch (err) {
    // Clean up temp file on failure
    try { unlinkSync(tmpFile); } catch {}
    throw err;
  }
}

/**
 * Create a Feishu group via lark-cli API.
 *
 * Uses POST /open-apis/im/v1/chats with:
 * - uuid: for idempotent creation (uses mapping key)
 * - name: the group name
 *
 * @returns The created chatId
 */
async function createGroupViaLark(
  groupName: string,
  uuid: string,
): Promise<string> {
  const body = JSON.stringify({
    name: groupName,
    uuid: uuid,
  });

  try {
    const { stdout } = await execFileAsync(
      'lark-cli',
      ['api', 'POST', '/open-apis/im/v1/chats', '-d', body],
      { timeout: LARK_TIMEOUT_MS, maxBuffer: 1024 * 1024 },
    );

    // Parse the response to extract chatId
    return parseChatIdFromResponse(stdout);
  } catch (err: unknown) {
    const execErr = err as { stderr?: string; message?: string; stdout?: string };
    const errorOutput = execErr.stderr ?? execErr.message ?? 'unknown error';

    // If there's stdout even in error case, try to parse it
    if (execErr.stdout) {
      try {
        const chatId = parseChatIdFromResponse(execErr.stdout);
        if (chatId) {
          console.error(`WARN: lark-cli reported error but response contained chatId`);
          return chatId;
        }
      } catch {}
    }

    throw new Error(
      `lark-cli group creation failed: ${errorOutput.replace(/\n/g, ' ').replace(/\s+/g, ' ').trim()}`,
    );
  }
}

/**
 * Parse the Feishu API response to extract the chatId.
 * Handles multiple response formats.
 */
function parseChatIdFromResponse(responseText: string): string {
  let parsed: FeishuCreateChatResponse;
  try {
    parsed = JSON.parse(responseText.trim());
  } catch {
    throw new Error(`Failed to parse lark-cli response as JSON: ${responseText.slice(0, 200)}`);
  }

  // Check for API error
  if (parsed.code !== undefined && parsed.code !== 0) {
    throw new Error(`Feishu API error ${parsed.code}: ${parsed.msg ?? 'unknown'}`);
  }

  // Try multiple paths to find chatId
  const chatId =
    parsed.data?.chat_id ??
    parsed.data?.chats?.[0]?.chat_id ??
    parsed.chat_id ??
    null;

  if (!chatId || !CHAT_ID_REGEX.test(chatId)) {
    throw new Error(
      `Could not extract valid chatId from response. ` +
      `Response keys: ${Object.keys(parsed).join(', ')}. ` +
      `Data: ${JSON.stringify(parsed).slice(0, 300)}`,
    );
  }

  return chatId;
}

// ---- Main ----

async function main(): Promise<void> {
  const rawPrNumber = process.env.PR_NUMBER ?? '';
  const rawPrTitle = process.env.PR_TITLE ?? '';
  const mappingFile = process.env.MAPPING_FILE ?? 'workspace/bot-chat-mapping.json';
  const skipLark = process.env.CREATE_SKIP_LARK === '1';

  // 1. Validate inputs
  const prNumber = validatePrNumber(rawPrNumber);
  const prTitle = validatePrTitle(rawPrTitle);
  const mappingKey = makeMappingKey(prNumber);

  // 2. Check idempotency: read mapping file
  const existingMapping = readMappingFile(mappingFile);
  const existingEntry = existingMapping[mappingKey];

  if (existingEntry?.chatId) {
    // Mapping already exists — idempotent success
    console.log(`OK: Mapping already exists for PR #${prNumber} → ${existingEntry.chatId} (${mappingKey})`);
    console.log(`CHAT_ID=${existingEntry.chatId}`);
    return;
  }

  // 3. Generate group name
  const groupName = generateGroupName(prNumber, prTitle);
  console.log(`INFO: Creating group for PR #${prNumber}: '${groupName}'`);

  // 4. Check lark-cli availability (unless skipped)
  if (!skipLark) {
    try {
      await execFileAsync('lark-cli', ['--version'], { timeout: 5000 });
    } catch {
      exit('Missing required dependency: lark-cli not found in PATH');
    }
  }

  // 5. Create group via lark-cli (or simulate for testing)
  let chatId: string;

  if (skipLark) {
    // Dry-run mode for testing
    chatId = `oc_test_pr${prNumber}`;
    console.log(`INFO: Skipping lark-cli (dry-run mode), using synthetic chatId`);
  } else {
    chatId = await createGroupViaLark(groupName, mappingKey);
  }

  console.log(`INFO: Group created with chatId: ${chatId}`);

  // 6. Write mapping entry
  const newEntry: MappingEntry = {
    chatId,
    createdAt: new Date().toISOString(),
    purpose: 'pr-review',
  };

  existingMapping[mappingKey] = newEntry;

  try {
    writeMappingFile(mappingFile, existingMapping);
    console.log(`INFO: Mapping written: ${mappingKey} → ${chatId}`);
  } catch (err) {
    // Critical: group was created but mapping wasn't saved
    console.error(`ERROR: Group was created (${chatId}) but mapping write failed: ${err instanceof Error ? err.message : err}`);
    console.error(`ERROR: Manual cleanup may be needed — delete the group ${chatId} or manually add mapping`);
    console.log(`CHAT_ID=${chatId}`);
    process.exit(1);
  }

  // 7. Success output
  console.log(`OK: Created group ${chatId} for PR #${prNumber} (${mappingKey})`);
  console.log(`CHAT_ID=${chatId}`);
}

main().catch((err) => {
  console.error(`ERROR: ${err instanceof Error ? err.message : err}`);
  process.exit(1);
});
