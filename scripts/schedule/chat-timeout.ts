#!/usr/bin/env tsx
/**
 * schedule/chat-timeout.ts — Detect expired active chats, dissolve groups, and clean up.
 *
 * Reads all active chats from workspace/chats/, checks if expiresAt has passed,
 * dissolves the group via lark-cli (if no user response), and marks as expired.
 * Also cleans up expired chat files past the retention period.
 *
 * Environment variables (optional):
 *   CHAT_MAX_PER_RUN              Max chats to process per execution (default: 10)
 *   CHAT_EXPIRED_RETENTION_HOURS  Hours to retain expired files before cleanup (default: 1)
 *   CHAT_SKIP_LARK_CHECK          Set to '1' to skip lark-cli availability check (for testing)
 *
 * Exit codes:
 *   0 — success (or no expired chats found)
 *   1 — fatal error (missing dependencies)
 */

import { readdir, readFile, writeFile, stat, realpath, rename, unlink } from 'node:fs/promises';
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
} from '../chat/schema.js';
import { acquireLock } from '../chat/lock.js';

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

/**
 * Dismiss a Feishu group via lark-cli.
 * Uses the raw API call: DELETE /open-apis/im/v1/chats/{chatId}
 */
async function dismissGroup(chatId: string): Promise<{ success: boolean; error: string | null }> {
  try {
    await execFileAsync(
      'lark-cli',
      ['api', 'DELETE', `/open-apis/im/v1/chats/${chatId}`],
      { timeout: LARK_TIMEOUT_MS, maxBuffer: 1024 * 1024 },
    );
    return { success: true, error: null };
  } catch (err: unknown) {
    const execErr = err as { stderr?: string; message?: string; code?: number | null };
    const errorMsg = execErr.stderr ?? execErr.message ?? 'unknown error';
    return { success: false, error: errorMsg.replace(/\n/g, ' ').replace(/\s+/g, ' ').trim() };
  }
}

async function main() {
  // ---- Check lark-cli availability (skippable for testing) ----
  if (process.env.CHAT_SKIP_LARK_CHECK !== '1') {
    try {
      await execFileAsync('lark-cli', ['--version'], { timeout: 5000 });
    } catch {
      exit('Missing required dependency: lark-cli not found in PATH');
    }
  }

  // ---- Parse and validate environment variables ----
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

  let retentionHours = 1;
  const retentionEnv = process.env.CHAT_EXPIRED_RETENTION_HOURS;
  if (retentionEnv) {
    const parsed = parseInt(retentionEnv, 10);
    if (!Number.isFinite(parsed) || parsed <= 0) {
      console.error(`WARN: Invalid CHAT_EXPIRED_RETENTION_HOURS='${retentionEnv}', falling back to 1`);
      retentionHours = 1;
    } else {
      retentionHours = parsed;
    }
  }

  // ---- Setup chat directory ----
  const chatDir = resolve(CHAT_DIR);
  try {
    await stat(chatDir);
  } catch {
    console.log('INFO: No chats directory found');
    process.exit(0);
  }

  const canonicalDir = await realpath(chatDir);
  let files: string[];
  try {
    files = await readdir(canonicalDir);
  } catch {
    exit('Failed to read chat directory');
  }

  const jsonFiles = files.filter((f) => f.endsWith('.json'));
  const now = nowISO();
  let processed = 0;

  // ---- Step 1: Find expired active chats ----
  const expiredFiles: string[] = [];
  const cleanupFiles: string[] = [];

  for (const fileName of jsonFiles) {
    const filePath = resolve(canonicalDir, fileName);

    // Verify file is within chat directory
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

    if (chat.status === 'active') {
      // Check if expired
      const expires = chat.expiresAt;
      if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(expires) && expires < now) {
        expiredFiles.push(filePath);
      }
    } else if (chat.status === 'expired') {
      // Check if past retention period for cleanup
      const expiredAt = (chat as Record<string, unknown>).expiredAt as string | undefined;
      if (expiredAt && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(expiredAt)) {
        const retentionCutoff = new Date(Date.now() - retentionHours * 3600 * 1000).toISOString();
        if (expiredAt < retentionCutoff) {
          cleanupFiles.push(filePath);
        }
      } else {
        // No expiredAt field — use expiresAt as fallback (older files)
        const retentionCutoff = new Date(Date.now() - retentionHours * 3600 * 1000).toISOString();
        if (expires < retentionCutoff) {
          cleanupFiles.push(filePath);
        }
      }
    }
  }

  if (expiredFiles.length === 0 && cleanupFiles.length === 0) {
    console.log('INFO: No expired chats found');
    process.exit(0);
  }

  console.log(`INFO: Found ${expiredFiles.length} expired active chat(s), ${cleanupFiles.length} cleanup candidate(s)`);

  // ---- Step 2: Process expired active chats ----
  for (const filePath of expiredFiles) {
    if (processed >= maxPerRun) {
      console.log(`INFO: Reached max processing limit (${maxPerRun}), stopping`);
      break;
    }

    // Read data
    let content: string;
    try {
      content = await readFile(filePath, 'utf-8');
    } catch (err) {
      console.error(`WARN: Failed to read chat data from ${filePath}, skipping`);
      continue;
    }

    let chat: ChatFile;
    try {
      chat = parseChatFile(content, filePath);
    } catch (err) {
      console.error(`WARN: Failed to parse chat data from ${filePath}, skipping`);
      continue;
    }

    const { id: chatId } = chat;
    const hasResponse = chat.response !== null;

    // Acquire exclusive lock
    let lock;
    try {
      lock = await acquireLock(`${filePath}.lock`, 'exclusive', 0);
    } catch {
      console.log(`INFO: Chat ${chatId} is locked by another process, skipping`);
      continue;
    }

    try {
      // Re-read under lock
      const currentContent = await readFile(filePath, 'utf-8');
      const currentChat = parseChatFile(currentContent, filePath);

      if (currentChat.status !== 'active') {
        console.log(`INFO: Chat ${chatId} status changed to '${currentChat.status}', skipping`);
        continue;
      }

      // Double-check expiry under lock
      const expires = currentChat.expiresAt;
      if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(expires) || expires >= now) {
        console.log(`INFO: Chat ${chatId} is no longer expired, skipping`);
        continue;
      }

      // Dissolve group only if no user response
      const currentHasResponse = currentChat.response !== null;
      if (!currentHasResponse && currentChat.chatId) {
        console.log(`INFO: Chat ${chatId} has no response, dissolving group ${currentChat.chatId}`);
        const result = await dismissGroup(currentChat.chatId);
        if (!result.success) {
          console.error(`WARN: Failed to dissolve group ${currentChat.chatId} for chat ${chatId}: ${result.error}`);
          // Continue to mark as expired even if dissolution fails
          // The group may have already been dissolved or the API may be temporarily unavailable
        } else {
          console.log(`OK: Dissolved group ${currentChat.chatId} for chat ${chatId}`);
        }
      } else if (currentHasResponse) {
        console.log(`INFO: Chat ${chatId} has user response, skipping group dissolution`);
      }

      // Update status to expired
      const updated = {
        ...currentChat,
        status: 'expired' as const,
        expiredAt: now,
      };
      await atomicWrite(filePath, JSON.stringify(updated, null, 2) + '\n');
      console.log(`OK: Chat ${chatId} marked as expired`);
      processed++;
    } catch (err) {
      console.error(`WARN: Error processing chat ${chatId}: ${err}`);
    } finally {
      await lock.release();
    }
  }

  // ---- Step 3: Clean up old expired files ----
  let cleanedUp = 0;
  for (const filePath of cleanupFiles) {
    try {
      // Verify file is still expired before deleting
      const content = await readFile(filePath, 'utf-8');
      const chat = parseChatFile(content, filePath);
      if (chat.status !== 'expired') {
        console.log(`INFO: Chat ${chat.id} is no longer expired, skipping cleanup`);
        continue;
      }

      await unlink(filePath);
      console.log(`OK: Cleaned up expired chat file: ${filePath}`);
      cleanedUp++;
    } catch (err) {
      console.error(`WARN: Failed to clean up ${filePath}: ${err}`);
    }
  }

  console.log(`INFO: Processed ${processed} expired chat(s), cleaned up ${cleanedUp} file(s)`);
}

main().catch((err) => {
  console.error(`ERROR: ${err instanceof Error ? err.message : err}`);
  process.exit(1);
});
