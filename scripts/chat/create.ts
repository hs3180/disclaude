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
 *
 * Exit codes:
 *   0 — success
 *   1 — validation error or write failure
 */

import { mkdir, writeFile, stat, rename } from 'node:fs/promises';
import { resolve, join, dirname } from 'node:path';
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

  // ---- Step 2: Validate required fields ----
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

  // ---- Step 3: Setup directory and resolve path ----
  const chatDir = resolve(CHAT_DIR);
  await mkdir(chatDir, { recursive: true });

  const chatFile = resolve(chatDir, `${chatId}.json`);

  // Path traversal protection
  if (!chatFile.startsWith(chatDir + '/')) {
    exit(`Path traversal detected for chat ID '${chatId}'`);
  }

  // ---- Step 4: Check uniqueness under lock ----
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

    // ---- Step 5: Write chat file ----
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

  // ---- Step 6: Trigger chats-activation schedule (Issue #1953) ----
  // Write a signal file to trigger immediate activation instead of waiting for next cron
  const schedulesDir = resolve(dirname(chatDir), 'schedules');
  const triggersDir = join(schedulesDir, '.triggers');
  const triggerFile = join(triggersDir, 'schedule-chats-activation');
  try {
    await mkdir(triggersDir, { recursive: true });
    await writeFile(triggerFile, new Date().toISOString(), 'utf-8');
    console.log(`OK: Trigger signal written for chats-activation`);
  } catch (err) {
    // Trigger write failure is non-fatal — cron will pick it up eventually
    console.error(`WARN: Failed to write trigger signal (non-fatal): ${err instanceof Error ? err.message : err}`);
  }
}

main().catch((err) => {
  console.error(`ERROR: ${err instanceof Error ? err.message : err}`);
  process.exit(1);
});
