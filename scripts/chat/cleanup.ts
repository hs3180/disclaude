#!/usr/bin/env tsx
/**
 * chat/cleanup.ts — Clean up expired chat files past retention period.
 *
 * Scans workspace/chats/ for expired chats older than the retention period
 * and deletes their JSON files and lock files.
 *
 * Environment variables (optional):
 *   CHAT_CLEANUP_RETENTION  Retention period in seconds (default: 3600 = 1 hour)
 *   CHAT_MAX_PER_RUN        Max chats to process per execution (default: 50)
 *
 * Exit codes:
 *   0 — success (or no expired chats to clean up)
 *   1 — fatal error
 */

import { readdir, readFile, unlink, stat, realpath } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import {
  parseChatFile,
  CHAT_DIR,
  UTC_DATETIME_REGEX,
} from './schema.js';
import { withExclusiveLock } from './lock.js';

// Extended chat file with optional expiredAt field
interface ChatFileEx {
  id: string;
  status: string;
  expiresAt: string;
  expiredAt?: string | null;
}

function exit(msg: string): never {
  console.error(`ERROR: ${msg}`);
  process.exit(1);
}

async function main() {
  const rawRetention = process.env.CHAT_CLEANUP_RETENTION ?? '';
  const parsedRetention = parseInt(rawRetention, 10);
  const retentionSeconds = rawRetention === '' ? 3600 : (isNaN(parsedRetention) ? 3600 : parsedRetention);
  const maxPerRun = parseInt(process.env.CHAT_MAX_PER_RUN ?? '', 10) || 50;

  let processed = 0;

  // Validate retention (0 means clean up immediately)
  if (retentionSeconds < 0) {
    console.warn(`WARN: Invalid CHAT_CLEANUP_RETENTION=${retentionSeconds}, falling back to 3600`);
  }
  const effectiveRetention = retentionSeconds >= 0 ? retentionSeconds : 3600;

  // Validate chat directory
  let chatDir: string;
  try {
    const resolved = resolve(CHAT_DIR);
    await stat(resolved);
    chatDir = await realpath(resolved);
  } catch {
    exit('workspace/chats directory not found');
  }

  // List chat files
  let files: string[];
  try {
    files = await readdir(chatDir);
  } catch {
    exit('Failed to read chat directory');
  }

  const jsonFiles = files.filter((f) => f.endsWith('.json'));
  const nowEpoch = Math.floor(Date.now() / 1000);

  for (const fileName of jsonFiles) {
    if (processed >= maxPerRun) {
      console.log(`INFO: Reached max processing limit (${maxPerRun}), stopping`);
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

    // Read and validate
    let content: string;
    try {
      content = await readFile(filePath, 'utf-8');
    } catch {
      continue;
    }

    let chat: ChatFileEx;
    try {
      const parsed = parseChatFile(content, filePath) as unknown as ChatFileEx;
      chat = parsed;
    } catch {
      console.error(`WARN: Skipping corrupted file: ${filePath}`);
      continue;
    }

    // Only process expired chats
    if (chat.status !== 'expired') {
      continue;
    }

    // Determine expiration timestamp
    let expiredAt = chat.expiredAt || chat.expiresAt;
    if (!expiredAt) {
      console.warn(`WARN: No timestamp found for expired chat ${chat.id}, skipping`);
      continue;
    }

    // Parse ISO 8601 to epoch
    if (!UTC_DATETIME_REGEX.test(expiredAt)) {
      console.warn(`WARN: Non-UTC timestamp '${expiredAt}' for chat ${chat.id}, skipping`);
      continue;
    }

    const expiredEpoch = Math.floor(new Date(expiredAt).getTime() / 1000);
    if (isNaN(expiredEpoch)) {
      console.warn(`WARN: Cannot parse timestamp '${expiredAt}' for chat ${chat.id}, skipping`);
      continue;
    }

    const age = nowEpoch - expiredEpoch;
    if (age < effectiveRetention) {
      continue;
    }

    console.log(`INFO: Cleaning up chat ${chat.id} (expired ${age}s ago, retention: ${effectiveRetention}s)`);

    // Acquire lock before deletion
    const lockPath = `${filePath}.lock`;
    await withExclusiveLock(lockPath, async () => {
      // Re-read under lock
      try {
        const freshContent = await readFile(filePath, 'utf-8');
        const currentChat = parseChatFile(freshContent, filePath) as unknown as ChatFileEx;

        if (currentChat.status !== 'expired') {
          console.log(`INFO: Chat ${chat.id} status changed to '${currentChat.status}', skipping cleanup`);
          return;
        }
      } catch {
        // File may have been deleted already
        return;
      }

      // Delete chat file and lock file
      try {
        await unlink(filePath);
      } catch {
        // Already deleted
      }
      try {
        await unlink(lockPath);
      } catch {
        // Lock file may not exist
      }
      console.log(`OK: Cleaned up chat ${chat.id}`);
    });

    processed++;
  }

  console.log(`INFO: Cleaned up ${processed} chat(s) in this run`);
}

main().catch((err) => {
  console.error(`ERROR: ${err instanceof Error ? err.message : err}`);
  process.exit(1);
});
