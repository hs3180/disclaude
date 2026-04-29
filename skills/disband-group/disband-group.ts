#!/usr/bin/env tsx
/**
 * skills/disband-group/disband-group.ts — Disband a Feishu group chat via lark-cli.
 *
 * Takes a Feishu group chat ID, disbands the group using lark-cli,
 * and cleans up the corresponding entry in bot-chat-mapping.json.
 *
 * Environment variables:
 *   DISBAND_CHAT_ID       Feishu group chat ID (oc_xxx format)
 *   DISBAND_MAPPING_FILE  Path to bot-chat-mapping.json (default: workspace/bot-chat-mapping.json)
 *   DISBAND_SKIP_LARK     Set to '1' to skip lark-cli check and API call (for testing)
 *
 * Exit codes:
 *   0 — success
 *   1 — validation error or fatal error
 */

import { execFile } from 'node:child_process';
import * as fsPromises from 'fs/promises';
import * as path from 'path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

// ---- Constants ----

const LARK_TIMEOUT_MS = 30_000;

/**
 * Regex for Feishu group chat IDs.
 * Group chat IDs start with 'oc_' followed by alphanumeric characters.
 */
const GROUP_CHAT_ID_REGEX = /^oc_[a-zA-Z0-9]+$/;

/** Default path to the mapping file */
const DEFAULT_MAPPING_FILE = 'workspace/bot-chat-mapping.json';

// ---- Types ----

interface MappingEntry {
  chatId: string;
  createdAt: string;
  purpose: string;
}

interface MappingTable {
  [key: string]: MappingEntry;
}

// ---- Validation ----

function exit(msg: string): never {
  console.error(`ERROR: ${msg}`);
  process.exit(1);
}

function validateChatId(chatId: string): void {
  if (!chatId) {
    exit('DISBAND_CHAT_ID environment variable is required');
  }
  if (!GROUP_CHAT_ID_REGEX.test(chatId)) {
    exit(`Invalid DISBAND_CHAT_ID '${chatId}' — must match oc_xxxxx format`);
  }
}

// ---- Mapping cleanup ----

/**
 * Remove all entries matching the given chatId from the mapping file.
 *
 * Uses atomic write (temp file + rename) to prevent data corruption.
 *
 * @returns The number of entries removed
 */
async function cleanupMapping(
  mappingFilePath: string,
  chatId: string,
): Promise<{ removed: number; error: string | null }> {
  try {
    const content = await fsPromises.readFile(mappingFilePath, 'utf-8');
    const table: MappingTable = JSON.parse(content);

    if (!table || typeof table !== 'object' || Array.isArray(table)) {
      // Invalid structure — nothing to clean up
      return { removed: 0, error: null };
    }

    const keysToRemove = Object.keys(table).filter((key) => table[key].chatId === chatId);

    if (keysToRemove.length === 0) {
      console.log(`INFO: No mapping entries found for chatId ${chatId}`);
      return { removed: 0, error: null };
    }

    for (const key of keysToRemove) {
      delete table[key];
      console.log(`INFO: Removed mapping entry '${key}' for chatId ${chatId}`);
    }

    // Atomic write: write to temp then rename
    const dir = path.dirname(mappingFilePath);
    await fsPromises.mkdir(dir, { recursive: true });
    const tmpFile = `${mappingFilePath}.${Date.now()}.tmp`;
    const newContent = `${JSON.stringify(table, null, 2)}\n`;

    try {
      await fsPromises.writeFile(tmpFile, newContent, 'utf-8');
      await fsPromises.rename(tmpFile, mappingFilePath);
    } catch (writeError) {
      // Clean up temp file on failure
      try { await fsPromises.unlink(tmpFile); } catch {}
      throw writeError;
    }

    console.log(`INFO: Removed ${keysToRemove.length} mapping entry/entries for chatId ${chatId}`);
    return { removed: keysToRemove.length, error: null };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      // Mapping file doesn't exist — nothing to clean up
      console.log('INFO: Mapping file does not exist, skipping cleanup');
      return { removed: 0, error: null };
    }
    const errorMsg = error instanceof Error ? error.message : String(error);
    console.error(`WARN: Failed to clean up mapping file: ${errorMsg}`);
    return { removed: 0, error: errorMsg };
  }
}

// ---- Core logic ----

/**
 * Disband a Feishu group via lark-cli.
 * Uses the subcommand: lark-cli im chat disband --chat_id $CHAT_ID
 */
async function disbandGroup(
  chatId: string,
): Promise<{ success: boolean; error: string | null }> {
  try {
    await execFileAsync(
      'lark-cli',
      ['im', 'chat', 'disband', '--chat_id', chatId],
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

// ---- Main ----

async function main() {
  const chatId = process.env.DISBAND_CHAT_ID ?? '';
  const mappingFile = process.env.DISBAND_MAPPING_FILE ?? DEFAULT_MAPPING_FILE;

  // Validate inputs
  validateChatId(chatId);

  console.log(`INFO: Disbanding group ${chatId}`);

  // Step 1: Clean up mapping records (before disband — mapping is a cache)
  const mappingResult = await cleanupMapping(mappingFile, chatId);
  if (mappingResult.error) {
    console.error(`WARN: Mapping cleanup had issues: ${mappingResult.error}`);
  }

  // Check lark-cli availability (skippable for testing)
  if (process.env.DISBAND_SKIP_LARK !== '1') {
    try {
      await execFileAsync('lark-cli', ['--version'], { timeout: 5000 });
    } catch {
      exit('Missing required dependency: lark-cli not found in PATH');
    }
  }

  // Skip actual API call in dry-run mode (for testing)
  if (process.env.DISBAND_SKIP_LARK === '1') {
    console.log(`OK: Group ${chatId} disbanded (dry-run), ${mappingResult.removed} mapping entry/entries removed`);
    return;
  }

  // Step 2: Execute disband via lark-cli
  const result = await disbandGroup(chatId);

  if (result.success) {
    console.log(`OK: Group ${chatId} disbanded, ${mappingResult.removed} mapping entry/entries removed`);
  } else {
    // Disband failed — but mapping cleanup already succeeded (mapping is a cache)
    console.error(`ERROR: Failed to disband group ${chatId}: ${result.error}`);
    console.log(`INFO: Mapping cleanup was still performed (${mappingResult.removed} entry/entries removed)`);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(`ERROR: ${err instanceof Error ? err.message : err}`);
  process.exit(1);
});
