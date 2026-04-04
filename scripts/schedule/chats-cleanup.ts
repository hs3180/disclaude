#!/usr/bin/env tsx
/**
 * schedule/chats-cleanup.ts — Clean up expired/failed chat files past grace period.
 *
 * Reads all chat files from workspace/chats/, identifies expired and failed chats
 * past the configured grace period, and removes them. Also cleans up orphaned lock files.
 *
 * Environment variables (optional):
 *   CHAT_CLEANUP_GRACE_HOURS  Grace period in hours before cleanup (default: 24)
 *   CHAT_CLEANUP_MAX_PER_RUN  Max files to clean per execution (default: 50)
 *
 * Exit codes:
 *   0 — success (or no files to clean)
 *   1 — fatal error
 */

import { readdir, readFile, stat, unlink, realpath } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import {
  parseChatFile,
  nowISO,
  CHAT_DIR,
  type ChatFile,
} from '../chat/schema.js';

function exit(msg: string): never {
  console.error(`ERROR: ${msg}`);
  process.exit(1);
}

const DEFAULT_GRACE_HOURS = 24;
const DEFAULT_MAX_PER_RUN = 50;

async function main() {
  // ---- Parse and validate config ----
  let graceHours = DEFAULT_GRACE_HOURS;
  const graceEnv = process.env.CHAT_CLEANUP_GRACE_HOURS;
  if (graceEnv) {
    const parsed = parseInt(graceEnv, 10);
    if (!Number.isFinite(parsed) || parsed <= 0) {
      console.error(`WARN: Invalid CHAT_CLEANUP_GRACE_HOURS='${graceEnv}', falling back to ${DEFAULT_GRACE_HOURS}`);
      graceHours = DEFAULT_GRACE_HOURS;
    } else {
      graceHours = parsed;
    }
  }

  let maxPerRun = DEFAULT_MAX_PER_RUN;
  const maxEnv = process.env.CHAT_CLEANUP_MAX_PER_RUN;
  if (maxEnv) {
    const parsed = parseInt(maxEnv, 10);
    if (!Number.isFinite(parsed) || parsed <= 0) {
      console.error(`WARN: Invalid CHAT_CLEANUP_MAX_PER_RUN='${maxEnv}', falling back to ${DEFAULT_MAX_PER_RUN}`);
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
    console.log('INFO: Chat directory does not exist, nothing to clean up');
    process.exit(0);
  }

  const canonicalDir = await realpath(chatDir);
  const gracePeriodMs = graceHours * 60 * 60 * 1000;
  const now = new Date();
  let cleaned = 0;

  // ---- Step 1: List all files ----
  let files: string[];
  try {
    files = await readdir(canonicalDir);
  } catch {
    exit('Failed to read chat directory');
  }

  // ---- Step 2: Clean up orphaned lock files ----
  const lockFiles = files.filter((f) => f.endsWith('.json.lock'));
  for (const lockFile of lockFiles) {
    const lockPath = resolve(canonicalDir, lockFile);
    const correspondingJson = lockFile.replace(/\.lock$/, '');

    // If the corresponding JSON file doesn't exist, the lock is orphaned
    if (!files.includes(correspondingJson)) {
      try {
        await unlink(lockPath);
        console.log(`INFO: Removed orphaned lock file: ${lockFile}`);
      } catch {
        console.error(`WARN: Failed to remove orphaned lock file: ${lockFile}`);
      }
    }
  }

  // ---- Step 3: Find expired/failed chats past grace period ----
  const jsonFiles = files.filter((f) => f.endsWith('.json'));

  for (const fileName of jsonFiles) {
    if (cleaned >= maxPerRun) {
      console.log(`INFO: Reached max cleanup limit (${maxPerRun}), stopping`);
      break;
    }

    const filePath = resolve(canonicalDir, fileName);

    // Verify file is within chat directory (symlink safety)
    let realFilePath: string;
    try {
      realFilePath = await realpath(filePath);
    } catch {
      continue;
    }
    if (dirname(realFilePath) !== canonicalDir) {
      continue;
    }

    // Read and validate
    let content: string;
    try {
      content = await readFile(filePath, 'utf-8');
    } catch {
      continue;
    }

    let chat: ChatFile;
    try {
      chat = parseChatFile(content, filePath);
    } catch {
      console.error(`WARN: Skipping corrupted file: ${filePath}`);
      continue;
    }

    // Only clean up expired and failed chats
    if (chat.status !== 'expired' && chat.status !== 'failed') {
      continue;
    }

    // Determine the cutoff time based on status
    const timestamp = chat.status === 'expired'
      ? (chat.expiredAt ?? chat.activatedAt ?? chat.createdAt)
      : (chat.failedAt ?? chat.createdAt);

    const cutoffTime = new Date(timestamp);
    cutoffTime.setTime(cutoffTime.getTime() + gracePeriodMs);

    // Check if past grace period
    if (now < cutoffTime) {
      continue;
    }

    // Remove the chat file
    try {
      await unlink(filePath);
      console.log(`INFO: Cleaned up ${chat.status} chat ${chat.id} (file: ${fileName})`);
      cleaned++;

      // Also try to remove the lock file if it exists
      const lockPath = `${filePath}.lock`;
      try {
        await unlink(lockPath);
      } catch {
        // Lock file might not exist, that's fine
      }
    } catch (err) {
      console.error(`WARN: Failed to clean up ${fileName}: ${err}`);
    }
  }

  if (cleaned === 0) {
    console.log('INFO: No chats to clean up');
  } else {
    console.log(`INFO: Cleaned up ${cleaned} chat(s) in this run`);
  }
}

main().catch((err) => {
  console.error(`ERROR: ${err instanceof Error ? err.message : err}`);
  process.exit(1);
});
