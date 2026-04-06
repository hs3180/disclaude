/**
 * Integration tests for chats-cleanup script.
 *
 * Tests the orphaned .lock file cleanup logic.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdir, rm, writeFile, stat, utimes } from 'node:fs/promises';
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

function createChatData(overrides: Record<string, unknown> = {}): string {
  const defaults = {
    id: 'test-cleanup-1',
    status: 'expired',
    chatId: null,
    createdAt: '2020-01-01T00:00:00Z',
    activatedAt: null,
    expiresAt: '2020-01-01T00:00:00Z',
    expiredAt: '2020-01-01T01:00:00Z',
    createGroup: { name: 'Test Group', members: ['ou_test123'] },
    context: {},
    response: null,
    activationAttempts: 0,
    lastActivationError: null,
    failedAt: null,
  };
  return JSON.stringify({ ...defaults, ...overrides }, null, 2);
}

const TEST_IDS = ['test-cleanup-1', 'test-cleanup-2', 'test-cleanup-3'];

async function cleanupTestFiles() {
  for (const id of TEST_IDS) {
    try {
      await rm(resolve(CHAT_DIR, `${id}.json`), { force: true });
      await rm(resolve(CHAT_DIR, `${id}.json.lock`), { force: true });
    } catch {
      // Ignore
    }
  }
  // Clean up extra test files
  for (const name of ['orphan-lock.json.lock', 'recent-lock.json.lock']) {
    try {
      await rm(resolve(CHAT_DIR, name), { force: true });
    } catch {
      // Ignore
    }
  }
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

  it('should report no .lock files when none exist', async () => {
    await writeFile(
      resolve(CHAT_DIR, 'test-cleanup-1.json'),
      createChatData({ id: 'test-cleanup-1' }),
    );
    const result = await runScript('scripts/schedule/chats-cleanup.ts');
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('No .lock files');
  });

  it('should clean up orphaned .lock file (no corresponding .json)', async () => {
    // Create only a .lock file without the corresponding .json
    const lockPath = resolve(CHAT_DIR, 'orphan-lock.json.lock');
    await writeFile(lockPath, '');

    // Set mtime to 2 hours ago (past the default 1-hour threshold)
    const twoHoursAgo = new Date(Date.now() - 2 * 3600 * 1000);
    await utimes(lockPath, twoHoursAgo, twoHoursAgo);

    const result = await runScript('scripts/schedule/chats-cleanup.ts');
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('Cleaned up orphaned lock file');
    expect(result.stdout).toContain('orphan-lock.json.lock');

    // Verify file was deleted
    await expect(stat(lockPath)).rejects.toThrow();
  });

  it('should not delete .lock file when corresponding .json exists', async () => {
    const jsonPath = resolve(CHAT_DIR, 'test-cleanup-1.json');
    const lockPath = resolve(CHAT_DIR, 'test-cleanup-1.json.lock');
    await writeFile(jsonPath, createChatData({ id: 'test-cleanup-1' }));
    await writeFile(lockPath, '');

    // Set mtime to 2 hours ago
    const twoHoursAgo = new Date(Date.now() - 2 * 3600 * 1000);
    await utimes(lockPath, twoHoursAgo, twoHoursAgo);

    const result = await runScript('scripts/schedule/chats-cleanup.ts');
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('Cleaned up 0');

    // Verify .lock file still exists
    await expect(stat(lockPath)).resolves.toBeDefined();
  });

  it('should skip recent .lock files (within age threshold)', async () => {
    const lockPath = resolve(CHAT_DIR, 'recent-lock.json.lock');
    await writeFile(lockPath, '');

    // Set mtime to 10 minutes ago (within the default 1-hour threshold)
    const tenMinAgo = new Date(Date.now() - 10 * 60 * 1000);
    await utimes(lockPath, tenMinAgo, tenMinAgo);

    const result = await runScript('scripts/schedule/chats-cleanup.ts');
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('skipped 1');

    // Verify file still exists
    await expect(stat(lockPath)).resolves.toBeDefined();
  });

  it('should handle multiple orphaned .lock files', async () => {
    const twoHoursAgo = new Date(Date.now() - 2 * 3600 * 1000);

    // Create 2 orphaned .lock files
    const lockPath1 = resolve(CHAT_DIR, 'test-cleanup-1.json.lock');
    const lockPath2 = resolve(CHAT_DIR, 'test-cleanup-2.json.lock');
    await writeFile(lockPath1, '');
    await writeFile(lockPath2, '');
    await utimes(lockPath1, twoHoursAgo, twoHoursAgo);
    await utimes(lockPath2, twoHoursAgo, twoHoursAgo);

    // Create 1 .lock file with corresponding .json (should NOT be deleted)
    const jsonPath3 = resolve(CHAT_DIR, 'test-cleanup-3.json');
    const lockPath3 = resolve(CHAT_DIR, 'test-cleanup-3.json.lock');
    await writeFile(jsonPath3, createChatData({ id: 'test-cleanup-3' }));
    await writeFile(lockPath3, '');
    await utimes(lockPath3, twoHoursAgo, twoHoursAgo);

    const result = await runScript('scripts/schedule/chats-cleanup.ts');
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('Cleaned up 2');

    // Verify orphaned files were deleted
    await expect(stat(lockPath1)).rejects.toThrow();
    await expect(stat(lockPath2)).rejects.toThrow();

    // Verify non-orphaned file still exists
    await expect(stat(lockPath3)).resolves.toBeDefined();
  });

  it('should respect CHAT_LOCK_MAX_AGE_HOURS environment variable', async () => {
    const lockPath = resolve(CHAT_DIR, 'orphan-lock.json.lock');
    await writeFile(lockPath, '');

    // Set mtime to 30 minutes ago
    const thirtyMinAgo = new Date(Date.now() - 30 * 60 * 1000);
    await utimes(lockPath, thirtyMinAgo, thirtyMinAgo);

    // With default threshold (1 hour), should skip
    const result1 = await runScript('scripts/schedule/chats-cleanup.ts');
    expect(result1.code).toBe(0);
    expect(result1.stdout).toContain('skipped 1');
    await expect(stat(lockPath)).resolves.toBeDefined();

    // With 0.25 hour (15 min) threshold, should clean up
    const result2 = await runScript('scripts/schedule/chats-cleanup.ts', {
      CHAT_LOCK_MAX_AGE_HOURS: '0.25',
    });
    expect(result2.code).toBe(0);
    expect(result2.stdout).toContain('Cleaned up 1');
    await expect(stat(lockPath)).rejects.toThrow();
  });

  it('should handle invalid CHAT_LOCK_MAX_AGE_HOURS gracefully', async () => {
    const lockPath = resolve(CHAT_DIR, 'orphan-lock.json.lock');
    await writeFile(lockPath, '');

    const twoHoursAgo = new Date(Date.now() - 2 * 3600 * 1000);
    await utimes(lockPath, twoHoursAgo, twoHoursAgo);

    const result = await runScript('scripts/schedule/chats-cleanup.ts', {
      CHAT_LOCK_MAX_AGE_HOURS: 'invalid',
    });
    expect(result.code).toBe(0);
    expect(result.stderr).toContain('falling back to 1');
    // Should still clean up since file is 2 hours old (past default 1 hour)
    expect(result.stdout).toContain('Cleaned up 1');
  });

  it('should be idempotent (running twice is safe)', async () => {
    const lockPath = resolve(CHAT_DIR, 'orphan-lock.json.lock');
    await writeFile(lockPath, '');

    const twoHoursAgo = new Date(Date.now() - 2 * 3600 * 1000);
    await utimes(lockPath, twoHoursAgo, twoHoursAgo);

    // First run
    const result1 = await runScript('scripts/schedule/chats-cleanup.ts');
    expect(result1.code).toBe(0);
    expect(result1.stdout).toContain('Cleaned up 1');

    // Second run — should find no .lock files
    const result2 = await runScript('scripts/schedule/chats-cleanup.ts');
    expect(result2.code).toBe(0);
    expect(result2.stdout).toContain('No .lock files');
  });
});
