#!/usr/bin/env tsx
/**
 * chat-timeout/cleanup.ts — Clean up expired chat files past retention period.
 *
 * Scans workspace/chats/ for expired chats where the time since expiredAt
 * exceeds the retention period (default: 1 hour), and deletes the chat
 * file and its associated .lock file.
 *
 * Environment variables (optional):
 *   CHAT_RETENTION_HOURS  Hours to retain expired files (default: 1)
 *   CHAT_MAX_PER_RUN      Max files to clean per execution (default: 50)
 *   CHAT_DRY_RUN          If "true", report actions without executing (default: false)
 *
 * Exit codes:
 *   0 — success (or no files to clean)
 *   1 — fatal error
 */

import { readdir, readFile, unlink, stat } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import {
  parseChatFile,
  nowISO,
  CHAT_DIR,
  UTC_DATETIME_REGEX,
  ValidationError,
  type ChatFile,
} from '../chat/schema.js';

// ---- Config ----
const retentionHours = parsePositiveFloat(process.env.CHAT_RETENTION_HOURS, 1);
const maxPerRun = parsePositiveInt(process.env.CHAT_MAX_PER_RUN, 50);
const dryRun = process.env.CHAT_DRY_RUN === 'true';
const retentionMs = retentionHours * 60 * 60 * 1000;

// ---- Counters ----
let cleaned = 0;
let retained = 0;
let errors = 0;

function parsePositiveInt(value: string | undefined, defaultValue: number): number {
  if (!value) return defaultValue;
  const n = parseInt(value, 10);
  if (isNaN(n) || n <= 0) return defaultValue;
  return n;
}

function parsePositiveFloat(value: string | undefined, defaultValue: number): number {
  if (!value) return defaultValue;
  const n = parseFloat(value);
  if (isNaN(n) || n <= 0) return defaultValue;
  return n;
}

async function safeUnlink(filePath: string): Promise<void> {
  try {
    await unlink(filePath);
  } catch (err: unknown) {
    const nodeErr = err as { code?: string };
    if (nodeErr.code !== 'ENOENT') {
      throw err;
    }
  }
}

async function main() {
  const chatDir = resolve(CHAT_DIR);

  // Ensure directory exists
  try {
    await stat(chatDir);
  } catch {
    console.log('INFO: Chat directory does not exist, nothing to clean');
    process.exit(0);
  }

  if (dryRun) {
    console.log('INFO: DRY RUN mode — no files will be deleted');
  }

  console.log(
    `INFO: Starting cleanup at ${nowISO()} (retention: ${retentionHours}h, max: ${maxPerRun} files)`,
  );

  // ---- Step 1: Scan for expired chats ----
  let files: string[];
  try {
    const entries = await readdir(chatDir);
    files = entries
      .filter((e) => e.endsWith('.json') && !e.endsWith('.lock'))
      .map((e) => join(chatDir, e));
  } catch {
    console.log('INFO: No chat files found');
    process.exit(0);
  }

  // ---- Step 2: Process each expired chat ----
  for (const filePath of files) {
    if (cleaned >= maxPerRun) {
      console.log(`INFO: Reached max cleanup limit (${maxPerRun}), stopping`);
      break;
    }

    // Read and validate file
    let content: string;
    let chat: ChatFile;
    let rawData: Record<string, unknown>;
    try {
      content = await readFile(filePath, 'utf-8');
      rawData = JSON.parse(content);
      chat = parseChatFile(content, filePath);
    } catch (err) {
      console.warn(`WARN: Skipping corrupted file ${filePath}: ${err instanceof Error ? err.message : err}`);
      continue;
    }

    // Only clean expired chats
    if (chat.status !== 'expired') {
      continue;
    }

    // Check retention period (requires valid expiredAt in UTC Z-suffix format)
    // Note: expiredAt is not part of ChatFile schema — it's set by the timeout script
    const expiredAt = rawData.expiredAt as string | null | undefined;
    if (!expiredAt || typeof expiredAt !== 'string' || !UTC_DATETIME_REGEX.test(expiredAt)) {
      console.warn(
        `WARN: Chat ${chat.id} has missing or non-UTC expiredAt '${expiredAt ?? 'null'}', skipping cleanup`,
      );
      continue;
    }

    const expiredMs = new Date(expiredAt).getTime();
    const nowMs = Date.now();
    const elapsedMs = nowMs - expiredMs;

    if (elapsedMs < retentionMs) {
      retained++;
      continue;
    }

    // Past retention — clean up
    const elapsedHr = (elapsedMs / (1000 * 60 * 60)).toFixed(1);
    console.log(`INFO: Cleaning chat ${chat.id} (expired ${elapsedHr}h ago)`);

    if (dryRun) {
      console.log(`DRY RUN: Would delete ${filePath} and ${filePath}.lock`);
      cleaned++;
    } else {
      try {
        await safeUnlink(filePath);
        await safeUnlink(`${filePath}.lock`);
        cleaned++;
        console.log(`OK: Deleted chat ${chat.id}`);
      } catch (err) {
        console.error(
          `ERROR: Failed to delete chat ${chat.id}: ${err instanceof Error ? err.message : err}`,
        );
        errors++;
      }
    }
  }

  // ---- Step 3: Summary ----
  console.log('---');
  console.log(`INFO: Cleanup complete`);
  console.log(`  Cleaned: ${cleaned}`);
  console.log(`  Retained (within retention): ${retained}`);
  console.log(`  Errors: ${errors}`);
}

main().catch((err) => {
  console.error(`ERROR: ${err instanceof Error ? err.message : err}`);
  process.exit(1);
});
