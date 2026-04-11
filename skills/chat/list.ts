#!/usr/bin/env tsx
/**
 * chat/list.ts — List chats with optional status filter.
 *
 * Environment variables:
 *   CHAT_STATUS (optional) Filter by status: "pending", "active", "expired", "failed"
 *
 * Exit codes:
 *   0 — success (matching chat filenames printed to stdout, one per line)
 *   1 — directory not found
 */

import { readdir, readFile, stat, realpath } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import {
  parseChatFile,
  CHAT_DIR,
  type ChatStatus,
} from './schema.js';
import { acquireLock } from './lock.js';

function exit(msg: string): never {
  console.error(`ERROR: ${msg}`);
  process.exit(1);
}

async function main() {
  const filter = process.env.CHAT_STATUS as ChatStatus | undefined;

  // Validate filter if provided
  if (filter && !['pending', 'active', 'expired', 'failed'].includes(filter)) {
    exit(`Invalid CHAT_STATUS '${filter}' — must be one of: pending, active, expired, failed`);
  }

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

  for (const fileName of jsonFiles) {
    const filePath = resolve(chatDir, fileName);

    // Verify file is still within chat directory after symlink resolution
    let realFilePath: string;
    try {
      realFilePath = await realpath(filePath);
    } catch {
      continue; // Skip broken symlinks
    }

    if (dirname(realFilePath) !== chatDir) {
      console.error(`WARN: Skipping file outside chat directory: ${filePath}`);
      continue;
    }

    // Read and validate file
    let content: string;
    try {
      content = await readFile(filePath, 'utf-8');
    } catch {
      continue;
    }

    let chat;
    try {
      chat = parseChatFile(content, filePath);
    } catch {
      console.error(`WARN: Skipping corrupted file: ${filePath}`);
      continue;
    }

    // Acquire shared lock for consistent read (skip if unavailable)
    const lock = await acquireLock(`${filePath}.lock`, 'shared', 0);
    try {
      // Re-read under lock for consistency
      content = await readFile(filePath, 'utf-8');
      chat = parseChatFile(content, filePath);

      // Apply filter
      if (!filter || chat.status === filter) {
        console.log(filePath);
      }
    } catch {
      // Skip if we can't read under lock
    } finally {
      await lock.release();
    }
  }
}

main().catch((err) => {
  console.error(`ERROR: ${err instanceof Error ? err.message : err}`);
  process.exit(1);
});
