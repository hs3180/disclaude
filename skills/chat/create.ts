#!/usr/bin/env tsx
/**
 * chat/create.ts — Create a pending chat file.
 *
 * Environment variables:
 *   CHAT_ID         (required) Unique chat identifier (e.g. "pr-123")
 *   CHAT_EXPIRES_AT (required) ISO 8601 Z-suffix expiry timestamp
 *   CHAT_GROUP_NAME (required) Group display name
 *   CHAT_MEMBERS    (required) JSON array of member open IDs (e.g. '["ou_xxx","ou_yyy"]')
 *   CHAT_CONTEXT    (optional) JSON object for consumer use (default: '{}')
 *   CHAT_TRIGGER_MODE (optional) 'mention' or 'always' (no default — auto-set at activation)
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
} from './schema.js';
import { withExclusiveLock } from './lock.js';

function exit(msg: string): never {
  console.error(`ERROR: ${msg}`);
  process.exit(1);
}

async function main() {
  // ---- Step 1: Validate chat ID ----
  const chatId = process.env.CHAT_ID;
  try {
    validateChatId(chatId ?? '');
  } catch (err) {
    exit(err instanceof ValidationError ? err.message : String(err));
  }

  // ---- Step 2: Validate optional triggerMode field ----
  const triggerModeRaw = process.env.CHAT_TRIGGER_MODE;
  let triggerMode: 'mention' | 'always' | undefined;
  if (triggerModeRaw !== undefined) {
    if (triggerModeRaw === 'mention' || triggerModeRaw === 'always') {
      triggerMode = triggerModeRaw;
    } else {
      exit(`CHAT_TRIGGER_MODE must be 'mention' or 'always', got '${triggerModeRaw}'`);
    }
  }

  // ---- Step 3: Validate required fields ----
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

  // ---- Step 4: Setup directory and resolve path ----
  const chatDir = resolve(CHAT_DIR);
  await mkdir(chatDir, { recursive: true });

  const chatFile = resolve(chatDir, `${chatId}.json`);

  // Path traversal protection
  if (!chatFile.startsWith(chatDir + '/')) {
    exit(`Path traversal detected for chat ID '${chatId}'`);
  }

  // ---- Step 5: Check uniqueness under lock ----
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

    // ---- Step 6: Write chat file ----
    const chatData: ChatFile = {
      id: chatId!,
      status: 'pending',
      chatId: null,
      createdAt: nowISO(),
      activatedAt: null,
      expiresAt: expiresAt!,
      expiredAt: null,
      createGroup: {
        name: truncatedName,
        members,
      },
      context,
      // Issue #2018: Only set triggerMode when explicitly provided via env.
      // Auto-setting based on member count is handled at a higher level.
      ...(triggerMode !== undefined ? { triggerMode } : {}),
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

  console.log(`OK: Chat ${chatId} created successfully`);
}

main().catch((err) => {
  console.error(`ERROR: ${err instanceof Error ? err.message : err}`);
  process.exit(1);
});
