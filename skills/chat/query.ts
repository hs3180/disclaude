#!/usr/bin/env tsx
/**
 * chat/query.ts — Query a chat's current status.
 *
 * Environment variables:
 *   CHAT_ID (required) Unique chat identifier
 *
 * Exit codes:
 *   0 — success (chat content printed to stdout)
 *   1 — validation error or chat not found
 */

import { readFile, stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import {
  validateChatId,
  parseChatFile,
  CHAT_DIR,
  ValidationError,
} from './schema.js';
import { withSharedLock } from './lock.js';

function exit(msg: string): never {
  console.error(`ERROR: ${msg}`);
  process.exit(1);
}

async function main() {
  const chatId = process.env.CHAT_ID;
  try {
    validateChatId(chatId ?? '');
  } catch (err) {
    exit(err instanceof ValidationError ? err.message : String(err));
  }

  const chatDir = resolve(CHAT_DIR);
  const chatFile = resolve(chatDir, `${chatId}.json`);

  // Path traversal protection
  if (!chatFile.startsWith(chatDir + '/')) {
    exit(`Path traversal detected for chat ID '${chatId}'`);
  }

  // Check file exists
  try {
    await stat(chatFile);
  } catch (err: unknown) {
    // @ts-expect-error - checking error code
    if (err?.code === 'ENOENT') {
      exit(`Chat ${chatId} not found`);
    }
    exit(`Failed to access chat file: ${err}`);
  }

  // Read under shared lock
  const lockPath = `${chatFile}.lock`;
  await withSharedLock(lockPath, async () => {
    const content = await readFile(chatFile, 'utf-8');
    parseChatFile(content, chatFile); // Validate before output
    process.stdout.write(content);
  });
}

main().catch((err) => {
  console.error(`ERROR: ${err instanceof Error ? err.message : err}`);
  process.exit(1);
});
