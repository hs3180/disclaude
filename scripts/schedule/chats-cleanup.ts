#!/usr/bin/env tsx
/**
 * schedule/chats-cleanup.ts — Clean up orphaned .lock files and old failed chat files.
 *
 * Scans workspace/chats/ for:
 *   1. Orphaned .lock files (not actively held by any process) — deleted immediately
 *   2. Old failed chat files (past retention period) — deleted
 *
 * Environment variables (optional):
 *   CHAT_FAILED_RETENTION_HOURS  Hours to retain failed files before cleanup (default: 24)
 *   CHAT_LOCK_MAX_AGE_MS         Max age (ms) for .lock files to skip flock check (default: 60000)
 *   CHAT_SKIP_LARK_CHECK         Set to '1' to skip lark-cli availability check (for testing)
 *
 * Exit codes:
 *   0 — success (or nothing to clean up)
 *   1 — fatal error
 */

import { readdir, readFile, stat, realpath, unlink } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import {
  parseChatFile,
  CHAT_DIR,
  UTC_DATETIME_REGEX,
  type ChatFile,
} from '../chat/schema.js';
import { acquireLock, isFlockAvailable } from '../chat/lock.js';

const execFileAsync = promisify(execFile);

function exit(msg: string): never {
  console.error(`ERROR: ${msg}`);
  process.exit(1);
}

/**
 * Check if a .lock file is orphaned by attempting a non-blocking exclusive lock.
 * If we can acquire the lock, no other process holds it → it's orphaned.
 */
async function isOrphanedLock(lockPath: string): Promise<boolean> {
  if (!isFlockAvailable()) {
    // Without flock support, fall back to age-based heuristic:
    // If the lock file is older than CHAT_LOCK_MAX_AGE_MS, consider it orphaned.
    const maxAgeRaw = process.env.CHAT_LOCK_MAX_AGE_MS ?? '60000';
    const maxAge = parseInt(maxAgeRaw, 10);
    if (Number.isNaN(maxAge) || maxAge < 0) {
      // Invalid value — fall back to safe default (don't delete)
      return false;
    }
    try {
      const fileStat = await stat(lockPath);
      // maxAge of 0 means treat all lock files as orphaned (useful for testing)
      return Date.now() - fileStat.mtimeMs >= maxAge;
    } catch {
      return true; // Can't stat → probably gone
    }
  }

  try {
    const lock = await acquireLock(lockPath, 'exclusive', 0);
    await lock.release();
    return true; // Successfully acquired → no one else holds it → orphaned
  } catch {
    return false; // Lock is held by another process → not orphaned
  }
}

async function main() {
  // ---- Check lark-cli availability (skippable for testing) ----
  if (process.env.CHAT_SKIP_LARK_CHECK !== '1') {
    try {
      await execFileAsync('lark-cli', ['--version'], { timeout: 5000 });
    } catch {
      exit('Missing required dependency: lark-cli not found in PATH');
    }
  }

  // ---- Parse environment variables ----
  let failedRetentionHours = 24;
  const retentionEnv = process.env.CHAT_FAILED_RETENTION_HOURS;
  if (retentionEnv) {
    const parsed = parseInt(retentionEnv, 10);
    if (!Number.isFinite(parsed) || parsed <= 0) {
      console.error(`WARN: Invalid CHAT_FAILED_RETENTION_HOURS='${retentionEnv}', falling back to 24`);
      failedRetentionHours = 24;
    } else {
      failedRetentionHours = parsed;
    }
  }

  // ---- Setup chat directory ----
  const chatDir = resolve(CHAT_DIR);
  try {
    await stat(chatDir);
  } catch {
    console.log('INFO: No chats directory found');
    process.exit(0);
  }

  const canonicalDir = await realpath(chatDir);
  let files: string[];
  try {
    files = await readdir(canonicalDir);
  } catch {
    exit('Failed to read chat directory');
  }

  // ---- Step 1: Clean up orphaned .lock files ----
  const lockFiles = files.filter((f) => f.endsWith('.lock'));
  let locksCleaned = 0;

  for (const fileName of lockFiles) {
    const filePath = resolve(canonicalDir, fileName);

    // Verify file is within chat directory
    let realFilePath: string;
    try {
      realFilePath = await realpath(filePath);
    } catch {
      // File may have been deleted between readdir and now — skip
      continue;
    }
    if (dirname(realFilePath) !== canonicalDir) {
      continue;
    }

    const orphaned = await isOrphanedLock(filePath);
    if (orphaned) {
      try {
        await unlink(filePath);
        locksCleaned++;
        console.log(`OK: Removed orphaned lock file: ${fileName}`);
      } catch (err) {
        console.error(`WARN: Failed to remove lock file ${fileName}: ${err}`);
      }
    } else {
      console.log(`INFO: Lock file ${fileName} is actively held, skipping`);
    }
  }

  // ---- Step 2: Clean up old failed chat files ----
  const jsonFiles = files.filter((f) => f.endsWith('.json'));
  const failedRetentionCutoff = new Date(Date.now() - failedRetentionHours * 3600 * 1000).toISOString();
  let failedCleaned = 0;

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

    // Only process failed chats
    if (chat.status !== 'failed') {
      continue;
    }

    // Check retention period using failedAt (or createdAt as fallback)
    const timestamp = chat.failedAt ?? chat.createdAt;
    if (!UTC_DATETIME_REGEX.test(timestamp)) {
      console.error(`WARN: Chat ${chat.id} has invalid timestamp, skipping cleanup`);
      continue;
    }

    if (timestamp < failedRetentionCutoff) {
      try {
        await unlink(filePath);
        // Also try to clean up the associated lock file
        try {
          await unlink(`${filePath}.lock`);
        } catch {
          // Lock file may not exist — ignore
        }
        failedCleaned++;
        console.log(`OK: Cleaned up failed chat file: ${fileName}`);
      } catch (err) {
        console.error(`WARN: Failed to clean up ${fileName}: ${err}`);
      }
    }
  }

  // ---- Summary ----
  if (locksCleaned === 0 && failedCleaned === 0) {
    console.log('INFO: Nothing to clean up');
  } else {
    console.log(`INFO: Cleaned up ${locksCleaned} orphaned lock file(s), ${failedCleaned} failed chat file(s)`);
  }
}

main().catch((err) => {
  console.error(`ERROR: ${err instanceof Error ? err.message : err}`);
  process.exit(1);
});
