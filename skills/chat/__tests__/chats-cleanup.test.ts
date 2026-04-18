/**
 * Integration tests for chats-cleanup schedule script.
 *
 * Tests the orphaned .lock file detection and cleanup logic.
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

async function runScript(env: Record<string, string> = {}): Promise<{ stdout: string; stderr: string; code: number }> {
  const scriptPath = resolve(PROJECT_ROOT, 'schedules/chats-cleanup.ts');
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

const TEST_FILES = [
  'test-cleanup-1.json',
  'test-cleanup-1.json.lock',
  'test-cleanup-2.json.lock',
  'test-cleanup-3.json',
  'test-cleanup-3.json.lock',
  'test-cleanup-4.json.lock',
  'test-cleanup-old.json',
  'test-cleanup-old.json.lock',
];

async function cleanupTestFiles() {
  for (const file of TEST_FILES) {
    try {
      await rm(resolve(CHAT_DIR, file), { force: true });
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
    const result = await runScript();
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('not found');
  });

  it('should report no .lock files when directory is empty', async () => {
    const result = await runScript();
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('No .lock files');
  });

  it('should clean up orphaned .lock file (no corresponding .json)', async () => {
    // Create only a .lock file without corresponding .json
    await writeFile(resolve(CHAT_DIR, 'test-cleanup-2.json.lock'), '12345\n999999\n', 'utf-8');

    const result = await runScript();
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('Cleaned up test-cleanup-2.json.lock');
    expect(result.stdout).toContain('orphaned');

    // Verify .lock was deleted
    await expect(stat(resolve(CHAT_DIR, 'test-cleanup-2.json.lock'))).rejects.toThrow();
  });

  it('should not clean up .lock file when corresponding .json exists', async () => {
    // Create both .json and .lock
    const chatData = {
      id: 'test-cleanup-1',
      status: 'active',
      chatId: 'oc_test',
      createdAt: '2026-01-01T00:00:00Z',
      activatedAt: '2026-01-01T00:01:00Z',
      expiresAt: '2099-12-31T23:59:59Z',
      createGroup: { name: 'Test', members: ['ou_test123'] },
      context: {},
      response: null,
      activationAttempts: 0,
      lastActivationError: null,
      failedAt: null,
      expiredAt: null,
    };
    await writeFile(resolve(CHAT_DIR, 'test-cleanup-1.json'), JSON.stringify(chatData, null, 2), 'utf-8');
    await writeFile(resolve(CHAT_DIR, 'test-cleanup-1.json.lock'), `${process.pid}\n${Date.now()}\n`, 'utf-8');

    const result = await runScript();
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('Cleaned 0 .lock file(s)');

    // Verify .lock still exists
    const lockStat = await stat(resolve(CHAT_DIR, 'test-cleanup-1.json.lock'));
    expect(lockStat).toBeTruthy();
  });

  it('should clean up .lock file that exceeds maximum age', async () => {
    // Create a .json and a very old .lock
    const chatData = {
      id: 'test-cleanup-old',
      status: 'expired',
      chatId: 'oc_old',
      createdAt: '2020-01-01T00:00:00Z',
      activatedAt: '2020-01-01T00:01:00Z',
      expiresAt: '2020-01-02T00:00:00Z',
      createGroup: { name: 'Old', members: ['ou_test123'] },
      context: {},
      response: null,
      activationAttempts: 0,
      lastActivationError: null,
      failedAt: null,
      expiredAt: '2020-01-02T00:00:00Z',
    };
    await writeFile(resolve(CHAT_DIR, 'test-cleanup-old.json'), JSON.stringify(chatData, null, 2), 'utf-8');
    await writeFile(resolve(CHAT_DIR, 'test-cleanup-old.json.lock'), '12345\n1000000000000\n', 'utf-8');

    // Set very short max age so the lock is considered too old
    const result = await runScript({ CHAT_LOCK_MAX_AGE_MS: '1000' }); // 1 second
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('Cleaned up test-cleanup-old.json.lock');
    expect(result.stdout).toContain('too old');

    // Verify .lock was deleted
    await expect(stat(resolve(CHAT_DIR, 'test-cleanup-old.json.lock'))).rejects.toThrow();
  });

  it('should handle multiple .lock files in one run', async () => {
    // Create multiple orphaned .lock files
    await writeFile(resolve(CHAT_DIR, 'test-cleanup-2.json.lock'), '12345\n999999\n', 'utf-8');
    await writeFile(resolve(CHAT_DIR, 'test-cleanup-4.json.lock'), '67890\n999999\n', 'utf-8');

    const result = await runScript();
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('Cleaned 2 .lock file(s)');

    // Verify both were deleted
    await expect(stat(resolve(CHAT_DIR, 'test-cleanup-2.json.lock'))).rejects.toThrow();
    await expect(stat(resolve(CHAT_DIR, 'test-cleanup-4.json.lock'))).rejects.toThrow();
  });

  it('should respect CHAT_LOCK_MAX_AGE_MS setting', async () => {
    // Create a recent .lock (without corresponding .json — always orphaned)
    await writeFile(resolve(CHAT_DIR, 'test-cleanup-2.json.lock'), `${process.pid}\n${Date.now()}\n`, 'utf-8');

    // With very long max age, it's still cleaned up because it's orphaned
    const result = await runScript({ CHAT_LOCK_MAX_AGE_MS: '999999999' });
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('Cleaned up test-cleanup-2.json.lock');
    expect(result.stdout).toContain('orphaned');
  });

  it('should reject invalid CHAT_LOCK_MAX_AGE_MS and use default', async () => {
    await writeFile(resolve(CHAT_DIR, 'test-cleanup-2.json.lock'), '12345\n999999\n', 'utf-8');

    const result = await runScript({ CHAT_LOCK_MAX_AGE_MS: 'invalid' });
    expect(result.code).toBe(0);
    expect(result.stderr).toContain('Invalid CHAT_LOCK_MAX_AGE_MS');
    // Should still function with default
    expect(result.stdout).toContain('Cleaned up test-cleanup-2.json.lock');
  });
});
