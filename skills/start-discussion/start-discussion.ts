#!/usr/bin/env tsx
/**
 * start-discussion.ts — Create a non-blocking discussion chat.
 *
 * Creates a pending chat file with discussion-specific defaults.
 * The chats-activation Schedule will create the Feishu group automatically.
 *
 * Environment variables:
 *   DISCUSSION_TOPIC        (required) Discussion topic/question
 *   DISCUSSION_MEMBERS      (required) JSON array of member open IDs
 *   DISCUSSION_CONTEXT      (optional) JSON object with discussion context/materials
 *   DISCUSSION_EXPIRES_HOURS (optional, default 24) Hours until expiry
 *   DISCUSSION_ID           (optional) Custom chat ID (auto-generated if not provided)
 *
 * Exit codes:
 *   0 — success
 *   1 — validation error or write failure
 */

import { mkdir, stat, writeFile, rename } from 'node:fs/promises';
import { resolve } from 'node:path';
import {
  validateChatId,
  validateGroupName,
  validateMembers,
  validateContext,
  truncateGroupName,
  nowISO,
  CHAT_DIR,
  CHAT_ID_REGEX,
  ValidationError,
  type ChatFile,
} from '../chat/schema.js';
import { withExclusiveLock } from '../chat/lock.js';

// ---- Constants ----

const DEFAULT_EXPIRES_HOURS = 24;
const MAX_EXPIRES_HOURS = 168; // 7 days

// ---- Helpers ----

function exit(msg: string): never {
  console.error(`ERROR: ${msg}`);
  process.exit(1);
}

/**
 * Generate a discussion chat ID from the current timestamp.
 * Format: discuss-{unix_timestamp_ms}
 */
function generateDiscussionId(): string {
  return `discuss-${Date.now()}`;
}

/**
 * Compute expiry timestamp in ISO 8601 Z-suffix format.
 */
function computeExpiresAt(hours: number): string {
  const now = new Date();
  now.setUTCHours(now.getUTCHours() + hours);
  return now.toISOString().replace(/\.\d{3}Z$/, 'Z');
}

/**
 * Sanitize a topic into a valid group name.
 * Replaces characters not in the GROUP_NAME_REGEX allowlist with spaces,
 * then collapses multiple spaces and trims.
 */
function topicToGroupName(topic: string): string {
  // GROUP_NAME_REGEX: /^[a-zA-Z0-9_\-.#:/ ()（）【】]+$/
  const sanitized = topic
    .replace(/[^\w\-\.#\/: ()（）【】]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!sanitized) {
    return 'Discussion';
  }
  return truncateGroupName(sanitized);
}

// ---- Main ----

async function main() {
  // ---- Step 1: Validate topic and derive group name ----
  const topic = process.env.DISCUSSION_TOPIC?.trim();
  if (!topic) {
    exit('DISCUSSION_TOPIC environment variable is required');
  }

  const groupName = topicToGroupName(topic);
  try {
    validateGroupName(groupName);
  } catch (err) {
    exit(err instanceof ValidationError ? err.message : String(err));
  }

  // ---- Step 2: Validate or generate discussion ID ----
  const customId = process.env.DISCUSSION_ID?.trim();
  const discussionId = customId || generateDiscussionId();
  try {
    validateChatId(discussionId);
  } catch (err) {
    exit(err instanceof ValidationError ? err.message : String(err));
  }

  // ---- Step 3: Validate members ----
  const membersRaw = process.env.DISCUSSION_MEMBERS;
  let members: string[];
  try {
    const parsed = membersRaw ? JSON.parse(membersRaw) : undefined;
    members = validateMembers(parsed);
  } catch (err) {
    if (err instanceof ValidationError) {
      exit(err.message);
    }
    exit(`DISCUSSION_MEMBERS must be valid JSON: ${membersRaw}`);
  }

  // ---- Step 4: Validate optional context ----
  const contextRaw = process.env.DISCUSSION_CONTEXT;
  let context: Record<string, unknown>;
  try {
    const parsed = contextRaw ? JSON.parse(contextRaw) : undefined;
    context = validateContext(parsed);
  } catch (err) {
    if (err instanceof ValidationError) {
      exit(err.message);
    }
    exit(`DISCUSSION_CONTEXT must be valid JSON: ${contextRaw}`);
  }

  // Add topic to context automatically
  const enrichedContext: Record<string, unknown> = {
    ...context,
    discussionTopic: topic,
  };

  // ---- Step 5: Validate and compute expiry ----
  let expiresHours = DEFAULT_EXPIRES_HOURS;
  const expiresHoursRaw = process.env.DISCUSSION_EXPIRES_HOURS;
  if (expiresHoursRaw) {
    const parsed = parseFloat(expiresHoursRaw);
    if (!Number.isFinite(parsed) || parsed <= 0) {
      exit(`DISCUSSION_EXPIRES_HOURS must be a positive number, got '${expiresHoursRaw}'`);
    }
    if (parsed > MAX_EXPIRES_HOURS) {
      exit(`DISCUSSION_EXPIRES_HOURS cannot exceed ${MAX_EXPIRES_HOURS} (7 days), got '${expiresHoursRaw}'`);
    }
    expiresHours = parsed;
  }

  const expiresAt = computeExpiresAt(expiresHours);
  const truncatedName = truncateGroupName(groupName);

  // ---- Step 6: Setup directory and resolve path ----
  const chatDir = resolve(CHAT_DIR);
  await mkdir(chatDir, { recursive: true });

  const chatFile = resolve(chatDir, `${discussionId}.json`);

  // Path traversal protection
  if (!chatFile.startsWith(chatDir + '/')) {
    exit(`Path traversal detected for discussion ID '${discussionId}'`);
  }

  // ---- Step 7: Create chat file under exclusive lock ----
  const lockPath = `${chatFile}.lock`;
  await withExclusiveLock(lockPath, async () => {
    // Double-check file doesn't exist
    try {
      await stat(chatFile);
      throw new ValidationError(`Discussion ${discussionId} already exists`);
    } catch (err: unknown) {
      if (err instanceof ValidationError) throw err;
      const nodeErr = err as { code?: string };
      if (nodeErr.code !== 'ENOENT') {
        throw new Error(`Failed to check discussion file: ${err}`);
      }
    }

    // ---- Step 8: Write chat file ----
    const chatData: ChatFile = {
      id: discussionId,
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
      context: enrichedContext,
      // Use 'always' triggerMode for discussion groups (2-person chat, bot should respond to all messages)
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

  // ---- Step 9: Output result ----
  console.log(`OK: Discussion ${discussionId} created`);
  console.log(`CHAT_ID: ${discussionId}`);
}

main().catch((err) => {
  console.error(`ERROR: ${err instanceof Error ? err.message : err}`);
  process.exit(1);
});
