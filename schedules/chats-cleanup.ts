#!/usr/bin/env tsx
/**
 * schedules/chats-cleanup.ts — Clean up orphaned files in workspace/chats/.
 *
 * Scans for and removes:
 * - Orphaned `.lock` files whose corresponding `.json` file no longer exists
 * - Residual `.tmp` files from failed atomic writes
 * - Residual `.stale.*` files from lock contention cleanup
 *
 * Environment variables (optional):
 *   CHAT_CLEANUP_MAX_FILES  Max files to process per execution (default: 50)
 *   CHAT_CLEANUP_MIN_AGE_MS Minimum file age in ms before cleanup (default: 60000)
 *
 * Exit codes:
 *   0 — success (or nothing to clean)
 *   1 — fatal error
 */

import { readdir, stat, unlink } from 'node:fs/promises';
import { resolve, dirname, basename } from 'node:path';
import { CHAT_DIR } from '../skills/chat/schema.js';

const DEFAULT_MAX_FILES = 50;
const DEFAULT_MIN_AGE_MS = 60_000; // 1 minute

function exit(msg: string): never {
  console.error(`ERROR: ${msg}`);
  process.exit(1);
}

async function main() {
  // ---- Parse environment variables ----
  let maxFiles = DEFAULT_MAX_FILES;
  const maxFilesEnv = process.env.CHAT_CLEANUP_MAX_FILES;
  if (maxFilesEnv) {
    const parsed = parseInt(maxFilesEnv, 10);
    if (!Number.isFinite(parsed) || parsed <= 0) {
      console.error(`WARN: Invalid CHAT_CLEANUP_MAX_FILES='${maxFilesEnv}', falling back to ${DEFAULT_MAX_FILES}`);
      maxFiles = DEFAULT_MAX_FILES;
    } else {
      maxFiles = parsed;
    }
  }

  let minAgeMs = DEFAULT_MIN_AGE_MS;
  const minAgeEnv = process.env.CHAT_CLEANUP_MIN_AGE_MS;
  if (minAgeEnv) {
    const parsed = parseInt(minAgeEnv, 10);
    if (!Number.isFinite(parsed) || parsed < 0) {
      console.error(`WARN: Invalid CHAT_CLEANUP_MIN_AGE_MS='${minAgeEnv}', falling back to ${DEFAULT_MIN_AGE_MS}`);
      minAgeMs = DEFAULT_MIN_AGE_MS;
    } else {
      minAgeMs = parsed;
    }
  }

  // ---- Check directory exists ----
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
  } catch {
    exit('Failed to read chat directory');
  }

  // ---- Identify cleanup candidates ----
  const now = Date.now();
  const candidates: string[] = [];

  for (const fileName of files) {
    // Only consider non-JSON files
    if (fileName.endsWith('.json')) continue;

    // Match cleanup targets:
    // 1. .lock files (orphaned locks)
    // 2. .tmp files (failed atomic write residuals)
    // 3. .stale.* files (lock contention residuals)
    const isLock = fileName.endsWith('.lock');
    const isTmp = /\.\d+\.tmp$/.test(fileName);
    const isStale = /\.stale\.\d+$/.test(fileName);

    if (!isLock && !isTmp && !isStale) continue;

    candidates.push(fileName);
  }

  if (candidates.length === 0) {
    console.log('INFO: No cleanup candidates found');
    process.exit(0);
  }

  console.log(`INFO: Found ${candidates.length} cleanup candidate(s)`);

  // ---- Process candidates ----
  let cleaned = 0;
  let skipped = 0;

  for (const fileName of candidates) {
    if (cleaned >= maxFiles) {
      console.log(`INFO: Reached max file limit (${maxFiles}), stopping`);
      break;
    }

    const filePath = resolve(chatDir, fileName);

    // Check file age — skip recently created files
    let fileStat;
    try {
      fileStat = await stat(filePath);
    } catch {
      // File was removed by another process
      continue;
    }

    const fileAge = now - fileStat.mtimeMs;
    if (fileAge < minAgeMs) {
      skipped++;
      continue;
    }

    // For .lock files, check if the corresponding JSON still exists
    if (fileName.endsWith('.lock')) {
      const jsonName = fileName.replace(/\.lock$/, '');
      const jsonPath = resolve(chatDir, jsonName);
      try {
        await stat(jsonPath);
        // JSON file still exists — lock is not orphaned, skip
        skipped++;
        continue;
      } catch {
        // JSON file doesn't exist — lock is orphaned, proceed to delete
      }
    }

    // Delete the file
    try {
      await unlink(filePath);
      console.log(`OK: Cleaned up ${fileName}`);
      cleaned++;
    } catch (err) {
      console.error(`WARN: Failed to delete ${fileName}: ${err}`);
    }
  }

  console.log(`INFO: Cleaned ${cleaned} file(s), skipped ${skipped}`);
}

main().catch((err) => {
  console.error(`ERROR: ${err instanceof Error ? err.message : err}`);
  process.exit(1);
});
