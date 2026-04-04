/**
 * Integration tests for chats-activation.ts schedule script.
 *
 * Tests the full activation flow: pending chat → lark-cli group creation → active status.
 * Uses a mock lark-cli script to simulate the Feishu CLI tool.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdir, rm, readFile, writeFile, chmod } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = resolve(__dirname, '../../..');
const CHAT_DIR = resolve(PROJECT_ROOT, 'workspace/chats');
const MOCK_DIR = resolve(__dirname, 'mock-bin');

// Track mock behavior
let mockShouldFail = false;
let mockFailError = '';
let mockChatId = 'oc_mock_activated_12345';
let mockVersionCallCount = 0;
let mockCreateCallCount = 0;

// Helper to create a pending chat file
async function createPendingChat(id: string, overrides: Record<string, unknown> = {}): Promise<void> {
  const chatData = {
    id,
    status: 'pending',
    chatId: null,
    createdAt: '2026-01-01T00:00:00Z',
    activatedAt: null,
    expiresAt: '2099-12-31T23:59:59Z',
    createGroup: { name: `Test Group ${id}`, members: ['ou_test123'] },
    context: {},
    response: null,
    activationAttempts: 0,
    lastActivationError: null,
    failedAt: null,
    ...overrides,
  };
  await writeFile(resolve(CHAT_DIR, `${id}.json`), JSON.stringify(chatData, null, 2) + '\n', 'utf-8');
}

// Helper to read a chat file
async function readChat(id: string): Promise<Record<string, unknown>> {
  const content = await readFile(resolve(CHAT_DIR, `${id}.json`), 'utf-8');
  return JSON.parse(content);
}

// Helper to run the activation script
async function runActivation(env: Record<string, string> = {}): Promise<{ stdout: string; stderr: string; code: number }> {
  const scriptPath = resolve(PROJECT_ROOT, 'scripts/schedule/chats-activation.ts');
  const pathEnv = `${MOCK_DIR}:${process.env.PATH}`;
  try {
    const result = await execFileAsync('npx', ['tsx', scriptPath], {
      env: { ...process.env, ...env, PATH: pathEnv },
      maxBuffer: 1024 * 1024,
      cwd: PROJECT_ROOT,
      timeout: 30000,
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
  'act-pending-1', 'act-pending-2', 'act-expired-1', 'act-failed-1',
  'act-retry-1', 'act-recovery-1', 'act-invalid-name-1', 'act-invalid-member-1',
  'act-active-1', 'act-max-1', 'act-max-2', 'act-max-3', 'act-corrupted-1',
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

// Create mock lark-cli script
async function createMockLarkCli() {
  const mockScript = [
    '#!/bin/bash',
    'if [[ "$1" == "--version" ]]; then',
    '  echo "lark-cli 0.1.0"',
    '  exit 0',
    'fi',
    '',
    'if [[ "$1" == "im" && "$2" == "+chat-create" ]]; then',
    '  if [[ "$MOCK_LARK_FAIL" == "true" ]]; then',
    '    echo "$MOCK_LARK_ERROR" >&2',
    '    exit 1',
    '  fi',
    '  CID="${MOCK_LARK_CHAT_ID:-oc_mock_default_chat}"',
    '  echo "{\\"data\\":{\\"chat_id\\":\\"${CID}\\"},\\"code\\":0}"',
    '  exit 0',
    'fi',
    '',
    'echo "Unknown command: $@" >&2',
    'exit 1',
  ].join('\n');
  await mkdir(MOCK_DIR, { recursive: true });
  await writeFile(resolve(MOCK_DIR, 'lark-cli'), mockScript, 'utf-8');
  await chmod(resolve(MOCK_DIR, 'lark-cli'), 0o755);
}

describe('chats-activation schedule', () => {
  beforeEach(async () => {
    await mkdir(CHAT_DIR, { recursive: true });
    await cleanupTestFiles();
    await createMockLarkCli();

    // Reset mock behavior
    mockShouldFail = false;
    mockFailError = '';
    mockChatId = 'oc_mock_activated_12345';
    mockVersionCallCount = 0;
    mockCreateCallCount = 0;
  });

  afterEach(async () => {
    await cleanupTestFiles();
  });

  describe('successful activation', () => {
    it('should activate a pending chat via lark-cli', async () => {
      await createPendingChat('act-pending-1');

      const result = await runActivation({
        MOCK_LARK_CHAT_ID: 'oc_new_group_999',
      });

      expect(result.code).toBe(0);
      expect(result.stdout).toContain('activated');

      const chat = await readChat('act-pending-1');
      expect(chat.status).toBe('active');
      expect(chat.chatId).toBe('oc_new_group_999');
      expect(chat.activatedAt).toBeTruthy();
      expect(chat.activationAttempts).toBe(0);
      expect(chat.lastActivationError).toBeNull();
    });

    it('should activate multiple pending chats in one run', async () => {
      await createPendingChat('act-pending-1');
      await createPendingChat('act-pending-2');

      const result = await runActivation({
        MOCK_LARK_CHAT_ID: 'oc_multi_1',
      });

      expect(result.code).toBe(0);

      const chat1 = await readChat('act-pending-1');
      const chat2 = await readChat('act-pending-2');
      expect(chat1.status).toBe('active');
      expect(chat2.status).toBe('active');
    });
  });

  describe('expired chat handling', () => {
    it('should skip and mark expired pending chats', async () => {
      await createPendingChat('act-expired-1', {
        expiresAt: '2020-01-01T00:00:00Z', // Past expiry
      });

      const result = await runActivation();

      expect(result.code).toBe(0);

      const chat = await readChat('act-expired-1');
      expect(chat.status).toBe('expired');
      expect(chat.expiredAt).toBeTruthy();
    });
  });

  describe('error handling and retries', () => {
    it('should record error and increment retry count on lark-cli failure', async () => {
      await createPendingChat('act-retry-1');

      const result = await runActivation({
        MOCK_LARK_FAIL: 'true',
        MOCK_LARK_ERROR: 'API rate limit exceeded',
      });

      expect(result.code).toBe(0); // Script exits 0 even on individual failures

      const chat = await readChat('act-retry-1');
      expect(chat.status).toBe('pending');
      expect(chat.activationAttempts).toBe(1);
      expect(chat.lastActivationError).toContain('API rate limit exceeded');
    });

    it('should mark chat as failed after max retries', async () => {
      await createPendingChat('act-failed-1', {
        activationAttempts: 4, // Already tried 4 times (max is 5)
      });

      const result = await runActivation({
        MOCK_LARK_FAIL: 'true',
        MOCK_LARK_ERROR: 'Permission denied',
      });

      expect(result.code).toBe(0);

      const chat = await readChat('act-failed-1');
      expect(chat.status).toBe('failed');
      expect(chat.activationAttempts).toBe(5);
      expect(chat.lastActivationError).toContain('Permission denied');
      expect(chat.failedAt).toBeTruthy();
    });
  });

  describe('idempotent recovery', () => {
    it('should recover a chat that already has chatId to active', async () => {
      await createPendingChat('act-recovery-1', {
        chatId: 'oc_existing_group',
        activationAttempts: 2,
        lastActivationError: 'Previous error',
      });

      const result = await runActivation();

      expect(result.code).toBe(0);
      expect(result.stdout).toContain('recovering');

      const chat = await readChat('act-recovery-1');
      expect(chat.status).toBe('active');
      expect(chat.chatId).toBe('oc_existing_group');
      expect(chat.activatedAt).toBeTruthy();
      // Note: The recovery path (existing chatId) does not reset activationAttempts
      // This is a known behavior of the current implementation
      expect(chat.activationAttempts).toBe(2);
    });
  });

  describe('input validation', () => {
    it('should skip chats with invalid group name', async () => {
      await createPendingChat('act-invalid-name-1', {
        createGroup: { name: 'test; rm -rf /', members: ['ou_test123'] },
      });

      const result = await runActivation();

      expect(result.code).toBe(0);
      expect(result.stderr).toContain('Invalid group name');

      const chat = await readChat('act-invalid-name-1');
      expect(chat.status).toBe('pending'); // Unchanged
    });

    it('should skip chats with invalid member IDs', async () => {
      await createPendingChat('act-invalid-member-1', {
        createGroup: { name: 'Valid Name', members: ['not_a_valid_id'] },
      });

      const result = await runActivation();

      expect(result.code).toBe(0);
      // parseChatFile validates member format and rejects the file as corrupted
      // before the activation logic can check individual member IDs
      expect(result.stderr).toContain('corrupted');

      const chat = await readChat('act-invalid-member-1');
      expect(chat.status).toBe('pending'); // Unchanged
    });

    it('should skip chats with empty members list', async () => {
      await createPendingChat('act-invalid-member-1', {
        createGroup: { name: 'Valid Name', members: [] },
      });

      const result = await runActivation();

      expect(result.code).toBe(0);
      expect(result.stderr).toContain('No members');

      const chat = await readChat('act-invalid-member-1');
      expect(chat.status).toBe('pending'); // Unchanged
    });
  });

  describe('status filtering', () => {
    it('should skip already active chats', async () => {
      await createPendingChat('act-active-1', { status: 'active', chatId: 'oc_already_active' });

      const result = await runActivation();

      expect(result.code).toBe(0);

      const chat = await readChat('act-active-1');
      expect(chat.status).toBe('active');
      expect(chat.chatId).toBe('oc_already_active');
    });
  });

  describe('rate limiting', () => {
    it('should respect CHAT_MAX_PER_RUN limit', async () => {
      await createPendingChat('act-max-1');
      await createPendingChat('act-max-2');
      await createPendingChat('act-max-3');

      const result = await runActivation({
        CHAT_MAX_PER_RUN: '2',
      });

      expect(result.code).toBe(0);
      expect(result.stdout).toContain('max processing limit');

      // Only 2 should be processed (order may vary, but exactly 2 should be active)
      const chats = await Promise.all([
        readChat('act-max-1'),
        readChat('act-max-2'),
        readChat('act-max-3'),
      ]);
      const activeCount = chats.filter((c) => c.status === 'active').length;
      expect(activeCount).toBe(2);
    });
  });

  describe('edge cases', () => {
    it('should handle empty chat directory gracefully', async () => {
      // No chat files created
      const result = await runActivation();

      expect(result.code).toBe(0);
      expect(result.stdout).toContain('No pending chats found');
    });

    it('should skip corrupted JSON files', async () => {
      // Write a corrupted JSON file
      await writeFile(resolve(CHAT_DIR, 'act-corrupted-1.json'), 'not valid json {{{', 'utf-8');

      const result = await runActivation();

      expect(result.code).toBe(0);
      expect(result.stderr).toContain('corrupted');
    });

    it('should handle invalid CHAT_MAX_PER_RUN gracefully', async () => {
      await createPendingChat('act-pending-1');

      const result = await runActivation({
        CHAT_MAX_PER_RUN: 'invalid',
      });

      expect(result.code).toBe(0);
      // Warning is printed to stderr, script falls back to default and processes normally
      expect(result.stderr).toContain('Invalid CHAT_MAX_PER_RUN');
      expect(result.stdout).toContain('Processed');
    });
  });
});
