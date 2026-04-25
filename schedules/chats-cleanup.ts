#!/usr/bin/env tsx
/**
 * schedules/chats-cleanup.ts — Clean up orphaned .lock files and .stale.* remnants.
 *
 * Scans workspace/chats/ for stale lock files left behind by crashed processes.
 * Uses PID-based liveness checks (from lock.ts) to determine if lock holders are still alive.
 *
 * Environment variables (optional):
 *   CHAT_MAX_PER_RUN  Max files to clean per execution (default: 50)
 *   CHAT_SKIP_CHECK   Set to '1' to skip pre-flight checks (for testing)
 *
 * Exit codes:
 *   0 — success (or nothing to clean)
 *   1 — fatal error
 */

import { readdir, readFile, unlink, stat, realpath } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import {
  CHAT_DIR,
  DEFAULT_MAX_PER_RUN,
} from '../skills/chat/schema.js';

// ---- Types ----

interface LockInfo {
  holderPid: number;
  acquiredAt: number;
}

// ---- Constants ----

const DEFAULT_CLEANUP_MAX = 50;
const STALE_FILE_PATTERN = /\.stale\.\d+$/;

// ---- Helpers ----

function exit(msg: string): never {
  console.error(`ERROR: ${msg}`);
  process.exit(1);
}

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
function parseLockContent(content: string): LockInfo | null {
  const lines = content.trim().split('\n');
  if (lines.length < 2) return null;
  const holderPid = parseInt(lines[0], 10);
  const acquiredAt = parseInt(lines[1], 10);
  if (isNaN(holderPid) || isNaN(acquiredAt)) return null;
  return { holderPid, acquiredAt };
}

// ---- Main ----

async function main() {
  // ---- Parse environment variables ----
  let maxPerRun = DEFAULT_CLEANUP_MAX;
  const maxPerRunEnv = process.env.CHAT_MAX_PER_RUN;
  if (maxPerRunEnv) {
    const parsed = parseInt(maxPerRunEnv, 10);
    if (!Number.isFinite(parsed) || parsed <= 0) {
      console.error(`WARN: Invalid CHAT_MAX_PER_RUN='${maxPerRunEnv}', falling back to ${DEFAULT_CLEANUP_MAX}`);
      maxPerRun = DEFAULT_CLEANUP_MAX;
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

  const canonicalDir = await realpath(chatDir);
  let files: string[];
  try {
    files = await readdir(canonicalDir);
  } catch {
    exit('Failed to read chat directory');
  }

  // ---- Step 1: Collect cleanup candidates ----
  const lockFiles: string[] = [];
  const staleFiles: string[] = [];

  for (const fileName of files) {
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

    if (fileName.endsWith('.lock')) {
      lockFiles.push(filePath);
    } else if (STALE_FILE_PATTERN.test(fileName)) {
      staleFiles.push(filePath);
    }
  }

  if (lockFiles.length === 0 && staleFiles.length === 0) {
    console.log('INFO: No lock files to clean up');
    process.exit(0);
  }

  console.log(`INFO: Found ${lockFiles.length} .lock file(s), ${staleFiles.length} .stale file(s)`);

  // ---- Step 2: Clean up .lock files ----
  let cleaned = 0;
  let kept = 0;

  for (const lockPath of lockFiles) {
    if (cleaned >= maxPerRun) {
      console.log(`INFO: Reached max cleanup limit (${maxPerRun}), stopping`);
      break;
    }

    // Derive the expected .json file path
    const jsonPath = lockPath.replace(/\.lock$/, '');

    // Check if the corresponding .json file exists
    let jsonExists: boolean;
    try {
      await stat(jsonPath);
      jsonExists = true;
    } catch {
      jsonExists = false;
    }

    // If the .json file doesn't exist, the .lock is orphaned → remove
    if (!jsonExists) {
      try {
        await unlink(lockPath);
        console.log(`OK: Removed orphaned lock (no .json): ${lockPath}`);
        cleaned++;
      } catch (err) {
        console.error(`WARN: Failed to remove orphaned lock ${lockPath}: ${err}`);
      }
      continue;
    }

    // .json exists — check if lock holder process is alive
    let content: string;
    try {
      content = await readFile(lockPath, 'utf-8');
    } catch {
      // File was removed by another process
      continue;
    }

    const info = parseLockContent(content);

    if (!info) {
      // Corrupted/invalid lock content → remove
      try {
        await unlink(lockPath);
        console.log(`OK: Removed corrupted lock: ${lockPath}`);
        cleaned++;
      } catch (err) {
        console.error(`WARN: Failed to remove corrupted lock ${lockPath}: ${err}`);
      }
      continue;
    }

    if (!isProcessAlive(info.holderPid)) {
      // Lock holder is dead → remove stale lock
      try {
        await unlink(lockPath);
        console.log(`OK: Removed stale lock (PID ${info.holderPid} dead): ${lockPath}`);
        cleaned++;
      } catch (err) {
        console.error(`WARN: Failed to remove stale lock ${lockPath}: ${err}`);
      }
      continue;
    }

    // Lock holder is alive — keep the lock
    kept++;
  }

  // ---- Step 3: Clean up .stale.* files ----
  for (const stalePath of staleFiles) {
    if (cleaned >= maxPerRun) {
      console.log(`INFO: Reached max cleanup limit (${maxPerRun}), stopping`);
      break;
    }

    try {
      await unlink(stalePath);
      console.log(`OK: Removed stale remnant: ${stalePath}`);
      cleaned++;
    } catch (err) {
      console.error(`WARN: Failed to remove stale file ${stalePath}: ${err}`);
    }
  }

  console.log(`INFO: Cleaned ${cleaned} file(s), kept ${kept} active lock(s)`);
}

main().catch((err) => {
  console.error(`ERROR: ${err instanceof Error ? err.message : err}`);
  process.exit(1);
});
