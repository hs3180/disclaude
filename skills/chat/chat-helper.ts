#!/usr/bin/env tsx
/**
 * skills/chat/chat-helper.ts — Helper for temporary chat group operations via lark-cli.
 *
 * Encapsulates lark-cli calls for creating and dissolving Feishu groups,
 * with input validation and error handling.
 *
 * Usage:
 *   CHAT_ACTION=create CHAT_TOPIC="My Topic" npx tsx skills/chat/chat-helper.ts
 *   CHAT_ACTION=dissolve CHAT_TARGET_ID=oc_xxx npx tsx skills/chat/chat-helper.ts
 *
 * Environment variables:
 *   CHAT_ACTION     "create" or "dissolve" (required)
 *   CHAT_TOPIC      Topic/group name for create action (required for create)
 *   CHAT_TARGET_ID  Feishu chat ID for dissolve action (required for dissolve)
 *   CHAT_USERS      Comma-separated user open_ids to add (optional, create only)
 *   CHAT_SKIP_LARK  Set to '1' to skip lark-cli calls (testing only)
 *
 * Exit codes:
 *   0 — success (outputs JSON to stdout)
 *   1 — validation error or fatal error
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

// ---- Constants ----

const LARK_TIMEOUT_MS = 30_000;
const MAX_GROUP_NAME_LENGTH = 64;

/**
 * Regex for Feishu group chat IDs (oc_xxx format).
 */
const GROUP_CHAT_ID_REGEX = /^oc_[a-zA-Z0-9]+$/;

// ---- Types ----

interface CreateResult {
  action: 'create';
  chatId: string;
  name: string;
}

interface DissolveResult {
  action: 'dissolve';
  chatId: string;
  success: boolean;
}

type ActionResult = CreateResult | DissolveResult;

// ---- Validation ----

function exit(msg: string): never {
  console.error(`ERROR: ${msg}`);
  process.exit(1);
}

function validateChatId(chatId: string): void {
  if (!chatId) {
    exit('CHAT_TARGET_ID is required for dissolve action');
  }
  if (!GROUP_CHAT_ID_REGEX.test(chatId)) {
    exit(`Invalid CHAT_TARGET_ID '${chatId}' — must match oc_xxxxx format`);
  }
}

function validateTopic(topic: string): string {
  if (!topic || topic.trim().length === 0) {
    exit('CHAT_TOPIC is required for create action');
  }
  // Truncate to max length at character boundaries (CJK-safe)
  return Array.from(topic.trim()).slice(0, MAX_GROUP_NAME_LENGTH).join('');
}

// ---- Core operations ----

/**
 * Create a new Feishu group via lark-cli.
 * Returns the chatId of the newly created group.
 */
async function createGroup(
  name: string,
  users?: string[],
): Promise<{ chatId: string; name: string }> {
  try {
    const { stdout } = await execFileAsync(
      'lark-cli',
      ['im', '+chat-create', '--name', name],
      { timeout: LARK_TIMEOUT_MS, maxBuffer: 1024 * 1024 },
    );

    // Parse chatId from lark-cli output
    // Expected output format varies; try to extract oc_xxx pattern
    const chatIdMatch = stdout.match(/(oc_[a-zA-Z0-9]+)/);
    if (!chatIdMatch) {
      throw new Error(`Could not parse chatId from lark-cli output: ${stdout.trim()}`);
    }

    const chatId = chatIdMatch[1];

    // Add users if specified
    if (users && users.length > 0) {
      try {
        await execFileAsync(
          'lark-cli',
          [
            'im', 'chat.members', 'create',
            '--params', JSON.stringify({
              chat_id: chatId,
              member_id_type: 'open_id',
              succeed_type: 1,
            }),
            '--data', JSON.stringify({ id_list: users }),
            '--as', 'user',
          ],
          { timeout: LARK_TIMEOUT_MS, maxBuffer: 1024 * 1024 },
        );
      } catch (err) {
        // Log warning but don't fail — group is created, users can be added later
        const warnMsg = err instanceof Error ? err.message : String(err);
        console.error(`WARN: Failed to add users to group ${chatId}: ${warnMsg}`);
      }
    }

    return { chatId, name };
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    throw new Error(`lark-cli group creation failed: ${errorMsg}`);
  }
}

/**
 * Dissolve a Feishu group via lark-cli raw API call.
 */
async function dissolveGroup(
  chatId: string,
): Promise<{ chatId: string; success: boolean }> {
  try {
    await execFileAsync(
      'lark-cli',
      ['api', 'DELETE', `/open-apis/im/v1/chats/${chatId}`],
      { timeout: LARK_TIMEOUT_MS, maxBuffer: 1024 * 1024 },
    );
    return { chatId, success: true };
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    // Group may already be dissolved — log but report
    console.error(`WARN: lark-cli dissolution call failed for ${chatId}: ${errorMsg}`);
    return { chatId, success: false };
  }
}

// ---- Main ----

async function main(): Promise<void> {
  const action = process.env.CHAT_ACTION ?? '';
  const skipLark = process.env.CHAT_SKIP_LARK === '1';

  // Validate action
  if (action !== 'create' && action !== 'dissolve') {
    exit('CHAT_ACTION must be "create" or "dissolve"');
  }

  // Check lark-cli availability (skippable for testing)
  if (!skipLark) {
    try {
      await execFileAsync('lark-cli', ['--version'], { timeout: 5000 });
    } catch {
      exit('Missing required dependency: lark-cli not found in PATH. Install with: npm install -g @larksuite/cli');
    }
  }

  let result: ActionResult;

  if (action === 'create') {
    const rawTopic = process.env.CHAT_TOPIC ?? '';
    const name = validateTopic(rawTopic);
    const displayName = `讨论: ${name}`;

    console.error(`INFO: Creating group '${displayName}'`);

    if (skipLark) {
      // Dry-run mode for testing
      const mockChatId = `oc_test_${Date.now()}`;
      result = { action: 'create', chatId: mockChatId, name: displayName };
    } else {
      const users = process.env.CHAT_USERS
        ? process.env.CHAT_USERS.split(',').map(u => u.trim()).filter(Boolean)
        : undefined;
      const created = await createGroup(displayName, users);
      result = { action: 'create', chatId: created.chatId, name: created.name };
    }
  } else {
    // dissolve
    const chatId = process.env.CHAT_TARGET_ID ?? '';
    validateChatId(chatId);

    console.error(`INFO: Dissolving group ${chatId}`);

    if (skipLark) {
      result = { action: 'dissolve', chatId, success: true };
    } else {
      const dissolved = await dissolveGroup(chatId);
      result = { action: 'dissolve', chatId: dissolved.chatId, success: dissolved.success };
    }
  }

  // Output result as JSON to stdout (for Agent to parse)
  console.log(JSON.stringify(result, null, 2));
}

main().catch((err) => {
  console.error(`ERROR: ${err instanceof Error ? err.message : err}`);
  process.exit(1);
});
