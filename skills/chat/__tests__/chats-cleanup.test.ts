/**
 * Integration tests for chats-cleanup script.
 *
 * Tests the lock file cleanup logic: orphaned locks, stale locks,
 * corrupted locks, and .stale.* remnant cleanup.
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

const TEST_IDS = [
  'test-cleanup-1', 'test-cleanup-2', 'test-cleanup-3',
  'test-cleanup-4', 'test-cleanup-5',
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
  // Clean up any stale files
  try {
    const files = await import('node:fs/promises').then(m => m.readdir(CHAT_DIR));
    for (const f of files) {
      if (/\.stale\.\d+$/.test(f) && f.includes('test-cleanup')) {
        await rm(resolve(CHAT_DIR, f), { force: true });
      }
    }
  } catch {
    // Ignore
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
    const result = await runScript('schedules/chats-cleanup.ts');
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('No chats directory');
  });

  it('should report no lock files when directory is empty of locks', async () => {
    // Create a .json file but no .lock file
    await writeFile(
      resolve(CHAT_DIR, 'test-cleanup-1.json'),
      JSON.stringify({ id: 'test-cleanup-1', status: 'pending', expiresAt: '2099-12-31T23:59:59Z', createGroup: { name: 'Test', members: ['ou_test'] }, context: {}, response: null, activationAttempts: 0, lastActivationError: null, failedAt: null, chatId: null, createdAt: '2026-01-01T00:00:00Z', activatedAt: null, expiredAt: null }),
    );
    const result = await runScript('schedules/chats-cleanup.ts');
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('No lock files to clean up');
  });

  it('should remove orphaned .lock files (no corresponding .json)', async () => {
    // Create a .lock file without a corresponding .json
    const lockPath = resolve(CHAT_DIR, 'test-cleanup-1.json.lock');
    await writeFile(lockPath, `${process.pid}\n${Date.now()}\n`);

    const result = await runScript('schedules/chats-cleanup.ts');
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('orphaned lock');
    expect(result.stdout).toContain('Cleaned');

    // Verify lock file was removed
    await expect(stat(lockPath)).rejects.toThrow();
  });

  it('should remove stale .lock files (holder process is dead)', async () => {
    // Create a .json file
    await writeFile(
      resolve(CHAT_DIR, 'test-cleanup-1.json'),
      JSON.stringify({ id: 'test-cleanup-1', status: 'pending', expiresAt: '2099-12-31T23:59:59Z', createGroup: { name: 'Test', members: ['ou_test'] }, context: {}, response: null, activationAttempts: 0, lastActivationError: null, failedAt: null, chatId: null, createdAt: '2026-01-01T00:00:00Z', activatedAt: null, expiredAt: null }),
    );

    // Create a .lock file with a dead PID (99999999 is very unlikely to exist)
    const lockPath = resolve(CHAT_DIR, 'test-cleanup-1.json.lock');
    await writeFile(lockPath, `99999999\n${Date.now()}\n`);

    const result = await runScript('schedules/chats-cleanup.ts');
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('stale lock');
    expect(result.stdout).toContain('Cleaned');

    // Verify lock file was removed
    await expect(stat(lockPath)).rejects.toThrow();
  });

  it('should keep active .lock files (holder process is alive)', async () => {
    // Create a .json file
    await writeFile(
      resolve(CHAT_DIR, 'test-cleanup-1.json'),
      JSON.stringify({ id: 'test-cleanup-1', status: 'pending', expiresAt: '2099-12-31T23:59:59Z', createGroup: { name: 'Test', members: ['ou_test'] }, context: {}, response: null, activationAttempts: 0, lastActivationError: null, failedAt: null, chatId: null, createdAt: '2026-01-01T00:00:00Z', activatedAt: null, expiredAt: null }),
    );

    // Create a .lock file with the current process PID (which is alive)
    const lockPath = resolve(CHAT_DIR, 'test-cleanup-1.json.lock');
    await writeFile(lockPath, `${process.pid}\n${Date.now()}\n`);

    const result = await runScript('schedules/chats-cleanup.ts');
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('kept');

    // Verify lock file still exists
    const lockStat = await stat(lockPath);
    expect(lockStat).toBeTruthy();
  });

  it('should remove corrupted .lock files (invalid content)', async () => {
    // Create a .json file
    await writeFile(
      resolve(CHAT_DIR, 'test-cleanup-1.json'),
      JSON.stringify({ id: 'test-cleanup-1', status: 'pending', expiresAt: '2099-12-31T23:59:59Z', createGroup: { name: 'Test', members: ['ou_test'] }, context: {}, response: null, activationAttempts: 0, lastActivationError: null, failedAt: null, chatId: null, createdAt: '2026-01-01T00:00:00Z', activatedAt: null, expiredAt: null }),
    );

    // Create a .lock file with invalid content
    const lockPath = resolve(CHAT_DIR, 'test-cleanup-1.json.lock');
    await writeFile(lockPath, 'not a valid lock file');

    const result = await runScript('schedules/chats-cleanup.ts');
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('corrupted lock');

    // Verify lock file was removed
    await expect(stat(lockPath)).rejects.toThrow();
  });

  it('should clean up .stale.* remnant files', async () => {
    // Create a .stale.* file (simulating interrupted lock cleanup)
    const stalePath = resolve(CHAT_DIR, 'test-cleanup-1.json.lock.stale.12345');
    await writeFile(stalePath, `${process.pid}\n${Date.now()}\n`);

    const result = await runScript('schedules/chats-cleanup.ts');
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('stale remnant');

    // Verify stale file was removed
    await expect(stat(stalePath)).rejects.toThrow();
  });

  it('should handle multiple cleanup candidates in one run', async () => {
    // Create orphaned locks
    await writeFile(resolve(CHAT_DIR, 'test-cleanup-1.json.lock'), `99999999\n${Date.now()}\n`);
    await writeFile(resolve(CHAT_DIR, 'test-cleanup-2.json.lock'), `99999998\n${Date.now()}\n`);

    // Create a stale remnant
    await writeFile(resolve(CHAT_DIR, 'test-cleanup-3.json.lock.stale.12345'), `${process.pid}\n${Date.now()}\n`);

    const result = await runScript('schedules/chats-cleanup.ts');
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('Cleaned 3');

    // Verify all cleaned up
    await expect(stat(resolve(CHAT_DIR, 'test-cleanup-1.json.lock'))).rejects.toThrow();
    await expect(stat(resolve(CHAT_DIR, 'test-cleanup-2.json.lock'))).rejects.toThrow();
    await expect(stat(resolve(CHAT_DIR, 'test-cleanup-3.json.lock.stale.12345'))).rejects.toThrow();
  });

  it('should respect CHAT_MAX_PER_RUN limit', async () => {
    // Create 4 orphaned locks
    for (let i = 1; i <= 4; i++) {
      await writeFile(resolve(CHAT_DIR, `test-cleanup-${i}.json.lock`), `9999999${i}\n${Date.now()}\n`);
    }

    const result = await runScript('schedules/chats-cleanup.ts', {
      CHAT_MAX_PER_RUN: '2',
    });
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('Reached max cleanup limit');

    // Verify only 2 were cleaned (first 2 .lock files found)
    let remainingLocks = 0;
    for (let i = 1; i <= 4; i++) {
      try {
        await stat(resolve(CHAT_DIR, `test-cleanup-${i}.json.lock`));
        remainingLocks++;
      } catch {
        // File was cleaned
      }
    }
    // At least 2 should remain (but some may be in .stale.* cleanup)
    expect(remainingLocks).toBeGreaterThanOrEqual(2);
  });
});
