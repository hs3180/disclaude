/**
 * Helpers for chat skill integration tests.
 *
 * These tests call real lark-cli and use real filesystem I/O.
 * They are skipped automatically when lark-cli is unavailable.
 *
 * @see Issue #3284
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BotChatMappingStore } from '@disclaude/core';

const execFileAsync = promisify(execFile);

/** Timeout for lark-cli commands (ms). */
const LARK_TIMEOUT_MS = 30_000;

/** Max group name length enforced by Feishu. */
export const MAX_GROUP_NAME_LENGTH = 64;

/**
 * Result of a lark-cli group creation.
 */
export interface CreateGroupResult {
  chatId: string;
  rawOutput: string;
}

/**
 * Result of a lark-cli group dissolution.
 */
export interface DissolveGroupResult {
  success: boolean;
  error: string | null;
}

/**
 * Create a workspace-scoped temp directory with a BotChatMappingStore.
 */
export function createTestWorkspace(): {
  dir: string;
  store: BotChatMappingStore;
  cleanup: () => void;
} {
  const dir = mkdtempSync(join(tmpdir(), 'chat-integ-'));
  const store = new BotChatMappingStore({
    filePath: join(dir, 'bot-chat-mapping.json'),
  });
  return {
    dir,
    store,
    cleanup: () => {
      try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
    },
  };
}

/**
 * Check whether lark-cli is available and authenticated.
 * Returns true if lark-cli can be invoked, false otherwise.
 */
export async function isLarkCliAvailable(): Promise<boolean> {
  try {
    await execFileAsync('lark-cli', ['--version'], { timeout: 5000 });
    return true;
  } catch {
    return false;
  }
}

/**
 * Create a Feishu group via lark-cli.
 *
 * Calls: `lark-cli im chat create --name "<name>" --description "<desc>"`
 *
 * Parses the chatId (oc_xxx) from stdout.
 */
export async function createGroup(
  name: string,
  description?: string,
): Promise<CreateGroupResult> {
  const args = ['im', 'chat', 'create', '--name', name];
  if (description) {
    args.push('--description', description);
  }

  const { stdout } = await execFileAsync('lark-cli', args, {
    timeout: LARK_TIMEOUT_MS,
    maxBuffer: 1024 * 1024,
  });

  // Parse chatId from output — lark-cli outputs JSON or plain text with oc_ ID
  const chatIdMatch = stdout.match(/(oc_[a-zA-Z0-9]+)/);
  if (!chatIdMatch) {
    throw new Error(`Failed to parse chatId from lark-cli output: ${stdout.trim()}`);
  }

  return { chatId: chatIdMatch[1], rawOutput: stdout.trim() };
}

/**
 * Dissolve a Feishu group via lark-cli.
 *
 * Calls: `lark-cli api DELETE /open-apis/im/v1/chats/<chatId>`
 */
export async function dissolveGroup(chatId: string): Promise<DissolveGroupResult> {
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
 * Truncate a string to max length at character boundaries (CJK-safe).
 */
export function truncate(str: string, maxLen: number): string {
  return Array.from(str).slice(0, maxLen).join('');
}
