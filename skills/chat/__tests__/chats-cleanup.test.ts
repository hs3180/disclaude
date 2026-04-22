/**
 * Unit tests for chats-cleanup schedule script.
 *
 * Tests the cleanup of orphaned .lock files, leftover .tmp files,
 * and .stale.* files in workspace/chats/.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdir, rm, writeFile, readFile, stat } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = resolve(__dirname, '../../..');
const CHAT_DIR_RESOLVED = resolve(PROJECT_ROOT, 'workspace/chats');

const TEST_PREFIX = 'test-cleanup-';

function testId(name: string) {
  return `${TEST_PREFIX}${name}`;
}

const ALL_TEST_IDS = [
  testId('orphan-lock'),
  testId('active-lock'),
  testId('tmp-file'),
  testId('stale-file'),
  testId('young-lock'),
  testId('young-tmp'),
];

async function cleanupTestFiles() {
  for (const id of ALL_TEST_IDS) {
    for (const ext of ['.json', '.json.lock', '.json.tmp', `.json.stale.${process.pid}`]) {
      try {
        await rm(resolve(CHAT_DIR_RESOLVED, `${id}${ext}`), { force: true });
      } catch {
        // Ignore
      }
    }
    // Also clean up numbered tmp files
    try {
      const dir = await import('node:fs/promises').then(m => m.readdir(CHAT_DIR_RESOLVED));
      for (const f of dir) {
        if (f.startsWith(id) && (f.endsWith('.tmp') || f.includes('.stale.'))) {
          await rm(resolve(CHAT_DIR_RESOLVED, f), { force: true });
        }
      }
    } catch {
      // Ignore
    }
  }
}

function makeChatData(id: string, status: string) {
  return {
    id,
    status,
    chatId: status === 'active' ? 'oc_existing' : null,
    createdAt: '2026-01-01T00:00:00Z',
    activatedAt: status === 'active' ? '2026-01-01T00:01:00Z' : null,
    expiresAt: '2099-12-31T23:59:59Z',
    createGroup: { name: 'Test Group', members: ['ou_test123'] },
    context: {},
    response: null,
    activationAttempts: 0,
    lastActivationError: null,
    failedAt: null,
    expiredAt: null,
  };
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

describe('chats-cleanup', () => {
  beforeEach(async () => {
    await mkdir(CHAT_DIR_RESOLVED, { recursive: true });
    await cleanupTestFiles();
  });

  afterEach(async () => {
    await cleanupTestFiles();
  });

  describe('orphan lock file cleanup', () => {
    it('should remove orphaned .lock file when .json does not exist', async () => {
      const id = testId('orphan-lock');
      const lockPath = resolve(CHAT_DIR_RESOLVED, `${id}.json.lock`);

      // Create only the .lock file (no .json)
      await writeFile(lockPath, `${process.pid}\n${Date.now() - 120000}\n`, 'utf-8');
      expect(await fileExists(lockPath)).toBe(true);

      // Run cleanup
      const { stdout, stderr } = await execFileAsync(
        'npx',
        ['tsx', resolve(PROJECT_ROOT, 'schedules/chats-cleanup.ts')],
        {
          cwd: PROJECT_ROOT,
          env: { ...process.env, CLEANUP_LOCK_MIN_AGE_SECONDS: '1' },
          timeout: 30000,
        },
      );

      // Lock file should be removed
      expect(await fileExists(lockPath)).toBe(false);
      expect(stdout).toContain('orphan lock');
    });

    it('should preserve .lock file when corresponding .json exists', async () => {
      const id = testId('active-lock');
      const jsonPath = resolve(CHAT_DIR_RESOLVED, `${id}.json`);
      const lockPath = resolve(CHAT_DIR_RESOLVED, `${id}.json.lock`);

      // Create both .json and .lock
      await writeFile(jsonPath, JSON.stringify(makeChatData(id, 'active'), null, 2), 'utf-8');
      await writeFile(lockPath, `${process.pid}\n${Date.now() - 120000}\n`, 'utf-8');

      // Run cleanup
      await execFileAsync(
        'npx',
        ['tsx', resolve(PROJECT_ROOT, 'schedules/chats-cleanup.ts')],
        {
          cwd: PROJECT_ROOT,
          env: { ...process.env, CLEANUP_LOCK_MIN_AGE_SECONDS: '1' },
          timeout: 30000,
        },
      );

      // Lock file should be preserved (json still exists)
      expect(await fileExists(lockPath)).toBe(true);
    });

    it('should skip .lock files that are too recent', async () => {
      const id = testId('young-lock');
      const lockPath = resolve(CHAT_DIR_RESOLVED, `${id}.json.lock`);

      // Create a very recent .lock file (no .json)
      await writeFile(lockPath, `${process.pid}\n${Date.now()}\n`, 'utf-8');

      // Run cleanup with high min age
      await execFileAsync(
        'npx',
        ['tsx', resolve(PROJECT_ROOT, 'schedules/chats-cleanup.ts')],
        {
          cwd: PROJECT_ROOT,
          env: { ...process.env, CLEANUP_LOCK_MIN_AGE_SECONDS: '3600' },
          timeout: 30000,
        },
      );

      // Lock file should be preserved (too recent)
      expect(await fileExists(lockPath)).toBe(true);
    });
  });

  describe('temp file cleanup', () => {
    it('should remove old .tmp files', async () => {
      const id = testId('tmp-file');
      const tmpPath = resolve(CHAT_DIR_RESOLVED, `${id}.json.${Date.now()}.tmp`);

      // Create a .tmp file with old timestamp
      await writeFile(tmpPath, JSON.stringify(makeChatData(id, 'pending'), null, 2), 'utf-8');

      // Manually set mtime to 2 minutes ago (workaround for filesystem time granularity)
      const twoMinutesAgo = new Date(Date.now() - 120000);
      const { utimes } = await import('node:fs/promises');
      await utimes(tmpPath, twoMinutesAgo, twoMinutesAgo);

      // Run cleanup
      await execFileAsync(
        'npx',
        ['tsx', resolve(PROJECT_ROOT, 'schedules/chats-cleanup.ts')],
        {
          cwd: PROJECT_ROOT,
          env: { ...process.env, CLEANUP_LOCK_MIN_AGE_SECONDS: '1' },
          timeout: 30000,
        },
      );

      // .tmp file should be removed
      expect(await fileExists(tmpPath)).toBe(false);
    });

    it('should skip .tmp files that are too recent', async () => {
      const id = testId('young-tmp');
      const tmpPath = resolve(CHAT_DIR_RESOLVED, `${id}.json.${Date.now()}.tmp`);

      // Create a very recent .tmp file
      await writeFile(tmpPath, JSON.stringify(makeChatData(id, 'pending'), null, 2), 'utf-8');

      // Run cleanup with high min age
      await execFileAsync(
        'npx',
        ['tsx', resolve(PROJECT_ROOT, 'schedules/chats-cleanup.ts')],
        {
          cwd: PROJECT_ROOT,
          env: { ...process.env, CLEANUP_LOCK_MIN_AGE_SECONDS: '3600' },
          timeout: 30000,
        },
      );

      // .tmp file should be preserved (too recent)
      expect(await fileExists(tmpPath)).toBe(true);
    });
  });

  describe('stale file cleanup', () => {
    it('should remove old .stale.* files', async () => {
      const id = testId('stale-file');
      const stalePath = resolve(CHAT_DIR_RESOLVED, `${id}.json.lock.stale.${process.pid}`);

      // Create a .stale file with old timestamp
      await writeFile(stalePath, `${process.pid}\n${Date.now()}\n`, 'utf-8');

      const twoMinutesAgo = new Date(Date.now() - 120000);
      const { utimes } = await import('node:fs/promises');
      await utimes(stalePath, twoMinutesAgo, twoMinutesAgo);

      // Run cleanup
      await execFileAsync(
        'npx',
        ['tsx', resolve(PROJECT_ROOT, 'schedules/chats-cleanup.ts')],
        {
          cwd: PROJECT_ROOT,
          env: { ...process.env, CLEANUP_LOCK_MIN_AGE_SECONDS: '1' },
          timeout: 30000,
        },
      );

      // .stale file should be removed
      expect(await fileExists(stalePath)).toBe(false);
    });
  });

  describe('edge cases', () => {
    it('should handle empty directory gracefully', async () => {
      // Only test files present (no orphan files)
      const { stdout } = await execFileAsync(
        'npx',
        ['tsx', resolve(PROJECT_ROOT, 'schedules/chats-cleanup.ts')],
        {
          cwd: PROJECT_ROOT,
          env: { ...process.env, CLEANUP_LOCK_MIN_AGE_SECONDS: '1' },
          timeout: 30000,
        },
      );

      expect(stdout).toContain('No orphan files found');
    });

    it('should respect CLEANUP_MAX_PER_RUN limit', async () => {
      // Create multiple orphan lock files
      const ids = [];
      for (let i = 0; i < 3; i++) {
        const id = `${TEST_PREFIX}multi-${i}`;
        ids.push(id);
        ALL_TEST_IDS.push(id);
        const lockPath = resolve(CHAT_DIR_RESOLVED, `${id}.json.lock`);
        await writeFile(lockPath, `${process.pid}\n${Date.now() - 120000}\n`, 'utf-8');
      }

      try {
        // Run cleanup with max 1 file per run
        await execFileAsync(
          'npx',
          ['tsx', resolve(PROJECT_ROOT, 'schedules/chats-cleanup.ts')],
          {
            cwd: PROJECT_ROOT,
            env: {
              ...process.env,
              CLEANUP_LOCK_MIN_AGE_SECONDS: '1',
              CLEANUP_MAX_PER_RUN: '1',
            },
            timeout: 30000,
          },
        );

        // At most 1 file should be deleted (due to max limit)
        let remainingCount = 0;
        for (const id of ids) {
          if (await fileExists(resolve(CHAT_DIR_RESOLVED, `${id}.json.lock`))) {
            remainingCount++;
          }
        }
        // At least 2 should remain (3 total - 1 max)
        expect(remainingCount).toBeGreaterThanOrEqual(2);
      } finally {
        // Clean up
        for (const id of ids) {
          try {
            await rm(resolve(CHAT_DIR_RESOLVED, `${id}.json.lock`), { force: true });
          } catch {
            // Ignore
          }
        }
      }
    });

    it('should handle already-deleted files gracefully', async () => {
      const id = testId('orphan-lock');
      const lockPath = resolve(CHAT_DIR_RESOLVED, `${id}.json.lock`);

      // Create and immediately note the path
      await writeFile(lockPath, `${process.pid}\n${Date.now() - 120000}\n`, 'utf-8');

      // Run cleanup — should succeed without errors
      const { stdout } = await execFileAsync(
        'npx',
        ['tsx', resolve(PROJECT_ROOT, 'schedules/chats-cleanup.ts')],
        {
          cwd: PROJECT_ROOT,
          env: { ...process.env, CLEANUP_LOCK_MIN_AGE_SECONDS: '1' },
          timeout: 30000,
        },
      );

      expect(stdout).toContain('Cleaned up');
    });
  });
});
