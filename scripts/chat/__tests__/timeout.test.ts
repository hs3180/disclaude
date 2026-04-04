/**
 * Unit tests for chat timeout script.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdir, rm, readFile, writeFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = resolve(__dirname, '../../..');
const CHAT_DIR = resolve(PROJECT_ROOT, 'workspace/chats');
const SCRIPT_PATH = resolve(PROJECT_ROOT, 'scripts/chat/timeout.ts');
const MOCK_BIN_DIR = resolve(__dirname, 'mock-bin');

interface ChatData {
  id: string;
  status: string;
  chatId: string | null;
  createdAt: string;
  activatedAt: string | null;
  expiresAt: string;
  createGroup: { name: string; members: string[] };
  context: Record<string, unknown>;
  response: null | { content: string; responder: string; repliedAt: string };
  activationAttempts: number;
  lastActivationError: string | null;
  failedAt: string | null;
}

function makeChat(overrides: Partial<ChatData> = {}): ChatData {
  return {
    id: 'test-timeout-1',
    status: 'active',
    chatId: 'oc_testchat',
    createdAt: '2026-03-24T10:00:00Z',
    activatedAt: '2026-03-24T10:01:00Z',
    expiresAt: '2026-03-24T10:00:00Z', // Already expired
    createGroup: { name: 'Test Chat', members: ['ou_testuser'] },
    context: {},
    response: null,
    activationAttempts: 0,
    lastActivationError: null,
    failedAt: null,
    ...overrides,
  };
}

async function writeChatFile(id: string, data: ChatData): Promise<void> {
  await writeFile(resolve(CHAT_DIR, `${id}.json`), JSON.stringify(data, null, 2) + '\n');
}

async function readChatFile(id: string): Promise<ChatData> {
  const content = await readFile(resolve(CHAT_DIR, `${id}.json`), 'utf-8');
  return JSON.parse(content);
}

/**
 * Run the timeout script with mock lark-cli in PATH.
 */
async function runTimeoutScript(env: Record<string, string> = {}): Promise<{ stdout: string; stderr: string; code: number }> {
  // Prepend mock bin directory to PATH so lark-cli is available
  const pathDelimiter = process.platform === 'win32' ? ';' : ':';
  const currentPath = process.env.PATH ?? '';
  const newPath = env.PATH ?? `${MOCK_BIN_DIR}${pathDelimiter}${currentPath}`;

  try {
    const result = await execFileAsync('npx', ['tsx', SCRIPT_PATH], {
      env: { ...process.env, PATH: newPath, ...env },
      maxBuffer: 1024 * 1024,
      cwd: PROJECT_ROOT,
    });
    return { stdout: result.stdout, stderr: result.stderr, code: 0 };
  } catch (err: unknown) {
    const execErr = err as { stdout?: string; stderr?: string; code?: number };
    return {
      stdout: execErr.stdout ?? '',
      stderr: execErr.stderr ?? '',
      code: execErr.code ?? 1,
    };
  }
}

const TEST_IDS = [
  'test-timeout-1',
  'test-timeout-2',
  'test-timeout-3',
  'test-timeout-4',
  'test-timeout-5',
  'test-timeout-pending',
  'test-timeout-failed',
  'test-timeout-future',
];

async function cleanupTestFiles() {
  for (const id of TEST_IDS) {
    try {
      await rm(resolve(CHAT_DIR, `${id}.json`), { force: true });
      await rm(resolve(CHAT_DIR, `${id}.json.lock`), { force: true });
    } catch {
      // Ignore
    }
  }
}

describe('chat timeout script', () => {
  beforeEach(async () => {
    await mkdir(CHAT_DIR, { recursive: true });
    await cleanupTestFiles();
  });

  afterEach(async () => {
    await cleanupTestFiles();
  });

  it('should exit with error when lark-cli is not available', async () => {
    // Use a PATH that has npx/node but NOT lark-cli
    // Extract system paths (exclude mock-bin) to ensure lark-cli is missing
    const systemPath = (process.env.PATH ?? '')
      .split(':')
      .filter((p) => !p.includes('mock-bin'))
      .join(':');
    const result = await runTimeoutScript({ PATH: systemPath });
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('lark-cli');
  });

  it('should report no timed-out chats when directory is empty', async () => {
    const result = await runTimeoutScript();
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('No timed-out');
  });

  it('should skip non-active chats (pending, expired, failed)', async () => {
    await writeChatFile('test-timeout-pending', makeChat({ id: 'test-timeout-pending', status: 'pending', expiresAt: '2026-01-01T00:00:00Z' }));
    await writeChatFile('test-timeout-failed', makeChat({ id: 'test-timeout-failed', status: 'failed', expiresAt: '2026-01-01T00:00:00Z' }));
    // Create an already-expired chat that should NOT be picked up (not active)
    const alreadyExpired = makeChat({ id: 'test-timeout-5', status: 'expired', expiresAt: '2026-01-01T00:00:00Z' });
    await writeChatFile('test-timeout-5', alreadyExpired);

    const result = await runTimeoutScript();
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('No timed-out');
  });

  it('should skip active chats that have not yet expired', async () => {
    // Set expiresAt far in the future
    const futureChat = makeChat({ id: 'test-timeout-future', expiresAt: '2099-12-31T23:59:59Z' });
    await writeChatFile('test-timeout-future', futureChat);

    const result = await runTimeoutScript();
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('No timed-out');
  });

  it('should detect and mark timed-out active chat as expired', async () => {
    const expiredChat = makeChat({ id: 'test-timeout-1', chatId: null }); // No chatId, no dissolution needed
    await writeChatFile('test-timeout-1', expiredChat);

    const result = await runTimeoutScript();
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('expired');

    const updated = await readChatFile('test-timeout-1');
    expect(updated.status).toBe('expired');
    expect(updated.expiredAt).toBeDefined();
  });

  it('should mark timed-out chat as expired and dissolve group when no response', async () => {
    const expiredChat = makeChat({ id: 'test-timeout-2', chatId: 'oc_dissolve_test' });
    await writeChatFile('test-timeout-2', expiredChat);

    const result = await runTimeoutScript();
    expect(result.code).toBe(0);

    const updated = await readChatFile('test-timeout-2');
    expect(updated.status).toBe('expired');
    expect(updated.expiredAt).toBeDefined();

    // With mock lark-cli, dissolution should succeed
    expect(result.stdout).toContain('test-timeout-2');
    expect(result.stdout).toContain('Dissolved group');
  });

  it('should mark timed-out chat as expired without dissolution when user has responded', async () => {
    const respondedChat = makeChat({
      id: 'test-timeout-3',
      chatId: 'oc_responded_test',
      response: {
        content: 'Approved',
        responder: 'ou_testuser',
        repliedAt: '2026-03-24T09:30:00Z',
      },
    });
    await writeChatFile('test-timeout-3', respondedChat);

    const result = await runTimeoutScript();
    expect(result.code).toBe(0);

    const updated = await readChatFile('test-timeout-3');
    expect(updated.status).toBe('expired');
    expect(updated.expiredAt).toBeDefined();

    // Should NOT attempt dissolution (user has responded)
    expect(result.stdout).toContain('has user response');
    expect(result.stdout).not.toContain('Dissolved group oc_responded_test');
  });

  it('should skip chats with non-standard expiresAt format (fail-open)', async () => {
    const nonStandardChat = makeChat({
      id: 'test-timeout-4',
      expiresAt: '2026-03-24T10:00:00+08:00', // Non-Z-suffix format
    });
    await writeChatFile('test-timeout-4', nonStandardChat);

    const result = await runTimeoutScript();
    expect(result.code).toBe(0);

    // Should not be picked up (fail-open)
    expect(result.stdout).toContain('No timed-out');

    const unchanged = await readChatFile('test-timeout-4');
    expect(unchanged.status).toBe('active');
  });

  it('should skip corrupted JSON files gracefully', async () => {
    await writeFile(resolve(CHAT_DIR, 'test-timeout-1.json'), 'not valid json {{{');
    await writeFile(resolve(CHAT_DIR, 'test-timeout-2.json'), JSON.stringify(makeChat({ id: 'test-timeout-2', chatId: null })));

    const result = await runTimeoutScript();
    expect(result.code).toBe(0);
    expect(result.stderr).toContain('corrupted');

    // Valid file should still be processed
    const updated = await readChatFile('test-timeout-2');
    expect(updated.status).toBe('expired');
  });

  it('should respect CHAT_MAX_PER_RUN limit', async () => {
    // Create 3 timed-out chats, set max to 1
    for (let i = 1; i <= 3; i++) {
      const chat = makeChat({ id: `test-timeout-${i}`, chatId: null });
      await writeChatFile(`test-timeout-${i}`, chat);
    }

    const result = await runTimeoutScript({ CHAT_MAX_PER_RUN: '1' });
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('max processing limit');

    // Only 1 should be processed
    let expiredCount = 0;
    for (let i = 1; i <= 3; i++) {
      try {
        const chat = await readChatFile(`test-timeout-${i}`);
        if (chat.status === 'expired') expiredCount++;
      } catch {
        // File not found
      }
    }
    expect(expiredCount).toBeLessThanOrEqual(1);
  });

  it('should handle chat directory not existing', async () => {
    // Remove the chat directory
    await rm(CHAT_DIR, { recursive: true, force: true });

    const result = await runTimeoutScript();
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('does not exist');
  });

  it('should output summary with correct stats', async () => {
    await writeChatFile('test-timeout-1', makeChat({ id: 'test-timeout-1', chatId: null }));
    await writeChatFile('test-timeout-2', makeChat({ id: 'test-timeout-2', chatId: 'oc_test' }));

    const result = await runTimeoutScript();
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('Summary');
    expect(result.stdout).toContain('checked: 2');
    expect(result.stdout).toContain('expired: 2');
  });
});
