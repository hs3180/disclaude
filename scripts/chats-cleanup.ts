#!/usr/bin/env tsx
/**
 * scripts/chats-cleanup.ts — Clean up orphaned .lock files in workspace/chats/.
 *
 * Scans workspace/chats/ for .lock files and removes those that are:
 * 1. Orphaned — the corresponding .json file no longer exists
 * 2. Stale — the lock file is past retention age AND the holder process is dead
 *
 * Environment variables (optional):
 *   CHAT_LOCK_MAX_AGE_MS  Max age of a lock file before stale check (default: 3600000 = 1 hour)
 *
 * Exit codes:
 *   0 — success (or no lock files found)
 *   1 — fatal error
 */

import { readdir, stat, unlink, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { CHAT_DIR } from '../skills/chat/schema.js';

const DEFAULT_MAX_AGE_MS = 3_600_000; // 1 hour

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
  // Parse environment variables
  let maxAgeMs = DEFAULT_MAX_AGE_MS;
  const maxAgeEnv = process.env.CHAT_LOCK_MAX_AGE_MS;
  if (maxAgeEnv) {
    const parsed = parseInt(maxAgeEnv, 10);
    if (!Number.isFinite(parsed) || parsed <= 0) {
      console.error(`WARN: Invalid CHAT_LOCK_MAX_AGE_MS='${maxAgeEnv}', falling back to ${DEFAULT_MAX_AGE_MS}`);
      maxAgeMs = DEFAULT_MAX_AGE_MS;
    } else {
      maxAgeMs = parsed;
    }
  }

  // Setup chat directory
  const chatDir = resolve(CHAT_DIR);
  try {
    await stat(chatDir);
  } catch {
    console.log('INFO: workspace/chats directory not found, nothing to clean up');
    process.exit(0);
  }

  // List all files
  let files: string[];
  try {
    files = await readdir(chatDir);
  } catch {
    console.error('ERROR: Failed to read workspace/chats directory');
    process.exit(1);
  }

  const lockFiles = files.filter((f) => f.endsWith('.lock'));

  if (lockFiles.length === 0) {
    console.log('INFO: No .lock files found in workspace/chats/');
    process.exit(0);
  }

  console.log(`INFO: Found ${lockFiles.length} .lock file(s) to inspect`);

  let cleaned = 0;
  let retained = 0;

  for (const lockFileName of lockFiles) {
    const lockPath = resolve(chatDir, lockFileName);

    // Check 1: Is the corresponding .json file still present?
    const jsonFileName = lockFileName.replace(/\.lock$/, '');
    const jsonPath = resolve(chatDir, jsonFileName);
    let jsonExists: boolean;
    try {
      await stat(jsonPath);
      jsonExists = true;
    } catch {
      jsonExists = false;
    }

    if (!jsonExists) {
      // The .json file has been cleaned up — this .lock is orphaned
      try {
        await unlink(lockPath);
        console.log(`OK: Removed orphaned lock file: ${lockFileName} (no corresponding .json file)`);
        cleaned++;
      } catch (err) {
        console.error(`WARN: Failed to remove orphaned lock file ${lockFileName}: ${err}`);
      }
      continue;
    }

    // Check 2: Is the lock file stale (old + holder process dead)?
    let content: string;
    try {
      content = await readFile(lockPath, 'utf-8');
    } catch {
      // Lock file may have been removed between readdir and now
      continue;
    }

    const info = parseLockContent(content);

    if (!info) {
      // Invalid lock content — treat as stale
      try {
        await unlink(lockPath);
        console.log(`OK: Removed invalid lock file: ${lockFileName} (malformed content)`);
        cleaned++;
      } catch (err) {
        console.error(`WARN: Failed to remove invalid lock file ${lockFileName}: ${err}`);
      }
      continue;
    }

    const lockAge = Date.now() - info.acquiredAt;

    if (lockAge < maxAgeMs) {
      // Lock is still fresh — retain it
      retained++;
      continue;
    }

    // Lock is old — check if holder process is still alive
    if (!isProcessAlive(info.holderPid)) {
      try {
        await unlink(lockPath);
        console.log(`OK: Removed stale lock file: ${lockFileName} (holder PID ${info.holderPid} is dead, age ${Math.round(lockAge / 1000)}s)`);
        cleaned++;
      } catch (err) {
        console.error(`WARN: Failed to remove stale lock file ${lockFileName}: ${err}`);
      }
    } else {
      // Lock is old but process is still alive — retain it (unusual but safe)
      retained++;
    }
  }

  console.log(`INFO: Cleaned ${cleaned} .lock file(s), retained ${retained}`);
}

main().catch((err) => {
  console.error(`ERROR: ${err instanceof Error ? err.message : err}`);
  process.exit(1);
});
