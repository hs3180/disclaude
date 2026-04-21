#!/usr/bin/env tsx
/**
 * context-offload/create-side-group.ts — Synchronously create a side group for context offloading.
 *
 * Unlike the `chat` skill (which creates pending chats requiring schedule activation),
 * this script creates groups immediately via `lark-cli` and registers them as active
 * chats for lifecycle management.
 *
 * Environment variables:
 *   SIDE_GROUP_NAME        (required) Group display name (max 64 chars, auto-truncated)
 *   SIDE_GROUP_MEMBERS     (required) JSON array of member open IDs (e.g. '["ou_xxx"]')
 *   SIDE_GROUP_PARENT_CHAT_ID (required) Parent chat ID for reference
 *   SIDE_GROUP_TOPIC       (optional) Topic description stored in chat context
 *   SIDE_GROUP_EXPIRES_AT  (optional) ISO 8601 Z-suffix expiry (default: 24h from now)
 *
 * Exit codes:
 *   0 — success (outputs JSON with chatId and chatFilePath)
 *   1 — validation error or group creation failure
 */

import { mkdir, writeFile, rename } from 'node:fs/promises';
import { resolve } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import {
  validateGroupName,
  validateMembers,
  validateContext,
  truncateGroupName,
  nowISO,
  CHAT_DIR,
  GROUP_NAME_REGEX,
  MEMBER_ID_REGEX,
  MAX_GROUP_NAME_LENGTH,
  LARK_TIMEOUT_MS,
  ValidationError,
  type ChatFile,
} from '../chat/schema.js';
import { withExclusiveLock } from '../chat/lock.js';

const execFileAsync = promisify(execFile);

function exit(msg: string): never {
  console.error(`ERROR: ${msg}`);
  process.exit(1);
}

/**
 * Generate a unique chat ID for the side group.
 * Format: side-{timestamp}-{random}
 */
function generateChatId(): string {
  const ts = Date.now().toString(36);
  const rand = Math.random().toString(36).substring(2, 8);
  return `side-${ts}-${rand}`;
}

/**
 * Calculate default expiry: 24 hours from now.
 */
function defaultExpiresAt(): string {
  const d = new Date();
  d.setHours(d.getHours() + 24);
  return d.toISOString();
}

async function main() {
  // ---- Step 1: Validate inputs ----
  const groupName = process.env.SIDE_GROUP_NAME;
  try {
    validateGroupName(groupName ?? '');
  } catch (err) {
    exit(err instanceof ValidationError ? err.message : String(err));
  }

  const membersRaw = process.env.SIDE_GROUP_MEMBERS;
  let members: string[];
  try {
    const parsed = membersRaw ? JSON.parse(membersRaw) : undefined;
    members = validateMembers(parsed);
  } catch (err) {
    if (err instanceof ValidationError) {
      exit(err.message);
    }
    exit(`SIDE_GROUP_MEMBERS must be valid JSON: ${membersRaw}`);
  }

  const parentChatId = process.env.SIDE_GROUP_PARENT_CHAT_ID;
  if (!parentChatId) {
    exit('SIDE_GROUP_PARENT_CHAT_ID environment variable is required');
  }

  const topic = process.env.SIDE_GROUP_TOPIC ?? '';

  let expiresAt = process.env.SIDE_GROUP_EXPIRES_AT;
  if (!expiresAt) {
    expiresAt = defaultExpiresAt();
  } else if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(expiresAt)) {
    exit(`SIDE_GROUP_EXPIRES_AT must be UTC Z-suffix format (e.g. 2099-12-31T23:59:59Z), got '${expiresAt}'`);
  }

  const truncatedName = truncateGroupName(groupName!);

  // ---- Step 2: Check lark-cli availability ----
  try {
    await execFileAsync('lark-cli', ['--version'], { timeout: 5000 });
  } catch {
    exit('Missing required dependency: lark-cli not found in PATH');
  }

  // ---- Step 3: Create group via lark-cli ----
  const membersStr = members.join(',');
  let larkResult = '';
  let larkError: string | null = null;

  try {
    const result = await execFileAsync(
      'lark-cli',
      ['im', '+chat-create', '--name', truncatedName, '--users', membersStr],
      { timeout: LARK_TIMEOUT_MS, maxBuffer: 1024 * 1024 },
    );
    larkResult = result.stdout;
  } catch (err: unknown) {
    const execErr = err as { stdout?: string; stderr?: string; message?: string };
    larkResult = execErr.stdout ?? '';
    larkError = execErr.stderr ?? execErr.message ?? '';
  }

  // Parse chat ID from lark-cli response
  let newChatId: string | null = null;
  try {
    const parsed = JSON.parse(larkResult);
    newChatId = parsed?.data?.chat_id ?? null;
  } catch {
    // Not valid JSON
  }

  if (!newChatId) {
    const errorMsg = (larkError ?? larkResult ?? 'unknown error').replace(/\n/g, ' ').trim();
    exit(`Failed to create group via lark-cli: ${errorMsg}`);
  }

  // ---- Step 4: Create chat file in active state ----
  const chatId = generateChatId();
  const chatDir = resolve(CHAT_DIR);
  await mkdir(chatDir, { recursive: true });

  const chatFile = resolve(chatDir, `${chatId}.json`);

  // Path traversal protection
  if (!chatFile.startsWith(chatDir + '/')) {
    exit(`Path traversal detected for chat ID '${chatId}'`);
  }

  const context: Record<string, unknown> = {
    parentChatId,
    ...(topic ? { topic } : {}),
    type: 'context-offload',
  };

  const chatData: ChatFile = {
    id: chatId,
    status: 'active',
    chatId: newChatId,
    createdAt: nowISO(),
    activatedAt: nowISO(),
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

  const lockPath = `${chatFile}.lock`;
  await withExclusiveLock(lockPath, async () => {
    const tmpFile = `${chatFile}.${Date.now()}.tmp`;
    await writeFile(tmpFile, JSON.stringify(chatData, null, 2) + '\n', 'utf-8');
    await rename(tmpFile, chatFile);
  });

  // ---- Step 5: Output result ----
  const output = {
    chatId: newChatId,
    internalId: chatId,
    chatFilePath: chatFile,
    groupName: truncatedName,
    expiresAt,
  };
  console.log(JSON.stringify(output, null, 2));
}

main().catch((err) => {
  console.error(`ERROR: ${err instanceof Error ? err.message : err}`);
  process.exit(1);
});
