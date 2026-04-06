#!/usr/bin/env tsx
/**
 * schedule/chats-cleanup.ts — Clean up orphaned .lock files in workspace/chats/.
 *
 * When chat-timeout.ts deletes expired chat files, the corresponding .lock files
 * are left behind. This script scans for orphaned .lock files (where the
 * corresponding .json file no longer exists) and removes them.
 *
 * Environment variables (optional):
 *   CHAT_LOCK_MAX_AGE_HOURS  Max age of orphaned .lock files to clean (default: 1)
 *                            Only deletes .lock files older than this threshold
 *
 * Exit codes:
 *   0 — success (or no orphaned lock files found)
 */

import { readdir, stat, realpath, unlink } from 'node:fs/promises';
import { resolve, dirname, basename } from 'node:path';
import { CHAT_DIR } from '../chat/schema.js';

function exit(msg: string): never {
  console.error(`ERROR: ${msg}`);
  process.exit(1);
}

async function main() {
  // ---- Parse and validate CHAT_LOCK_MAX_AGE_HOURS ----
  let maxAgeHours = 1;
  const maxAgeEnv = process.env.CHAT_LOCK_MAX_AGE_HOURS;
  if (maxAgeEnv) {
    const parsed = parseFloat(maxAgeEnv);
    if (!Number.isFinite(parsed) || parsed <= 0) {
      console.error(`WARN: Invalid CHAT_LOCK_MAX_AGE_HOURS='${maxAgeEnv}', falling back to 1`);
      maxAgeHours = 1;
    } else {
      maxAgeHours = parsed;
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

  // ---- Step 1: Find orphaned .lock files ----
  const lockFiles = files.filter((f) => f.endsWith('.lock'));

  if (lockFiles.length === 0) {
    console.log('INFO: No .lock files found');
    process.exit(0);
  }

  const cutoffTime = Date.now() - maxAgeHours * 3600 * 1000;
  let cleanedUp = 0;
  let skipped = 0;

  for (const lockFileName of lockFiles) {
    const lockFilePath = resolve(canonicalDir, lockFileName);

    // Verify file is within chat directory
    let realLockPath: string;
    try {
      realLockPath = await realpath(lockFilePath);
    } catch {
      // File may have been deleted between readdir and now — skip
      continue;
    }
    if (dirname(realLockPath) !== canonicalDir) {
      continue;
    }

    // Check age of .lock file
    try {
      const lockStat = await stat(realLockPath);
      if (lockStat.mtimeMs > cutoffTime) {
        skipped++;
        continue;
      }
    } catch {
      continue;
    }

    // Derive the corresponding .json file path
    // .lock files are named like: {chatId}.json.lock
    // So the corresponding .json file is: {chatId}.json
    const jsonFileName = lockFileName.replace(/\.lock$/, '');
    const jsonFilePath = resolve(canonicalDir, jsonFileName);

    // Check if the corresponding .json file exists
    let jsonExists = false;
    try {
      await stat(jsonFilePath);
      jsonExists = true;
    } catch {
      // .json file doesn't exist — .lock file is orphaned
    }

    if (!jsonExists) {
      try {
        await unlink(realLockPath);
        console.log(`OK: Cleaned up orphaned lock file: ${lockFileName}`);
        cleanedUp++;
      } catch (err) {
        console.error(`WARN: Failed to delete orphaned lock file ${lockFileName}: ${err}`);
      }
    }
  }

  console.log(`INFO: Cleaned up ${cleanedUp} orphaned lock file(s), skipped ${skipped} recent lock file(s)`);
}

main().catch((err) => {
  console.error(`ERROR: ${err instanceof Error ? err.message : err}`);
  process.exit(1);
});
