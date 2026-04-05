#!/usr/bin/env tsx
/**
 * chat/timeout.ts — Detect and expire timed-out active chats, dissolve groups via lark-cli.
 *
 * Environment variables (optional):
 *   CHAT_MAX_PER_RUN  Max chats to process per execution (default: 10)
 *   CHAT_DRY_RUN      Set to 1 to preview changes without executing (default: 0)
 *
 * Exit codes:
 *   0 — success (or no timed-out chats found)
 *   1 — fatal error (missing dependencies)
 */

import { readdir, readFile, stat, realpath, rename, writeFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import {
  parseChatFile,
  CHAT_DIR,
  UTC_DATETIME_REGEX,
  nowISO,
  DEFAULT_MAX_PER_RUN,
  LARK_TIMEOUT_MS,
  type ChatFile,
  type ChatStatus,
} from './schema.js';
import { withExclusiveLock } from './lock.js';

const execFileAsync = promisify(execFile);

function exit(msg: string): never {
  console.error(`ERROR: ${msg}`);
  process.exit(1);
}

/**
 * Atomic file update: write to temp file then rename.
 */
async function atomicWrite(filePath: string, data: string): Promise<void> {
  const tmpFile = `${filePath}.${Date.now()}.tmp`;
  await writeFile(tmpFile, data, 'utf-8');
  await rename(tmpFile, filePath);
}

interface ProcessResult {
  processed: number;
  expired: number;
  skipped: number;
  failed: number;
}

async function main() {
  const maxPerRun = parseInt(process.env.CHAT_MAX_PER_RUN ?? '', 10) || DEFAULT_MAX_PER_RUN;
  const dryRun = process.env.CHAT_DRY_RUN === '1';

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

  // ---- Step 1: List active chats ----
  let files: string[];
  try {
    const allFiles = await readdir(chatDir);
    files = allFiles.filter((f) => f.endsWith('.json'));
  } catch {
    exit('Failed to read chat directory');
  }

  const now = nowISO();
  const activeFiles: string[] = [];

  for (const fileName of files) {
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

    if (chat.status === 'active') {
      activeFiles.push(filePath);
    }
  }

  if (activeFiles.length === 0) {
    console.log('INFO: No active chats found');
    return;
  }

  console.log(`INFO: Found ${activeFiles.length} active chat(s)`);

  const result: ProcessResult = { processed: 0, expired: 0, skipped: 0, failed: 0 };

  // ---- Step 2: Process active chats ----
  for (const filePath of activeFiles) {
    if (result.processed >= maxPerRun) {
      console.log(`INFO: Reached max processing limit (${maxPerRun}), stopping`);
      break;
    }

    // Read chat data
    let content: string;
    try {
      content = await readFile(filePath, 'utf-8');
    } catch {
      console.error(`WARN: Failed to read ${filePath}, skipping`);
      result.processed++;
      continue;
    }

    let chat: ChatFile;
    try {
      chat = parseChatFile(content, filePath);
    } catch {
      console.error(`WARN: Skipping corrupted file: ${filePath}`);
      result.processed++;
      continue;
    }

    // Check timeout
    if (!chat.expiresAt) {
      console.log(`WARN: Chat ${chat.id} has no expiresAt, skipping`);
      result.processed++;
      continue;
    }

    if (!UTC_DATETIME_REGEX.test(chat.expiresAt)) {
      console.log(`WARN: Chat ${chat.id} has non-UTC expiresAt '${chat.expiresAt}', skipping timeout check`);
      result.skipped++;
      result.processed++;
      continue;
    }

    if (chat.expiresAt > now) {
      console.log(`INFO: Chat ${chat.id} not yet expired (expires: ${chat.expiresAt})`);
      result.skipped++;
      result.processed++;
      continue;
    }

    // Chat is expired
    console.log(`INFO: Chat ${chat.id} expired at ${chat.expiresAt}`);

    if (dryRun) {
      if (chat.response) {
        console.log(`  → [DRY RUN] Would mark as expired (group preserved — user responded)`);
      } else {
        console.log(`  → [DRY RUN] Would dissolve group and mark as expired`);
      }
      result.expired++;
      result.processed++;
      continue;
    }

    // Check for user response
    const hasResponse = chat.response !== null && chat.response !== undefined;

    if (hasResponse) {
      console.log('  → Marked as expired (group preserved — user responded)');
    } else if (chat.chatId) {
      // Dissolve group via lark-cli
      console.log(`  → Dissolving group ${chat.chatId}...`);
      try {
        await execFileAsync('lark-cli', ['api', 'DELETE', `/open-apis/im/v1/chats/${chat.chatId}`], {
          timeout: LARK_TIMEOUT_MS,
        });
        console.log('  → Group dissolved successfully');
      } catch (err: unknown) {
        const errMsg = err instanceof Error ? err.message : String(err);
        if (errMsg.includes('timed out') || errMsg.includes('ETIMEDOUT')) {
          console.log(`WARN: lark-cli timed out after ${LARK_TIMEOUT_MS}ms (chat ${chat.id})`);
        } else {
          console.log(`WARN: Failed to dissolve group: ${errMsg}`);
        }
        // Continue to mark as expired even if dissolution fails
      }
    } else {
      console.log('  → No chatId found, skipping group dissolution');
    }

    // Mark as expired under lock
    const lockPath = `${filePath}.lock`;
    try {
      await withExclusiveLock(lockPath, async () => {
        // Re-read and re-validate under lock
        const freshContent = await readFile(filePath, 'utf-8');
        const freshChat = parseChatFile(freshContent, filePath);

        if (freshChat.status !== 'active') {
          console.log(`  → Status changed to '${freshChat.status}', skipping expiration mark`);
          result.skipped++;
          return;
        }

        // Update status
        const updatedContent = freshContent.replace(
          /"status":\s*"active"/,
          `"status": "expired"`
        );
        const expiredContent = updatedContent.replace(
          /"failedAt":\s*null/,
          `"expiredAt": "${nowISO()}",\n  "failedAt": null`
        );

        // Use jq-style update via JSON parse
        const data = JSON.parse(freshContent) as Record<string, unknown>;
        data.status = 'expired';
        data.expiredAt = nowISO();
        await atomicWrite(filePath, JSON.stringify(data, null, 2) + '\n');
      });
      result.expired++;
    } catch (err: unknown) {
      const errMsg = err instanceof Error ? err.message : String(err);
      if (errMsg.includes('already locked') || errMsg.includes('timed out')) {
        console.log(`WARN: Chat ${chat.id} is locked by another process, skipping`);
        result.skipped++;
      } else {
        console.log(`WARN: Failed to mark chat ${chat.id} as expired: ${errMsg}`);
        result.failed++;
      }
    }

    result.processed++;
  }

  console.log(
    `INFO: Processed ${result.processed} chat(s) — expired: ${result.expired}, skipped: ${result.skipped}, failed: ${result.failed}`
  );
}

main().catch((err) => {
  console.error(`ERROR: ${err instanceof Error ? err.message : err}`);
  process.exit(1);
});
