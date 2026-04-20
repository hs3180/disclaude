#!/usr/bin/env tsx
/**
 * schedules/chats-cleanup.ts — Clean up orphaned .lock and .stale.* files.
 *
 * Scans workspace/chats/ for lock-related files that are no longer needed:
 *   - .lock files whose holder process is dead
 *   - .lock files whose corresponding .json file no longer exists
 *   - .stale.* files left over from lock contention races
 *
 * Environment variables (optional):
 *   CHAT_STALE_MAX_AGE_MS  Max age in ms for .stale.* files before cleanup (default: 300000 = 5 min)
 *
 * Exit codes:
 *   0 — success
 */

import { readdir, readFile, stat, realpath, unlink } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { CHAT_DIR } from '../skills/chat/schema.js';

// ---- Constants ----

const DEFAULT_STALE_MAX_AGE_MS = 5 * 60 * 1000; // 5 minutes

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
 * Returns null if content is invalid.
 */
function parseLockContent(content: string): { holderPid: number; acquiredAt: number } | null {
  const lines = content.trim().split('\n');
  if (lines.length < 2) return null;
  const holderPid = parseInt(lines[0], 10);
  const acquiredAt = parseInt(lines[1], 10);
  if (isNaN(holderPid) || isNaN(acquiredAt)) return null;
  return { holderPid, acquiredAt };
}

async function main() {
  // ---- Parse environment variables ----
  let staleMaxAge = DEFAULT_STALE_MAX_AGE_MS;
  const staleMaxAgeEnv = process.env.CHAT_STALE_MAX_AGE_MS;
  if (staleMaxAgeEnv) {
    const parsed = parseInt(staleMaxAgeEnv, 10);
    if (!Number.isFinite(parsed) || parsed < 0) {
      console.error(`WARN: Invalid CHAT_STALE_MAX_AGE_MS='${staleMaxAgeEnv}', falling back to ${DEFAULT_STALE_MAX_AGE_MS}`);
      staleMaxAge = DEFAULT_STALE_MAX_AGE_MS;
    } else {
      staleMaxAge = parsed;
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

  let canonicalDir: string;
  try {
    canonicalDir = await realpath(chatDir);
  } catch {
    console.error('ERROR: Failed to resolve chat directory path');
    process.exit(1);
  }

  let files: string[];
  try {
    files = await readdir(canonicalDir);
  } catch {
    console.error('ERROR: Failed to read chat directory');
    process.exit(1);
  }

  const lockFiles = files.filter((f) => f.endsWith('.lock'));
  const staleFiles = files.filter((f) => /\.stale\.\d+$/.test(f));

  if (lockFiles.length === 0 && staleFiles.length === 0) {
    console.log('INFO: No orphaned lock files found');
    process.exit(0);
  }

  console.log(`INFO: Scanning ${lockFiles.length} .lock file(s) and ${staleFiles.length} .stale file(s)`);

  let cleanedLocks = 0;
  let cleanedStales = 0;
  let skipped = 0;

  const now = Date.now();

  // ---- Step 1: Clean up .lock files ----
  for (const fileName of lockFiles) {
    const lockPath = resolve(canonicalDir, fileName);
    const jsonFileName = fileName.replace(/\.lock$/, '');
    const jsonPath = resolve(canonicalDir, jsonFileName);

    try {
      // Check 1: Corresponding .json file exists?
      try {
        await stat(jsonPath);
      } catch {
        // JSON file doesn't exist — orphaned lock
        await unlink(lockPath);
        console.log(`OK: Removed orphaned lock (no .json): ${fileName}`);
        cleanedLocks++;
        continue;
      }

      // Check 2: Parse lock content and check holder PID
      let content: string;
      try {
        content = await readFile(lockPath, 'utf-8');
      } catch {
        // Lock file disappeared between listing and reading
        continue;
      }

      const info = parseLockContent(content);

      if (!info) {
        // Corrupted lock content — safe to remove
        await unlink(lockPath);
        console.log(`OK: Removed corrupted lock: ${fileName}`);
        cleanedLocks++;
        continue;
      }

      if (!isProcessAlive(info.holderPid)) {
        // Holder process is dead — stale lock
        await unlink(lockPath);
        console.log(`OK: Removed stale lock (PID ${info.holderPid} dead): ${fileName}`);
        cleanedLocks++;
        continue;
      }

      // Lock is active — skip
      skipped++;
    } catch (err) {
      console.error(`WARN: Failed to process lock file ${fileName}: ${err}`);
    }
  }

  // ---- Step 2: Clean up .stale.* files ----
  for (const fileName of staleFiles) {
    const stalePath = resolve(canonicalDir, fileName);

    try {
      const fileStat = await stat(stalePath);
      const age = now - fileStat.mtimeMs;

      if (age >= staleMaxAge) {
        await unlink(stalePath);
        console.log(`OK: Removed stale file (${Math.round(age / 1000)}s old): ${fileName}`);
        cleanedStales++;
      } else {
        // Recently created — might still be in use
        skipped++;
      }
    } catch (err) {
      console.error(`WARN: Failed to process stale file ${fileName}: ${err}`);
    }
  }

  console.log(`INFO: Cleaned ${cleanedLocks} lock(s), ${cleanedStales} stale file(s), skipped ${skipped} active file(s)`);
}

main().catch((err) => {
  console.error(`ERROR: ${err instanceof Error ? err.message : err}`);
  process.exit(1);
});
