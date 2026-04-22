#!/usr/bin/env tsx
/**
 * schedules/chats-cleanup.ts — Clean up orphaned lock and temp files.
 *
 * Scans workspace/chats/ for orphaned .lock files (whose corresponding .json
 * no longer exists), leftover .tmp files (from interrupted atomic writes),
 * and .stale.* files (from lock race resolution). Only removes files that
 * are old enough to be safe to delete (default: 60 seconds).
 *
 * Environment variables (optional):
 *   CLEANUP_MAX_PER_RUN           Max files to process per execution (default: 50)
 *   CLEANUP_LOCK_MIN_AGE_SECONDS  Minimum file age in seconds before cleanup (default: 60)
 *
 * Exit codes:
 *   0 — success (or nothing to clean)
 *   1 — fatal error
 */

import { readdir, stat, unlink, realpath } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';

// ---- Constants ----

const DEFAULT_MAX_PER_RUN = 50;
const DEFAULT_MIN_AGE_SECONDS = 60;

// ---- Helpers ----

function exit(msg: string): never {
  console.error(`ERROR: ${msg}`);
  process.exit(1);
}

function parsePositiveInt(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const parsed = parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    console.error(`WARN: Invalid env value '${value}', falling back to ${fallback}`);
    return fallback;
  }
  return parsed;
}

/**
 * Check if a file is older than `minAgeSeconds`.
 * Returns false if the file cannot be stat'd or is too recent.
 */
async function isOlderThan(filePath: string, minAgeSeconds: number): Promise<boolean> {
  try {
    const fileStat = await stat(filePath);
    const ageMs = Date.now() - fileStat.mtimeMs;
    return ageMs >= minAgeSeconds * 1000;
  } catch {
    return false;
  }
}

/**
 * Safely delete a file, returning true if deleted or already gone.
 */
async function safeUnlink(filePath: string, label: string): Promise<boolean> {
  try {
    await unlink(filePath);
    console.log(`OK: Cleaned up ${label}: ${filePath}`);
    return true;
  } catch (err: unknown) {
    const nodeErr = err as { code?: string };
    if (nodeErr.code === 'ENOENT') {
      // Already deleted by another process — not an error
      return true;
    }
    console.error(`WARN: Failed to delete ${label} '${filePath}': ${err}`);
    return false;
  }
}

// ---- Main ----

async function main() {
  const maxPerRun = parsePositiveInt(process.env.CLEANUP_MAX_PER_RUN, DEFAULT_MAX_PER_RUN);
  const minAgeSeconds = parsePositiveInt(process.env.CLEANUP_LOCK_MIN_AGE_SECONDS, DEFAULT_MIN_AGE_SECONDS);

  const chatDir = resolve('workspace/chats');
  let dirStat;
  try {
    dirStat = await stat(chatDir);
  } catch {
    console.log('INFO: No chats directory found');
    process.exit(0);
  }

  if (!dirStat.isDirectory()) {
    exit('workspace/chats is not a directory');
  }

  const canonicalDir = await realpath(chatDir);
  let files: string[];
  try {
    files = await readdir(canonicalDir);
  } catch {
    exit('Failed to read chat directory');
  }

  // Categorize candidate files
  const lockFiles: string[] = [];
  const tmpFiles: string[] = [];
  const staleFiles: string[] = [];
  const jsonFiles = new Set<string>();

  for (const fileName of files) {
    if (fileName.endsWith('.json')) {
      jsonFiles.add(fileName);
    } else if (fileName.endsWith('.lock')) {
      lockFiles.push(fileName);
    } else if (fileName.endsWith('.tmp')) {
      tmpFiles.push(fileName);
    } else if (fileName.includes('.stale.')) {
      staleFiles.push(fileName);
    }
  }

  if (lockFiles.length === 0 && tmpFiles.length === 0 && staleFiles.length === 0) {
    console.log('INFO: No orphan files found');
    process.exit(0);
  }

  console.log(
    `INFO: Found ${lockFiles.length} .lock file(s), ` +
    `${tmpFiles.length} .tmp file(s), ` +
    `${staleFiles.length} .stale file(s)`,
  );

  let processed = 0;

  // ---- Step 1: Clean up orphaned .lock files ----
  for (const lockFile of lockFiles) {
    if (processed >= maxPerRun) {
      console.log(`INFO: Reached max processing limit (${maxPerRun}), stopping`);
      break;
    }

    const lockPath = resolve(canonicalDir, lockFile);

    // Verify file is within chat directory
    let realLockPath: string;
    try {
      realLockPath = await realpath(lockPath);
    } catch {
      continue;
    }
    if (dirname(realLockPath) !== canonicalDir) {
      continue;
    }

    // Determine the corresponding .json file name
    // Lock file format: {chatId}.json.lock
    const jsonFileName = lockFile.replace(/\.lock$/, '');
    if (jsonFiles.has(jsonFileName)) {
      // Corresponding .json exists — lock may be in use, skip
      continue;
    }

    // Age check — avoid removing recently created locks
    const isOld = await isOlderThan(lockPath, minAgeSeconds);
    if (!isOld) {
      continue;
    }

    const deleted = await safeUnlink(lockPath, 'orphan lock');
    if (deleted) processed++;
  }

  // ---- Step 2: Clean up leftover .tmp files ----
  for (const tmpFile of tmpFiles) {
    if (processed >= maxPerRun) {
      console.log(`INFO: Reached max processing limit (${maxPerRun}), stopping`);
      break;
    }

    const tmpPath = resolve(canonicalDir, tmpFile);

    // Verify file is within chat directory
    let realTmpPath: string;
    try {
      realTmpPath = await realpath(tmpPath);
    } catch {
      continue;
    }
    if (dirname(realTmpPath) !== canonicalDir) {
      continue;
    }

    // Age check — atomic writes complete in milliseconds, so 60s is very safe
    const isOld = await isOlderThan(tmpPath, minAgeSeconds);
    if (!isOld) {
      continue;
    }

    const deleted = await safeUnlink(tmpPath, 'temp');
    if (deleted) processed++;
  }

  // ---- Step 3: Clean up leftover .stale.* files ----
  for (const staleFile of staleFiles) {
    if (processed >= maxPerRun) {
      console.log(`INFO: Reached max processing limit (${maxPerRun}), stopping`);
      break;
    }

    const stalePath = resolve(canonicalDir, staleFile);

    // Verify file is within chat directory
    let realStalePath: string;
    try {
      realStalePath = await realpath(stalePath);
    } catch {
      continue;
    }
    if (dirname(realStalePath) !== canonicalDir) {
      continue;
    }

    // Age check
    const isOld = await isOlderThan(stalePath, minAgeSeconds);
    if (!isOld) {
      continue;
    }

    const deleted = await safeUnlink(stalePath, 'stale');
    if (deleted) processed++;
  }

  console.log(`INFO: Cleaned up ${processed} orphan file(s)`);
}

main().catch((err) => {
  console.error(`ERROR: ${err instanceof Error ? err.message : err}`);
  process.exit(1);
});
