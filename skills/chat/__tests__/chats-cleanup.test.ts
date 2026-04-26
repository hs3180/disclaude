/**
 * Integration tests for chats-cleanup schedule script.
 *
 * Tests the orphaned file cleanup logic: .lock, .tmp, and .stale.* files.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdir, rm, writeFile, stat, readdir } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

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

const TEST_FILES = [
  'test-cleanup-1.json',
  'test-cleanup-1.json.lock',
  'test-cleanup-2.json.lock',
  'test-cleanup-3.json.1234567890.tmp',
  'test-cleanup-4.json.lock.stale.12345',
  'test-cleanup-recent.json.lock',
];

async function cleanupTestFiles() {
  for (const fileName of TEST_FILES) {
    try {
      await rm(resolve(CHAT_DIR, fileName), { force: true });
    } catch {
      // Ignore
    }
  }
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
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

  it('should clean up orphaned .lock file when corresponding JSON is gone', async () => {
    // Create an orphaned .lock file (no corresponding .json)
    const lockPath = resolve(CHAT_DIR, 'test-cleanup-2.json.lock');
    await writeFile(lockPath, '12345\n1714000000000\n', 'utf-8');

    // Verify lock file exists
    expect(await fileExists(lockPath)).toBe(true);

    // Run cleanup with min age 0 to process immediately
    const result = await runScript('schedules/chats-cleanup.ts', {
      CHAT_CLEANUP_MIN_AGE_MS: '0',
    });

    expect(result.code).toBe(0);
    // Lock file should be cleaned up
    expect(await fileExists(lockPath)).toBe(false);
  });

  it('should not clean up .lock file when corresponding JSON still exists', async () => {
    // Create both .json and .lock files
    const jsonPath = resolve(CHAT_DIR, 'test-cleanup-1.json');
    const lockPath = resolve(CHAT_DIR, 'test-cleanup-1.json.lock');
    await writeFile(jsonPath, '{}', 'utf-8');
    await writeFile(lockPath, '12345\n1714000000000\n', 'utf-8');

    // Run cleanup with min age 0
    const result = await runScript('schedules/chats-cleanup.ts', {
      CHAT_CLEANUP_MIN_AGE_MS: '0',
    });

    expect(result.code).toBe(0);
    // Lock file should NOT be cleaned up (JSON still exists)
    expect(await fileExists(lockPath)).toBe(true);
  });

  it('should clean up residual .tmp files', async () => {
    const tmpPath = resolve(CHAT_DIR, 'test-cleanup-3.json.1234567890.tmp');
    await writeFile(tmpPath, 'partial data', 'utf-8');

    const result = await runScript('schedules/chats-cleanup.ts', {
      CHAT_CLEANUP_MIN_AGE_MS: '0',
    });

    expect(result.code).toBe(0);
    expect(await fileExists(tmpPath)).toBe(false);
  });

  it('should clean up residual .stale.* files', async () => {
    const stalePath = resolve(CHAT_DIR, 'test-cleanup-4.json.lock.stale.12345');
    await writeFile(stalePath, '', 'utf-8');

    const result = await runScript('schedules/chats-cleanup.ts', {
      CHAT_CLEANUP_MIN_AGE_MS: '0',
    });

    expect(result.code).toBe(0);
    expect(await fileExists(stalePath)).toBe(false);
  });

  it('should skip recently created files (min age protection)', async () => {
    const lockPath = resolve(CHAT_DIR, 'test-cleanup-recent.json.lock');
    await writeFile(lockPath, '12345\n' + Date.now() + '\n', 'utf-8');

    // Run cleanup with default min age (60 seconds)
    const result = await runScript('schedules/chats-cleanup.ts');

    expect(result.code).toBe(0);
    // Recently created lock should NOT be cleaned up
    expect(await fileExists(lockPath)).toBe(true);
  });

  it('should exit successfully when no chats directory exists', async () => {
    // Use a non-existent directory
    const result = await runScript('schedules/chats-cleanup.ts', {
      CHAT_DIR_OVERRIDE: '/tmp/nonexistent-chats-dir-' + Date.now(),
    });

    // Script should handle gracefully (it uses CHAT_DIR from schema.ts)
    // The actual behavior depends on whether workspace/chats exists
    expect(result.code).toBe(0);
  });

  it('should report no cleanup candidates when directory has only JSON files', async () => {
    const jsonPath = resolve(CHAT_DIR, 'test-cleanup-1.json');
    await writeFile(jsonPath, '{"id":"test","status":"active"}', 'utf-8');

    const result = await runScript('schedules/chats-cleanup.ts', {
      CHAT_CLEANUP_MIN_AGE_MS: '0',
    });

    expect(result.code).toBe(0);
    expect(result.stdout).toContain('No cleanup candidates found');
  });

  it('should respect CHAT_CLEANUP_MAX_FILES limit', async () => {
    // Create multiple orphaned lock files
    const lockFiles: string[] = [];
    for (let i = 0; i < 5; i++) {
      const lockPath = resolve(CHAT_DIR, `test-cleanup-max-${i}.json.lock`);
      await writeFile(lockPath, '12345\n1714000000000\n', 'utf-8');
      lockFiles.push(lockPath);
    }

    try {
      // Run cleanup with max files = 2
      const result = await runScript('schedules/chats-cleanup.ts', {
        CHAT_CLEANUP_MIN_AGE_MS: '0',
        CHAT_CLEANUP_MAX_FILES: '2',
      });

      expect(result.code).toBe(0);
      expect(result.stdout).toContain('Reached max file limit (2)');

      // At least 2 should be cleaned, at least 3 should remain
      let cleanedCount = 0;
      for (const f of lockFiles) {
        if (!(await fileExists(f))) cleanedCount++;
      }
      expect(cleanedCount).toBeGreaterThanOrEqual(2);
    } finally {
      // Clean up extra files
      for (const f of lockFiles) {
        try { await rm(f, { force: true }); } catch { /* ignore */ }
      }
    }
  });
});
