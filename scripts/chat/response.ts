#!/usr/bin/env tsx
/**
 * chat/response.ts — Record a user response to an active chat.
 *
 * Environment variables:
 *   CHAT_ID         (required) Unique chat identifier
 *   CHAT_RESPONSE   (required) User's response text
 *   CHAT_RESPONDER  (required) Responder's open ID (ou_xxxxx)
 *
 * Exit codes:
 *   0 — success
 *   1 — validation error or write failure
 */

import { readFile, writeFile, stat, rename } from 'node:fs/promises';
import { resolve } from 'node:path';
import {
  validateChatId,
  validateResponder,
  validateResponseContent,
  parseChatFile,
  nowISO,
  CHAT_DIR,
  ValidationError,
  type ChatFile,
} from './schema.js';
import { withExclusiveLock } from './lock.js';

function exit(msg: string): never {
  console.error(`ERROR: ${msg}`);
  process.exit(1);
}

async function main() {
  // ---- Validate inputs ----
  const chatId = process.env.CHAT_ID;
  try {
    validateChatId(chatId ?? '');
  } catch (err) {
    exit(err instanceof ValidationError ? err.message : String(err));
  }

  const responseText = process.env.CHAT_RESPONSE;
  try {
    validateResponseContent(responseText ?? '');
  } catch (err) {
    exit(err instanceof ValidationError ? err.message : String(err));
  }

  const responder = process.env.CHAT_RESPONDER;
  try {
    validateResponder(responder ?? '');
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

  // Validate file and check status
  let chat: ChatFile;
  try {
    const content = await readFile(chatFile, 'utf-8');
    chat = parseChatFile(content, chatFile);
  } catch (err) {
    exit(err instanceof ValidationError ? err.message : `Invalid chat file: ${err}`);
  }

  if (chat.status !== 'active') {
    exit(`Chat ${chatId} is '${chat.status}', cannot update (expected 'active')`);
  }

  // Check idempotency (reject duplicate responses)
  if (chat.response) {
    exit(
      `Chat ${chatId} already has a response from ${chat.response.responder} at ${chat.response.repliedAt} — refusing to overwrite`,
    );
  }

  // ---- Acquire exclusive lock and write response ----
  const lockPath = `${chatFile}.lock`;
  await withExclusiveLock(lockPath, async () => {
    // Re-read under lock (another process may have changed status or written a response)
    const content = await readFile(chatFile, 'utf-8');
    const currentChat = parseChatFile(content, chatFile);

    if (currentChat.status !== 'active') {
      exit(`Chat ${chatId} status changed to '${currentChat.status}' while waiting for lock`);
    }

    if (currentChat.response) {
      exit(`Chat ${chatId} already has a response — refusing to overwrite`);
    }

    // Write response atomically
    const updatedChat: ChatFile = {
      ...currentChat,
      response: {
        content: responseText!,
        responder: responder!,
        repliedAt: nowISO(),
      },
    };

    const tmpFile = `${chatFile}.${Date.now()}.tmp`;
    await writeFile(tmpFile, JSON.stringify(updatedChat, null, 2) + '\n', 'utf-8');
    await rename(tmpFile, chatFile);
  });

  console.log(`OK: Response recorded for chat ${chatId}`);
}

main().catch((err) => {
  console.error(`ERROR: ${err instanceof Error ? err.message : err}`);
  process.exit(1);
});
