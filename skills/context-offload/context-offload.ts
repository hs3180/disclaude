#!/usr/bin/env tsx
/**
 * skills/context-offload/context-offload.ts — Create a Feishu side group and deliver long-form content.
 *
 * Creates a Feishu group via lark-cli, invites members, and sends text content.
 * Designed for offloading long-form content (code, reports, docs) to a side group,
 * keeping the main conversation clean.
 *
 * Environment variables:
 *   OFFLOAD_GROUP_NAME    (required) Group display name (max 64 chars, auto-truncated)
 *   OFFLOAD_MEMBERS       (required) JSON array of member open IDs (e.g. '["ou_xxx"]')
 *   OFFLOAD_CONTENT       (optional) Text content to send to the group
 *   OFFLOAD_CONTENT_FILE  (optional) Path to file with content (alternative to OFFLOAD_CONTENT)
 *   OFFLOAD_SKIP_LARK     (optional) Set to '1' to skip lark-cli calls (testing only)
 *
 * Exit codes:
 *   0 — success
 *   1 — validation error or fatal error
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const execFileAsync = promisify(execFile);

// ---- Constants ----

const LARK_TIMEOUT_MS = 30_000;
const MAX_GROUP_NAME_LENGTH = 64;
const FEISHU_MSG_LIMIT = 4000; // Feishu message content limit (approximate)

/**
 * Regex for valid group names.
 * Allows letters, numbers, CJK characters, punctuation, and common symbols.
 * Rejects control characters and empty strings.
 */
const GROUP_NAME_REGEX = /^[^\x00-\x1F\x7F]+$/;

/**
 * Regex for Feishu member open IDs.
 */
const MEMBER_ID_REGEX = /^ou_[a-zA-Z0-9]+$/;

// ---- Types ----

interface OffloadResult {
  chatId: string;
  groupName: string;
  messageCount: number;
}

// ---- Validation ----

function exit(msg: string): never {
  console.error(`ERROR: ${msg}`);
  process.exit(1);
}

function validateGroupName(name: string): void {
  if (!name) {
    exit('OFFLOAD_GROUP_NAME environment variable is required');
  }
  if (!GROUP_NAME_REGEX.test(name)) {
    exit(`Invalid OFFLOAD_GROUP_NAME — contains control characters or is empty`);
  }
  if (name.trim().length === 0) {
    exit('OFFLOAD_GROUP_NAME cannot be blank (whitespace only)');
  }
}

function validateMembers(raw: string): string[] {
  let members: unknown;
  try {
    members = JSON.parse(raw);
  } catch {
    exit(`OFFLOAD_MEMBERS must be valid JSON: ${raw}`);
  }
  if (!Array.isArray(members) || members.length === 0) {
    exit('OFFLOAD_MEMBERS must be a non-empty JSON array of open IDs');
  }
  for (const member of members) {
    if (typeof member !== 'string' || !MEMBER_ID_REGEX.test(member)) {
      exit(`Invalid member ID '${member}' — expected ou_xxxxx format`);
    }
  }
  return members;
}

// ---- Helpers ----

/**
 * Truncate a group name to max length at character boundaries.
 * Handles CJK characters correctly via Array.from (splits by code point, not UTF-16 unit).
 */
function truncateGroupName(name: string): string {
  return Array.from(name).slice(0, MAX_GROUP_NAME_LENGTH).join('');
}

/**
 * Split content into chunks that fit within Feishu message limits.
 * Tries to split at paragraph boundaries when possible.
 */
function splitContent(content: string): string[] {
  if (content.length <= FEISHU_MSG_LIMIT) {
    return [content];
  }

  const chunks: string[] = [];
  let remaining = content;

  while (remaining.length > 0) {
    if (remaining.length <= FEISHU_MSG_LIMIT) {
      chunks.push(remaining);
      break;
    }

    // Try to find a paragraph break within the limit
    let splitIndex = -1;
    const searchStart = Math.max(FEISHU_MSG_LIMIT - 500, 0);
    const searchEnd = Math.min(FEISHU_MSG_LIMIT, remaining.length);

    // Look for double newline (paragraph break) from the end of the allowed range
    for (let i = searchEnd; i >= searchStart; i--) {
      if (remaining[i] === '\n' && i > 0 && remaining[i - 1] === '\n') {
        splitIndex = i;
        break;
      }
    }

    // Fallback: single newline
    if (splitIndex === -1) {
      for (let i = searchEnd; i >= searchStart; i--) {
        if (remaining[i] === '\n') {
          splitIndex = i + 1;
          break;
        }
      }
    }

    // Last resort: hard split at limit
    if (splitIndex === -1) {
      splitIndex = FEISHU_MSG_LIMIT;
    }

    chunks.push(remaining.substring(0, splitIndex));
    remaining = remaining.substring(splitIndex);
  }

  return chunks;
}

// ---- Core operations ----

/**
 * Create a Feishu group via lark-cli.
 * Uses the high-level command: lark-cli im +chat-create --name <name> --users <members>
 */
async function createGroup(
  groupName: string,
  members: string[],
): Promise<{ chatId: string; error: string | null }> {
  const truncatedName = truncateGroupName(groupName);
  const membersStr = members.join(',');

  try {
    const result = await execFileAsync(
      'lark-cli',
      ['im', '+chat-create', '--name', truncatedName, '--users', membersStr],
      { timeout: LARK_TIMEOUT_MS, maxBuffer: 1024 * 1024 },
    );

    // Parse response to extract chat_id
    let chatId: string | null = null;
    try {
      const parsed = JSON.parse(result.stdout);
      chatId = parsed?.data?.chat_id ?? null;
    } catch {
      // Not valid JSON
    }

    if (!chatId) {
      return { chatId: '', error: `Failed to parse chat_id from response: ${result.stdout.substring(0, 200)}` };
    }

    return { chatId, error: null };
  } catch (err: unknown) {
    const execErr = err as { stdout?: string; stderr?: string; message?: string };
    const errorMsg = (execErr.stderr ?? execErr.message ?? 'unknown error')
      .replace(/\n/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    return { chatId: '', error: errorMsg };
  }
}

/**
 * Send a text message to a Feishu chat via lark-cli raw API.
 * Uses POST /open-apis/im/v1/messages with receive_id_type=chat_id.
 */
async function sendMessage(
  chatId: string,
  text: string,
): Promise<{ success: boolean; error: string | null }> {
  // Escape JSON string content for Feishu API
  const contentJson = JSON.stringify({ text });
  const body = JSON.stringify({
    receive_id: chatId,
    msg_type: 'text',
    content: contentJson,
  });

  try {
    await execFileAsync(
      'lark-cli',
      ['api', 'POST', '/open-apis/im/v1/messages?receive_id_type=chat_id', '-d', body],
      { timeout: LARK_TIMEOUT_MS, maxBuffer: 1024 * 1024 },
    );
    return { success: true, error: null };
  } catch (err: unknown) {
    const execErr = err as { stderr?: string; message?: string };
    const errorMsg = (execErr.stderr ?? execErr.message ?? 'unknown error')
      .replace(/\n/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    return { success: false, error: errorMsg };
  }
}

// ---- Main ----

async function main() {
  // ---- Validate required inputs ----
  const groupName = process.env.OFFLOAD_GROUP_NAME ?? '';
  validateGroupName(groupName);

  const membersRaw = process.env.OFFLOAD_MEMBERS ?? '';
  const members = validateMembers(membersRaw);

  // ---- Get content (optional) ----
  let content: string | null = null;

  const contentEnv = process.env.OFFLOAD_CONTENT;
  const contentFile = process.env.OFFLOAD_CONTENT_FILE;

  if (contentEnv) {
    content = contentEnv;
  } else if (contentFile) {
    const filePath = resolve(contentFile);
    try {
      content = await readFile(filePath, 'utf-8');
    } catch {
      exit(`Failed to read content file: ${contentFile}`);
    }
  }

  const truncatedName = truncateGroupName(groupName);
  console.log(`INFO: Creating side group '${truncatedName}' with ${members.length} member(s)`);

  // ---- Check lark-cli availability (skippable for testing) ----
  const skipLark = process.env.OFFLOAD_SKIP_LARK === '1';

  if (!skipLark) {
    try {
      await execFileAsync('lark-cli', ['--version'], { timeout: 5000 });
    } catch {
      exit('Missing required dependency: lark-cli not found in PATH');
    }
  }

  // ---- Step 1: Create group ----
  let chatId = '';

  if (skipLark) {
    // Dry-run mode: use a placeholder chatId
    chatId = 'oc_dry_run_test';
    console.log(`INFO: [dry-run] Group would be created: '${truncatedName}'`);
  } else {
    const createResult = await createGroup(groupName, members);
    if (createResult.error) {
      exit(`Failed to create group: ${createResult.error}`);
    }
    chatId = createResult.chatId;
    console.log(`OK: Group created (chatId=${chatId})`);
  }

  // ---- Step 2: Send content (if provided) ----
  let messageCount = 0;

  if (content) {
    const chunks = splitContent(content);
    const totalChunks = chunks.length;

    console.log(`INFO: Sending content in ${totalChunks} message(s)`);

    for (let i = 0; i < chunks.length; i++) {
      const chunk = chunks[i];
      const prefix = totalChunks > 1 ? `[${i + 1}/${totalChunks}]\n` : '';
      const messageText = prefix + chunk;

      if (skipLark) {
        console.log(`INFO: [dry-run] Message ${i + 1}/${totalChunks} would be sent (${chunk.length} chars)`);
      } else {
        const result = await sendMessage(chatId, messageText);
        if (!result.success) {
          // Report partial failure but continue
          console.error(`WARN: Failed to send message ${i + 1}/${totalChunks}: ${result.error}`);
          // Continue sending remaining chunks
        } else {
          console.log(`OK: Message ${i + 1}/${totalChunks} sent (${chunk.length} chars)`);
        }
      }
      messageCount++;
    }
  } else {
    console.log('INFO: No content provided, group created without messages');
  }

  // ---- Step 3: Output result ----
  const result: OffloadResult = {
    chatId,
    groupName: truncatedName,
    messageCount,
  };

  // Output JSON result for the agent to use
  console.log(`RESULT: ${JSON.stringify(result)}`);
}

main().catch((err) => {
  console.error(`ERROR: ${err instanceof Error ? err.message : err}`);
  process.exit(1);
});
