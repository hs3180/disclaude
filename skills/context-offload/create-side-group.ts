#!/usr/bin/env tsx
/**
 * context-offload/create-side-group.ts — Create a side group for long-form content delivery.
 *
 * Creates a pending chat file in workspace/chats/ that the chats-activation
 * schedule will automatically activate (create group via lark-cli).
 *
 * Environment variables:
 *   OFFLOAD_PARENT_CHAT_ID (required) Originating chat ID (oc_xxx)
 *   OFFLOAD_NAME           (required) Display name for the side group
 *   OFFLOAD_MEMBERS        (required) JSON array of member open IDs
 *   OFFLOAD_CONTENT_SUMMARY(optional) Brief summary of content
 *   OFFLOAD_EXPIRES_HOURS  (optional) Hours until expiry (default: 48)
 *
 * Exit codes:
 *   0 — success
 *   1 — validation error or write failure
 *
 * Issue #2351: Context Offloading feature.
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
 * Generate a unique chat ID for context offloading.
 * Format: offload-{timestamp}-{random}
 */
function generateOffloadChatId(): string {
  const timestamp = Date.now();
  const random = Math.random().toString(36).slice(2, 8);
  return `offload-${timestamp}-${random}`;
}

/**
 * Calculate expiry timestamp from now + hours.
 */
function calculateExpiry(hours: number): string {
  const expiry = new Date(Date.now() + hours * 60 * 60 * 1000);
  return expiry.toISOString().replace(/\.\d{3}Z$/, 'Z');
}

async function main() {
  // ---- Step 1: Validate parent chat ID ----
  const parentChatId = process.env.OFFLOAD_PARENT_CHAT_ID;
  if (!parentChatId) {
    exit('OFFLOAD_PARENT_CHAT_ID environment variable is required');
  }

  // ---- Step 2: Validate group name ----
  const groupName = process.env.OFFLOAD_NAME;
  if (!groupName) {
    exit('OFFLOAD_NAME environment variable is required');
  }
  try {
    validateGroupName(groupName);
  } catch (err) {
    exit(err instanceof ValidationError ? err.message : String(err));
  }

  // ---- Step 3: Validate members ----
  const membersRaw = process.env.OFFLOAD_MEMBERS;
  let members: string[];
  try {
    const parsed = membersRaw ? JSON.parse(membersRaw) : undefined;
    members = validateMembers(parsed);
  } catch (err) {
    if (err instanceof ValidationError) {
      exit(err.message);
    }
    exit(`OFFLOAD_MEMBERS must be valid JSON: ${membersRaw}`);
  }

  // ---- Step 4: Parse optional fields ----
  const contentSummary = process.env.OFFLOAD_CONTENT_SUMMARY ?? '';

  let expiresHours = 48;
  const expiresHoursRaw = process.env.OFFLOAD_EXPIRES_HOURS;
  if (expiresHoursRaw) {
    const parsed = parseInt(expiresHoursRaw, 10);
    if (!Number.isFinite(parsed) || parsed <= 0 || parsed > 720) {
      exit(`OFFLOAD_EXPIRES_HOURS must be between 1 and 720, got '${expiresHoursRaw}'`);
    }
    expiresHours = parsed;
  }

  // ---- Step 5: Generate chat ID and calculate expiry ----
  const chatId = generateOffloadChatId();
  const truncatedName = truncateGroupName(groupName);
  const expiresAt = calculateExpiry(expiresHours);

  // ---- Step 6: Setup directory and resolve path ----
  const chatDir = resolve(CHAT_DIR);
  await mkdir(chatDir, { recursive: true });

  const chatFile = resolve(chatDir, `${chatId}.json`);

  // Path traversal protection
  if (!chatFile.startsWith(chatDir + '/')) {
    exit(`Path traversal detected for chat ID '${chatId}'`);
  }

  // ---- Step 7: Write chat file under lock ----
  const lockPath = `${chatFile}.lock`;
  await withExclusiveLock(lockPath, async () => {
    const context: Record<string, unknown> = {
      type: 'context-offload',
      parentChatId,
      contentSummary,
    };

    // Validate context size
    try {
      validateContext(context);
    } catch (err) {
      if (err instanceof ValidationError) {
        // Trim content summary if too large
        context.contentSummary = contentSummary.slice(0, 500);
      }
    }

    const chatData: ChatFile = {
      id: chatId,
      status: 'pending',
      chatId: null,
      createdAt: nowISO(),
      activatedAt: null,
      expiresAt,
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

  // ---- Step 8: Output result as JSON ----
  const result = {
    ok: true,
    chatId,
    parentChatId,
    groupName: truncatedName,
    expiresAt,
    message: 'Side group chat created, waiting for activation',
  };

  console.log(JSON.stringify(result, null, 2));
}

main().catch((err) => {
  console.error(`ERROR: ${err instanceof Error ? err.message : err}`);
  process.exit(1);
});
