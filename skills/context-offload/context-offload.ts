#!/usr/bin/env tsx
/**
 * skills/context-offload/context-offload.ts — Create a side group for long-form content delivery.
 *
 * Creates a Feishu group via lark-cli, invites the requesting user,
 * and returns the new group's chatId for content delivery.
 *
 * Environment variables:
 *   OFFLOAD_CHAT_ID          (required) The parent (main) chat ID (oc_xxx format)
 *   OFFLOAD_SENDER_OPEN_ID   (required) Open ID of the user to invite (ou_xxx format)
 *   OFFLOAD_GROUP_NAME        (required) Display name for the new group
 *   OFFLOAD_SKIP_LARK         (optional) Set to '1' to skip lark-cli check (testing)
 *
 * Exit codes:
 *   0 — success
 *   1 — validation error or group creation failure
 *
 * Issue #2351: Context Offloading - Auto-create side group for long-form content delivery.
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

// ---- Constants ----

export const LARK_TIMEOUT_MS = 30_000;
export const MAX_GROUP_NAME_LENGTH = 64;

// ---- Validation ----

export const CHAT_ID_REGEX = /^oc_[a-zA-Z0-9]+$/;
export const OPEN_ID_REGEX = /^ou_[a-zA-Z0-9]+$/;

export class ValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ValidationError';
  }
}

export function validateRequired(value: string | undefined, name: string): string {
  if (!value) {
    throw new ValidationError(`${name} environment variable is required`);
  }
  return value;
}

export function validateChatId(chatId: string): void {
  if (!CHAT_ID_REGEX.test(chatId)) {
    throw new ValidationError(
      `OFFLOAD_CHAT_ID must be oc_xxx format, got '${chatId}'`,
    );
  }
}

export function validateOpenId(openId: string): void {
  if (!OPEN_ID_REGEX.test(openId)) {
    throw new ValidationError(
      `OFFLOAD_SENDER_OPEN_ID must be ou_xxx format, got '${openId}'`,
    );
  }
}

export function truncateGroupName(name: string): string {
  return Array.from(name).slice(0, MAX_GROUP_NAME_LENGTH).join('');
}

// ---- JSON output helpers ----

interface SuccessResult {
  success: true;
  chatId: string;
  groupName: string;
}

interface FailureResult {
  success: false;
  error: string;
}

type Result = SuccessResult | FailureResult;

function outputResult(result: Result): never {
  console.log(JSON.stringify(result, null, 2));
  process.exit(result.success ? 0 : 1);
}

// ---- Main ----

async function main(): Promise<void> {
  // ---- Step 1: Validate environment variables ----
  const chatId = validateRequired(process.env.OFFLOAD_CHAT_ID, 'OFFLOAD_CHAT_ID');
  const senderOpenId = validateRequired(process.env.OFFLOAD_SENDER_OPEN_ID, 'OFFLOAD_SENDER_OPEN_ID');
  const groupNameRaw = validateRequired(process.env.OFFLOAD_GROUP_NAME, 'OFFLOAD_GROUP_NAME');

  try {
    validateChatId(chatId);
  } catch (err) {
    outputResult({
      success: false,
      error: err instanceof ValidationError ? err.message : String(err),
    });
  }

  try {
    validateOpenId(senderOpenId);
  } catch (err) {
    outputResult({
      success: false,
      error: err instanceof ValidationError ? err.message : String(err),
    });
  }

  const groupName = truncateGroupName(groupNameRaw);

  // ---- Step 2: Check lark-cli availability ----
  if (process.env.OFFLOAD_SKIP_LARK !== '1') {
    try {
      await execFileAsync('lark-cli', ['--version'], { timeout: 5000 });
    } catch {
      outputResult({
        success: false,
        error: 'Missing required dependency: lark-cli not found in PATH',
      });
    }
  }

  // ---- Step 3: Create group via lark-cli ----
  let larkResult: string;
  let larkError: string | null = null;

  try {
    const result = await execFileAsync(
      'lark-cli',
      ['im', '+chat-create', '--name', groupName, '--users', senderOpenId],
      { timeout: LARK_TIMEOUT_MS, maxBuffer: 1024 * 1024 },
    );
    larkResult = result.stdout;
  } catch (err: unknown) {
    const execErr = err as { stdout?: string; stderr?: string; message?: string };
    larkResult = execErr.stdout ?? '';
    larkError = execErr.stderr ?? execErr.message ?? '';
  }

  // ---- Step 4: Parse result and extract chatId ----
  let newChatId: string | null = null;
  try {
    const parsed = JSON.parse(larkResult);
    newChatId = parsed?.data?.chat_id ?? null;
  } catch {
    // Not valid JSON, treat as failure
  }

  if (!newChatId) {
    const errorMsg = (larkError ?? larkResult ?? 'unknown error')
      .replace(/\n/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    outputResult({
      success: false,
      error: `Failed to create group: ${errorMsg}`,
    });
  }

  // ---- Step 5: Output success ----
  outputResult({
    success: true,
    chatId: newChatId!,
    groupName,
  });
}

// Only run main() when executed directly (not when imported for testing)
if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith('context-offload.ts')) {
  main().catch((err: unknown) => {
    outputResult({
      success: false,
      error: err instanceof Error ? err.message : String(err),
    });
  });
}
