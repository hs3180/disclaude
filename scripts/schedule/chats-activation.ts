#!/usr/bin/env tsx
/**
 * schedule/chats-activation.ts — Auto-activate pending chats via lark-cli.
 *
 * Reads all pending chats from workspace/chats/, creates groups via lark-cli,
 * updates status to active. Marks expired or failed chats appropriately.
 *
 * Environment variables (optional):
 *   CHAT_MAX_PER_RUN  Max chats to process per execution (default: 10)
 *
 * Exit codes:
 *   0 — success (or no pending chats found)
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
  MAX_RETRIES,
  DEFAULT_MAX_PER_RUN,
  LARK_TIMEOUT_MS,
  GROUP_NAME_REGEX,
  MEMBER_ID_REGEX,
  MAX_GROUP_NAME_LENGTH,
  truncateGroupName,
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

  let processed = 0;

  // ---- Setup chat directory ----
  const chatDir = resolve(CHAT_DIR);
  try {
    await stat(chatDir);
  } catch {
    console.log('INFO: No pending chats found');
    process.exit(0);
  }

  const canonicalDir = await realpath(chatDir);

  // ---- Step 1: List pending chats (skip expired) ----
  const now = nowISO();
  const pendingFiles: string[] = [];

  let files: string[];
  try {
    files = await readdir(canonicalDir);
  } catch {
    exit('Failed to read chat directory');
  }

  const jsonFiles = files.filter((f) => f.endsWith('.json'));

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

    if (chat.status !== 'pending') continue;

    // Expiry pre-check
    const expires = chat.expiresAt;
    if (expires && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(expires) && expires < now) {
      console.log(`INFO: Chat ${chat.id} expired at ${expires} (skipping activation)`);

      // Mark as expired under lock
      const lock = await acquireLock(`${filePath}.lock`, 'exclusive', 0);
      try {
        const currentContent = await readFile(filePath, 'utf-8');
        const currentChat = parseChatFile(currentContent, filePath);
        if (currentChat.status === 'pending') {
          const updated = { ...currentChat, status: 'expired' as const, expiredAt: now };
          await atomicWrite(filePath, JSON.stringify(updated, null, 2) + '\n');
        } else {
          console.log(`INFO: Chat ${chat.id} status changed to '${currentChat.status}', skipping expiration mark`);
        }
      } catch (err) {
        console.error(`WARN: Failed to mark chat ${chat.id} as expired: ${err}`);
      } finally {
        await lock.release();
      }
      continue;
    }

    pendingFiles.push(filePath);
  }

  if (pendingFiles.length === 0) {
    console.log('INFO: No pending chats found');
    process.exit(0);
  }

  console.log(`INFO: Found ${pendingFiles.length} pending chat(s)`);

  // ---- Step 2: Activate pending chats ----
  for (const filePath of pendingFiles) {
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
    const groupName = chat.createGroup.name;
    const members = chat.createGroup.members;
    const attempts = chat.activationAttempts ?? 0;

    // Input validation
    if (!GROUP_NAME_REGEX.test(groupName)) {
      console.error(`ERROR: Invalid group name '${groupName}' for chat ${chatId} — contains unsafe characters, skipping`);
      continue;
    }
    const truncatedName = truncateGroupName(groupName);

    if (members.length === 0) {
      console.error(`ERROR: No members found for chat ${chatId}, skipping`);
      continue;
    }
    const skipChat = members.some((m) => !MEMBER_ID_REGEX.test(m));
    if (skipChat) {
      const invalidMember = members.find((m) => !MEMBER_ID_REGEX.test(m));
      console.error(`ERROR: Invalid member ID '${invalidMember}' for chat ${chatId} — expected ou_xxxxx format, skipping`);
      continue;
    }

    // Acquire exclusive lock
    const lock = await acquireLock(`${filePath}.lock`, 'exclusive', 0);
    try {
      // Re-read under lock
      const currentContent = await readFile(filePath, 'utf-8');
      const currentChat = parseChatFile(currentContent, filePath);

      if (currentChat.status !== 'pending') {
        console.log(`INFO: Chat ${chatId} status changed to '${currentChat.status}', skipping`);
        continue;
      }

      // Idempotent recovery: if chatId already exists, recover to active
      if (currentChat.chatId) {
        console.log(`INFO: Chat ${chatId} already has chatId=${currentChat.chatId}, recovering to active`);
        const recovered = { ...currentChat, status: 'active' as const, activatedAt: now };
        await atomicWrite(filePath, JSON.stringify(recovered, null, 2) + '\n');
        processed++;
        continue;
      }

      // Create group via lark-cli
      const membersStr = members.join(',');
      let larkResult: string;
      let larkError: string | null = null;
      let exitCode: number | null = null;

      try {
        const result = await execFileAsync(
          'lark-cli',
          ['im', '+chat-create', '--name', truncatedName, '--users', membersStr],
          { timeout: LARK_TIMEOUT_MS, maxBuffer: 1024 * 1024 },
        );
        larkResult = result.stdout;
      } catch (err: unknown) {
        const execErr = err as { stdout?: string; stderr?: string; code?: number | null; message?: string };
        larkResult = execErr.stdout ?? '';
        larkError = execErr.stderr ?? execErr.message ?? '';
        exitCode = execErr.code ?? null;
      }

      // Parse result
      let newChatId: string | null = null;
      try {
        const parsed = JSON.parse(larkResult);
        newChatId = parsed?.data?.chat_id ?? null;
      } catch {
        // Not valid JSON, treat as failure
      }

      const newAttempts = attempts + 1;

      if (newChatId) {
        // Success — update to active
        const updated = {
          ...currentChat,
          status: 'active' as const,
          chatId: newChatId,
          activatedAt: now,
          activationAttempts: 0,
          lastActivationError: null,
        };
        await atomicWrite(filePath, JSON.stringify(updated, null, 2) + '\n');
        console.log(`OK: Chat ${chatId} activated (chatId=${newChatId})`);
      } else {
        // Failure — record error and check retry limit
        const errorMsg = (larkError ?? larkResult ?? 'unknown error').replace(/\n/g, ' ').replace(/\s+/g, ' ').trim();
        console.error(`ERROR: Failed to create group for chat ${chatId} (attempt ${newAttempts}/${MAX_RETRIES})`);
        console.error(`  ${errorMsg}`);

        if (newAttempts >= MAX_RETRIES) {
          console.error(`WARN: Chat ${chatId} reached max retries (${MAX_RETRIES}), marking as failed`);
          const failed = {
            ...currentChat,
            status: 'failed' as const,
            activationAttempts: newAttempts,
            lastActivationError: errorMsg,
            failedAt: now,
          };
          await atomicWrite(filePath, JSON.stringify(failed, null, 2) + '\n');
          console.error(`WARN: Chat '${chatId}' activation failed after ${MAX_RETRIES} retries: ${errorMsg}`);
        } else {
          const retried = {
            ...currentChat,
            activationAttempts: newAttempts,
            lastActivationError: errorMsg,
          };
          await atomicWrite(filePath, JSON.stringify(retried, null, 2) + '\n');
        }
      }

      processed++;
    } catch (err) {
      console.error(`WARN: Error processing chat ${chatId}: ${err}`);
    } finally {
      await lock.release();
    }
  }

  console.log(`INFO: Processed ${processed} chat(s) in this run`);
}

main().catch((err) => {
  console.error(`ERROR: ${err instanceof Error ? err.message : err}`);
  process.exit(1);
});
