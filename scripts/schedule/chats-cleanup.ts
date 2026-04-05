#!/usr/bin/env tsx
/**
 * schedule/chats-cleanup.ts — Clean up expired/failed chat files past retention period.
 *
 * Environment variables (optional):
 *   CHAT_RETENTION_HOURS  Hours to retain expired/failed files (default: 1)
 *   CHAT_MAX_PER_RUN      Max files to clean per execution (default: 50)
 *
 * Exit codes:
 *   0 — success (or no files to clean)
 *   1 — fatal error (missing dependencies)
 */

import { readdir, readFile, stat, realpath, unlink } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import {
  parseChatFile,
  CHAT_DIR,
  UTC_DATETIME_REGEX,
  type ChatFile,
} from '../chat/schema.js';
import { withExclusiveLock } from '../chat/lock.js';

function exit(msg: string): never {
  console.error(`ERROR: ${msg}`);
  process.exit(1);
}

async function main() {
  const retentionHours = parseInt(process.env.CHAT_RETENTION_HOURS ?? '', 10) || 1;
  const maxPerRun = parseInt(process.env.CHAT_MAX_PER_RUN ?? '', 10) || 50;

  // ---- Step 0: Validate chat directory ----
  let chatDir: string;
  try {
    const resolved = resolve(CHAT_DIR);
    await stat(resolved);
    chatDir = await realpath(resolved);
  } catch {
    console.log('INFO: No chats directory found');
    return;
  }

  // ---- Step 1: Find expired/failed chats past retention ----
  let files: string[];
  try {
    const allFiles = await readdir(chatDir);
    files = allFiles.filter((f) => f.endsWith('.json'));
  } catch {
    exit('Failed to read chat directory');
  }

  const cutoffMs = retentionHours * 3600 * 1000;
  const now = Date.now();
  let cleaned = 0;
  let skipped = 0;

  for (const fileName of files) {
    if (cleaned >= maxPerRun) {
      console.log(`INFO: Reached max cleanup limit (${maxPerRun}), stopping`);
      break;
    }

    const filePath = resolve(chatDir, fileName);

    // Verify file is within chat directory
    let realFilePath: string;
    try {
      realFilePath = await realpath(filePath);
    } catch {
      continue;
    }
    if (dirname(realFilePath) !== chatDir) {
      console.error(`WARN: Skipping file outside chat directory: ${filePath}`);
      continue;
    }

    // Read and parse
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

    // Only process expired or failed
    if (chat.status !== 'expired' && chat.status !== 'failed') {
      continue;
    }

    // Determine file age
    const timestampField = chat.status === 'expired'
      ? (chat as ChatFile & { expiredAt?: string }).expiredAt
      : chat.failedAt;

    let fileAgeMs: number;
    if (timestampField && UTC_DATETIME_REGEX.test(timestampField)) {
      fileAgeMs = now - new Date(timestampField).getTime();
    } else {
      // Fallback to file mtime
      const fileStat = await stat(filePath);
      fileAgeMs = now - fileStat.mtimeMs;
    }

    if (fileAgeMs < cutoffMs) {
      skipped++;
      continue;
    }

    // Acquire lock and delete
    const lockPath = `${filePath}.lock`;
    try {
      await withExclusiveLock(lockPath, async () => {
        // Re-read and re-validate under lock
        const freshContent = await readFile(filePath, 'utf-8');
        const freshChat = parseChatFile(freshContent, filePath);

        if (freshChat.status !== 'expired' && freshChat.status !== 'failed') {
          console.log(`INFO: Chat ${freshChat.id} status changed to '${freshChat.status}', skipping cleanup`);
          skipped++;
          return;
        }

        // Delete files
        await unlink(filePath);
        try {
          await unlink(lockPath);
        } catch {
          // Lock file may already be cleaned up
        }

        console.log(`INFO: Cleaned up chat ${freshChat.id} (status was ${freshChat.status})`);
        cleaned++;
      });
    } catch (err: unknown) {
      const errMsg = err instanceof Error ? err.message : String(err);
      if (errMsg.includes('already locked') || errMsg.includes('timed out')) {
        console.log(`WARN: Chat ${chat.id} is locked by another process, skipping cleanup`);
        skipped++;
      } else {
        console.log(`WARN: Failed to clean up chat ${chat.id}: ${errMsg}`);
      }
    }
  }

  // ---- Step 2: Clean up orphaned lock files ----
  try {
    const allFiles = await readdir(chatDir);
    const lockFiles = allFiles.filter((f) => f.endsWith('.lock'));

    for (const lockFileName of lockFiles) {
      const lockPath = resolve(chatDir, lockFileName);
      const jsonPath = lockPath.replace(/\.lock$/, '');

      try {
        await stat(jsonPath);
      } catch {
        // JSON file doesn't exist, lock is orphaned
        try {
          await unlink(lockPath);
          console.log(`INFO: Removed orphaned lock file: ${lockFileName}`);
        } catch {
          // Ignore
        }
      }
    }
  } catch {
    // Ignore errors in orphan cleanup
  }

  console.log(`INFO: Cleanup complete — cleaned: ${cleaned}, skipped: ${skipped}`);
}

main().catch((err) => {
  console.error(`ERROR: ${err instanceof Error ? err.message : err}`);
  process.exit(1);
});
