#!/usr/bin/env tsx
/**
 * skills/chat/chats-cleanup.ts — Clean up orphaned .lock files in workspace/chats/.
 *
 * Scans the chat directory for .lock files whose corresponding .json file
 * no longer exists. These orphaned locks can accumulate when a chat file is
 * deleted (e.g., by chat-timeout cleanup) while a lock file remains.
 *
 * Environment variables (optional):
 *   CHAT_MAX_PER_RUN  Max lock files to process per execution (default: 50)
 *
 * Exit codes:
 *   0 — success (or no orphaned locks found)
 *   1 — fatal error
 */

import { readdir, stat, unlink, readFile } from 'node:fs/promises';
import { resolve, dirname, basename } from 'node:path';
import { pid } from 'node:process';
import {
  CHAT_DIR,
  DEFAULT_MAX_PER_RUN,
} from './schema.js';

const DEFAULT_LOCK_MAX_PER_RUN = 50;

// Reuse the isProcessAlive check from lock.ts logic
function isProcessAlive(checkPid: number): boolean {
  try {
    process.kill(checkPid, 0);
    return true;
  } catch {
    return false;
  }
}

interface LockInfo {
  holderPid: number;
  acquiredAt: number;
}

function parseLockContent(content: string): LockInfo | null {
  const lines = content.trim().split('\n');
  if (lines.length < 2) return null;
  const holderPid = parseInt(lines[0], 10);
  const acquiredAt = parseInt(lines[1], 10);
  if (isNaN(holderPid) || isNaN(acquiredAt)) return null;
  return { holderPid, acquiredAt };
}

async function main() {
  // ---- Parse environment variables ----
  let maxPerRun = DEFAULT_LOCK_MAX_PER_RUN;
  const maxPerRunEnv = process.env.CHAT_MAX_PER_RUN;
  if (maxPerRunEnv) {
    const parsed = parseInt(maxPerRunEnv, 10);
    if (!Number.isFinite(parsed) || parsed <= 0) {
      console.error(`WARN: Invalid CHAT_MAX_PER_RUN='${maxPerRunEnv}', falling back to ${DEFAULT_LOCK_MAX_PER_RUN}`);
      maxPerRun = DEFAULT_LOCK_MAX_PER_RUN;
    } else {
      maxPerRun = parsed;
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

  let files: string[];
  try {
    files = await readdir(chatDir);
  } catch {
    console.error('ERROR: Failed to read chat directory');
    process.exit(1);
  }

  // ---- Find .lock files ----
  const lockFiles = files.filter((f) => f.endsWith('.lock'));

  if (lockFiles.length === 0) {
    console.log('INFO: No lock files found');
    process.exit(0);
  }

  console.log(`INFO: Found ${lockFiles.length} lock file(s)`);

  // ---- Process lock files ----
  let cleaned = 0;
  let skipped = 0;

  for (const lockFileName of lockFiles) {
    if (cleaned >= maxPerRun) {
      console.log(`INFO: Reached max processing limit (${maxPerRun}), stopping`);
      break;
    }

    const lockPath = resolve(chatDir, lockFileName);

    // Derive the corresponding .json file name
    // Lock files follow the pattern: {chatfile}.json.lock
    const jsonFileName = lockFileName.replace(/\.lock$/, '');
    const jsonPath = resolve(chatDir, jsonFileName);

    // Check if the corresponding .json file still exists
    let jsonExists: boolean;
    try {
      await stat(jsonPath);
      jsonExists = true;
    } catch {
      jsonExists = false;
    }

    if (jsonExists) {
      // The .json file still exists — this lock is not orphaned
      // But check if the lock holder is still alive
      let lockContent: string;
      try {
        lockContent = await readFile(lockPath, 'utf-8');
      } catch {
        // Lock file was removed between readdir and now
        continue;
      }

      const info = parseLockContent(lockContent);
      if (info && !isProcessAlive(info.holderPid)) {
        // Lock holder is dead — stale lock with existing .json file
        // This is safe to remove because the holder process is gone
        try {
          await unlink(lockPath);
          console.log(`OK: Cleaned up stale lock (dead holder PID ${info.holderPid}): ${lockFileName}`);
          cleaned++;
        } catch {
          console.error(`WARN: Failed to remove stale lock: ${lockFileName}`);
        }
      } else {
        skipped++;
      }
      continue;
    }

    // The .json file no longer exists — this is an orphaned lock
    // Double-check: read lock content to verify the holder is dead
    let lockContent: string;
    try {
      lockContent = await readFile(lockPath, 'utf-8');
    } catch {
      // Lock file was removed between readdir and now
      continue;
    }

    const info = parseLockContent(lockContent);
    if (info && isProcessAlive(info.holderPid)) {
      // Lock holder is still alive — don't remove (may be in the process of creating)
      console.log(`INFO: Skipping orphaned lock with live holder (PID ${info.holderPid}): ${lockFileName}`);
      skipped++;
      continue;
    }

    // Safe to remove: .json gone and holder is dead (or lock content is invalid)
    try {
      await unlink(lockPath);
      console.log(`OK: Cleaned up orphaned lock: ${lockFileName}`);
      cleaned++;
    } catch (err) {
      console.error(`WARN: Failed to remove orphaned lock: ${lockFileName}: ${err}`);
    }
  }

  console.log(`INFO: Cleaned up ${cleaned} lock file(s), skipped ${skipped}`);
}

main().catch((err) => {
  console.error(`ERROR: ${err instanceof Error ? err.message : err}`);
  process.exit(1);
});
