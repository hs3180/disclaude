#!/usr/bin/env tsx
/**
 * schedule/chats-cleanup.ts — Clean up expired/failed chat files and orphaned lock files.
 *
 * Removes chat files in 'expired' or 'failed' status that have exceeded the retention period,
 * and cleans up orphaned .lock files (no corresponding .json file).
 *
 * Environment variables (optional):
 *   CHAT_CLEANUP_RETENTION_DAYS  Days to retain expired/failed files (default: 7)
 *
 * Exit codes:
 *   0 — success (or nothing to clean)
 *   1 — fatal error (missing dependencies)
 */

import { readdir, readFile, unlink, stat, realpath, rename, writeFile } from 'node:fs/promises';
import { resolve, dirname, basename } from 'node:path';
import {
  parseChatFile,
  nowISO,
  CHAT_DIR,
  type ChatFile,
} from '../chat/schema.js';

const DEFAULT_RETENTION_DAYS = 7;
const MS_PER_DAY = 86_400_000;

function exit(msg: string): never {
  console.error(`FATAL: ${msg}`);
  process.exit(1);
}

/**
 * Parse a retention days env var, returning default on invalid input.
 */
function parseRetentionDays(): number {
  const env = process.env.CHAT_CLEANUP_RETENTION_DAYS;
  if (!env) return DEFAULT_RETENTION_DAYS;
  const parsed = parseInt(env, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    console.error(`WARN: Invalid CHAT_CLEANUP_RETENTION_DAYS='${env}', falling back to ${DEFAULT_RETENTION_DAYS}`);
    return DEFAULT_RETENTION_DAYS;
  }
  return parsed;
}

/**
 * Delete a file, logging warnings on failure.
 */
async function safeDelete(filePath: string, description: string): Promise<void> {
  try {
    await unlink(filePath);
  } catch (err) {
    console.error(`WARN: Failed to delete ${description} '${filePath}': ${err}`);
  }
}

async function main() {
  const retentionDays = parseRetentionDays();
  const retentionMs = retentionDays * MS_PER_DAY;
  const cutoffDate = new Date(Date.now() - retentionMs);

  let deletedFiles = 0;
  let deletedLocks = 0;

  const chatDir = resolve(CHAT_DIR);

  // If chat directory doesn't exist, nothing to clean
  try {
    await stat(chatDir);
  } catch {
    console.log(`INFO: Chat directory '${chatDir}' does not exist, nothing to clean`);
    process.exit(0);
  }

  const canonicalDir = await realpath(chatDir);
  const cutoffISO = cutoffDate.toISOString();
  console.log(`INFO: Cleaning up chats older than ${retentionDays} days (cutoff: ${cutoffISO})`);

  let files: string[];
  try {
    files = await readdir(canonicalDir);
  } catch {
    exit('Failed to read chat directory');
  }

  const jsonFiles = files.filter((f) => f.endsWith('.json'));

  // ---- Step 1: Clean up expired/failed chat files ----
  for (const fileName of jsonFiles) {
    const filePath = resolve(canonicalDir, fileName);

    // Verify file is within chat directory
    let realFilePath: string;
    try {
      realFilePath = await realpath(filePath);
    } catch {
      continue;
    }
    if (dirname(realFilePath) !== canonicalDir) {
      continue;
    }

    // Read and validate
    let content: string;
    try {
      content = await readFile(filePath, 'utf-8');
    } catch {
      continue;
    }

    let chat: ChatFile;
    try {
      chat = parseChatFile(content, filePath);
    } catch {
      console.error(`WARN: Skipping corrupted file: ${filePath}`);
      continue;
    }

    // Only process expired or failed chats
    if (chat.status !== 'expired' && chat.status !== 'failed') {
      continue;
    }

    // Determine the relevant timestamp
    const timestamp = chat.status === 'expired' ? chat.expiredAt : chat.failedAt;

    let shouldDelete = false;

    if (timestamp) {
      // Parse and compare timestamp — accept both Z-suffix formats:
      //   2026-03-25T10:00:00Z       (strict UTC)
      //   2026-03-25T10:00:00.000Z   (UTC with milliseconds)
      const tsDate = new Date(timestamp);
      if (isNaN(tsDate.getTime())) {
        console.warn(`WARN: Chat ${chat.id} has unparseable timestamp '${timestamp}', skipping`);
        continue;
      }
      if (tsDate < cutoffDate) {
        shouldDelete = true;
      }
    } else {
      // Fallback: use file modification time
      try {
        const fileStat = await stat(filePath);
        if (fileStat.mtimeMs < cutoffDate.getTime()) {
          shouldDelete = true;
        }
      } catch {
        continue;
      }
    }

    if (shouldDelete) {
      const reason = timestamp ? `(timestamp: ${timestamp})` : '(no timestamp, file mtime older than retention)';
      console.log(`INFO: Deleting ${chat.status} chat ${chat.id} ${reason}`);
      await safeDelete(filePath, `chat file`);
      await safeDelete(`${filePath}.lock`, `lock file`);
      deletedFiles++;
    }
  }

  // ---- Step 2: Clean up orphaned .lock files ----
  const lockFiles = files.filter((f) => f.endsWith('.lock'));

  for (const lockFileName of lockFiles) {
    const lockFilePath = resolve(canonicalDir, lockFileName);

    // Verify file is within chat directory
    let realLockPath: string;
    try {
      realLockPath = await realpath(lockFilePath);
    } catch {
      continue;
    }
    if (dirname(realLockPath) !== canonicalDir) {
      continue;
    }

    // Derive the expected JSON file path
    const jsonFileName = lockFileName.replace(/\.lock$/, '');
    const jsonFilePath = resolve(canonicalDir, jsonFileName);

    try {
      await stat(jsonFilePath);
      // JSON file exists, lock is not orphaned
    } catch {
      // JSON file does not exist, lock is orphaned
      console.log(`INFO: Deleting orphaned lock file: ${lockFileName}`);
      await safeDelete(lockFilePath, `orphaned lock file`);
      deletedLocks++;
    }
  }

  console.log(`INFO: Cleanup complete — deleted ${deletedFiles} chat file(s), ${deletedLocks} orphaned lock file(s)`);
}

main().catch((err) => {
  console.error(`ERROR: ${err instanceof Error ? err.message : err}`);
  process.exit(1);
});
