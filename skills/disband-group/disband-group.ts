#!/usr/bin/env tsx
/**
 * skills/disband-group/disband-group.ts — Disband a Feishu group chat via lark-cli.
 *
 * Issue #2985: User-triggered group dissolution flow.
 *
 * Takes a Feishu group chat ID and an optional mapping key,
 * disbands the group using lark-cli direct API call, and removes
 * the mapping entry from workspace/bot-chat-mapping.json.
 *
 * Environment variables:
 *   DISBAND_CHAT_ID    Feishu group chat ID (oc_xxx format)
 *   DISBAND_MAPPING_KEY  Optional key in bot-chat-mapping.json to remove (e.g. "pr-123")
 *   DISBAND_SKIP_LARK  Set to '1' to skip lark-cli check and API call (for testing)
 *   WORKSPACE_DIR      Workspace directory containing bot-chat-mapping.json (default: ./workspace)
 *
 * Exit codes:
 *   0 — success (group disbanded, mapping cleaned up)
 *   1 — validation error or fatal error
 *   2 — group disbanded but mapping cleanup failed (partial success)
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';

const execFileAsync = promisify(execFile);

// ---- Constants ----

const LARK_TIMEOUT_MS = 30_000;

/**
 * Regex for Feishu group chat IDs.
 * Group chat IDs start with 'oc_' followed by alphanumeric characters.
 */
const GROUP_CHAT_ID_REGEX = /^oc_[a-zA-Z0-9]+$/;

// ---- Validation ----

function exit(msg: string, code: number = 1): never {
  console.error(`ERROR: ${msg}`);
  process.exit(code);
}

function validateChatId(chatId: string): void {
  if (!chatId) {
    exit('DISBAND_CHAT_ID environment variable is required');
  }
  if (!GROUP_CHAT_ID_REGEX.test(chatId)) {
    exit(`Invalid DISBAND_CHAT_ID '${chatId}' — must match oc_xxxxx format`);
  }
}

// ---- Core logic ----

/**
 * Disband a Feishu group via lark-cli.
 * Uses the API call: POST /open-apis/im/v1/chats/{chatId}/disband (bot-as-app)
 * or the lark-cli shorthand: `lark-cli im chat disband --chat_id <id>`
 */
async function disbandGroup(
  chatId: string,
): Promise<{ success: boolean; error: string | null }> {
  try {
    await execFileAsync(
      'lark-cli',
      ['api', 'DELETE', `/open-apis/im/v1/chats/${chatId}`],
      { timeout: LARK_TIMEOUT_MS, maxBuffer: 1024 * 1024 },
    );
    return { success: true, error: null };
  } catch (err: unknown) {
    const execErr = err as { stderr?: string; message?: string; code?: number | null };
    const errorMsg = (execErr.stderr ?? execErr.message ?? 'unknown error')
      .replace(/\n/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    return { success: false, error: errorMsg };
  }
}

/**
 * Remove a mapping entry from bot-chat-mapping.json.
 *
 * Tries to determine the mapping key from:
 * 1. DISBAND_MAPPING_KEY env var (explicit)
 * 2. Scanning all entries for the matching chatId (auto-detect)
 *
 * If no mapping is found, logs a warning but does not fail.
 */
async function removeMapping(
  chatId: string,
  mappingKey: string | undefined,
  workspaceDir: string,
): Promise<{ removed: boolean; key: string | null; error: string | null }> {
  const mappingFilePath = path.join(workspaceDir, 'bot-chat-mapping.json');

  let data: Record<string, { chatId: string; [key: string]: unknown }>;
  try {
    const content = await fs.readFile(mappingFilePath, 'utf-8');
    data = JSON.parse(content);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      // Mapping file doesn't exist — nothing to clean up
      console.log('INFO: No bot-chat-mapping.json found, skipping mapping cleanup');
      return { removed: false, key: null, error: null };
    }
    const msg = `Failed to read bot-chat-mapping.json: ${(error as Error).message}`;
    return { removed: false, key: null, error: msg };
  }

  // Determine the key to remove
  let keyToRemove: string | null = mappingKey ?? null;

  // Auto-detect: scan entries for matching chatId
  if (!keyToRemove) {
    for (const [key, entry] of Object.entries(data)) {
      if (entry && typeof entry === 'object' && entry.chatId === chatId) {
        keyToRemove = key;
        break;
      }
    }
  }

  if (!keyToRemove || !(keyToRemove in data)) {
    console.log(`INFO: No mapping entry found for chat ${chatId} (key=${mappingKey ?? 'auto'})`);
    return { removed: false, key: keyToRemove, error: null };
  }

  // Remove the entry
  delete data[keyToRemove];

  // Write back atomically
  const tmpFile = `${mappingFilePath}.${Date.now()}.tmp`;
  try {
    await fs.writeFile(tmpFile, `${JSON.stringify(data, null, 2)}\n`, 'utf-8');
    await fs.rename(tmpFile, mappingFilePath);
    console.log(`INFO: Removed mapping entry '${keyToRemove}' from bot-chat-mapping.json`);
    return { removed: true, key: keyToRemove, error: null };
  } catch (error) {
    // Clean up temp file
    try { await fs.unlink(tmpFile); } catch {}
    const msg = `Failed to update bot-chat-mapping.json: ${(error as Error).message}`;
    return { removed: false, key: keyToRemove, error: msg };
  }
}

// ---- Main ----

async function main() {
  const chatId = process.env.DISBAND_CHAT_ID ?? '';
  const mappingKey = process.env.DISBAND_MAPPING_KEY || undefined;
  const workspaceDir = process.env.WORKSPACE_DIR ?? path.resolve(process.cwd(), 'workspace');

  // Validate inputs
  validateChatId(chatId);

  console.log(`INFO: Disbanding group ${chatId}${mappingKey ? ` (mapping key: ${mappingKey})` : ''}`);

  // Check lark-cli availability (skippable for testing)
  if (process.env.DISBAND_SKIP_LARK !== '1') {
    try {
      await execFileAsync('lark-cli', ['--version'], { timeout: 5000 });
    } catch {
      exit('Missing required dependency: lark-cli not found in PATH');
    }
  }

  // Step 1: Disband the group
  if (process.env.DISBAND_SKIP_LARK === '1') {
    console.log(`OK: Group ${chatId} disbanded (dry-run)`);
  } else {
    const result = await disbandGroup(chatId);

    if (!result.success) {
      // Check if group was already disbanded (common case for retry)
      if (result.error?.includes('Chat not found') || result.error?.includes('chat is disbanded')) {
        console.log(`INFO: Group ${chatId} was already disbanded, proceeding with mapping cleanup`);
      } else {
        exit(`Failed to disband group ${chatId}: ${result.error}`);
      }
    } else {
      console.log(`OK: Group ${chatId} disbanded successfully`);
    }
  }

  // Step 2: Remove mapping entry
  const mappingResult = await removeMapping(chatId, mappingKey, workspaceDir);

  if (mappingResult.error) {
    console.warn(`WARN: Group disbanded but mapping cleanup failed: ${mappingResult.error}`);
    // Exit with partial success code
    process.exit(2);
  }

  if (mappingResult.removed) {
    console.log(`OK: Mapping entry '${mappingResult.key}' removed`);
  }

  console.log('OK: Disband operation completed successfully');
}

main().catch((err) => {
  console.error(`ERROR: ${err instanceof Error ? err.message : err}`);
  process.exit(1);
});
