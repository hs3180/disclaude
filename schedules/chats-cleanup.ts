#!/usr/bin/env tsx
/**
 * schedules/chats-cleanup.ts — Clean up orphaned .lock and .stale files in workspace/chats/.
 *
 * Scans the chat directory for leftover .lock files whose holder process is
 * dead, and .stale.* files from rename races in lock.ts. These files accumulate
 * when processes crash (OOM, SIGKILL) before releasing their locks.
 *
 * The stale-lock detection logic mirrors skills/chat/lock.ts (tryRemoveStaleLock):
 *   - Parse lock content ("PID\ntimestamp\n")
 *   - Check process liveness via `process.kill(pid, 0)`
 *   - Remove lock if holder is dead or content is corrupted
 *
 * Environment variables (optional):
 *   CHAT_MAX_CLEANUP  Max files to clean up per execution (default: 50)
 *
 * Exit codes:
 *   0 — success
 */

import { readdir, readFile, unlink, stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import { CHAT_DIR, DEFAULT_MAX_PER_RUN } from '../skills/chat/schema.js';

const MAX_CLEANUP = (() => {
  const env = process.env.CHAT_MAX_CLEANUP;
  if (env) {
    const parsed = parseInt(env, 10);
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
  }
  return Math.min(DEFAULT_MAX_PER_RUN * 5, 50); // 50 by default
})();

/**
 * Check if a process is alive by sending signal 0.
 * Returns true if the process exists and we have permission to signal it.
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

async function main() {
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

  // Find all .lock and .stale.* files
  const lockFiles = files.filter((f) => f.endsWith('.lock'));
  const staleFiles = files.filter((f) => /\.stale\.\d+$/.test(f));

  if (lockFiles.length === 0 && staleFiles.length === 0) {
    console.log('INFO: No orphaned lock files found');
    process.exit(0);
  }

  console.log(`INFO: Found ${lockFiles.length} .lock file(s), ${staleFiles.length} .stale file(s)`);

  let cleanedUp = 0;

  // ---- Step 1: Clean up orphaned .lock files ----
  for (const lockFileName of lockFiles) {
    if (cleanedUp >= MAX_CLEANUP) {
      console.log(`INFO: Reached max cleanup limit (${MAX_CLEANUP}), stopping`);
      break;
    }

    const lockPath = resolve(chatDir, lockFileName);

    let content: string;
    try {
      content = await readFile(lockPath, 'utf-8');
    } catch {
      // File was removed between readdir and readFile
      continue;
    }

    const info = parseLockContent(content);

    // Remove if content is invalid (corrupted/empty) or holder is confirmed dead
    const shouldRemove = !info || !isProcessAlive(info.holderPid);

    if (!shouldRemove) {
      continue;
    }

    try {
      await unlink(lockPath);
      const reason = !info ? 'corrupted' : `dead process (PID ${info.holderPid})`;
      console.log(`OK: Removed orphaned lock: ${lockFileName} (${reason})`);
      cleanedUp++;
    } catch {
      // Another process may have removed it, or file was re-acquired
    }
  }

  // ---- Step 2: Clean up .stale.* files (leftover from rename races) ----
  for (const staleFileName of staleFiles) {
    if (cleanedUp >= MAX_CLEANUP) {
      console.log(`INFO: Reached max cleanup limit (${MAX_CLEANUP}), stopping`);
      break;
    }

    const stalePath = resolve(chatDir, staleFileName);

    try {
      await unlink(stalePath);
      console.log(`OK: Removed stale file: ${staleFileName}`);
      cleanedUp++;
    } catch {
      // File may have been removed by another process
    }
  }

  console.log(`INFO: Cleaned up ${cleanedUp} file(s)`);
}

main().catch((err) => {
  console.error(`ERROR: ${err instanceof Error ? err.message : err}`);
  process.exit(1);
});
