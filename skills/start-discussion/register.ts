#!/usr/bin/env tsx
/**
 * skills/start-discussion/register.ts — Register an already-created discussion
 * group in the chat lifecycle system.
 *
 * Unlike `chat/create.ts` which creates a pending chat (waiting for
 * `chats-activation` to create the group), this script registers a chat
 * that was created directly via `lark-cli` — placing it in `active` state
 * immediately so that `chat-timeout` can manage its lifecycle.
 *
 * Environment variables:
 *   CHAT_ID           (required) Unique chat identifier (e.g. "discussion-1681726800")
 *   CHAT_FEISHU_ID    (required) Feishu group chat ID from lark-cli (e.g. "oc_xxxxx")
 *   CHAT_EXPIRES_AT   (required) ISO 8601 Z-suffix expiry timestamp
 *   CHAT_GROUP_NAME   (required) Group display name
 *   CHAT_MEMBERS      (required) JSON array of member open IDs (e.g. '["ou_xxx"]')
 *   CHAT_CONTEXT      (optional) JSON object for consumer use (default: '{}')
 *   CHAT_TRIGGER_MODE (optional) 'mention' or 'always' (default: 'always')
 *
 * Exit codes:
 *   0 — success
 *   1 — validation error or write failure
 */

import { mkdir, writeFile, stat, rename } from 'node:fs/promises';
import { resolve } from 'node:path';
import {
  validateChatId,
  validateExpiresAt,
  validateGroupName,
  validateMembers,
  validateContext,
  truncateGroupName,
  nowISO,
  CHAT_DIR,
  ValidationError,
  type ChatFile,
} from '../chat/schema.js';
import { withExclusiveLock } from '../chat/lock.js';

function exit(msg: string): never {
  console.error(`ERROR: ${msg}`);
  process.exit(1);
}

/**
 * Validate a Feishu group chat ID (oc_ prefix followed by hex chars).
 */
function validateFeishuChatId(id: string): void {
  if (!id) {
    throw new ValidationError('CHAT_FEISHU_ID environment variable is required');
  }
  if (!/^oc_[a-zA-Z0-9]+$/.test(id)) {
    throw new ValidationError(
      `Invalid Feishu chat ID '${id}' — expected oc_xxxxx format`,
    );
  }
}

async function main() {
  // ---- Step 1: Validate chat ID ----
  const chatId = process.env.CHAT_ID;
  try {
    validateChatId(chatId ?? '');
  } catch (err) {
    exit(err instanceof ValidationError ? err.message : String(err));
  }

  // ---- Step 2: Validate Feishu chat ID ----
  const feishuId = process.env.CHAT_FEISHU_ID;
  try {
    validateFeishuChatId(feishuId ?? '');
  } catch (err) {
    exit(err instanceof ValidationError ? err.message : String(err));
  }

  // ---- Step 3: Validate trigger mode ----
  const triggerModeRaw = process.env.CHAT_TRIGGER_MODE ?? 'always';
  let triggerMode: 'mention' | 'always';
  if (triggerModeRaw === 'mention' || triggerModeRaw === 'always') {
    triggerMode = triggerModeRaw;
  } else {
    exit(`CHAT_TRIGGER_MODE must be 'mention' or 'always', got '${triggerModeRaw}'`);
  }

  // ---- Step 4: Validate required fields ----
  const expiresAt = process.env.CHAT_EXPIRES_AT;
  try {
    validateExpiresAt(expiresAt ?? '');
  } catch (err) {
    exit(err instanceof ValidationError ? err.message : String(err));
  }

  const groupName = process.env.CHAT_GROUP_NAME;
  try {
    validateGroupName(groupName ?? '');
  } catch (err) {
    exit(err instanceof ValidationError ? err.message : String(err));
  }

  const membersRaw = process.env.CHAT_MEMBERS;
  let members: string[];
  try {
    const parsed = membersRaw ? JSON.parse(membersRaw) : undefined;
    members = validateMembers(parsed);
  } catch (err) {
    if (err instanceof ValidationError) {
      exit(err.message);
    }
    exit(`CHAT_MEMBERS must be valid JSON: ${membersRaw}`);
  }

  const contextRaw = process.env.CHAT_CONTEXT;
  let context: Record<string, unknown>;
  try {
    const parsed = contextRaw ? JSON.parse(contextRaw) : undefined;
    context = validateContext(parsed);
  } catch (err) {
    if (err instanceof ValidationError) {
      exit(err.message);
    }
    exit(`CHAT_CONTEXT must be valid JSON: ${contextRaw}`);
  }

  const truncatedName = truncateGroupName(groupName!);
  const now = nowISO();

  // ---- Step 5: Setup directory and resolve path ----
  const chatDir = resolve(CHAT_DIR);
  await mkdir(chatDir, { recursive: true });

  const chatFile = resolve(chatDir, `${chatId}.json`);

  // Path traversal protection
  if (!chatFile.startsWith(chatDir + '/')) {
    exit(`Path traversal detected for chat ID '${chatId}'`);
  }

  // ---- Step 6: Check uniqueness under lock ----
  const lockPath = `${chatFile}.lock`;
  await withExclusiveLock(lockPath, async () => {
    // Double-check file doesn't exist
    try {
      await stat(chatFile);
      throw new ValidationError(`Chat ${chatId} already exists`);
    } catch (err: unknown) {
      if (err instanceof ValidationError) throw err;
      const nodeErr = err as { code?: string };
      if (nodeErr.code !== 'ENOENT') {
        throw new Error(`Failed to check chat file: ${err}`);
      }
    }

    // ---- Step 7: Write chat file (active state) ----
    const chatData: ChatFile = {
      id: chatId!,
      status: 'active',
      chatId: feishuId!,
      createdAt: now,
      activatedAt: now,
      expiresAt: expiresAt!,
      expiredAt: null,
      createGroup: {
        name: truncatedName,
        members,
      },
      context,
      triggerMode,
      response: null,
      activationAttempts: 0,
      lastActivationError: null,
      failedAt: null,
    };

    // Atomic write: write to temp file then rename
    const tmpFile = `${chatFile}.${Date.now()}.tmp`;
    await writeFile(tmpFile, JSON.stringify(chatData, null, 2) + '\n', 'utf-8');
    await rename(tmpFile, chatFile);
  });

  console.log(`OK: Discussion ${chatId} registered (active, chatId=${feishuId})`);
}

main().catch((err) => {
  console.error(`ERROR: ${err instanceof Error ? err.message : err}`);
  process.exit(1);
});
