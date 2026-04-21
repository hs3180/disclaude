#!/usr/bin/env tsx
/**
 * skills/start-discussion/start-discussion.ts — Create a pending discussion chat.
 *
 * Creates a pending chat file using the chat skill infrastructure.
 * The chats-activation schedule will create the Feishu group via lark-cli.
 *
 * Environment variables:
 *   DISCUSSION_ID            (required) Unique discussion ID (e.g. "discuss-code-style")
 *   DISCUSSION_TOPIC         (required) Discussion topic (becomes group name)
 *   DISCUSSION_CONTEXT       (required) Full context for the ChatAgent
 *   DISCUSSION_MEMBERS       (required) JSON array of open IDs (e.g. '["ou_xxx"]')
 *   DISCUSSION_EXPIRES_HOURS (optional) Hours until expiry (default: 24)
 *
 * Exit codes:
 *   0 — success
 *   1 — validation error or write failure
 */

import {
  validateChatId,
  validateGroupName,
  validateMembers,
  nowISO,
  CHAT_DIR,
  type ChatFile,
  ValidationError,
} from '../chat/schema.js';
import { withExclusiveLock } from '../chat/lock.js';
import { mkdir, writeFile, stat, rename } from 'node:fs/promises';
import { resolve } from 'node:path';

// ---- Constants ----

const DEFAULT_EXPIRES_HOURS = 24;
const MAX_CONTEXT_LENGTH = 8000;

// ---- Validation ----

function exit(msg: string): never {
  console.error(`ERROR: ${msg}`);
  process.exit(1);
}

function validateDiscussionId(id: string): void {
  if (!id) {
    exit('DISCUSSION_ID environment variable is required');
  }
  // Discussion IDs should start with "discuss-" prefix for clarity
  try {
    validateChatId(id);
  } catch (err) {
    exit(err instanceof ValidationError ? err.message : String(err));
  }
}

function validateTopic(topic: string): void {
  if (!topic) {
    exit('DISCUSSION_TOPIC environment variable is required');
  }
  try {
    validateGroupName(topic);
  } catch (err) {
    exit(err instanceof ValidationError ? err.message : String(err));
  }
}

function validateDiscussionContext(context: string): void {
  if (!context) {
    exit('DISCUSSION_CONTEXT environment variable is required');
  }
  if (context.length > MAX_CONTEXT_LENGTH) {
    exit(`DISCUSSION_CONTEXT too long (${context.length} chars, max ${MAX_CONTEXT_LENGTH})`);
  }
}

function computeExpiry(hoursStr: string | undefined): string {
  const hours = hoursStr ? parseFloat(hoursStr) : DEFAULT_EXPIRES_HOURS;
  if (!Number.isFinite(hours) || hours <= 0) {
    exit(`DISCUSSION_EXPIRES_HOURS must be a positive number, got '${hoursStr}'`);
  }
  const expiry = new Date(Date.now() + hours * 60 * 60 * 1000);
  return expiry.toISOString().replace(/\.\d{3}Z$/, 'Z');
}

// ---- Main ----

async function main() {
  // ---- Step 1: Validate inputs ----
  const discussionId = process.env.DISCUSSION_ID ?? '';
  validateDiscussionId(discussionId);

  const topic = process.env.DISCUSSION_TOPIC ?? '';
  validateTopic(topic);

  const contextStr = process.env.DISCUSSION_CONTEXT ?? '';
  validateDiscussionContext(contextStr);

  const membersRaw = process.env.DISCUSSION_MEMBERS;
  if (!membersRaw) {
    exit('DISCUSSION_MEMBERS environment variable is required');
  }
  let members: string[];
  try {
    const parsed = JSON.parse(membersRaw);
    members = validateMembers(parsed);
  } catch (err) {
    if (err instanceof ValidationError) {
      // Replace generic "CHAT_MEMBERS" with "DISCUSSION_MEMBERS" in error message
      exit(err.message.replace('CHAT_MEMBERS', 'DISCUSSION_MEMBERS'));
    }
    exit(`DISCUSSION_MEMBERS must be valid JSON array: ${membersRaw}`);
  }

  const expiresAt = computeExpiry(process.env.DISCUSSION_EXPIRES_HOURS);

  // ---- Step 2: Setup directory and resolve path ----
  const chatDir = resolve(CHAT_DIR);
  await mkdir(chatDir, { recursive: true });

  const chatFile = resolve(chatDir, `${discussionId}.json`);

  // Path traversal protection
  if (!chatFile.startsWith(chatDir + '/')) {
    exit(`Path traversal detected for discussion ID '${discussionId}'`);
  }

  // ---- Step 3: Create chat file under exclusive lock ----
  const lockPath = `${chatFile}.lock`;
  await withExclusiveLock(lockPath, async () => {
    // Check uniqueness
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

    // ---- Step 4: Write chat file ----
    const chatData: ChatFile = {
      id: discussionId,
      status: 'pending',
      chatId: null,
      createdAt: nowISO(),
      activatedAt: null,
      expiresAt,
      expiredAt: null,
      createGroup: {
        name: topic,
        members,
      },
      context: {
        type: 'discussion',
        topic,
        discussionContext: contextStr,
      },
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

  // ---- Step 5: Output result ----
  console.log(`OK: Discussion '${discussionId}' created`);
  console.log(`  Topic: ${topic}`);
  console.log(`  Members: ${members.join(', ')}`);
  console.log(`  Expires: ${expiresAt}`);
  console.log(`  Status: pending (chats-activation schedule will create the group)`);
}

main().catch((err) => {
  console.error(`ERROR: ${err instanceof Error ? err.message : err}`);
  process.exit(1);
});
