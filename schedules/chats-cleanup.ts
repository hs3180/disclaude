#!/usr/bin/env tsx
/**
 * schedules/chats-cleanup.ts — Clean up orphaned .lock and .tmp files in workspace/chats/.
 *
 * Scans workspace/chats/ for stale lock files (whose holder process is dead)
 * and leftover .tmp files (from interrupted atomic writes). Removes them safely.
 *
 * Environment variables (optional):
 *   CHAT_LOCK_MIN_AGE_MS  Minimum age of lock files before cleanup (default: 60000 = 1 min)
 *   CHAT_MAX_CLEANUP      Max files to clean up per execution (default: 50)
 *
 * Exit codes:
 *   0 — success
 *   1 — fatal error
 */

import { readdir, readFile, unlink, stat } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { CHAT_DIR } from '../skills/chat/schema.js';

// ---- Constants ----

const DEFAULT_MIN_AGE_MS = 60_000; // 1 minute
const DEFAULT_MAX_CLEANUP = 50;

// ---- Types ----

interface CleanupResult {
  lockFilesRemoved: number;
  tmpFilesRemoved: number;
  errors: string[];
}

// ---- Helpers ----

/**
 * Check if a process is alive by sending signal 0.
 * Reuses the same pattern as lock.ts.
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

/**
 * Check if a lock file is orphaned (holder process is dead).
 * Also considers the file's age — very recent lock files are never removed
 * to avoid race conditions with processes that just started.
 */
async function isOrphanedLock(
  filePath: string,
  minAgeMs: number,
): Promise<{ orphaned: boolean; reason: string }> {
  let content: string;
  try {
    content = await readFile(filePath, 'utf-8');
  } catch {
    return { orphaned: false, reason: 'cannot read' };
  }

  const info = parseLockContent(content);

  // Invalid/corrupted lock file — remove if old enough
  if (!info) {
    // Check file age as a safety measure
    try {
      const fileStat = await stat(filePath);
      const age = Date.now() - fileStat.mtimeMs;
      if (age < minAgeMs) {
        return { orphaned: false, reason: 'corrupted but too recent' };
      }
    } catch {
      return { orphaned: false, reason: 'cannot stat' };
    }
    return { orphaned: true, reason: 'corrupted/invalid content' };
  }

  // Check if holder is still alive
  if (isProcessAlive(info.holderPid)) {
    return { orphaned: false, reason: `holder PID ${info.holderPid} is alive` };
  }

  // Holder is dead — check if lock is old enough to be safely removed
  const age = Date.now() - info.acquiredAt;
  if (age < minAgeMs) {
    return { orphaned: false, reason: `holder dead but too recent (${age}ms old)` };
  }

  return { orphaned: true, reason: `holder PID ${info.holderPid} is dead` };
}

// ---- Main ----

async function main() {
  // Parse environment variables
  let minAgeMs = DEFAULT_MIN_AGE_MS;
  const minAgeEnv = process.env.CHAT_LOCK_MIN_AGE_MS;
  if (minAgeEnv) {
    const parsed = parseInt(minAgeEnv, 10);
    if (!Number.isFinite(parsed) || parsed <= 0) {
      console.error(`WARN: Invalid CHAT_LOCK_MIN_AGE_MS='${minAgeEnv}', falling back to ${DEFAULT_MIN_AGE_MS}`);
      minAgeMs = DEFAULT_MIN_AGE_MS;
    } else {
      minAgeMs = parsed;
    }
  }

  let maxCleanup = DEFAULT_MAX_CLEANUP;
  const maxCleanupEnv = process.env.CHAT_MAX_CLEANUP;
  if (maxCleanupEnv) {
    const parsed = parseInt(maxCleanupEnv, 10);
    if (!Number.isFinite(parsed) || parsed <= 0) {
      console.error(`WARN: Invalid CHAT_MAX_CLEANUP='${maxCleanupEnv}', falling back to ${DEFAULT_MAX_CLEANUP}`);
      maxCleanup = DEFAULT_MAX_CLEANUP;
    } else {
      maxCleanup = parsed;
    }
  }

  // Setup chat directory
  const chatDir = resolve(CHAT_DIR);
  try {
    await stat(chatDir);
  } catch {
    console.log('INFO: No chats directory found, nothing to clean up');
    process.exit(0);
  }

  let files: string[];
  try {
    files = await readdir(chatDir);
  } catch (err) {
    console.error(`ERROR: Failed to read chat directory: ${err}`);
    process.exit(1);
  }

  const result: CleanupResult = {
    lockFilesRemoved: 0,
    tmpFilesRemoved: 0,
    errors: [],
  };

  let cleaned = 0;

  // Find and clean .lock files
  const lockFiles = files.filter((f) => f.endsWith('.lock'));
  for (const fileName of lockFiles) {
    if (cleaned >= maxCleanup) {
      console.log(`INFO: Reached max cleanup limit (${maxCleanup}), stopping`);
      break;
    }

    const filePath = resolve(chatDir, fileName);

    // Safety: verify file is within chat directory
    const realDir = dirname(filePath);
    if (realDir !== chatDir) {
      continue;
    }

    try {
      const check = await isOrphanedLock(filePath, minAgeMs);
      if (check.orphaned) {
        await unlink(filePath);
        console.log(`OK: Removed orphaned lock file: ${fileName} (${check.reason})`);
        result.lockFilesRemoved++;
        cleaned++;
      }
    } catch (err) {
      const msg = `Failed to clean up lock ${fileName}: ${err}`;
      result.errors.push(msg);
      console.error(`WARN: ${msg}`);
    }
  }

  // Find and clean .tmp files (leftover from interrupted atomic writes)
  const tmpFiles = files.filter((f) => f.endsWith('.tmp'));
  for (const fileName of tmpFiles) {
    if (cleaned >= maxCleanup) {
      break;
    }

    const filePath = resolve(chatDir, fileName);

    // Safety: verify file is within chat directory
    const realDir = dirname(filePath);
    if (realDir !== chatDir) {
      continue;
    }

    try {
      // Only remove tmp files older than minAgeMs to avoid race conditions
      const fileStat = await stat(filePath);
      const age = Date.now() - fileStat.mtimeMs;
      if (age < minAgeMs) {
        continue;
      }

      await unlink(filePath);
      console.log(`OK: Removed stale tmp file: ${fileName}`);
      result.tmpFilesRemoved++;
      cleaned++;
    } catch (err) {
      const msg = `Failed to clean up tmp ${fileName}: ${err}`;
      result.errors.push(msg);
      console.error(`WARN: ${msg}`);
    }
  }

  // Also clean up .stale.* files from lock.ts atomic rename operations
  const staleFiles = files.filter((f) => /\.stale\.\d+$/.test(f));
  for (const fileName of staleFiles) {
    if (cleaned >= maxCleanup) {
      break;
    }

    const filePath = resolve(chatDir, fileName);
    const realDir = dirname(filePath);
    if (realDir !== chatDir) {
      continue;
    }

    try {
      await unlink(filePath);
      console.log(`OK: Removed stale file: ${fileName}`);
      result.lockFilesRemoved++; // Count as lock-related
      cleaned++;
    } catch (err) {
      const msg = `Failed to clean up stale file ${fileName}: ${err}`;
      result.errors.push(msg);
      console.error(`WARN: ${msg}`);
    }
  }

  if (result.lockFilesRemoved === 0 && result.tmpFilesRemoved === 0) {
    console.log('INFO: No orphaned files found');
  } else {
    console.log(
      `INFO: Cleaned up ${result.lockFilesRemoved} lock file(s), ${result.tmpFilesRemoved} tmp file(s)`,
    );
  }

  if (result.errors.length > 0) {
    console.error(`WARN: ${result.errors.length} error(s) during cleanup`);
  }
}

main().catch((err) => {
  console.error(`ERROR: ${err instanceof Error ? err.message : err}`);
  process.exit(1);
});
