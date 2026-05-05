/**
 * Shared helpers for chat lifecycle integration tests.
 *
 * These tests call **real lark-cli** to create/dissolve Feishu groups.
 * All tests are skipped by default — run with:
 *
 *   FEISHU_INTEGRATION_TEST=true npx vitest --run tests/integration/feishu/chat-lifecycle
 *
 * Prerequisites:
 *   - lark-cli installed and authenticated (`lark auth status` passes)
 *   - Bot has permission to create/dissolve groups
 *
 * @see Issue #3284 — 建群与解散群集成测试
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { tmpdir } from 'os';
import { join } from 'path';
import { mkdtempSync, rmSync } from 'fs';
import { describe } from 'vitest';
import { BotChatMappingStore, makeMappingKey } from '../../../packages/core/src/scheduling/index.js';

const execFileAsync = promisify(execFile);

// ---- Skip guard ----

/** Whether chat lifecycle integration tests are enabled. */
export const CHAT_INTEGRATION =
  process.env.FEISHU_INTEGRATION_TEST === 'true';

/**
 * A describe block that only runs when FEISHU_INTEGRATION_TEST=true.
 * Follows the same pattern as `describeIfFeishu` in helpers.ts.
 */
export const describeIfChat = CHAT_INTEGRATION ? describe : describe.skip;

// ---- Constants ----

/** Timeout for lark-cli commands (ms). */
export const LARK_TIMEOUT_MS = 30_000;

/** Max length for Feishu group names. */
export const MAX_GROUP_NAME_LENGTH = 64;

/** Regex for valid Feishu group chat IDs (oc_xxx format). */
export const CHAT_ID_REGEX = /^oc_[a-zA-Z0-9]+$/;

/** Regex for valid Feishu user IDs (ou_xxx format). */
export const USER_ID_REGEX = /^ou_[a-zA-Z0-9]+$/;

// ---- Environment variables ----

/**
 * Parse TEST_CHAT_USER_IDS from environment.
 * Returns null if not set or empty.
 * Validates each ID matches ou_xxx format.
 */
export function getTestUserIds(): string[] | null {
  const raw = process.env.TEST_CHAT_USER_IDS?.trim();
  if (!raw) return null;

  const ids = raw.split(',').map((s) => s.trim()).filter(Boolean);
  for (const id of ids) {
    if (!USER_ID_REGEX.test(id)) {
      throw new Error(
        `Invalid TEST_CHAT_USER_IDS entry '${id}' — must match ou_xxx format`,
      );
    }
  }
  if (ids.length > 5) {
    throw new Error('TEST_CHAT_USER_IDS must contain at most 5 user IDs');
  }
  return ids;
}

// ---- Temp directory helpers ----

/**
 * Create a temporary directory for test artifacts.
 * Caller is responsible for cleanup via cleanupTempDir().
 */
export function createTempDir(): string {
  return mkdtempSync(join(tmpdir(), 'chat-lifecycle-test-'));
}

/**
 * Remove a temporary directory and all contents.
 */
export function cleanupTempDir(dir: string): void {
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    // Ignore cleanup errors
  }
}

// ---- lark-cli commands ----

/**
 * Result of a lark-cli im chat create command.
 */
export interface CreateGroupResult {
  /** Whether the command succeeded. */
  success: boolean;
  /** The chat ID of the created group (oc_xxx format), or null on failure. */
  chatId: string | null;
  /** Raw stdout from lark-cli. */
  stdout: string;
  /** Error message if the command failed. */
  error: string | null;
}

/**
 * Create a Feishu group via lark-cli.
 *
 * Calls: `lark-cli im chat create --name "..." --description "..."`
 *
 * @param name - Group name (will be truncated to 64 chars)
 * @param description - Optional group description
 * @returns CreateGroupResult with chatId on success
 */
export async function createGroup(
  name: string,
  description?: string,
): Promise<CreateGroupResult> {
  const truncatedName = truncateGroupName(name);
  const args = ['im', 'chat', 'create', '--name', truncatedName];
  if (description) {
    args.push('--description', description);
  }

  try {
    const { stdout } = await execFileAsync('lark-cli', args, {
      timeout: LARK_TIMEOUT_MS,
      maxBuffer: 1024 * 1024,
    });

    // Parse chatId from stdout — lark-cli outputs the chatId in the response
    const chatIdMatch = stdout.match(/(oc_[a-zA-Z0-9]+)/);
    const chatId = chatIdMatch ? chatIdMatch[1] : null;

    return { success: true, chatId, stdout, error: null };
  } catch (err: unknown) {
    const execErr = err as { stderr?: string; message?: string };
    const errorMsg = (execErr.stderr ?? execErr.message ?? 'unknown error')
      .replace(/\n/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    return { success: false, chatId: null, stdout: '', error: errorMsg };
  }
}

/**
 * Result of a dissolve group command.
 */
export interface DissolveGroupResult {
  /** Whether the command succeeded. */
  success: boolean;
  /** Error message if the command failed. */
  error: string | null;
}

/**
 * Dissolve a Feishu group via lark-cli.
 *
 * Calls: `lark-cli api DELETE /open-apis/im/v1/chats/{chatId}`
 *
 * @param chatId - The group chat ID to dissolve (oc_xxx format)
 * @returns DissolveGroupResult
 */
export async function dissolveGroup(
  chatId: string,
): Promise<DissolveGroupResult> {
  try {
    await execFileAsync(
      'lark-cli',
      ['api', 'DELETE', `/open-apis/im/v1/chats/${chatId}`],
      { timeout: LARK_TIMEOUT_MS, maxBuffer: 1024 * 1024 },
    );
    return { success: true, error: null };
  } catch (err: unknown) {
    const execErr = err as { stderr?: string; message?: string };
    const errorMsg = (execErr.stderr ?? execErr.message ?? 'unknown error')
      .replace(/\n/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    return { success: false, error: errorMsg };
  }
}

/**
 * Add members to a Feishu group via lark-cli.
 *
 * Calls: `lark-cli im chat members add --chat-id {chatId} --member-id-type open_id --ids {userId1},{userId2}`
 */
export async function addGroupMembers(
  chatId: string,
  userIds: string[],
): Promise<{ success: boolean; error: string | null }> {
  try {
    await execFileAsync(
      'lark-cli',
      [
        'im',
        'chat',
        'members',
        'add',
        '--chat-id',
        chatId,
        '--member-id-type',
        'open_id',
        '--ids',
        userIds.join(','),
      ],
      { timeout: LARK_TIMEOUT_MS, maxBuffer: 1024 * 1024 },
    );
    return { success: true, error: null };
  } catch (err: unknown) {
    const execErr = err as { stderr?: string; message?: string };
    const errorMsg = (execErr.stderr ?? execErr.message ?? 'unknown error')
      .replace(/\n/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    return { success: false, error: errorMsg };
  }
}

/**
 * Check if lark-cli is available and authenticated.
 *
 * @returns true if lark-cli is available, false otherwise
 */
export async function isLarkCliAvailable(): Promise<boolean> {
  try {
    await execFileAsync('lark-cli', ['--version'], { timeout: 5000 });
    return true;
  } catch {
    return false;
  }
}

// ---- Utility ----

/**
 * Truncate a group name to max length at character boundaries.
 * Handles CJK characters correctly via Array.from (splits by code point).
 */
export function truncateGroupName(name: string): string {
  return Array.from(name).slice(0, MAX_GROUP_NAME_LENGTH).join('');
}

/**
 * Create a BotChatMappingStore with a temp file.
 */
export function createTestMappingStore(
  tempDir: string,
): BotChatMappingStore {
  const filePath = join(tempDir, 'bot-chat-mapping.json');
  return new BotChatMappingStore({ filePath });
}
