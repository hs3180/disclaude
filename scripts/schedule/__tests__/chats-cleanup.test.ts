/**
 * Integration tests for chats-cleanup.ts schedule script.
 *
 * Tests the cleanup flow: expired/failed chats past grace period → file removal.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdir, rm, writeFile, stat } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = resolve(__dirname, '../../..');
const CHAT_DIR = resolve(PROJECT_ROOT, 'workspace/chats');

// Helper to create a chat file
async function createChat(id: string, overrides: Record<string, unknown> = {}): Promise<void> {
  const chatData = {
    id,
    status: 'expired',
    chatId: 'oc_test',
    createdAt: '2026-01-01T00:00:00Z',
    activatedAt: '2026-01-01T00:01:00Z',
    expiresAt: '2026-01-02T00:00:00Z',
    expiredAt: '2026-01-02T00:00:00Z',
    createGroup: { name: 'Test', members: ['ou_test123'] },
    context: {},
    response: null,
    activationAttempts: 0,
    lastActivationError: null,
    failedAt: null,
    ...overrides,
  };
  await writeFile(resolve(CHAT_DIR, `${id}.json`), JSON.stringify(chatData, null, 2) + '\n', 'utf-8');
}

// Helper to check if a file exists
async function fileExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

// Helper to run the cleanup script
async function runCleanup(env: Record<string, string> = {}): Promise<{ stdout: string; stderr: string; code: number }> {
  const scriptPath = resolve(PROJECT_ROOT, 'scripts/schedule/chats-cleanup.ts');
  try {
    const result = await execFileAsync('npx', ['tsx', scriptPath], {
      env: { ...process.env, ...env },
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

const CLEANUP_TEST_IDS = [
  'cleanup-expired-old', 'cleanup-expired-recent', 'cleanup-failed-old',
  'cleanup-failed-recent', 'cleanup-pending-1', 'cleanup-active-1',
  'cleanup-orphan-lock',
];

async function cleanupTestFiles() {
  for (const id of CLEANUP_TEST_IDS) {
    try {
      await rm(resolve(CHAT_DIR, `${id}.json`), { force: true });
      await rm(resolve(CHAT_DIR, `${id}.json.lock`), { force: true });
      await rm(resolve(CHAT_DIR, 'orphan-lock.json.lock'), { force: true });
    } catch {
      // Ignore
    }
  }
}

// Create a chat that expired a long time ago (past default grace period of 24h)
async function createOldExpiredChat(id: string): Promise<void> {
  await createChat(id, {
    status: 'expired',
    expiredAt: '2020-01-01T00:00:00Z', // Very old
  });
}

// Create a chat that expired recently (within grace period)
async function createRecentExpiredChat(id: string): Promise<void> {
  const recentExpiry = new Date(Date.now() - 1000 * 60 * 60); // 1 hour ago
  await createChat(id, {
    status: 'expired',
    expiredAt: recentExpiry.toISOString(),
  });
}

// Create a chat that failed a long time ago
async function createOldFailedChat(id: string): Promise<void> {
  await createChat(id, {
    status: 'failed',
    failedAt: '2020-01-01T00:00:00Z', // Very old
    expiresAt: '2099-12-31T23:59:59Z',
    expiredAt: null,
  });
}

// Create a chat that failed recently
async function createRecentFailedChat(id: string): Promise<void> {
  const recentFailure = new Date(Date.now() - 1000 * 60 * 60); // 1 hour ago
  await createChat(id, {
    status: 'failed',
    failedAt: recentFailure.toISOString(),
    expiresAt: '2099-12-31T23:59:59Z',
    expiredAt: null,
  });
}

describe('chats-cleanup schedule', () => {
  beforeEach(async () => {
    await mkdir(CHAT_DIR, { recursive: true });
    await cleanupTestFiles();
  });

  afterEach(async () => {
    await cleanupTestFiles();
  });

  describe('expired chat cleanup', () => {
    it('should remove expired chats past grace period', async () => {
      await createOldExpiredChat('cleanup-expired-old');

      const result = await runCleanup();

      expect(result.code).toBe(0);
      expect(result.stdout).toContain('Cleaned up');
      expect(await fileExists(resolve(CHAT_DIR, 'cleanup-expired-old.json'))).toBe(false);
    });

    it('should keep expired chats within grace period', async () => {
      await createRecentExpiredChat('cleanup-expired-recent');

      const result = await runCleanup();

      expect(result.code).toBe(0);
      expect(result.stdout).toContain('No chats to clean up');
      expect(await fileExists(resolve(CHAT_DIR, 'cleanup-expired-recent.json'))).toBe(true);
    });
  });

  describe('failed chat cleanup', () => {
    it('should remove failed chats past grace period', async () => {
      await createOldFailedChat('cleanup-failed-old');

      const result = await runCleanup();

      expect(result.code).toBe(0);
      expect(result.stdout).toContain('Cleaned up');
      expect(await fileExists(resolve(CHAT_DIR, 'cleanup-failed-old.json'))).toBe(false);
    });

    it('should keep failed chats within grace period', async () => {
      await createRecentFailedChat('cleanup-failed-recent');

      const result = await runCleanup();

      expect(result.code).toBe(0);
      expect(await fileExists(resolve(CHAT_DIR, 'cleanup-failed-recent.json'))).toBe(true);
    });
  });

  describe('non-cleanup targets', () => {
    it('should not touch pending chats', async () => {
      await createChat('cleanup-pending-1', {
        status: 'pending',
        chatId: null,
        expiredAt: null,
        failedAt: null,
        expiresAt: '2099-12-31T23:59:59Z',
      });

      const result = await runCleanup();

      expect(result.code).toBe(0);
      expect(await fileExists(resolve(CHAT_DIR, 'cleanup-pending-1.json'))).toBe(true);
    });

    it('should not touch active chats', async () => {
      await createChat('cleanup-active-1', {
        status: 'active',
        expiredAt: null,
        failedAt: null,
      });

      const result = await runCleanup();

      expect(result.code).toBe(0);
      expect(await fileExists(resolve(CHAT_DIR, 'cleanup-active-1.json'))).toBe(true);
    });
  });

  describe('orphaned lock files', () => {
    it('should remove orphaned lock files', async () => {
      // Create an orphaned lock file (no corresponding JSON)
      await writeFile(resolve(CHAT_DIR, 'orphan-lock.json.lock'), '', 'utf-8');

      const result = await runCleanup();

      expect(result.code).toBe(0);
      expect(result.stdout).toContain('orphaned lock file');
      expect(await fileExists(resolve(CHAT_DIR, 'orphan-lock.json.lock'))).toBe(false);
    });

    it('should not remove lock files with corresponding JSON', async () => {
      await createChat('cleanup-active-1', { status: 'active', expiredAt: null, failedAt: null });
      await writeFile(resolve(CHAT_DIR, 'cleanup-active-1.json.lock'), '', 'utf-8');

      const result = await runCleanup();

      expect(result.code).toBe(0);
      expect(await fileExists(resolve(CHAT_DIR, 'cleanup-active-1.json.lock'))).toBe(true);
    });
  });

  describe('configuration', () => {
    it('should respect CHAT_CLEANUP_GRACE_HOURS', async () => {
      // Create a chat that expired 2 hours ago
      const twoHoursAgo = new Date(Date.now() - 1000 * 60 * 60 * 2);
      await createChat('cleanup-expired-recent', {
        status: 'expired',
        expiredAt: twoHoursAgo.toISOString(),
      });

      // With 1 hour grace, it should be cleaned
      const result = await runCleanup({ CHAT_CLEANUP_GRACE_HOURS: '1' });

      expect(result.code).toBe(0);
      expect(result.stdout).toContain('Cleaned up');
      expect(await fileExists(resolve(CHAT_DIR, 'cleanup-expired-recent.json'))).toBe(false);
    });

    it('should respect CHAT_CLEANUP_MAX_PER_RUN', async () => {
      await createOldExpiredChat('cleanup-expired-old-1');
      await createOldExpiredChat('cleanup-expired-old-2');

      const result = await runCleanup({ CHAT_CLEANUP_MAX_PER_RUN: '1' });

      expect(result.code).toBe(0);
      expect(result.stdout).toContain('max cleanup limit');

      // Exactly 1 should be cleaned (the other remains)
      const remaining = (await fileExists(resolve(CHAT_DIR, 'cleanup-expired-old-1.json')))
        + (await fileExists(resolve(CHAT_DIR, 'cleanup-expired-old-2.json')));
      expect(remaining).toBe(1);
    });

    it('should handle invalid CHAT_CLEANUP_GRACE_HOURS gracefully', async () => {
      await createOldExpiredChat('cleanup-expired-old');

      const result = await runCleanup({ CHAT_CLEANUP_GRACE_HOURS: 'invalid' });

      expect(result.code).toBe(0);
      // Warning is printed to stderr, falls back to default grace period
      expect(result.stderr).toContain('Invalid CHAT_CLEANUP_GRACE_HOURS');
    });
  });

  describe('edge cases', () => {
    it('should handle empty chat directory gracefully', async () => {
      const result = await runCleanup();

      expect(result.code).toBe(0);
      expect(result.stdout).toContain('No chats to clean up');
    });

    it('should skip corrupted JSON files', async () => {
      await writeFile(resolve(CHAT_DIR, 'corrupted-cleanup.json'), 'not valid json', 'utf-8');

      const result = await runCleanup();

      expect(result.code).toBe(0);
      expect(result.stderr).toContain('corrupted');
    });

    it('should remove lock file along with cleaned chat', async () => {
      await createOldExpiredChat('cleanup-expired-old');
      await writeFile(resolve(CHAT_DIR, 'cleanup-expired-old.json.lock'), '', 'utf-8');

      const result = await runCleanup();

      expect(result.code).toBe(0);
      expect(await fileExists(resolve(CHAT_DIR, 'cleanup-expired-old.json'))).toBe(false);
      expect(await fileExists(resolve(CHAT_DIR, 'cleanup-expired-old.json.lock'))).toBe(false);
    });

    it('should handle missing chat directory gracefully', async () => {
      // Remove the chat directory
      await rm(CHAT_DIR, { recursive: true, force: true });

      const result = await runCleanup();

      expect(result.code).toBe(0);
      expect(result.stdout).toContain('does not exist');
    });
  });
});
