/**
 * Integration tests for chats-activation schedule script.
 *
 * Tests the actual file handling, expiry pre-check, and idempotent recovery
 * logic by running the schedule script with CHAT_SKIP_LARK_CHECK=1.
 * This ensures the state transitions and file operations work correctly
 * without requiring lark-cli to be installed.
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

async function runScript(env: Record<string, string> = {}): Promise<{ stdout: string; stderr: string; code: number }> {
  const scriptPath = resolve(PROJECT_ROOT, 'schedules/chats-activation.ts');
  try {
    const result = await execFileAsync('npx', ['tsx', scriptPath], {
      env: { ...process.env, CHAT_SKIP_LARK_CHECK: '1', ...env },
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
  'test-int-act-1',
  'test-int-act-2',
  'test-int-act-3',
  'test-int-act-4',
  'test-int-act-5',
  'test-int-act-6',
  'test-int-act-7',
  'test-int-act-8',
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

function makeChatData(id: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    status: 'pending',
    chatId: null,
    createdAt: '2026-01-01T00:00:00Z',
    activatedAt: null,
    expiresAt: '2099-12-31T23:59:59Z',
    expiredAt: null,
    createGroup: { name: 'Test Group', members: ['ou_test123'] },
    context: {},
    response: null,
    activationAttempts: 0,
    lastActivationError: null,
    failedAt: null,
    ...overrides,
  };
}

describe('chats-activation integration', () => {
  beforeEach(async () => {
    await mkdir(CHAT_DIR, { recursive: true });
    await cleanupTestFiles();
  });

  afterEach(async () => {
    await cleanupTestFiles();
  });

  describe('no pending chats', () => {
    it('should exit with success when no chats directory exists', async () => {
      await rm(CHAT_DIR, { recursive: true, force: true });
      const result = await runScript();
      expect(result.code).toBe(0);
      expect(result.stdout).toContain('No pending chats');
    });

    it('should exit with success when directory is empty', async () => {
      const result = await runScript();
      expect(result.code).toBe(0);
      expect(result.stdout).toContain('No pending chats');
    });

    it('should skip non-pending chats', async () => {
      await writeFile(
        resolve(CHAT_DIR, 'test-int-act-1.json'),
        JSON.stringify(makeChatData('test-int-act-1', { status: 'active', chatId: 'oc_existing' }), null, 2),
        'utf-8',
      );
      const result = await runScript();
      expect(result.code).toBe(0);
      expect(result.stdout).toContain('No pending chats');
    });
  });

  describe('expiry pre-check', () => {
    it('should mark expired pending chats as expired without activating', async () => {
      await writeFile(
        resolve(CHAT_DIR, 'test-int-act-1.json'),
        JSON.stringify(makeChatData('test-int-act-1', { expiresAt: '2020-01-01T00:00:00Z' }), null, 2),
        'utf-8',
      );

      const result = await runScript();
      expect(result.code).toBe(0);
      expect(result.stdout).toContain('expired at 2020-01-01T00:00:00Z');

      // Verify the file was updated to expired
      const content = await readFile(resolve(CHAT_DIR, 'test-int-act-1.json'), 'utf-8');
      const data = JSON.parse(content);
      expect(data.status).toBe('expired');
      expect(data.expiredAt).toBeTruthy();
    });

    it('should not mark non-expired pending chats as expired', async () => {
      await writeFile(
        resolve(CHAT_DIR, 'test-int-act-1.json'),
        JSON.stringify(makeChatData('test-int-act-1', { expiresAt: '2099-12-31T23:59:59Z' }), null, 2),
        'utf-8',
      );

      const result = await runScript();
      expect(result.code).toBe(0);

      // The file should still be pending (lark-cli not available, so activation fails)
      const content = await readFile(resolve(CHAT_DIR, 'test-int-act-1.json'), 'utf-8');
      const data = JSON.parse(content);
      expect(data.status).toBe('pending');
    });

    it('should handle mixed expired and non-expired pending chats', async () => {
      // Expired pending
      await writeFile(
        resolve(CHAT_DIR, 'test-int-act-1.json'),
        JSON.stringify(makeChatData('test-int-act-1', { expiresAt: '2020-01-01T00:00:00Z' }), null, 2),
        'utf-8',
      );
      // Non-expired pending
      await writeFile(
        resolve(CHAT_DIR, 'test-int-act-2.json'),
        JSON.stringify(makeChatData('test-int-act-2', { expiresAt: '2099-12-31T23:59:59Z' }), null, 2),
        'utf-8',
      );

      const result = await runScript();
      expect(result.code).toBe(0);

      // Expired one should be marked
      const expired = JSON.parse(await readFile(resolve(CHAT_DIR, 'test-int-act-1.json'), 'utf-8'));
      expect(expired.status).toBe('expired');

      // Non-expired one should still be pending
      const pending = JSON.parse(await readFile(resolve(CHAT_DIR, 'test-int-act-2.json'), 'utf-8'));
      expect(pending.status).toBe('pending');
    });
  });

  describe('idempotent recovery', () => {
    it('should recover pending chats that already have a chatId to active', async () => {
      await writeFile(
        resolve(CHAT_DIR, 'test-int-act-1.json'),
        JSON.stringify(
          makeChatData('test-int-act-1', {
            status: 'pending',
            chatId: 'oc_already_created',
            expiresAt: '2099-12-31T23:59:59Z',
          }),
          null,
          2,
        ),
        'utf-8',
      );

      const result = await runScript();
      expect(result.code).toBe(0);
      expect(result.stdout).toContain('recovering to active');

      const content = await readFile(resolve(CHAT_DIR, 'test-int-act-1.json'), 'utf-8');
      const data = JSON.parse(content);
      expect(data.status).toBe('active');
      expect(data.activatedAt).toBeTruthy();
    });
  });

  describe('activation failure handling', () => {
    it('should increment activationAttempts when lark-cli fails', async () => {
      await writeFile(
        resolve(CHAT_DIR, 'test-int-act-1.json'),
        JSON.stringify(makeChatData('test-int-act-1', { expiresAt: '2099-12-31T23:59:59Z' }), null, 2),
        'utf-8',
      );

      const result = await runScript();
      expect(result.code).toBe(0);

      const content = await readFile(resolve(CHAT_DIR, 'test-int-act-1.json'), 'utf-8');
      const data = JSON.parse(content);
      // lark-cli call will fail (mocked skip doesn't create groups), should record error
      expect(data.activationAttempts).toBeGreaterThanOrEqual(1);
      expect(data.lastActivationError).toBeTruthy();
    });

    it('should mark chat as failed after max retries', async () => {
      await writeFile(
        resolve(CHAT_DIR, 'test-int-act-1.json'),
        JSON.stringify(
          makeChatData('test-int-act-1', {
            expiresAt: '2099-12-31T23:59:59Z',
            activationAttempts: 4, // One more attempt will trigger failure
          }),
          null,
          2,
        ),
        'utf-8',
      );

      const result = await runScript();
      expect(result.code).toBe(0);

      const content = await readFile(resolve(CHAT_DIR, 'test-int-act-1.json'), 'utf-8');
      const data = JSON.parse(content);
      expect(data.status).toBe('failed');
      expect(data.failedAt).toBeTruthy();
      expect(data.activationAttempts).toBe(5);
    });
  });

  describe('invalid data handling', () => {
    it('should skip chats with corrupted JSON', async () => {
      await writeFile(resolve(CHAT_DIR, 'test-int-act-1.json'), 'not valid json {{{', 'utf-8');
      // Also add a valid pending chat to ensure processing continues
      await writeFile(
        resolve(CHAT_DIR, 'test-int-act-2.json'),
        JSON.stringify(makeChatData('test-int-act-2', { expiresAt: '2020-01-01T00:00:00Z' }), null, 2),
        'utf-8',
      );

      const result = await runScript();
      expect(result.code).toBe(0);
      expect(result.stderr).toContain('corrupted');

      // The valid expired chat should still be processed
      const expired = JSON.parse(await readFile(resolve(CHAT_DIR, 'test-int-act-2.json'), 'utf-8'));
      expect(expired.status).toBe('expired');
    });

    it('should skip chats with invalid group names', async () => {
      await writeFile(
        resolve(CHAT_DIR, 'test-int-act-1.json'),
        JSON.stringify(
          makeChatData('test-int-act-1', {
            expiresAt: '2099-12-31T23:59:59Z',
            createGroup: { name: 'bad;name`cmd`', members: ['ou_test123'] },
          }),
          null,
          2,
        ),
        'utf-8',
      );

      const result = await runScript();
      expect(result.code).toBe(0);
      expect(result.stderr).toContain('unsafe characters');
    });

    it('should skip chats with invalid member IDs', async () => {
      await writeFile(
        resolve(CHAT_DIR, 'test-int-act-1.json'),
        JSON.stringify(
          makeChatData('test-int-act-1', {
            expiresAt: '2099-12-31T23:59:59Z',
            createGroup: { name: 'Test', members: ['invalid_member'] },
          }),
          null,
          2,
        ),
        'utf-8',
      );

      const result = await runScript();
      expect(result.code).toBe(0);
      // Invalid members fail schema validation during parseChatFile, logged as corrupted
      expect(result.stderr).toContain('corrupted');
    });
  });

  describe('rate limiting', () => {
    it('should respect CHAT_MAX_PER_RUN limit for activation attempts', async () => {
      // Create 3 non-expired pending chats (will attempt activation but fail)
      for (let i = 1; i <= 3; i++) {
        await writeFile(
          resolve(CHAT_DIR, `test-int-act-${i}.json`),
          JSON.stringify(makeChatData(`test-int-act-${i}`, { expiresAt: '2099-12-31T23:59:59Z' }), null, 2),
          'utf-8',
        );
      }

      const result = await runScript({ CHAT_MAX_PER_RUN: '2' });
      expect(result.code).toBe(0);
      expect(result.stdout).toContain('Reached max processing limit');
    });
  });
});
