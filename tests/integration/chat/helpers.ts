import { execFile } from 'child_process';
import { promisify } from 'util';
import { mkdtemp, rm } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import { BotChatMappingStore } from '@disclaude/core';

const execFileAsync = promisify(execFile);

const LARK_TIMEOUT_MS = 30_000;
const LARK_MAX_BUFFER = 1024 * 1024;

export interface CreateGroupResult {
  chatId: string;
  raw: string;
}

export interface DissolveGroupResult {
  success: boolean;
  error: string | null;
}

/**
 * Check if lark-cli is available in PATH.
 */
export async function isLarkCliAvailable(): Promise<boolean> {
  try {
    await execFileAsync('which', ['lark-cli'], { timeout: 5_000 });
    return true;
  } catch {
    return false;
  }
}

/**
 * Create a Feishu group via `lark-cli im chat create`.
 * Returns the chatId extracted from command output.
 */
export async function createGroup(name: string, description?: string): Promise<CreateGroupResult> {
  const args = ['im', 'chat', 'create', '--name', name];
  if (description) {
    args.push('--description', description);
  }

  const { stdout } = await execFileAsync('lark-cli', args, {
    timeout: LARK_TIMEOUT_MS,
    maxBuffer: LARK_MAX_BUFFER,
  });

  // Try JSON parse first (lark-cli may output JSON)
  try {
    const json = JSON.parse(stdout);
    const chatId = json?.data?.chat_id;
    if (chatId && /^oc_[a-zA-Z0-9]+$/.test(chatId)) {
      return { chatId, raw: stdout };
    }
  } catch {
    // Not JSON output — fall through to regex
  }

  // Fallback: extract first oc_xxx pattern from output
  const match = stdout.match(/(oc_[a-zA-Z0-9]+)/);
  if (match) {
    return { chatId: match[1], raw: stdout };
  }

  throw new Error(`Could not extract chatId from lark-cli output: ${stdout.slice(0, 200)}`);
}

/**
 * Dissolve a Feishu group via `lark-cli api DELETE`.
 * Follows the same error-capture pattern as rename-group.ts.
 */
export async function dissolveGroup(chatId: string): Promise<DissolveGroupResult> {
  try {
    await execFileAsync(
      'lark-cli',
      ['api', 'DELETE', `/open-apis/im/v1/chats/${chatId}`],
      { timeout: LARK_TIMEOUT_MS, maxBuffer: LARK_MAX_BUFFER },
    );
    return { success: true, error: null };
  } catch (err: unknown) {
    const e = err as { stderr?: string; message?: string };
    const errorMsg = (e.stderr ?? e.message ?? 'unknown error')
      .replace(/\n/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    return { success: false, error: errorMsg };
  }
}

/**
 * Create a temp directory with a BotChatMappingStore for isolated testing.
 */
export async function createTempStore(): Promise<{
  store: BotChatMappingStore;
  dir: string;
  cleanup: () => Promise<void>;
}> {
  const dir = await mkdtemp(join(tmpdir(), 'chat-inttest-'));
  const store = new BotChatMappingStore({ filePath: join(dir, 'bot-chat-mapping.json') });
  return {
    store,
    dir,
    cleanup: () => rm(dir, { recursive: true, force: true }),
  };
}

/**
 * CJK-safe string truncation.
 * Counts CJK characters as 2 width units, ASCII as 1.
 */
export function truncateName(name: string, maxLen: number = 64): string {
  let width = 0;
  for (let i = 0; i < name.length; i++) {
    const cp = name.codePointAt(i)!;
    width += cp > 0x7f ? 2 : 1;
    if (width > maxLen) return name.slice(0, i);
  }
  return name;
}

/**
 * Generate a unique test group name with timestamp to avoid collisions.
 */
export function testGroupName(label: string): string {
  return `[inttest] ${label} ${Date.now()}`;
}
