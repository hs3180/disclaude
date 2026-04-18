#!/usr/bin/env tsx
/**
 * schedules/chats-cleanup.ts — Clean up orphaned .lock files in workspace/chats/.
 *
 * Scans workspace/chats/ for .lock files whose corresponding .json files
 * no longer exist (orphaned locks) or that have exceeded the maximum age
 * (potential deadlocks from crashed processes).
 *
 * Environment variables (optional):
 *   CHAT_LOCK_MAX_AGE_MS  Maximum age of .lock files in ms (default: 3600000 = 1 hour)
 *
 * Exit codes:
 *   0 — success (or no cleanup needed)
 *   1 — fatal error
 */

import { readdir, stat, unlink, realpath } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { CHAT_DIR } from '../skills/chat/schema.js';

const DEFAULT_LOCK_MAX_AGE_MS = 3600_000; // 1 hour

function exit(msg: string): never {
  console.error(`ERROR: ${msg}`);
  process.exit(1);
}

async function main() {
  // ---- Parse environment variables ----
  let lockMaxAgeMs = DEFAULT_LOCK_MAX_AGE_MS;
  const lockMaxAgeEnv = process.env.CHAT_LOCK_MAX_AGE_MS;
  if (lockMaxAgeEnv) {
    const parsed = parseInt(lockMaxAgeEnv, 10);
    if (!Number.isFinite(parsed) || parsed <= 0) {
      console.error(`WARN: Invalid CHAT_LOCK_MAX_AGE_MS='${lockMaxAgeEnv}', falling back to ${DEFAULT_LOCK_MAX_AGE_MS}`);
      lockMaxAgeMs = DEFAULT_LOCK_MAX_AGE_MS;
    } else {
      lockMaxAgeMs = parsed;
    }
  }

  // ---- Check chat directory exists ----
  const chatDir = resolve(CHAT_DIR);
  let canonicalDir: string;
  try {
    canonicalDir = await realpath(chatDir);
  } catch {
    console.log('INFO: workspace/chats directory not found, nothing to clean up');
    process.exit(0);
  }

  let files: string[];
  try {
    files = await readdir(canonicalDir);
  } catch {
    exit('Failed to read chat directory');
  }

  const lockFiles = files.filter((f) => f.endsWith('.lock'));

  if (lockFiles.length === 0) {
    console.log('INFO: No .lock files found');
    process.exit(0);
  }

  console.log(`INFO: Found ${lockFiles.length} .lock file(s)`);

  // ---- Process lock files ----
  let cleaned = 0;
  let skipped = 0;
  const now = Date.now();

  for (const lockFileName of lockFiles) {
    const lockPath = resolve(canonicalDir, lockFileName);

    // Verify lock file is within chat directory
    let realLockPath: string;
    try {
      realLockPath = await realpath(lockPath);
    } catch {
      // Broken symlink, safe to skip
      console.error(`WARN: Cannot resolve path for ${lockFileName}, skipping`);
      skipped++;
      continue;
    }

    if (dirname(realLockPath) !== canonicalDir) {
      console.error(`WARN: Skipping file outside chat directory: ${lockFileName}`);
      skipped++;
      continue;
    }

    // Derive the corresponding .json file path
    const jsonFileName = lockFileName.replace(/\.lock$/, '');
    const jsonPath = resolve(canonicalDir, jsonFileName);

    // Check if corresponding .json exists
    let jsonExists = false;
    try {
      await stat(jsonPath);
      jsonExists = true;
    } catch {
      jsonExists = false;
    }

    // Check lock file age
    let lockAge = 0;
    try {
      const lockStat = await stat(lockPath);
      lockAge = now - lockStat.mtimeMs;
    } catch {
      console.error(`WARN: Cannot stat ${lockFileName}, skipping`);
      skipped++;
      continue;
    }

    // Decision: clean if orphaned (no .json) or too old
    const isOrphaned = !jsonExists;
    const isTooOld = lockAge > lockMaxAgeMs;

    if (isOrphaned || isTooOld) {
      const reason = isOrphaned ? 'orphaned (no .json)' : `too old (${Math.round(lockAge / 1000)}s)`;
      try {
        await unlink(lockPath);
        console.log(`OK: Cleaned up ${lockFileName} (${reason})`);
        cleaned++;
      } catch (err) {
        console.error(`WARN: Failed to delete ${lockFileName}: ${err}`);
        skipped++;
      }
    } else {
      // Lock is still in use by an active process
      skipped++;
    }
  }

  console.log(`INFO: Cleaned ${cleaned} .lock file(s), skipped ${skipped}`);
}

main().catch((err) => {
  console.error(`ERROR: ${err instanceof Error ? err.message : err}`);
  process.exit(1);
});
