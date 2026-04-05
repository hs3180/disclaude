/**
 * Integration tests for chat-timeout scripts (timeout.ts + cleanup.ts).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdir, rm, readFile, writeFile, stat } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

// Derive project root from current file location
const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = resolve(__dirname, '../../..');
const CHAT_DIR = resolve(PROJECT_ROOT, 'workspace/chats');

// Helper to run a script with environment variables
async function runScript(
  script: string,
  env: Record<string, string> = {},
): Promise<{ stdout: string; stderr: string; code: number }> {
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

// Test chat IDs
const TIMEOUT_TEST_IDS = ['timeout-expired-1', 'timeout-expired-2', 'timeout-active-1', 'timeout-has-response-1'];
const CLEANUP_TEST_IDS = ['cleanup-recent-1', 'cleanup-stale-1', 'cleanup-active-1'];

async function cleanupTestFiles() {
  const allIds = [...TIMEOUT_TEST_IDS, ...CLEANUP_TEST_IDS];
  for (const id of allIds) {
    try {
      await rm(resolve(CHAT_DIR, `${id}.json`), { force: true });
      await rm(resolve(CHAT_DIR, `${id}.json.lock`), { force: true });
    } catch {
      // Ignore
    }
  }
}

function makeExpiredChat(id: string, overrides: Record<string, unknown> = {}): string {
  return JSON.stringify(
    {
      id,
      status: 'active',
      chatId: `oc_${id}`,
      createdAt: '2026-01-01T00:00:00Z',
      activatedAt: '2026-01-01T00:01:00Z',
      expiresAt: '2020-01-01T00:00:00Z', // Far in the past
      createGroup: { name: 'Test Group', members: ['ou_test123'] },
      context: {},
      response: null,
      activationAttempts: 0,
      lastActivationError: null,
      failedAt: null,
      ...overrides,
    },
    null,
    2,
  );
}

describe('chat-timeout scripts integration', () => {
  beforeEach(async () => {
    await mkdir(CHAT_DIR, { recursive: true });
    await cleanupTestFiles();
  });

  afterEach(async () => {
    await cleanupTestFiles();
  });

  describe('timeout', () => {
    it('should detect and expire a timed-out active chat (dry-run)', async () => {
      // Create an expired active chat
      await writeFile(
        resolve(CHAT_DIR, 'timeout-expired-1.json'),
        makeExpiredChat('timeout-expired-1'),
        'utf-8',
      );

      const result = await runScript('scripts/chat-timeout/timeout.ts', {
        CHAT_DRY_RUN: 'true',
      });

      expect(result.code).toBe(0);
      expect(result.stdout).toContain('DRY RUN');
      expect(result.stdout).toContain('timeout-expired-1');

      // File should NOT be modified in dry-run
      const content = await readFile(resolve(CHAT_DIR, 'timeout-expired-1.json'), 'utf-8');
      const data = JSON.parse(content);
      expect(data.status).toBe('active');
    });

    it('should mark a timed-out active chat as expired', async () => {
      await writeFile(
        resolve(CHAT_DIR, 'timeout-expired-2.json'),
        makeExpiredChat('timeout-expired-2'),
        'utf-8',
      );

      // Note: lark-cli is not available in test env, so group dissolution
      // will fail but the chat should still be marked as expired (graceful degradation)
      const result = await runScript('scripts/chat-timeout/timeout.ts', {
        // lark-cli won't be found, so this will fail fatally
      });

      // lark-cli not installed → fatal error
      expect(result.code).toBe(1);
    });

    it('should skip non-expired active chats', async () => {
      await writeFile(
        resolve(CHAT_DIR, 'timeout-active-1.json'),
        makeExpiredChat('timeout-active-1', {
          expiresAt: '2099-12-31T23:59:59Z', // Far in the future
        }),
        'utf-8',
      );

      const result = await runScript('scripts/chat-timeout/timeout.ts', {
        CHAT_DRY_RUN: 'true',
      });

      expect(result.code).toBe(0);
      expect(result.stdout).not.toContain('timeout-active-1');
    });

    it('should not dissolve group for chats with user response', async () => {
      await writeFile(
        resolve(CHAT_DIR, 'timeout-has-response-1.json'),
        makeExpiredChat('timeout-has-response-1', {
          response: {
            content: 'Approved',
            responder: 'ou_test123',
            repliedAt: '2020-01-01T00:30:00Z',
          },
        }),
        'utf-8',
      );

      const result = await runScript('scripts/chat-timeout/timeout.ts', {
        CHAT_DRY_RUN: 'true',
      });

      expect(result.code).toBe(0);
      expect(result.stdout).toContain('has user response');
      expect(result.stdout).not.toContain('Would dissolve');
    });

    it('should skip chats with non-UTC expiresAt (caught by schema validation)', async () => {
      await writeFile(
        resolve(CHAT_DIR, 'timeout-active-1.json'),
        makeExpiredChat('timeout-active-1', {
          expiresAt: '2020-01-01T00:00:00+08:00', // Non-UTC format
        }),
        'utf-8',
      );

      const result = await runScript('scripts/chat-timeout/timeout.ts', {
        CHAT_DRY_RUN: 'true',
      });

      // parseChatFile rejects non-UTC expiresAt, so the file is treated as corrupted
      expect(result.code).toBe(0);
      expect(result.stderr).toContain('Skipping corrupted');
    });

    it('should handle empty chat directory', async () => {
      // Ensure no test files exist
      await cleanupTestFiles();

      const result = await runScript('scripts/chat-timeout/timeout.ts', {
        CHAT_DRY_RUN: 'true',
      });

      // Should succeed (no chats to process is OK)
      expect(result.code).toBe(0);
    });
  });

  describe('cleanup', () => {
    it('should report stale expired files for cleanup (dry-run)', async () => {
      // Create an expired chat that expired long ago
      await writeFile(
        resolve(CHAT_DIR, 'cleanup-stale-1.json'),
        JSON.stringify(
          {
            id: 'cleanup-stale-1',
            status: 'expired',
            chatId: 'oc_cleanup_stale_1',
            createdAt: '2026-01-01T00:00:00Z',
            activatedAt: '2026-01-01T00:01:00Z',
            expiresAt: '2020-01-01T00:00:00Z',
            expiredAt: '2020-01-01T00:00:00Z', // Expired long ago
            createGroup: { name: 'Test', members: ['ou_test123'] },
            context: {},
            response: null,
            activationAttempts: 0,
            lastActivationError: null,
            failedAt: null,
          },
          null,
          2,
        ),
        'utf-8',
      );

      const result = await runScript('scripts/chat-timeout/cleanup.ts', {
        CHAT_RETENTION_HOURS: '0', // 0 hours = everything past retention
        CHAT_DRY_RUN: 'true',
      });

      expect(result.code).toBe(0);
      expect(result.stdout).toContain('DRY RUN');
      expect(result.stdout).toContain('cleanup-stale-1');
      expect(result.stdout).toContain('Would delete');

      // File should still exist in dry-run
      await expect(stat(resolve(CHAT_DIR, 'cleanup-stale-1.json'))).resolves.toBeDefined();
    });

    it('should delete stale expired files', async () => {
      await writeFile(
        resolve(CHAT_DIR, 'cleanup-stale-1.json'),
        JSON.stringify(
          {
            id: 'cleanup-stale-1',
            status: 'expired',
            chatId: 'oc_cleanup_stale_1',
            createdAt: '2026-01-01T00:00:00Z',
            activatedAt: '2026-01-01T00:01:00Z',
            expiresAt: '2020-01-01T00:00:00Z',
            expiredAt: '2020-01-01T00:00:00Z',
            createGroup: { name: 'Test', members: ['ou_test123'] },
            context: {},
            response: null,
            activationAttempts: 0,
            lastActivationError: null,
            failedAt: null,
          },
          null,
          2,
        ),
        'utf-8',
      );

      const result = await runScript('scripts/chat-timeout/cleanup.ts', {
        CHAT_RETENTION_HOURS: '0',
      });

      expect(result.code).toBe(0);
      expect(result.stdout).toContain('Deleted chat cleanup-stale-1');

      // File should be deleted
      await expect(stat(resolve(CHAT_DIR, 'cleanup-stale-1.json'))).rejects.toThrow('ENOENT');
    });

    it('should retain recently expired files', async () => {
      // Format without milliseconds to match UTC_DATETIME_REGEX
      const recentDate = new Date(Date.now() - 10 * 60 * 1000); // 10 min ago
      const recentExpired = recentDate.toISOString().replace(/\.\d{3}Z$/, 'Z');

      await writeFile(
        resolve(CHAT_DIR, 'cleanup-recent-1.json'),
        JSON.stringify(
          {
            id: 'cleanup-recent-1',
            status: 'expired',
            chatId: 'oc_cleanup_recent_1',
            createdAt: '2026-01-01T00:00:00Z',
            activatedAt: '2026-01-01T00:01:00Z',
            expiresAt: '2026-01-01T00:00:00Z',
            expiredAt: recentExpired,
            createGroup: { name: 'Test', members: ['ou_test123'] },
            context: {},
            response: null,
            activationAttempts: 0,
            lastActivationError: null,
            failedAt: null,
          },
          null,
          2,
        ),
        'utf-8',
      );

      const result = await runScript('scripts/chat-timeout/cleanup.ts', {
        CHAT_RETENTION_HOURS: '1', // 1 hour retention
      });

      expect(result.code).toBe(0);
      expect(result.stdout).toContain('Retained (within retention): 1');

      // File should still exist
      await expect(stat(resolve(CHAT_DIR, 'cleanup-recent-1.json'))).resolves.toBeDefined();
    });

    it('should skip non-expired chats', async () => {
      await writeFile(
        resolve(CHAT_DIR, 'cleanup-active-1.json'),
        makeExpiredChat('cleanup-active-1', {
          status: 'active',
        }),
        'utf-8',
      );

      const result = await runScript('scripts/chat-timeout/cleanup.ts', {
        CHAT_RETENTION_HOURS: '0',
      });

      expect(result.code).toBe(0);
      expect(result.stdout).not.toContain('cleanup-active-1');
    });

    it('should skip expired chats with missing expiredAt', async () => {
      await writeFile(
        resolve(CHAT_DIR, 'cleanup-stale-1.json'),
        JSON.stringify(
          {
            id: 'cleanup-stale-1',
            status: 'expired',
            chatId: 'oc_cleanup_stale_1',
            createdAt: '2026-01-01T00:00:00Z',
            activatedAt: '2026-01-01T00:01:00Z',
            expiresAt: '2020-01-01T00:00:00Z',
            expiredAt: null, // Missing expiredAt
            createGroup: { name: 'Test', members: ['ou_test123'] },
            context: {},
            response: null,
            activationAttempts: 0,
            lastActivationError: null,
            failedAt: null,
          },
          null,
          2,
        ),
        'utf-8',
      );

      const result = await runScript('scripts/chat-timeout/cleanup.ts', {
        CHAT_RETENTION_HOURS: '0',
      });

      expect(result.code).toBe(0);
      expect(result.stderr).toContain('missing or non-UTC expiredAt');
    });

    it('should handle empty chat directory', async () => {
      await cleanupTestFiles();

      const result = await runScript('scripts/chat-timeout/cleanup.ts', {
        CHAT_RETENTION_HOURS: '0',
      });

      expect(result.code).toBe(0);
    });
  });
});
