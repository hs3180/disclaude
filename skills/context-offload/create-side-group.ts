#!/usr/bin/env tsx
/**
 * skills/context-offload/create-side-group.ts — Create a side group for content offloading.
 *
 * Creates a pending chat file for a side group that will be activated by the
 * chats-activation schedule. The agent can then send long-form content to
 * the side group, keeping the main conversation clean.
 *
 * Issue #2351: Context Offloading - Auto-create side group for long-form content delivery.
 *
 * Environment variables:
 *   OFFLOAD_PARENT_CHAT_ID  (required) The parent chat ID where the request originated
 *   OFFLOAD_GROUP_NAME      (required) Display name for the side group
 *   OFFLOAD_MEMBERS         (required) JSON array of open IDs to invite
 *   OFFLOAD_CONTEXT         (optional) Additional context data (default: '{}')
 *   OFFLOAD_EXPIRES_HOURS   (optional) Hours until expiry (default: 24)
 *
 * Exit codes:
 *   0 — success
 *   1 — validation error or write failure
 */

import { mkdir, writeFile, stat, rename } from 'node:fs/promises';
import { resolve } from 'node:path';
import {
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
import { randomBytes } from 'node:crypto';

// ---- Constants ----

/** Default expiry time in hours for side groups */
const DEFAULT_EXPIRES_HOURS = 24;

/** Maximum expiry hours allowed (7 days) */
const MAX_EXPIRES_HOURS = 168;

/** Prefix for all side group chat IDs */
const CHAT_ID_PREFIX = 'offload-';

/** Length of random suffix for chat IDs (hex encoded bytes) */
const RANDOM_SUFFIX_BYTES = 4; // 8 hex chars

// ---- Validation ----

function exit(msg: string): never {
  console.error(`ERROR: ${msg}`);
  process.exit(1);
}

/**
 * Validate parent chat ID format.
 * Must be a non-empty string matching Feishu group chat format (oc_xxx).
 */
function validateParentChatId(chatId: string): void {
  if (!chatId) {
    exit('OFFLOAD_PARENT_CHAT_ID environment variable is required');
  }
  if (typeof chatId !== 'string' || !/^oc_[a-zA-Z0-9]+$/.test(chatId)) {
    exit(`Invalid OFFLOAD_PARENT_CHAT_ID '${chatId}' — must match oc_xxxxx format`);
  }
}

/**
 * Validate expiry hours value.
 * Must be a positive number within the allowed range.
 */
function validateExpiresHours(hours: number): void {
  if (!Number.isFinite(hours) || hours <= 0) {
    exit(`OFFLOAD_EXPIRES_HOURS must be a positive number, got '${hours}'`);
  }
  if (hours > MAX_EXPIRES_HOURS) {
    exit(`OFFLOAD_EXPIRES_HOURS cannot exceed ${MAX_EXPIRES_HOURS} hours (7 days), got '${hours}'`);
  }
}

/**
 * Generate a unique chat ID for the side group.
 * Format: offload-{8 hex chars}
 */
function generateChatId(): string {
  const suffix = randomBytes(RANDOM_SUFFIX_BYTES).toString('hex');
  return `${CHAT_ID_PREFIX}${suffix}`;
}

/**
 * Calculate expiry timestamp from now + hours.
 * Returns UTC ISO 8601 Z-suffix format.
 */
function calculateExpiresAt(hours: number): string {
  const expiresAt = new Date(Date.now() + hours * 3600 * 1000);
  return expiresAt.toISOString().replace(/\.\d{3}Z$/, 'Z');
}

// ---- Main ----

async function main() {
  // ---- Step 1: Validate required environment variables ----
  const parentChatId = process.env.OFFLOAD_PARENT_CHAT_ID ?? '';
  validateParentChatId(parentChatId);

  const groupName = process.env.OFFLOAD_GROUP_NAME;
  if (!groupName) {
    exit('OFFLOAD_GROUP_NAME environment variable is required');
  }
  try {
    validateGroupName(groupName);
  } catch (err) {
    exit(err instanceof ValidationError ? err.message : String(err));
  }

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

  // ---- Step 2: Validate optional environment variables ----
  const contextRaw = process.env.OFFLOAD_CONTEXT;
  let context: Record<string, unknown>;
  try {
    const parsed = contextRaw ? JSON.parse(contextRaw) : undefined;
    context = validateContext(parsed);
  } catch (err) {
    if (err instanceof ValidationError) {
      exit(err.message);
    }
    exit(`OFFLOAD_CONTEXT must be valid JSON: ${contextRaw}`);
  }

  // Add parent chat ID to context for traceability
  context = {
    ...context,
    parentChatId,
    type: 'context-offload',
  };

  let expiresHours = DEFAULT_EXPIRES_HOURS;
  const expiresHoursRaw = process.env.OFFLOAD_EXPIRES_HOURS;
  if (expiresHoursRaw) {
    const parsed = parseFloat(expiresHoursRaw);
    validateExpiresHours(parsed);
    expiresHours = parsed;
  }

  // ---- Step 3: Generate unique chat ID and expiry ----
  const chatId = generateChatId();
  const truncatedName = truncateGroupName(groupName);
  const expiresAt = calculateExpiresAt(expiresHours);

  // Validate the generated expiry timestamp
  try {
    validateExpiresAt(expiresAt);
  } catch (err) {
    exit(`Failed to generate valid expiry timestamp: ${err instanceof Error ? err.message : err}`);
  }

  // ---- Step 4: Setup directory and resolve path ----
  const chatDir = resolve(CHAT_DIR);
  await mkdir(chatDir, { recursive: true });

  const chatFile = resolve(chatDir, `${chatId}.json`);

  // Path traversal protection
  if (!chatFile.startsWith(chatDir + '/')) {
    exit(`Path traversal detected for chat ID '${chatId}'`);
  }

  // ---- Step 5: Write chat file under exclusive lock ----
  const lockPath = `${chatFile}.lock`;
  await withExclusiveLock(lockPath, async () => {
    // Double-check file doesn't exist (unlikely with random ID, but safe)
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

    // ---- Step 6: Write the chat file ----
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
      // triggerMode='always' so agent can send messages without @mention
      triggerMode: 'always',
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

  // ---- Step 7: Output result for agent consumption ----
  console.log('OK: Side group chat created');
  console.log(`CHAT_ID: ${chatId}`);
  console.log(`GROUP_NAME: ${truncatedName}`);
  console.log(`STATUS: pending`);
  console.log(`EXPIRES_AT: ${expiresAt}`);
  console.log(`PARENT_CHAT_ID: ${parentChatId}`);
}

main().catch((err) => {
  console.error(`ERROR: ${err instanceof Error ? err.message : err}`);
  process.exit(1);
});
