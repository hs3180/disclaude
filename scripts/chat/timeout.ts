#!/usr/bin/env tsx
/**
 * chat/timeout.ts — Detect timed-out active chats, mark as expired, dissolve groups.
 *
 * Reads all active chats from workspace/chats/, checks if they have exceeded
 * their TTL (expiresAt), marks them as expired, and optionally dissolves the
 * associated Feishu group via lark-cli.
 *
 * Environment variables (optional):
 *   CHAT_MAX_PER_RUN  Max chats to process per execution (default: 10)
 *
 * Exit codes:
 *   0 — success (or no timed-out chats found)
 *   1 — fatal error (missing dependencies)
 */

import { readdir, readFile, writeFile, stat, realpath, rename } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import {
  parseChatFile,
  nowISO,
  CHAT_DIR,
  DEFAULT_MAX_PER_RUN,
  LARK_TIMEOUT_MS,
  type ChatFile,
} from './schema.js';
import { acquireLock, isFlockAvailable } from './lock.js';

const execFileAsync = promisify(execFile);

function exit(msg: string): never {
  console.error(`ERROR: ${msg}`);
  process.exit(1);
}

/**
 * Atomic file write: write to temp file then rename.
 */
async function atomicWrite(filePath: string, data: string): Promise<void> {
  const tmpFile = `${filePath}.${Date.now()}.tmp`;
  await writeFile(tmpFile, data, 'utf-8');
  await rename(tmpFile, filePath);
}

interface RunStats {
  checked: number;
  expired: number;
  dissolved: number;
  skipped: number;
  errors: number;
}

async function main() {
  // ---- Check lark-cli availability ----
  try {
    await execFileAsync('lark-cli', ['--version'], { timeout: 5000 });
  } catch {
    exit('Missing required dependency: lark-cli not found in PATH');
  }

  // ---- Parse and validate CHAT_MAX_PER_RUN ----
  let maxPerRun = DEFAULT_MAX_PER_RUN;
  const maxPerRunEnv = process.env.CHAT_MAX_PER_RUN;
  if (maxPerRunEnv) {
    const parsed = parseInt(maxPerRunEnv, 10);
    if (!Number.isFinite(parsed) || parsed <= 0) {
      console.error(`WARN: Invalid CHAT_MAX_PER_RUN='${maxPerRunEnv}', falling back to ${DEFAULT_MAX_PER_RUN}`);
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
    console.log('INFO: No chats found (chat directory does not exist)');
    process.exit(0);
  }

  const canonicalDir = await realpath(chatDir);

  // ---- Step 1: List timed-out active chats ----
  const now = nowISO();
  const timedOutFiles: string[] = [];

  let files: string[];
  try {
    files = await readdir(canonicalDir);
  } catch {
    exit('Failed to read chat directory');
  }

  const jsonFiles = files.filter((f) => f.endsWith('.json'));

  for (const fileName of jsonFiles) {
    // Skip lock files that happen to end with .json (unlikely but defensive)
    if (fileName.endsWith('.lock') || fileName.endsWith('.tmp')) continue;

    const filePath = resolve(canonicalDir, fileName);

    // Verify file is within chat directory (path traversal protection)
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

    if (chat.status !== 'active') continue;

    // Check expiry (UTC Z-suffix format only)
    const expires = chat.expiresAt;
    if (expires && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(expires) && expires <= now) {
      timedOutFiles.push(filePath);
    }
  }

  if (timedOutFiles.length === 0) {
    console.log('INFO: No timed-out active chats found');
    process.exit(0);
  }

  console.log(`INFO: Found ${timedOutFiles.length} timed-out active chat(s)`);

  // ---- Step 2: Process each timed-out chat ----
  const stats: RunStats = { checked: 0, expired: 0, dissolved: 0, skipped: 0, errors: 0 };

  for (const filePath of timedOutFiles) {
    if (stats.checked >= maxPerRun) {
      console.log(`INFO: Reached max processing limit (${maxPerRun}), stopping`);
      break;
    }

    stats.checked++;

    // Read current data
    let content: string;
    try {
      content = await readFile(filePath, 'utf-8');
    } catch (err) {
      console.error(`WARN: Failed to read chat file ${filePath}, skipping`);
      stats.errors++;
      continue;
    }

    let chat: ChatFile;
    try {
      chat = parseChatFile(content, filePath);
    } catch (err) {
      console.error(`WARN: Failed to parse chat file ${filePath}, skipping`);
      stats.errors++;
      continue;
    }

    // Acquire exclusive lock (non-blocking)
    // If flock is not available (Node < 20.12), proceed without locking
    let lock: Awaited<ReturnType<typeof acquireLock>> | null = null;
    if (isFlockAvailable()) {
      try {
        lock = await acquireLock(`${filePath}.lock`, 'exclusive', 0);
      } catch {
        console.log(`INFO: Chat ${chat.id} is locked by another process, skipping`);
        stats.skipped++;
        continue;
      }
    }

    try {
      // Re-read under lock to get latest state
      const currentContent = await readFile(filePath, 'utf-8');
      const currentChat = parseChatFile(currentContent, filePath);

      if (currentChat.status !== 'active') {
        console.log(`INFO: Chat ${chat.id} status changed to '${currentChat.status}', skipping`);
        stats.skipped++;
        continue;
      }

      const hasResponse = currentChat.response !== null;
      const hasChatId = currentChat.chatId !== null;

      // Dissolve group if no user response and group exists
      if (!hasResponse && hasChatId) {
        try {
          await execFileAsync(
            'lark-cli',
            ['api', 'DELETE', `/open-apis/im/v1/chats/${currentChat.chatId}`],
            { timeout: LARK_TIMEOUT_MS, maxBuffer: 1024 * 1024 },
          );
          console.log(`OK: Dissolved group ${currentChat.chatId} for chat ${chat.id}`);
          stats.dissolved++;
        } catch (err: unknown) {
          const execErr = err as { stderr?: string; message?: string };
          const errorMsg = (execErr.stderr ?? execErr.message ?? 'unknown error').replace(/\n/g, ' ').trim();
          console.error(`WARN: Failed to dissolve group ${currentChat.chatId} for chat ${chat.id}: ${errorMsg}`);
          // Still mark as expired even if dissolution fails
        }
      } else if (hasResponse) {
        console.log(`INFO: Chat ${chat.id} has user response, skipping group dissolution`);
      } else {
        console.log(`INFO: Chat ${chat.id} has no chatId, skipping group dissolution`);
      }

      // Mark as expired
      const updated = {
        ...currentChat,
        status: 'expired' as const,
        expiredAt: now,
      };
      await atomicWrite(filePath, JSON.stringify(updated, null, 2) + '\n');
      console.log(`OK: Chat ${chat.id} marked as expired`);
      stats.expired++;
    } catch (err) {
      console.error(`WARN: Error processing chat ${chat.id}: ${err}`);
      stats.errors++;
    } finally {
      if (lock) {
        await lock.release();
      }
    }
  }

  // ---- Step 3: Summary ----
  console.log(`INFO: Summary — checked: ${stats.checked}, expired: ${stats.expired}, dissolved: ${stats.dissolved}, skipped: ${stats.skipped}, errors: ${stats.errors}`);
}

main().catch((err) => {
  console.error(`ERROR: ${err instanceof Error ? err.message : err}`);
  process.exit(1);
});
