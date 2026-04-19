#!/usr/bin/env tsx
/**
 * schedules/chats-cleanup.ts — Clean up orphaned .lock files in workspace/chats/.
 *
 * Scans workspace/chats/ for .lock files whose corresponding .json files
 * no longer exist (orphaned locks), and removes them. Also removes stale
 * .lock files whose holder process is no longer alive.
 *
 * Environment variables (optional):
 *   CHAT_MAX_PER_RUN  Max lock files to process per execution (default: 50)
 *
 * Exit codes:
 *   0 — success (or no orphaned locks found)
 *   1 — fatal error
 */

import { readdir, readFile, unlink, stat, realpath } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { pid } from 'node:process';
import { CHAT_DIR, DEFAULT_MAX_PER_RUN } from '../skills/chat/schema.js';

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
function parseLockContent(content: string): { holderPid: number } | null {
  const lines = content.trim().split('\n');
  if (lines.length < 1) return null;
  const holderPid = parseInt(lines[0], 10);
  if (isNaN(holderPid)) return null;
  return { holderPid };
}

async function main() {
  // ---- Parse environment variables ----
  let maxPerRun = DEFAULT_MAX_PER_RUN;
  const maxPerRunEnv = process.env.CHAT_MAX_PER_RUN;
  if (maxPerRunEnv) {
    const parsed = parseInt(maxPerRunEnv, 10);
    if (!Number.isFinite(parsed) || parsed <= 0) {
      console.error(`WARN: Invalid CHAT_MAX_PER_RUN='${maxPerRunEnv}', falling back to ${DEFAULT_MAX_PER_RUN}`);
      maxPerRun = DEFAULT_MAX_PER_RUN;
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
    console.error('ERROR: Failed to read chat directory');
    process.exit(1);
  }

  const lockFiles = files.filter((f) => f.endsWith('.lock'));

  if (lockFiles.length === 0) {
    console.log('INFO: No .lock files found');
    process.exit(0);
  }

  console.log(`INFO: Found ${lockFiles.length} .lock file(s)`);

  let cleaned = 0;
  let stale = 0;
  let skipped = 0;

  for (const lockFileName of lockFiles) {
    if (cleaned + stale >= maxPerRun) {
      console.log(`INFO: Reached max processing limit (${maxPerRun}), stopping`);
      break;
    }

    const lockFilePath = resolve(canonicalDir, lockFileName);

    // Verify file is within chat directory (path traversal protection)
    let realLockPath: string;
    try {
      realLockPath = await realpath(lockFilePath);
    } catch {
      // Lock file may have been removed by another process
      continue;
    }
    if (dirname(realLockPath) !== canonicalDir) {
      continue;
    }

    // Derive the corresponding .json file name
    const jsonFileName = lockFileName.replace(/\.lock$/, '');
    const jsonFilePath = resolve(canonicalDir, jsonFileName);

    // Check if the corresponding .json file exists
    let jsonExists: boolean;
    try {
      await stat(jsonFilePath);
      jsonExists = true;
    } catch {
      jsonExists = false;
    }

    if (!jsonExists) {
      // Orphaned lock file — the .json file was cleaned up but .lock remains
      try {
        await unlink(lockFilePath);
        console.log(`OK: Removed orphaned .lock file: ${lockFileName}`);
        cleaned++;
      } catch {
        console.error(`WARN: Failed to remove orphaned .lock file: ${lockFileName}`);
      }
      continue;
    }

    // .json file exists — check if lock is stale (holder process is dead)
    let content: string;
    try {
      content = await readFile(lockFilePath, 'utf-8');
    } catch {
      // Lock file may have been removed between our readdir and here
      continue;
    }

    const info = parseLockContent(content);
    if (!info) {
      // Corrupted lock file content — remove it
      try {
        await unlink(lockFilePath);
        console.log(`OK: Removed corrupted .lock file: ${lockFileName}`);
        stale++;
      } catch {
        console.error(`WARN: Failed to remove corrupted .lock file: ${lockFileName}`);
      }
      continue;
    }

    // Don't remove our own lock
    if (info.holderPid === pid) {
      skipped++;
      continue;
    }

    if (!isProcessAlive(info.holderPid)) {
      // Stale lock — holder process is dead
      try {
        await unlink(lockFilePath);
        console.log(`OK: Removed stale .lock file: ${lockFileName} (dead PID ${info.holderPid})`);
        stale++;
      } catch {
        console.error(`WARN: Failed to remove stale .lock file: ${lockFileName}`);
      }
    } else {
      // Lock is held by a live process — skip
      skipped++;
    }
  }

  console.log(
    `INFO: Cleanup complete — removed ${cleaned} orphaned + ${stale} stale .lock file(s), skipped ${skipped}`,
  );
}

main().catch((err) => {
  console.error(`ERROR: ${err instanceof Error ? err.message : err}`);
  process.exit(1);
});
