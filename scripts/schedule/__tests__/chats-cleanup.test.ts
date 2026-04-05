/**
 * Integration tests for chats-cleanup schedule script.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdir, rm, readFile, writeFile, stat } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = resolve(__dirname, '../../..');
const CHAT_DIR = resolve(PROJECT_ROOT, 'workspace/chats');

async function runScript(script: string, env: Record<string, string> = {}): Promise<{ stdout: string; stderr: string; code: number }> {
  const scriptPath = resolve(PROJECT_ROOT, script);
  try {
    const result = await execFileAsync('npx', ['tsx', scriptPath], {
      env: { ...process.env, ...env },
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

const TEST_IDS = ['test-cleanup-1', 'test-cleanup-2', 'test-cleanup-3', 'test-cleanup-4', 'test-cleanup-5'];

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

/** Format a Date as UTC Z-suffix ISO 8601 without milliseconds (matches UTC_DATETIME_REGEX) */
function toUTC(date: Date): string {
  return date.toISOString().replace(/\.\d{3}Z$/, 'Z');
}

function makeExpiredChat(id: string, overrides: Record<string, unknown> = {}) {
  const now = new Date();
  const oldExpiredAt = new Date(now.getTime() - 5 * 60 * 60 * 1000); // 5 hours ago
  return {
    id,
    status: 'expired',
    chatId: `oc_test_${id}`,
    createdAt: toUTC(new Date(now.getTime() - 48 * 60 * 60 * 1000)),
    activatedAt: toUTC(new Date(now.getTime() - 47 * 60 * 60 * 1000)),
    expiresAt: toUTC(oldExpiredAt),
    createGroup: { name: 'Test Group', members: ['ou_test123'] },
    context: {},
    response: null,
    activationAttempts: 0,
    lastActivationError: null,
    failedAt: null,
    expiredAt: toUTC(oldExpiredAt),
    ...overrides,
  };
}

function makeFailedChat(id: string) {
  const now = new Date();
  const oldFailedAt = new Date(now.getTime() - 5 * 60 * 60 * 1000); // 5 hours ago
  return makeExpiredChat(id, {
    status: 'failed',
    failedAt: toUTC(oldFailedAt),
    lastActivationError: 'Test error',
    expiredAt: undefined,
  });
}

function makeRecentExpiredChat(id: string) {
  const now = new Date();
  const recentExpiredAt = new Date(now.getTime() - 10 * 60 * 1000); // 10 minutes ago
  return makeExpiredChat(id, {
    expiredAt: toUTC(recentExpiredAt),
    expiresAt: toUTC(recentExpiredAt),
  });
}

describe('chats cleanup', () => {
  beforeEach(async () => {
    await mkdir(CHAT_DIR, { recursive: true });
    await cleanupTestFiles();
  });

  afterEach(async () => {
    await cleanupTestFiles();
  });

  describe('cleanup script', () => {
    it('should delete expired chats past retention period', async () => {
      const chatData = makeExpiredChat('test-cleanup-1');
      await writeFile(
        resolve(CHAT_DIR, 'test-cleanup-1.json'),
        JSON.stringify(chatData, null, 2),
        'utf-8',
      );

      const result = await runScript('scripts/schedule/chats-cleanup.ts', {
        CHAT_RETENTION_HOURS: '1',
      });

      expect(result.code).toBe(0);
      expect(result.stdout).toContain('Cleaned up');

      // Verify file deleted
      let exists = false;
      try {
        await stat(resolve(CHAT_DIR, 'test-cleanup-1.json'));
        exists = true;
      } catch {
        // File deleted as expected
      }
      expect(exists).toBe(false);
    });

    it('should delete failed chats past retention period', async () => {
      const chatData = makeFailedChat('test-cleanup-2');
      await writeFile(
        resolve(CHAT_DIR, 'test-cleanup-2.json'),
        JSON.stringify(chatData, null, 2),
        'utf-8',
      );

      const result = await runScript('scripts/schedule/chats-cleanup.ts', {
        CHAT_RETENTION_HOURS: '1',
      });

      expect(result.code).toBe(0);
      expect(result.stdout).toContain('Cleaned up');

      // Verify file deleted
      let exists = false;
      try {
        await stat(resolve(CHAT_DIR, 'test-cleanup-2.json'));
        exists = true;
      } catch {
        // File deleted as expected
      }
      expect(exists).toBe(false);
    });

    it('should skip recently expired chats within retention period', async () => {
      const chatData = makeRecentExpiredChat('test-cleanup-3');
      await writeFile(
        resolve(CHAT_DIR, 'test-cleanup-3.json'),
        JSON.stringify(chatData, null, 2),
        'utf-8',
      );

      const result = await runScript('scripts/schedule/chats-cleanup.ts', {
        CHAT_RETENTION_HOURS: '1',
      });

      expect(result.code).toBe(0);

      // Verify file still exists
      const content = await readFile(resolve(CHAT_DIR, 'test-cleanup-3.json'), 'utf-8');
      const data = JSON.parse(content);
      expect(data.id).toBe('test-cleanup-3');
      expect(data.status).toBe('expired');
    });

    it('should skip active and pending chats', async () => {
      const activeChat = { ...makeExpiredChat('test-cleanup-4'), status: 'active' };
      const pendingChat = { ...makeExpiredChat('test-cleanup-5'), status: 'pending' };

      await writeFile(resolve(CHAT_DIR, 'test-cleanup-4.json'), JSON.stringify(activeChat, null, 2), 'utf-8');
      await writeFile(resolve(CHAT_DIR, 'test-cleanup-5.json'), JSON.stringify(pendingChat, null, 2), 'utf-8');

      const result = await runScript('scripts/schedule/chats-cleanup.ts', {
        CHAT_RETENTION_HOURS: '0', // 0 hours = clean everything past retention
      });

      expect(result.code).toBe(0);

      // Both files should still exist
      const content4 = await readFile(resolve(CHAT_DIR, 'test-cleanup-4.json'), 'utf-8');
      expect(JSON.parse(content4).status).toBe('active');

      const content5 = await readFile(resolve(CHAT_DIR, 'test-cleanup-5.json'), 'utf-8');
      expect(JSON.parse(content5).status).toBe('pending');
    });

    it('should clean up orphaned lock files', async () => {
      // Create an orphaned lock file (no corresponding .json)
      const lockPath = resolve(CHAT_DIR, 'test-cleanup-1.json.lock');
      const { writeFile: writeLockFile } = await import('node:fs/promises');
      await writeLockFile(lockPath, '', 'utf-8');

      const result = await runScript('scripts/schedule/chats-cleanup.ts');

      expect(result.code).toBe(0);
      expect(result.stdout).toContain('orphaned');

      // Verify lock file deleted
      let exists = false;
      try {
        await stat(lockPath);
        exists = true;
      } catch {
        // File deleted as expected
      }
      expect(exists).toBe(false);
    });
  });
});
