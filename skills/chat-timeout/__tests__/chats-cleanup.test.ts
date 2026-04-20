/**
 * Integration tests for schedules/chats-cleanup.ts
 *
 * Tests orphaned .lock file cleanup, stale .tmp file removal,
 * and .stale.* file cleanup.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdir, rm, writeFile, readFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = resolve(__dirname, '../../..');
const CHAT_DIR = resolve(PROJECT_ROOT, 'workspace/chats');

async function runCleanup(
  env: Record<string, string> = {},
): Promise<{ stdout: string; stderr: string; code: number }> {
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

describe('chats-cleanup', () => {
  beforeEach(async () => {
    await mkdir(CHAT_DIR, { recursive: true });
  });

  afterEach(async () => {
    // Clean up test files
    try {
      await rm(CHAT_DIR, { recursive: true, force: true });
    } catch {
      // Ignore
    }
  });

  it('should exit cleanly when chats directory does not exist', async () => {
    await rm(CHAT_DIR, { recursive: true, force: true });
    const result = await runCleanup();
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('No chats directory');
  });

  it('should report no orphaned files when directory is empty', async () => {
    const result = await runCleanup();
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('No orphaned files');
  });

  it('should remove lock file with dead holder process', async () => {
    // Create a lock file with a PID that definitely doesn't exist (very high number)
    const deadPid = 999999999;
    const lockPath = resolve(CHAT_DIR, 'test-chat-1.json.lock');
    const content = `${deadPid}\n${Date.now() - 120000}\n`; // 2 minutes old
    await writeFile(lockPath, content, 'utf-8');

    const result = await runCleanup({ CHAT_LOCK_MIN_AGE_MS: '1000' });
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('Removed orphaned lock file');

    // Verify file was removed
    await expect(readFile(lockPath, 'utf-8')).rejects.toThrow();
  });

  it('should NOT remove lock file with alive holder process', async () => {
    // Use current process PID (which is alive)
    const lockPath = resolve(CHAT_DIR, 'test-chat-2.json.lock');
    const content = `${process.pid}\n${Date.now() - 120000}\n`;
    await writeFile(lockPath, content, 'utf-8');

    const result = await runCleanup({ CHAT_LOCK_MIN_AGE_MS: '1000' });
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('No orphaned files');

    // Verify file still exists
    const fileContent = await readFile(lockPath, 'utf-8');
    expect(fileContent).toContain(String(process.pid));
  });

  it('should NOT remove recent lock files even with dead holder', async () => {
    const deadPid = 999999999;
    const lockPath = resolve(CHAT_DIR, 'test-chat-3.json.lock');
    const content = `${deadPid}\n${Date.now()}\n`; // Just created
    await writeFile(lockPath, content, 'utf-8');

    const result = await runCleanup({ CHAT_LOCK_MIN_AGE_MS: '60000' }); // 1 minute minimum
    expect(result.code).toBe(0);
    // Should NOT have removed the file (too recent)
    expect(result.stdout).toContain('No orphaned files');

    // Verify file still exists
    const fileContent = await readFile(lockPath, 'utf-8');
    expect(fileContent).toContain(String(deadPid));
  });

  it('should remove corrupted lock files that are old enough', async () => {
    const lockPath = resolve(CHAT_DIR, 'test-chat-4.json.lock');
    // Write invalid content
    await writeFile(lockPath, 'corrupted-content', 'utf-8');

    // Use small min age so the file qualifies
    const result = await runCleanup({ CHAT_LOCK_MIN_AGE_MS: '1' });
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('Removed orphaned lock file');

    // Verify file was removed
    await expect(readFile(lockPath, 'utf-8')).rejects.toThrow();
  });

  it('should remove stale .tmp files', async () => {
    const tmpPath = resolve(CHAT_DIR, 'test-chat-5.json.1234567890.tmp');
    await writeFile(tmpPath, '{"test": true}', 'utf-8');

    const result = await runCleanup({ CHAT_LOCK_MIN_AGE_MS: '1' });
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('Removed stale tmp file');

    // Verify file was removed
    await expect(readFile(tmpPath, 'utf-8')).rejects.toThrow();
  });

  it('should NOT remove recent .tmp files', async () => {
    const tmpPath = resolve(CHAT_DIR, 'test-chat-6.json.tmp');
    await writeFile(tmpPath, '{"test": true}', 'utf-8');

    // Default min age is 1 minute — file is brand new
    const result = await runCleanup({ CHAT_LOCK_MIN_AGE_MS: '60000' });
    expect(result.code).toBe(0);
    // Should not have removed the tmp file
    expect(result.stdout).toContain('No orphaned files');

    // Verify file still exists
    const fileContent = await readFile(tmpPath, 'utf-8');
    expect(fileContent).toContain('test');
  });

  it('should remove .stale.* files', async () => {
    const stalePath = resolve(CHAT_DIR, 'test-chat-7.json.lock.stale.12345');
    await writeFile(stalePath, 'old-data', 'utf-8');

    const result = await runCleanup({ CHAT_LOCK_MIN_AGE_MS: '1' });
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('Removed stale file');

    // Verify file was removed
    await expect(readFile(stalePath, 'utf-8')).rejects.toThrow();
  });

  it('should respect CHAT_MAX_CLEANUP limit', async () => {
    // Create 3 lock files with dead PIDs
    for (let i = 0; i < 3; i++) {
      const lockPath = resolve(CHAT_DIR, `test-max-${i}.json.lock`);
      const content = `999999999\n${Date.now() - 120000}\n`;
      await writeFile(lockPath, content, 'utf-8');
    }

    const result = await runCleanup({
      CHAT_LOCK_MIN_AGE_MS: '1',
      CHAT_MAX_CLEANUP: '1',
    });
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('Reached max cleanup limit');
  });

  it('should not touch .json chat files', async () => {
    // Create a valid chat file alongside lock files
    const chatPath = resolve(CHAT_DIR, 'test-chat-8.json');
    const chatData = {
      id: 'test-chat-8',
      status: 'expired',
      chatId: 'oc_test',
      createdAt: '2026-01-01T00:00:00Z',
      activatedAt: '2026-01-01T00:01:00Z',
      expiresAt: '2026-01-02T00:00:00Z',
      expiredAt: '2026-01-02T00:00:00Z',
      createGroup: { name: 'Test', members: ['ou_test123'] },
      context: {},
      response: null,
      activationAttempts: 0,
      lastActivationError: null,
      failedAt: null,
    };
    await writeFile(chatPath, JSON.stringify(chatData, null, 2), 'utf-8');

    // Also create an orphaned lock
    const lockPath = resolve(CHAT_DIR, 'test-chat-8.json.lock');
    await writeFile(lockPath, `999999999\n${Date.now() - 120000}\n`, 'utf-8');

    const result = await runCleanup({ CHAT_LOCK_MIN_AGE_MS: '1' });
    expect(result.code).toBe(0);

    // Chat file should still exist
    const content = await readFile(chatPath, 'utf-8');
    const data = JSON.parse(content);
    expect(data.id).toBe('test-chat-8');

    // Lock file should be removed
    await expect(readFile(lockPath, 'utf-8')).rejects.toThrow();
  });
});
