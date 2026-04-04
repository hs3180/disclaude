#!/usr/bin/env tsx
/**
 * chat/expire.ts — Expire timed-out active chats and dissolve their groups.
 *
 * Scans workspace/chats/ for active chats past their expiresAt timestamp,
 * marks them as expired, and attempts to dissolve the associated Feishu group
 * via lark-cli. Group dissolution failure does not prevent expiration marking.
 *
 * Environment variables (optional):
 *   CHAT_MAX_PER_RUN  Max chats to process per execution (default: 10)
 *   CHAT_EXPIRE_DRY_RUN  Set to "true" to skip group dissolution (for testing)
 *
 * Exit codes:
 *   0 — success (or no expired chats found)
 *   1 — fatal error
 */

import { readdir, readFile, writeFile, rename, stat, realpath } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import {
  parseChatFile,
  CHAT_DIR,
  DEFAULT_MAX_PER_RUN,
  UTC_DATETIME_REGEX,
  type ChatFile,
} from './schema.js';
import { withExclusiveLock } from './lock.js';

const execFileAsync = promisify(execFile);

/** Current UTC time in ISO 8601 Z-suffix format without milliseconds (matches UTC_DATETIME_REGEX) */
function nowUTC(): string {
  const d = new Date();
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}T${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}:${String(d.getUTCSeconds()).padStart(2, '0')}Z`;
}

// Extended chat file with optional expiredAt field
interface ChatFileEx extends ChatFile {
  expiredAt?: string | null;
}

function exit(msg: string): never {
  console.error(`ERROR: ${msg}`);
  process.exit(1);
}

async function main() {
  const maxPerRun = parseInt(process.env.CHAT_MAX_PER_RUN ?? '', 10) || DEFAULT_MAX_PER_RUN;
  const dryRun = process.env.CHAT_EXPIRE_DRY_RUN === 'true';
  const larkTimeout = 30_000; // 30 seconds

  let processed = 0;

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
  const now = nowUTC();

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
      chat = parseChatFile(content, filePath) as ChatFileEx;
    } catch {
      console.error(`WARN: Skipping corrupted file: ${filePath}`);
      continue;
    }

    // Only process active chats
    if (chat.status !== 'active') {
      continue;
    }

    // Validate expiresAt format
    if (!UTC_DATETIME_REGEX.test(chat.expiresAt)) {
      console.warn(`WARN: Chat ${chat.id} has non-UTC expiresAt '${chat.expiresAt}', skipping`);
      continue;
    }

    // Check if expired
    if (chat.expiresAt > now) {
      continue;
    }

    console.log(`INFO: Chat ${chat.id} expired at ${chat.expiresAt} (now: ${now})`);

    // Acquire lock and process
    const lockPath = `${filePath}.lock`;
    await withExclusiveLock(lockPath, async () => {
      // Re-read under lock
      const freshContent = await readFile(filePath, 'utf-8');
      const currentChat = parseChatFile(freshContent, filePath) as ChatFileEx;

      if (currentChat.status !== 'active') {
        console.log(`INFO: Chat ${chat.id} status changed to '${currentChat.status}', skipping`);
        return;
      }

      // Attempt to dissolve group via lark-cli (best-effort)
      const chatIdFeishu = currentChat.chatId;
      if (chatIdFeishu && !dryRun) {
        try {
          await execFileAsync('lark-cli', [
            'api', 'DELETE', `/open-apis/im/v1/chats/${chatIdFeishu}`,
          ], { timeout: larkTimeout });
          console.log(`OK: Dissolved group ${chatIdFeishu} for chat ${chat.id}`);
        } catch (err: unknown) {
          const errMsg = err instanceof Error ? err.message : String(err);
          console.warn(`WARN: Failed to dissolve group ${chatIdFeishu} for chat ${chat.id}: ${errMsg}`);
          // Still mark as expired even if dissolution fails
        }
      } else if (chatIdFeishu && dryRun) {
        console.log(`DRY RUN: Would dissolve group ${chatIdFeishu} for chat ${chat.id}`);
      } else if (!chatIdFeishu) {
        console.log(`INFO: Chat ${chat.id} has no chatId (no group to dissolve)`);
      }

      // Update status to expired
      const updatedChat: ChatFileEx = {
        ...currentChat,
        status: 'expired',
        expiredAt: now,
      };

      const tmpFile = `${filePath}.${Date.now()}.tmp`;
      await writeFile(tmpFile, JSON.stringify(updatedChat, null, 2) + '\n', 'utf-8');
      await rename(tmpFile, filePath);
      console.log(`OK: Chat ${chat.id} marked as expired`);
    });

    processed++;
  }

  console.log(`INFO: Expired ${processed} chat(s) in this run`);
}

main().catch((err) => {
  console.error(`ERROR: ${err instanceof Error ? err.message : err}`);
  process.exit(1);
});
