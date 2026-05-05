/**
 * Shared helpers for chat integration tests.
 *
 * All tests using these helpers are **skipped by default** when lark-cli
 * is unavailable or TEST_CHAT_DRY_RUN=1 (default).
 *
 * Run with lark-cli:
 *   TEST_CHAT_DRY_RUN=0 npx vitest --run tests/integration/chat
 *
 * Run in dry-run mode (CI-safe):
 *   npx vitest --run tests/integration/chat
 *
 * @see Issue #3284 — Chat integration test design
 */

import { execFile } from 'child_process';
import { promisify } from 'util';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { describe, it } from 'vitest';
import {
  BotChatMappingStore,
  type MappingEntry,
  type MappingTable,
  makeMappingKey,
  purposeFromKey,
} from '@disclaude/core';

const execFileAsync = promisify(execFile);

// ---- Environment Configuration ----

/** Whether to skip real lark-cli calls (default: true for CI safety) */
export const DRY_RUN = process.env.TEST_CHAT_DRY_RUN !== '0';

/** Test user IDs for member-related tests */
export const TEST_USERS = (process.env.TEST_CHAT_USER_IDS ?? '')
  .split(',')
  .map((u) => u.trim())
  .filter(Boolean);

// Validate test user format
for (const user of TEST_USERS) {
  if (!/^ou_[a-zA-Z0-9]+/.test(user)) {
    throw new Error(
      `Invalid TEST_CHAT_USER_IDS format: "${user}". Expected ou_xxx format.`,
    );
  }
}
if (TEST_USERS.length > 5) {
  throw new Error(
    `Too many TEST_CHAT_USER_IDS: ${TEST_USERS.length}. Maximum 5 allowed.`,
  );
}

// ---- Lark-cli Availability ----

let _larkAvailable: boolean | null = null;

/**
 * Check if lark-cli is installed and authenticated.
 * Caches the result for the test session.
 */
export async function isLarkCliAvailable(): Promise<boolean> {
  if (_larkAvailable !== null) return _larkAvailable;
  try {
    await execFileAsync('lark-cli', ['auth', 'status'], { timeout: 5000 });
    _larkAvailable = true;
  } catch {
    _larkAvailable = false;
  }
  return _larkAvailable;
}

// ---- Test Environment Factory ----

export interface TestEnv {
  tmpDir: string;
  mappingPath: string;
  store: BotChatMappingStore;
  createdChatIds: string[];
}

/**
 * Create an isolated test environment with a temp mapping file.
 * Returns cleanup function for afterEach/afterAll.
 */
export function createTestEnv(): TestEnv {
  const tmpDir = mkdtempSync(join(tmpdir(), 'chat-integ-'));
  const mappingPath = join(tmpDir, 'bot-chat-mapping.json');
  const store = new BotChatMappingStore({ filePath: mappingPath });
  const createdChatIds: string[] = [];

  return { tmpDir, mappingPath, store, createdChatIds };
}

/**
 * Clean up a test environment (temp directory + created groups).
 */
export async function cleanupTestEnv(env: TestEnv): Promise<void> {
  // Dissolve any groups created during the test (when not in dry-run)
  for (const chatId of env.createdChatIds) {
    try {
      await execLark(['api', 'DELETE', `/open-apis/im/v1/chats/${chatId}`]);
    } catch {
      // Best-effort cleanup; group may already be dissolved
    }
  }

  // Remove temp directory
  try {
    rmSync(env.tmpDir, { recursive: true, force: true });
  } catch {
    // Ignore cleanup errors
  }
}

// ---- Lark-cli Execution ----

/**
 * Execute a lark-cli command.
 * @throws if lark-cli is not available or the command fails
 */
export async function execLark(
  args: string[],
): Promise<{ stdout: string; stderr: string }> {
  return execFileAsync('lark-cli', args, { timeout: 30000 });
}

// ---- Group Name Utilities ----

/**
 * Truncate a group name to a maximum number of characters.
 * Uses Array.from() for CJK-safe character boundary handling.
 *
 * This mirrors the logic the Agent would execute via:
 *   node -e "console.log(Array.from('${NAME}').slice(0, 64).join(''))"
 */
export function truncateGroupName(name: string, maxLen: number = 64): string {
  return Array.from(name).slice(0, maxLen).join('');
}

/**
 * Generate a mapping key for a discussion group.
 * Format: discussion-{timestamp}
 */
export function makeDiscussionKey(): string {
  return `discussion-${Math.floor(Date.now() / 1000)}`;
}

// ---- Mapping File Utilities ----

/**
 * Read and parse the mapping file.
 * Returns null if file doesn't exist or has invalid JSON.
 */
export function readMappingFile(path: string): MappingTable | null {
  try {
    if (!existsSync(path)) return null;
    const content = readFileSync(path, 'utf-8');
    return JSON.parse(content) as MappingTable;
  } catch {
    return null;
  }
}

/**
 * Write a mapping table to file (for test setup).
 */
export function writeMappingFile(path: string, table: MappingTable): void {
  writeFileSync(path, JSON.stringify(table, null, 2) + '\n', 'utf-8');
}

// ---- Vitest Helpers ----

/**
 * Describe block that only runs when:
 * 1. TEST_CHAT_DRY_RUN=0 (explicit opt-in)
 * 2. lark-cli is installed and authenticated
 */
export const describeIfLarkAvailable = DRY_RUN
  ? describe.skip
  : describe;

/**
 * Check if we should run lark-cli tests.
 * Must be called in beforeAll or later (async).
 */
export async function shouldRunLarkTests(): Promise<boolean> {
  if (DRY_RUN) return false;
  return isLarkCliAvailable();
}

/**
 * Parse chatId from lark-cli `im chat create` output.
 * Expected format: the output contains an oc_xxx identifier.
 */
export function parseChatIdFromOutput(output: string): string | null {
  const match = output.match(/(oc_[a-zA-Z0-9]+)/);
  return match ? match[1] : null;
}
