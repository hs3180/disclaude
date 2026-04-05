#!/usr/bin/env tsx
/**
 * chat-timeout/timeout.ts — Detect timed-out active chats and dissolve their groups.
 *
 * Scans workspace/chats/ for active chats where now >= expiresAt,
 * dissolves the group via lark-cli (if no user response), and marks
 * the chat as expired.
 *
 * Environment variables (optional):
 *   CHAT_MAX_PER_RUN  Max chats to process per execution (default: 10)
 *   CHAT_DRY_RUN      If "true", report actions without executing (default: false)
 *   LARK_TIMEOUT_MS   Timeout for lark-cli calls in ms (default: 30000)
 *
 * Exit codes:
 *   0 — success (or no timed-out chats found)
 *   1 — fatal error (missing dependencies)
 */

import { readdir, readFile, stat, rename, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import {
  parseChatFile,
  nowISO,
  CHAT_DIR,
  UTC_DATETIME_REGEX,
  DEFAULT_MAX_PER_RUN,
  LARK_TIMEOUT_MS,
  ValidationError,
  type ChatFile,
} from '../chat/schema.js';
import { withExclusiveLock, isFlockAvailable } from '../chat/lock.js';

const execFileAsync = promisify(execFile);

// ---- Config ----
const maxPerRun = parsePositiveInt(process.env.CHAT_MAX_PER_RUN, DEFAULT_MAX_PER_RUN);
const dryRun = process.env.CHAT_DRY_RUN === 'true';
const larkTimeoutMs = parsePositiveInt(process.env.LARK_TIMEOUT_MS, LARK_TIMEOUT_MS);

// ---- Counters ----
let processed = 0;
let dissolved = 0;
let skippedHasResponse = 0;
let errors = 0;

function parsePositiveInt(value: string | undefined, defaultValue: number): number {
  if (!value) return defaultValue;
  const n = parseInt(value, 10);
  if (isNaN(n) || n <= 0) return defaultValue;
  return n;
}

function exit(msg: string): never {
  console.error(`FATAL: ${msg}`);
  process.exit(1);
}

/** Atomically update a chat file with a jq-like transform */
async function atomicWrite(chatFile: string, updated: ChatFile): Promise<void> {
  const tmpFile = `${chatFile}.${Date.now()}.tmp`;
  await writeFile(tmpFile, JSON.stringify(updated, null, 2) + '\n', 'utf-8');
  await rename(tmpFile, chatFile);
}

/** Dissolve a group via lark-cli */
async function dissolveGroup(chatId: string): Promise<{ success: boolean; error?: string }> {
  try {
    await execFileAsync(
      'lark-cli',
      ['api', 'DELETE', `/open-apis/im/v1/chats/${chatId}`],
      { timeout: larkTimeoutMs },
    );
    return { success: true };
  } catch (err: unknown) {
    const execErr = err as { code?: string; message?: string; stderr?: string };
    if (execErr.code === 'ETIMEDOUT' || execErr.killed) {
      return { success: false, error: `lark-cli timed out after ${larkTimeoutMs}ms` };
    }
    return { success: false, error: execErr.stderr?.trim() || execErr.message || String(err) };
  }
}

async function main() {
  // ---- Step 0: Environment check ----
  if (!dryRun) {
    try {
      await execFileAsync('which', ['lark-cli'], { timeout: 5000 });
    } catch {
      exit('lark-cli not found. Install with: npm install -g @larksuite/cli');
    }
  } else {
    console.warn('WARN: DRY RUN mode — lark-cli check skipped');
  }

  const chatDir = resolve(CHAT_DIR);

  // Ensure directory exists
  try {
    await stat(chatDir);
  } catch {
    console.log('INFO: Chat directory does not exist, nothing to process');
    process.exit(0);
  }

  if (dryRun) {
    console.log('INFO: DRY RUN mode — no changes will be made');
  }

  if (!isFlockAvailable()) {
    console.warn('WARN: fs.flock not available, concurrency safety is disabled');
  }

  const now = nowISO();
  console.log(`INFO: Starting timeout check at ${now} (max ${maxPerRun} chats)`);

  // ---- Step 1: Scan for active chats ----
  let files: string[];
  try {
    const entries = await readdir(chatDir);
    files = entries
      .filter((e) => e.endsWith('.json') && !e.endsWith('.lock'))
      .map((e) => join(chatDir, e));
  } catch {
    console.log('INFO: No chat files found');
    process.exit(0);
  }

  // ---- Step 2: Process each active chat ----
  for (const filePath of files) {
    if (processed >= maxPerRun) {
      console.log(`INFO: Reached max processing limit (${maxPerRun}), stopping`);
      break;
    }

    // Read and validate file
    let content: string;
    let chat: ChatFile;
    let rawData: Record<string, unknown>;
    try {
      content = await readFile(filePath, 'utf-8');
      rawData = JSON.parse(content);
      chat = parseChatFile(content, filePath);
    } catch (err) {
      console.warn(`WARN: Skipping corrupted file ${filePath}: ${err instanceof Error ? err.message : err}`);
      continue;
    }

    // Only process active chats
    if (chat.status !== 'active') {
      continue;
    }

    // Check expiry (only UTC Z-suffix format for reliable comparison)
    if (!UTC_DATETIME_REGEX.test(chat.expiresAt)) {
      console.warn(`WARN: Chat ${chat.id} has non-UTC expiresAt '${chat.expiresAt}', skipping`);
      continue;
    }

    if (chat.expiresAt >= now) {
      continue; // Not expired yet
    }

    processed++;
    const expiredAgo = timeSince(chat.expiresAt, now);
    console.log(`INFO: Chat ${chat.id} expired ${expiredAgo} ago (expiresAt: ${chat.expiresAt})`);

    // Check if user has responded
    if (chat.response) {
      console.log(`INFO: Chat ${chat.id} has user response, marking expired without dissolving group`);
      skippedHasResponse++;
    } else if (chat.chatId) {
      // Dissolve the group
      if (dryRun) {
        console.log(`DRY RUN: Would dissolve group ${chat.chatId} for chat ${chat.id}`);
        dissolved++;
      } else {
        const result = await dissolveGroup(chat.chatId);
        if (result.success) {
          console.log(`OK: Dissolved group ${chat.chatId} for chat ${chat.id}`);
          dissolved++;
        } else {
          console.warn(`WARN: Failed to dissolve group ${chat.chatId} for chat ${chat.id}: ${result.error}`);
          // Still mark as expired — group may already be deleted or inaccessible
          errors++;
        }
      }
    } else {
      console.log(`INFO: Chat ${chat.id} has no chatId, marking expired without dissolving`);
    }

    // Update status to expired (under lock)
    if (dryRun) {
      console.log(`DRY RUN: Would mark chat ${chat.id} as expired`);
    } else {
      const lockPath = `${filePath}.lock`;
      try {
        await withExclusiveLock(lockPath, async () => {
          // Re-read under lock
          const currentContent = await readFile(filePath, 'utf-8');
          const currentChat = parseChatFile(currentContent, filePath);

          // Double-check status under lock
          if (currentChat.status !== 'active') {
            console.log(`INFO: Chat ${chat.id} status changed to '${currentChat.status}', skipping`);
            return;
          }

          const updated: Record<string, unknown> = {
            ...currentChat,
            status: 'expired',
            expiredAt: nowISO(),
          };
          await atomicWrite(filePath, updated);
          console.log(`OK: Chat ${chat.id} marked as expired`);
        });
      } catch (err) {
        console.error(`ERROR: Failed to update chat ${chat.id}: ${err instanceof Error ? err.message : err}`);
        errors++;
      }
    }
  }

  // ---- Step 3: Summary ----
  console.log('---');
  console.log(`INFO: Timeout check complete`);
  console.log(`  Processed: ${processed}`);
  console.log(`  Groups dissolved: ${dissolved}`);
  console.log(`  Skipped (has response): ${skippedHasResponse}`);
  console.log(`  Errors: ${errors}`);
}

/** Calculate human-readable time difference between two ISO timestamps */
function timeSince(earlier: string, later: string): string {
  const diffMs = new Date(later).getTime() - new Date(earlier).getTime();
  const diffMin = Math.floor(diffMs / 60000);
  if (diffMin < 60) return `${diffMin}m`;
  const diffHr = Math.floor(diffMin / 60);
  if (diffHr < 24) return `${diffHr}h ${diffMin % 60}m`;
  const diffDay = Math.floor(diffHr / 24);
  return `${diffDay}d ${diffHr % 24}h`;
}

main().catch((err) => {
  console.error(`ERROR: ${err instanceof Error ? err.message : err}`);
  process.exit(1);
});
