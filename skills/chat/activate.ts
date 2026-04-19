#!/usr/bin/env tsx
/**
 * chat/activate.ts — Activate a pending chat immediately with a known chatId.
 *
 * Used by the start-discussion Skill to bypass the chats-activation schedule
 * when the group has been created directly via lark-cli.
 *
 * Environment variables:
 *   CHAT_ID     (required) Unique chat identifier (e.g. "pr-123")
 *   CHAT_CHAT_ID (required) Feishu group chat ID (e.g. "oc_xxx")
 *
 * Exit codes:
 *   0 — success
 *   1 — validation error or write failure
 */

import { readFile, rename, stat, writeFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import {
  validateChatId,
  nowISO,
  CHAT_DIR,
  parseChatFile,
  ValidationError,
  type ChatFile,
} from './schema.js';
import { withExclusiveLock } from './lock.js';

const CHAT_ID_FEISHU_REGEX = /^oc_[a-zA-Z0-9]+$/;

function exit(msg: string): never {
  console.error(`ERROR: ${msg}`);
  process.exit(1);
}

async function main() {
  // ---- Step 1: Validate inputs ----
  const chatId = process.env.CHAT_ID;
  try {
    validateChatId(chatId ?? '');
  } catch (err) {
    exit(err instanceof ValidationError ? err.message : String(err));
  }

  const chatChatId = process.env.CHAT_CHAT_ID;
  if (!chatChatId) {
    exit('CHAT_CHAT_ID environment variable is required');
  }
  if (!CHAT_ID_FEISHU_REGEX.test(chatChatId)) {
    exit(`Invalid Feishu chat ID '${chatChatId}' — expected oc_xxxxx format`);
  }

  // ---- Step 2: Resolve file path ----
  const chatDir = resolve(CHAT_DIR);
  const chatFile = resolve(chatDir, `${chatId}.json`);

  // Path traversal protection
  if (!chatFile.startsWith(chatDir + '/')) {
    exit(`Path traversal detected for chat ID '${chatId}'`);
  }

  // ---- Step 3: Read and validate under lock ----
  const lockPath = `${chatFile}.lock`;
  await withExclusiveLock(lockPath, async () => {
    // Check file exists
    try {
      await stat(chatFile);
    } catch {
      exit(`Chat '${chatId}' not found`);
    }

    // Read current state
    let content: string;
    try {
      content = await readFile(chatFile, 'utf-8');
    } catch {
      exit(`Failed to read chat file for '${chatId}'`);
    }

    let chat: ChatFile;
    try {
      chat = parseChatFile(content, chatFile);
    } catch (err) {
      exit(`Corrupted chat file for '${chatId}': ${err instanceof Error ? err.message : err}`);
    }

    // Validate state transition
    if (chat.status === 'active' && chat.chatId === chatChatId) {
      // Idempotent — already active with the same chatId
      console.log(`OK: Chat ${chatId} already active (chatId=${chatChatId})`);
      return;
    }

    if (chat.status !== 'pending' && chat.status !== 'active') {
      exit(`Chat '${chatId}' is '${chat.status}', cannot activate (expected 'pending' or 'active')`);
    }

    // ---- Step 4: Update to active ----
    const now = nowISO();
    const updated: ChatFile = {
      ...chat,
      status: 'active',
      chatId: chatChatId,
      activatedAt: chat.activatedAt ?? now,
      activationAttempts: 0,
      lastActivationError: null,
      failedAt: null,
    };

    // Atomic write
    const tmpFile = `${chatFile}.${Date.now()}.tmp`;
    await writeFile(tmpFile, JSON.stringify(updated, null, 2) + '\n', 'utf-8');
    await rename(tmpFile, chatFile);

    console.log(`OK: Chat ${chatId} activated (chatId=${chatChatId})`);
  });
}

main().catch((err) => {
  console.error(`ERROR: ${err instanceof Error ? err.message : err}`);
  process.exit(1);
});
