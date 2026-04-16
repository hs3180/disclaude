#!/usr/bin/env tsx
/**
 * skills/chat/chats-cleanup.ts — Clean up orphaned .lock files in workspace/chats/.
 *
 * Scans the chat directory for .lock files whose corresponding .json file
 * no longer exists (i.e. the chat file was cleaned up by chat-timeout but
 * the lock file was left behind). Also removes stale `.stale.*` artifacts
 * from lock contention races.
 *
 * Lock files whose holder process is still alive are preserved to avoid
 * interfering with active operations.
 *
 * Environment variables (optional):
 *   CHAT_SKIP_LIVE_CHECK  Set to '1' to skip process liveness check (for testing)
 *
 * Exit codes:
 *   0 — success
 */

import { readdir, readFile, unlink, stat } from 'node:fs/promises';
import { resolve, dirname, basename } from 'node:path';
import { CHAT_DIR } from './schema.js';

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
  const skipLiveCheck = process.env.CHAT_SKIP_LIVE_CHECK === '1';

  // ---- Locate chat directory ----
  const chatDir = resolve(process.env.CHAT_DIR || CHAT_DIR);
  try {
    await stat(chatDir);
  } catch {
    console.log('INFO: No chats directory found');
    process.exit(0);
  }

  let files: string[];
  try {
    files = await readdir(chatDir);
  } catch (err) {
    console.error(`ERROR: Failed to read chat directory: ${err}`);
    process.exit(1);
  }

  // ---- Step 1: Find orphaned .lock files ----
  const lockFiles = files.filter((f) => f.endsWith('.lock'));
  const staleFiles = files.filter((f) => /\.stale\.\d+$/.test(f));

  if (lockFiles.length === 0 && staleFiles.length === 0) {
    console.log('INFO: No orphaned lock files found');
    process.exit(0);
  }

  let cleanedLocks = 0;
  let cleanedStale = 0;
  let skipped = 0;

  // ---- Step 2: Clean up orphaned .lock files ----
  for (const lockFileName of lockFiles) {
    const lockPath = resolve(chatDir, lockFileName);
    const baseName = lockFileName.replace(/\.lock$/, '');
    const jsonPath = resolve(chatDir, baseName);

    // Check if corresponding .json file exists
    let jsonExists: boolean;
    try {
      await stat(jsonPath);
      jsonExists = true;
    } catch {
      jsonExists = false;
    }

    if (jsonExists) {
      // The .json file still exists — the lock is not orphaned, skip
      skipped++;
      continue;
    }

    // The .json file is gone — check if the lock holder is still alive
    let content: string;
    try {
      content = await readFile(lockPath, 'utf-8');
    } catch {
      // Lock file was removed by another process
      continue;
    }

    const info = parseLockContent(content);

    if (!skipLiveCheck && info && isProcessAlive(info.holderPid)) {
      // Lock holder is still alive — don't remove
      console.log(`INFO: Lock ${lockFileName} holder (PID ${info.holderPid}) is alive, skipping`);
      skipped++;
      continue;
    }

    // Safe to remove — either invalid content, dead holder, or live check skipped
    try {
      await unlink(lockPath);
      console.log(`OK: Removed orphaned lock file: ${lockFileName}`);
      cleanedLocks++;
    } catch (err) {
      console.error(`WARN: Failed to remove lock file ${lockFileName}: ${err}`);
    }
  }

  // ---- Step 3: Clean up stale .stale.* artifacts ----
  for (const staleFileName of staleFiles) {
    const stalePath = resolve(chatDir, staleFileName);
    try {
      await unlink(stalePath);
      console.log(`OK: Removed stale artifact: ${staleFileName}`);
      cleanedStale++;
    } catch (err) {
      console.error(`WARN: Failed to remove stale artifact ${staleFileName}: ${err}`);
    }
  }

  console.log(
    `INFO: Cleaned up ${cleanedLocks} orphaned lock(s), ${cleanedStale} stale artifact(s), ${skipped} skipped`,
  );
}

main().catch((err) => {
  console.error(`ERROR: ${err instanceof Error ? err.message : err}`);
  process.exit(1);
});
