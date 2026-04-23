#!/usr/bin/env tsx
/**
 * skills/chat/cleanup-locks.ts — Clean up orphaned and stale .lock files in workspace/chats/.
 *
 * Scans workspace/chats/ for .lock files and removes those that are:
 * 1. Orphaned (corresponding .json file no longer exists)
 * 2. Stale (holder process is dead AND lock age exceeds max age threshold)
 *
 * Environment variables (optional):
 *   CHAT_LOCK_MAX_AGE_HOURS  Max lock age in hours before cleanup (default: 1)
 *   CHAT_DIR                 Chat directory path (default: workspace/chats)
 *
 * Exit codes:
 *   0 — success (or no lock files found)
 *   1 — fatal error (invalid directory, etc.)
 */

import { readdir, readFile, unlink, stat, realpath } from 'node:fs/promises';
import { resolve, dirname, basename } from 'node:path';

// ---- Constants ----

const DEFAULT_CHAT_DIR = 'workspace/chats';
const DEFAULT_MAX_AGE_HOURS = 1;

// ---- Helpers ----

/**
 * Check if a process is alive by sending signal 0.
 */
function isProcessAlive(checkPid: number): boolean {
  try {
    process.kill(checkPid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Parse lock file content (format: "PID\ntimestamp\n").
 * Returns null if content is invalid or incomplete.
 */
function parseLockContent(content: string): { holderPid: number; acquiredAt: number } | null {
  const lines = content.trim().split('\n');
  if (lines.length < 2) return null;
  const holderPid = parseInt(lines[0], 10);
  const acquiredAt = parseInt(lines[1], 10);
  if (isNaN(holderPid) || isNaN(acquiredAt)) return null;
  return { holderPid, acquiredAt };
}

function exit(msg: string): never {
  console.error(`ERROR: ${msg}`);
  process.exit(1);
}

// ---- Main ----

async function main() {
  // ---- Parse environment variables ----
  const chatDir = resolve(process.env.CHAT_DIR || DEFAULT_CHAT_DIR);

  let maxAgeHours = DEFAULT_MAX_AGE_HOURS;
  const maxAgeEnv = process.env.CHAT_LOCK_MAX_AGE_HOURS;
  if (maxAgeEnv) {
    const parsed = parseFloat(maxAgeEnv);
    if (!Number.isFinite(parsed) || parsed <= 0) {
      console.error(`WARN: Invalid CHAT_LOCK_MAX_AGE_HOURS='${maxAgeEnv}', falling back to ${DEFAULT_MAX_AGE_HOURS}`);
      maxAgeHours = DEFAULT_MAX_AGE_HOURS;
    } else {
      maxAgeHours = parsed;
    }
  }

  const maxAgeMs = maxAgeHours * 3600 * 1000;
  const now = Date.now();

  // ---- Check chat directory ----
  try {
    await stat(chatDir);
  } catch {
    console.log('INFO: No chats directory found, nothing to clean up');
    process.exit(0);
  }

  const canonicalDir = await realpath(chatDir);
  let files: string[];
  try {
    files = await readdir(canonicalDir);
  } catch {
    exit('Failed to read chat directory');
  }

  // ---- Find lock files ----
  const lockFiles = files.filter((f) => f.endsWith('.lock'));

  if (lockFiles.length === 0) {
    console.log('INFO: No lock files found');
    process.exit(0);
  }

  console.log(`INFO: Found ${lockFiles.length} lock file(s)`);

  let cleanedUp = 0;
  let skipped = 0;

  for (const lockFileName of lockFiles) {
    const lockFilePath = resolve(canonicalDir, lockFileName);

    // Verify lock file is within chat directory
    let realLockPath: string;
    try {
      realLockPath = await realpath(lockFilePath);
    } catch {
      // Lock file was removed between readdir and realpath
      continue;
    }
    if (dirname(realLockPath) !== canonicalDir) {
      continue;
    }

    // Derive the corresponding data file path
    const dataFileName = basename(lockFileName, '.lock');
    const dataFilePath = resolve(canonicalDir, dataFileName);

    // Check if corresponding data file exists
    let dataFileExists = false;
    try {
      await stat(dataFilePath);
      dataFileExists = true;
    } catch {
      // Data file does not exist — this is an orphaned lock
    }

    if (!dataFileExists) {
      // Orphaned lock: corresponding JSON file doesn't exist
      try {
        await unlink(lockFilePath);
        console.log(`OK: Removed orphaned lock: ${lockFileName} (no corresponding ${dataFileName})`);
        cleanedUp++;
      } catch (err) {
        console.error(`WARN: Failed to remove orphaned lock ${lockFileName}: ${err}`);
      }
      continue;
    }

    // Data file exists — check if lock is stale
    let content: string;
    try {
      content = await readFile(lockFilePath, 'utf-8');
    } catch (err) {
      console.error(`WARN: Failed to read lock file ${lockFileName}: ${err}`);
      skipped++;
      continue;
    }

    const info = parseLockContent(content);
    if (!info) {
      // Invalid lock content — treat as orphaned
      try {
        await unlink(lockFilePath);
        console.log(`OK: Removed invalid lock: ${lockFileName} (corrupted content)`);
        cleanedUp++;
      } catch (err) {
        console.error(`WARN: Failed to remove invalid lock ${lockFileName}: ${err}`);
      }
      continue;
    }

    // Check if holder process is still alive
    if (isProcessAlive(info.holderPid)) {
      console.log(`INFO: Lock ${lockFileName} held by live process (PID ${info.holderPid}), skipping`);
      skipped++;
      continue;
    }

    // Process is dead — check lock age
    const lockAge = now - info.acquiredAt;
    if (lockAge < maxAgeMs) {
      console.log(`INFO: Lock ${lockFileName} holder dead but age ${Math.round(lockAge / 60000)}min < ${maxAgeHours}h threshold, skipping`);
      skipped++;
      continue;
    }

    // Stale lock: holder dead AND age exceeds threshold
    try {
      await unlink(lockFilePath);
      console.log(`OK: Removed stale lock: ${lockFileName} (holder PID ${info.holderPid} dead, age ${Math.round(lockAge / 3600000)}h)`);
      cleanedUp++;
    } catch (err) {
      console.error(`WARN: Failed to remove stale lock ${lockFileName}: ${err}`);
    }
  }

  console.log(`INFO: Cleaned up ${cleanedUp} lock file(s), skipped ${skipped}`);
}

main().catch((err) => {
  console.error(`ERROR: ${err instanceof Error ? err.message : err}`);
  process.exit(1);
});
