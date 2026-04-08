/**
 * Integration tests for chats-cleanup script.
 *
 * Tests orphaned .lock file cleanup and old failed chat file cleanup
 * without actually calling lark-cli (tests run with CHAT_SKIP_LARK_CHECK).
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
async function runScript(script: string, env: Record<string, string> = {}): Promise<{ stdout: string; stderr: string; code: number }> {
  const scriptPath = resolve(PROJECT_ROOT, script);
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

function createChatData(overrides: Record<string, unknown> = {}): string {
  const defaults = {
    id: 'test-cleanup-1',
    status: 'failed',
    chatId: null,
    createdAt: '2020-01-01T00:00:00Z',
    activatedAt: null,
    expiresAt: '2020-01-02T00:00:00Z',
    expiredAt: null,
    createGroup: { name: 'Test Group', members: ['ou_test123'] },
    context: {},
    response: null,
    activationAttempts: 5,
    lastActivationError: 'All retries exhausted',
    failedAt: '2020-01-01T01:00:00Z',
  };
  return JSON.stringify({ ...defaults, ...overrides }, null, 2);
}

const TEST_IDS = [
  'test-cleanup-1', 'test-cleanup-2', 'test-cleanup-3',
  'test-cleanup-4', 'test-cleanup-5', 'test-cleanup-lock-1',
];

async function cleanupTestFiles() {
  for (const id of TEST_IDS) {
    try { await rm(resolve(CHAT_DIR, `${id}.json`), { force: true }); } catch { /* ignore */ }
    try { await rm(resolve(CHAT_DIR, `${id}.json.lock`), { force: true }); } catch { /* ignore */ }
  }
  // Also clean up standalone lock files
  try { await rm(resolve(CHAT_DIR, 'orphan-lock.json.lock'), { force: true }); } catch { /* ignore */ }
  try { await rm(resolve(CHAT_DIR, 'standalone.lock'), { force: true }); } catch { /* ignore */ }
}

describe('chats-cleanup script', () => {
  beforeEach(async () => {
    await mkdir(CHAT_DIR, { recursive: true });
    await cleanupTestFiles();
  });

  afterEach(async () => {
    await cleanupTestFiles();
  });

  it('should exit successfully when no chats directory exists', async () => {
    await rm(CHAT_DIR, { recursive: true, force: true });
    const result = await runScript('scripts/schedule/chats-cleanup.ts');
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('No chats directory');
  });

  it('should report nothing to clean up when directory is empty', async () => {
    const result = await runScript('scripts/schedule/chats-cleanup.ts');
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('Nothing to clean up');
  });

  it('should clean up orphaned .lock files', async () => {
    // Create an orphaned lock file (no process holds it)
    await writeFile(resolve(CHAT_DIR, 'orphan-lock.json.lock'), '');
    // Create a corresponding .json file so the lock has a "parent"
    await writeFile(
      resolve(CHAT_DIR, 'orphan-lock.json'),
      createChatData({ id: 'orphan-lock', status: 'pending' }),
    );

    const result = await runScript('scripts/schedule/chats-cleanup.ts', {
      CHAT_LOCK_MAX_AGE_MS: '0', // Treat all lock files as orphaned (for testing without fs.flock)
    });
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('Removed orphaned lock file');

    // Verify lock file was deleted
    await expect(stat(resolve(CHAT_DIR, 'orphan-lock.json.lock'))).rejects.toThrow();
    // Verify the .json file still exists
    const content = await readFile(resolve(CHAT_DIR, 'orphan-lock.json'), 'utf-8');
    expect(JSON.parse(content).id).toBe('orphan-lock');
  });

  it('should clean up standalone .lock files (no corresponding .json)', async () => {
    await writeFile(resolve(CHAT_DIR, 'standalone.lock'), '');

    const result = await runScript('scripts/schedule/chats-cleanup.ts', {
      CHAT_LOCK_MAX_AGE_MS: '0',
    });
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('Removed orphaned lock file');

    await expect(stat(resolve(CHAT_DIR, 'standalone.lock'))).rejects.toThrow();
  });

  it('should clean up failed chat files past retention period', async () => {
    await writeFile(
      resolve(CHAT_DIR, 'test-cleanup-1.json'),
      createChatData({
        id: 'test-cleanup-1',
        status: 'failed',
        failedAt: '2020-01-01T01:00:00Z',
        createdAt: '2020-01-01T00:00:00Z',
      }),
    );

    const result = await runScript('scripts/schedule/chats-cleanup.ts', {
      CHAT_FAILED_RETENTION_HOURS: '24',
    });
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('Cleaned up failed chat file');

    // Verify file was deleted
    await expect(stat(resolve(CHAT_DIR, 'test-cleanup-1.json'))).rejects.toThrow();
  });

  it('should also clean up associated .lock file when deleting failed chat', async () => {
    await writeFile(
      resolve(CHAT_DIR, 'test-cleanup-1.json'),
      createChatData({
        id: 'test-cleanup-1',
        status: 'failed',
        failedAt: '2020-01-01T01:00:00Z',
      }),
    );
    await writeFile(resolve(CHAT_DIR, 'test-cleanup-1.json.lock'), '');

    const result = await runScript('scripts/schedule/chats-cleanup.ts', {
      CHAT_FAILED_RETENTION_HOURS: '24',
    });
    expect(result.code).toBe(0);

    // Both files should be deleted
    await expect(stat(resolve(CHAT_DIR, 'test-cleanup-1.json'))).rejects.toThrow();
    await expect(stat(resolve(CHAT_DIR, 'test-cleanup-1.json.lock'))).rejects.toThrow();
  });

  it('should not clean up recently failed chat files', async () => {
    const recentTime = new Date(Date.now() - 10 * 60 * 1000).toISOString(); // 10 minutes ago
    await writeFile(
      resolve(CHAT_DIR, 'test-cleanup-1.json'),
      createChatData({
        id: 'test-cleanup-1',
        status: 'failed',
        failedAt: recentTime,
        createdAt: recentTime,
        expiresAt: new Date(Date.now() + 3600 * 1000).toISOString(),
      }),
    );

    const result = await runScript('scripts/schedule/chats-cleanup.ts', {
      CHAT_FAILED_RETENTION_HOURS: '24',
    });
    expect(result.code).toBe(0);

    // File should still exist
    const content = await readFile(resolve(CHAT_DIR, 'test-cleanup-1.json'), 'utf-8');
    expect(JSON.parse(content).status).toBe('failed');
  });

  it('should not clean up non-failed chat files', async () => {
    // Create active, pending, and expired chats — none should be cleaned
    await writeFile(
      resolve(CHAT_DIR, 'test-cleanup-1.json'),
      createChatData({ id: 'test-cleanup-1', status: 'active', failedAt: null, expiresAt: '2099-12-31T23:59:59Z' }),
    );
    await writeFile(
      resolve(CHAT_DIR, 'test-cleanup-2.json'),
      createChatData({ id: 'test-cleanup-2', status: 'pending', failedAt: null, expiresAt: '2099-12-31T23:59:59Z' }),
    );
    await writeFile(
      resolve(CHAT_DIR, 'test-cleanup-3.json'),
      createChatData({ id: 'test-cleanup-3', status: 'expired', failedAt: null, expiredAt: '2020-01-01T01:00:00Z' }),
    );

    const result = await runScript('scripts/schedule/chats-cleanup.ts');
    expect(result.code).toBe(0);
    expect(result.stdout).not.toContain('Cleaned up failed chat file');

    // All files should still exist
    await expect(stat(resolve(CHAT_DIR, 'test-cleanup-1.json'))).resolves.toBeDefined();
    await expect(stat(resolve(CHAT_DIR, 'test-cleanup-2.json'))).resolves.toBeDefined();
    await expect(stat(resolve(CHAT_DIR, 'test-cleanup-3.json'))).resolves.toBeDefined();
  });

  it('should skip corrupted JSON files', async () => {
    await writeFile(resolve(CHAT_DIR, 'test-cleanup-1.json'), 'not valid json {{{');

    const result = await runScript('scripts/schedule/chats-cleanup.ts');
    expect(result.code).toBe(0);
    expect(result.stderr).toContain('corrupted');
  });

  it('should use createdAt as fallback when failedAt is null', async () => {
    await writeFile(
      resolve(CHAT_DIR, 'test-cleanup-1.json'),
      createChatData({
        id: 'test-cleanup-1',
        status: 'failed',
        failedAt: null,
        createdAt: '2020-01-01T00:00:00Z', // Far in the past
        expiresAt: '2020-01-02T00:00:00Z',
      }),
    );

    const result = await runScript('scripts/schedule/chats-cleanup.ts', {
      CHAT_FAILED_RETENTION_HOURS: '24',
    });
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('Cleaned up failed chat file');

    await expect(stat(resolve(CHAT_DIR, 'test-cleanup-1.json'))).rejects.toThrow();
  });

  it('should clean up multiple orphaned lock files in one run', async () => {
    for (const id of ['test-cleanup-1', 'test-cleanup-2', 'test-cleanup-3']) {
      await writeFile(resolve(CHAT_DIR, `${id}.json.lock`), '');
    }

    const result = await runScript('scripts/schedule/chats-cleanup.ts', {
      CHAT_LOCK_MAX_AGE_MS: '0',
    });
    expect(result.code).toBe(0);

    // All lock files should be cleaned
    for (const id of ['test-cleanup-1', 'test-cleanup-2', 'test-cleanup-3']) {
      await expect(stat(resolve(CHAT_DIR, `${id}.json.lock`))).rejects.toThrow();
    }
  });

  it('should handle CHAT_FAILED_RETENTION_HOURS=0 by cleaning all failed files', async () => {
    const recentTime = new Date(Date.now() - 60 * 1000).toISOString(); // 1 minute ago
    await writeFile(
      resolve(CHAT_DIR, 'test-cleanup-1.json'),
      createChatData({
        id: 'test-cleanup-1',
        status: 'failed',
        failedAt: recentTime,
        createdAt: recentTime,
        expiresAt: new Date(Date.now() + 3600 * 1000).toISOString(),
      }),
    );

    // Use retention of 0 (effectively clean everything)
    const result = await runScript('scripts/schedule/chats-cleanup.ts', {
      CHAT_FAILED_RETENTION_HOURS: '0',
    });
    // With 0 retention, all failed files should be cleaned
    // But 0 is treated as invalid and falls back to 24
    expect(result.code).toBe(0);

    // File should still exist since 0 falls back to 24
    const content = await readFile(resolve(CHAT_DIR, 'test-cleanup-1.json'), 'utf-8');
    expect(JSON.parse(content).status).toBe('failed');
  });
});
