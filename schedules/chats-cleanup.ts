#!/usr/bin/env tsx
/**
 * schedules/chats-cleanup.ts — Clean up orphaned .lock, .stale.*, and temp .tmp files.
 *
 * When chat-timeout deletes expired .json files, their .lock files become orphaned.
 * Additionally, lock.ts may leave .stale.* files from lock contention resolution,
 * and atomicWrite may leave {filename}.{timestamp}.tmp files from failed writes.
 * This schedule periodically cleans up these residual files.
 *
 * Exit codes:
 *   0 — success (or nothing to clean up)
 *   1 — fatal error (directory access failure)
 */

import { readdir, unlink, stat, realpath, access } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';

const CHAT_DIR = 'workspace/chats';

interface CleanupResult {
  orphanLocks: number;
  staleFiles: number;
  tmpFiles: number;
  errors: number;
}

async function main() {
  const chatDir = resolve(CHAT_DIR);

  // Check if chat directory exists
  try {
    await stat(chatDir);
  } catch {
    console.log('INFO: No chats directory found, nothing to clean up');
    process.exit(0);
  }

  const canonicalDir = await realpath(chatDir);

  // List all files in the directory
  let files: string[];
  try {
    files = await readdir(canonicalDir);
  } catch {
    console.error('ERROR: Failed to read chat directory');
    process.exit(1);
  }

  const result: CleanupResult = {
    orphanLocks: 0,
    staleFiles: 0,
    tmpFiles: 0,
    errors: 0,
  };

  for (const fileName of files) {
    const filePath = resolve(canonicalDir, fileName);

    // Verify file is within chat directory (path traversal protection)
    let realFilePath: string;
    try {
      realFilePath = await realpath(filePath);
    } catch {
      // File may have been deleted between readdir and realpath — skip
      continue;
    }
    if (dirname(realFilePath) !== canonicalDir) {
      continue;
    }

    try {
      // Category 1: Orphan .lock files (*.json.lock without corresponding .json)
      if (fileName.endsWith('.json.lock')) {
        const jsonFileName = fileName.slice(0, -'.lock'.length); // Remove .lock suffix
        const jsonFilePath = resolve(canonicalDir, jsonFileName);

        const jsonExists = await access(jsonFilePath).then(() => true).catch(() => false);
        if (!jsonExists) {
          await unlink(realFilePath);
          console.log(`OK: Removed orphaned lock file: ${fileName}`);
          result.orphanLocks++;
        }
        continue;
      }

      // Category 2: Stale lock residue files (*.stale.*)
      if (/\.stale\.\d+$/.test(fileName)) {
        await unlink(realFilePath);
        console.log(`OK: Removed stale lock residue: ${fileName}`);
        result.staleFiles++;
        continue;
      }

      // Category 3: Atomic write temp files ({filename}.{timestamp}.tmp)
      // Pattern: anything ending in .{10+ digit timestamp}.tmp but NOT .json.lock
      if (/^\S+\.\d{10,}\.tmp$/.test(fileName)) {
        await unlink(realFilePath);
        console.log(`OK: Removed temp write residue: ${fileName}`);
        result.tmpFiles++;
        continue;
      }
    } catch (err) {
      console.error(`WARN: Failed to clean up ${fileName}: ${err}`);
      result.errors++;
    }
  }

  const totalCleaned = result.orphanLocks + result.staleFiles + result.tmpFiles;
  if (totalCleaned === 0 && result.errors === 0) {
    console.log('INFO: No residual files to clean up');
  } else {
    console.log(
      `INFO: Cleanup complete — orphan locks: ${result.orphanLocks}, stale files: ${result.staleFiles}, tmp files: ${result.tmpFiles}, errors: ${result.errors}`,
    );
  }
}

main().catch((err) => {
  console.error(`ERROR: ${err instanceof Error ? err.message : err}`);
  process.exit(1);
});
