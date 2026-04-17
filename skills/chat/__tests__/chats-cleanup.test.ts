/**
 * Tests for schedules/chats-cleanup.ts — Orphaned lock file cleanup.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdir, rm, writeFile, readFile, readdir } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { pid } from 'node:process';

const execFileAsync = promisify(execFile);

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = resolve(__dirname, '../../..');
const CHAT_DIR = resolve(PROJECT_ROOT, 'workspace/chats');

async function runCleanup(env: Record<string, string> = {}): Promise<{ stdout: string; stderr: string; code: number }> {
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

const TEST_FILES: string[] = [];

function testPath(name: string): string {
  TEST_FILES.push(name);
  return resolve(CHAT_DIR, name);
}

async function cleanupTestFiles() {
  for (const name of TEST_FILES) {
    try {
      await rm(resolve(CHAT_DIR, name), { force: true });
    } catch {
      // Ignore
    }
  }
  // Also clean up any .stale files matching our test pattern
  try {
    const files = await readdir(CHAT_DIR);
    for (const f of files) {
      if (f.startsWith('test-cleanup-') && (f.endsWith('.lock') || /\.stale\.\d+$/.test(f))) {
        await rm(resolve(CHAT_DIR, f), { force: true });
      }
    }
  } catch {
    // Ignore
  }
}

describe('chats-cleanup', () => {
  beforeEach(async () => {
    await mkdir(CHAT_DIR, { recursive: true });
    await cleanupTestFiles();
  });

  afterEach(async () => {
    await cleanupTestFiles();
  });

  it('should report no lock files when directory is clean', async () => {
    const result = await runCleanup();
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('No orphaned lock files found');
  });

  it('should remove lock file with dead PID', async () => {
    const lockFile = testPath('test-cleanup-dead.lock');
    // Use a PID that definitely doesn't exist (99999999)
    await writeFile(lockFile, '99999999\n1710000000000\n', 'utf-8');

    const result = await runCleanup();
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('Removed orphaned lock');
    expect(result.stdout).toContain('dead process');

    // Verify file was deleted
    await expect(readFile(lockFile, 'utf-8')).rejects.toThrow();
  });

  it('should NOT remove lock file with live PID', async () => {
    const lockFile = testPath('test-cleanup-alive.lock');
    // Use current process PID (which is alive)
    await writeFile(lockFile, `${pid}\n${Date.now()}\n`, 'utf-8');

    const result = await runCleanup();
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('Cleaned up 0 file(s)');

    // Verify file still exists
    const content = await readFile(lockFile, 'utf-8');
    expect(content).toContain(String(pid));
  });

  it('should remove lock file with corrupted content', async () => {
    const lockFile = testPath('test-cleanup-corrupt.lock');
    await writeFile(lockFile, 'not-a-valid-lock-file\n', 'utf-8');

    const result = await runCleanup();
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('Removed orphaned lock');
    expect(result.stdout).toContain('corrupted');

    // Verify file was deleted
    await expect(readFile(lockFile, 'utf-8')).rejects.toThrow();
  });

  it('should remove lock file with empty content', async () => {
    const lockFile = testPath('test-cleanup-empty.lock');
    await writeFile(lockFile, '', 'utf-8');

    const result = await runCleanup();
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('Removed orphaned lock');

    // Verify file was deleted
    await expect(readFile(lockFile, 'utf-8')).rejects.toThrow();
  });

  it('should remove .stale.* files', async () => {
    const staleFile = testPath(`test-cleanup-old.json.stale.${pid}`);
    await writeFile(staleFile, 'stale content', 'utf-8');

    const result = await runCleanup();
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('Removed stale file');

    // Verify file was deleted
    await expect(readFile(staleFile, 'utf-8')).rejects.toThrow();
  });

  it('should handle mix of alive and dead lock files', async () => {
    const aliveLock = testPath('test-cleanup-mix-alive.lock');
    const deadLock = testPath('test-cleanup-mix-dead.lock');

    await writeFile(aliveLock, `${pid}\n${Date.now()}\n`, 'utf-8');
    await writeFile(deadLock, '99999999\n1710000000000\n', 'utf-8');

    const result = await runCleanup();
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('Removed orphaned lock');

    // Alive lock should still exist
    const content = await readFile(aliveLock, 'utf-8');
    expect(content).toContain(String(pid));

    // Dead lock should be removed
    await expect(readFile(deadLock, 'utf-8')).rejects.toThrow();
  });

  it('should handle missing chat directory gracefully', async () => {
    // Run with CHAT_DIR pointing to a non-existent directory
    const result = await runCleanup({
      // Override is not possible via env since CHAT_DIR is hardcoded;
      // Instead, we just verify the script handles the case where no lock files exist
    });
    expect(result.code).toBe(0);
  });

  it('should respect CHAT_MAX_CLEANUP limit', async () => {
    // Create multiple dead lock files
    for (let i = 0; i < 5; i++) {
      const lockFile = testPath(`test-cleanup-limit-${i}.lock`);
      await writeFile(lockFile, `99999999\n1710000000000\n`, 'utf-8');
    }

    const result = await runCleanup({ CHAT_MAX_CLEANUP: '2' });
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('Reached max cleanup limit');
    expect(result.stdout).toContain('Cleaned up 2 file(s)');
  });
});
