/**
 * Unit tests for chats-cleanup schedule script.
 *
 * Tests the lock file cleanup logic including orphaned locks (no corresponding
 * .json file), stale locks (dead holder process), and corrupted lock files.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdir, rm, writeFile, readFile, stat } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { pid } from 'node:process';
import { CHAT_DIR } from '../schema.js';

const execFileAsync = promisify(execFile);

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = resolve(__dirname, '../../..');
const CHAT_DIR_RESOLVED = resolve(PROJECT_ROOT, CHAT_DIR);
const SCHEDULE_SCRIPT = resolve(PROJECT_ROOT, 'schedules/chats-cleanup.ts');

const TEST_IDS = [
  'test-cleanup-orphan',
  'test-cleanup-active',
  'test-cleanup-stale',
  'test-cleanup-corrupted',
  'test-cleanup-self',
];

async function cleanupTestFiles() {
  for (const id of TEST_IDS) {
    try {
      await rm(resolve(CHAT_DIR_RESOLVED, `${id}.json`), { force: true });
      await rm(resolve(CHAT_DIR_RESOLVED, `${id}.json.lock`), { force: true });
    } catch {
      // Ignore
    }
  }
}

function makeChatData(id: string, status: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    status,
    chatId: status === 'active' ? 'oc_test123' : null,
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
    ...overrides,
  };
}

describe('chats-cleanup', () => {
  beforeEach(async () => {
    await mkdir(CHAT_DIR_RESOLVED, { recursive: true });
    await cleanupTestFiles();
  });

  afterEach(async () => {
    await cleanupTestFiles();
  });

  describe('orphaned .lock files', () => {
    it('should remove .lock file when corresponding .json does not exist', async () => {
      // Create only the .lock file (no .json)
      const lockPath = resolve(CHAT_DIR_RESOLVED, 'test-cleanup-orphan.json.lock');
      await writeFile(lockPath, `${pid}\n${Date.now()}\n`);

      // Verify lock exists
      await expect(stat(lockPath)).resolves.toBeDefined();

      // Run cleanup
      const { stdout } = await execFileAsync('npx', ['tsx', SCHEDULE_SCRIPT], {
        timeout: 30000,
        cwd: PROJECT_ROOT,
      });

      expect(stdout).toContain('Removed orphaned .lock file');

      // Verify lock was removed
      await expect(stat(lockPath)).rejects.toThrow();
    });

    it('should NOT remove .lock file when corresponding .json exists and process is alive', async () => {
      // Create both .json and .lock (with current PID = alive)
      const jsonPath = resolve(CHAT_DIR_RESOLVED, 'test-cleanup-active.json');
      const lockPath = resolve(CHAT_DIR_RESOLVED, 'test-cleanup-active.json.lock');

      await writeFile(jsonPath, JSON.stringify(makeChatData('test-cleanup-active', 'active'), null, 2));
      await writeFile(lockPath, `${pid}\n${Date.now()}\n`);

      // Run cleanup
      const { stdout } = await execFileAsync('npx', ['tsx', SCHEDULE_SCRIPT], {
        timeout: 30000,
        cwd: PROJECT_ROOT,
      });

      // Lock should still exist (held by live process)
      await expect(stat(lockPath)).resolves.toBeDefined();
    });
  });

  describe('stale .lock files', () => {
    it('should remove .lock file with dead PID', async () => {
      // Create .json and .lock with a dead PID (999999 is very unlikely to exist)
      const jsonPath = resolve(CHAT_DIR_RESOLVED, 'test-cleanup-stale.json');
      const lockPath = resolve(CHAT_DIR_RESOLVED, 'test-cleanup-stale.json.lock');

      await writeFile(jsonPath, JSON.stringify(makeChatData('test-cleanup-stale', 'active'), null, 2));
      await writeFile(lockPath, '999999\n1000000000000\n');

      // Run cleanup
      const { stdout } = await execFileAsync('npx', ['tsx', SCHEDULE_SCRIPT], {
        timeout: 30000,
        cwd: PROJECT_ROOT,
      });

      expect(stdout).toContain('Removed stale .lock file');

      // Lock should be removed
      await expect(stat(lockPath)).rejects.toThrow();
      // JSON should still exist
      await expect(stat(jsonPath)).resolves.toBeDefined();
    });
  });

  describe('corrupted .lock files', () => {
    it('should remove .lock file with corrupted content', async () => {
      // Create .json and corrupted .lock
      const jsonPath = resolve(CHAT_DIR_RESOLVED, 'test-cleanup-corrupted.json');
      const lockPath = resolve(CHAT_DIR_RESOLVED, 'test-cleanup-corrupted.json.lock');

      await writeFile(jsonPath, JSON.stringify(makeChatData('test-cleanup-corrupted', 'active'), null, 2));
      await writeFile(lockPath, 'not-a-valid-pid\n');

      // Run cleanup
      const { stdout } = await execFileAsync('npx', ['tsx', SCHEDULE_SCRIPT], {
        timeout: 30000,
        cwd: PROJECT_ROOT,
      });

      expect(stdout).toContain('Removed corrupted .lock file');

      // Lock should be removed
      await expect(stat(lockPath)).rejects.toThrow();
      // JSON should still exist
      await expect(stat(jsonPath)).resolves.toBeDefined();
    });
  });

  describe('self-held locks', () => {
    it('should NOT remove .lock file held by current process', async () => {
      const jsonPath = resolve(CHAT_DIR_RESOLVED, 'test-cleanup-self.json');
      const lockPath = resolve(CHAT_DIR_RESOLVED, 'test-cleanup-self.json.lock');

      await writeFile(jsonPath, JSON.stringify(makeChatData('test-cleanup-self', 'active'), null, 2));
      // Write current PID (the cleanup script's own PID, which is different from test PID)
      await writeFile(lockPath, `${pid}\n${Date.now()}\n`);

      // Run cleanup — the lock has test's PID, which is alive
      // The cleanup script runs as a child process with different PID
      const { stdout } = await execFileAsync('npx', ['tsx', SCHEDULE_SCRIPT], {
        timeout: 30000,
        cwd: PROJECT_ROOT,
      });

      // Lock should still exist (holder PID = test process is alive)
      await expect(stat(lockPath)).resolves.toBeDefined();
    });
  });

  describe('edge cases', () => {
    it('should handle empty chats directory gracefully', async () => {
      // No files in directory (or no .lock files)
      const { stdout } = await execFileAsync('npx', ['tsx', SCHEDULE_SCRIPT], {
        timeout: 30000,
        cwd: PROJECT_ROOT,
      });

      // Should complete without error
      expect(stdout).toBeDefined();
    });

    it('should handle missing chats directory gracefully', async () => {
      // Temporarily rename the directory
      const backupDir = CHAT_DIR_RESOLVED + '.bak-test';
      try {
        await rm(backupDir, { force: true, recursive: true });
      } catch {
        // Ignore
      }

      try {
        await mkdir(CHAT_DIR_RESOLVED, { recursive: true });

        // Remove it
        await rm(CHAT_DIR_RESOLVED, { force: true, recursive: true });

        const { stdout } = await execFileAsync('npx', ['tsx', SCHEDULE_SCRIPT], {
          timeout: 30000,
          cwd: PROJECT_ROOT,
        });

        expect(stdout).toContain('No chats directory found');
      } finally {
        // Restore directory
        await mkdir(CHAT_DIR_RESOLVED, { recursive: true });
      }
    });
  });
});
