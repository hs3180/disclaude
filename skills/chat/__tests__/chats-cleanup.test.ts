/**
 * Tests for schedules/chats-cleanup.ts
 *
 * Uses child_process.execFile to run the script in isolation,
 * following the same pattern as chats-activation.test.ts.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdir, writeFile, stat, rm, unlink } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { pid } from 'node:process';

const execFileAsync = promisify(execFile);

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '../../..');
const SCRIPT = resolve(ROOT, 'schedules/chats-cleanup.ts');
const CHAT_DIR = resolve(ROOT, 'workspace/chats');

async function runScript(env?: Record<string, string>): Promise<{ stdout: string; stderr: string; exitCode: number | null }> {
  try {
    const result = await execFileAsync('npx', ['tsx', SCRIPT], {
      cwd: ROOT,
      timeout: 15000,
      env: { ...process.env, ...env },
    });
    return { stdout: result.stdout, stderr: result.stderr, exitCode: 0 };
  } catch (err: unknown) {
    const execErr = err as { stdout?: string; stderr?: string; code?: number | null };
    return {
      stdout: execErr.stdout ?? '',
      stderr: execErr.stderr ?? '',
      exitCode: execErr.code ?? 1,
    };
  }
}

describe('chats-cleanup script', () => {
  const createdFiles: string[] = [];

  beforeEach(async () => {
    // Ensure workspace/chats exists
    await mkdir(CHAT_DIR, { recursive: true });
  });

  afterEach(async () => {
    // Clean up test files
    for (const f of createdFiles) {
      await unlink(f).catch(() => {});
    }
    createdFiles.length = 0;
  });

  it('should exit successfully when no lock files exist', async () => {
    const result = await runScript();
    expect(result.exitCode).toBe(0);
  });

  it('should remove orphaned .lock file when corresponding .json does not exist', async () => {
    const lockPath = resolve(CHAT_DIR, 'orphan-test-123.json.lock');
    createdFiles.push(lockPath);

    // Create a .lock file without a corresponding .json
    await writeFile(lockPath, `${pid}\n${Date.now()}\n`);

    const result = await runScript();
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('Removed orphaned lock');

    // Verify the file was deleted
    await expect(stat(lockPath)).rejects.toThrow();
  });

  it('should remove stale .lock file when holder process is dead', async () => {
    const jsonPath = resolve(CHAT_DIR, 'stale-test-456.json');
    const lockPath = resolve(CHAT_DIR, 'stale-test-456.json.lock');
    createdFiles.push(jsonPath, lockPath);

    // Create a valid .json file
    await writeFile(jsonPath, JSON.stringify({
      id: 'stale-test-456',
      status: 'active',
      chatId: null,
      createdAt: '2026-04-20T10:00:00Z',
      activatedAt: null,
      expiresAt: '2026-04-21T10:00:00Z',
      expiredAt: null,
      createGroup: { name: 'Test Group', members: ['ou_test'] },
      context: {},
      response: null,
      activationAttempts: 0,
      lastActivationError: null,
      failedAt: null,
    }, null, 2) + '\n');

    // Create a .lock file with a dead PID (PID 99999999 is very unlikely to exist)
    await writeFile(lockPath, `99999999\n${Date.now()}\n`);

    const result = await runScript();
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('Removed stale lock');

    // Verify the lock was deleted but .json still exists
    await expect(stat(lockPath)).rejects.toThrow();
    await expect(stat(jsonPath)).resolves.toBeDefined();

    // Clean up the remaining json
    await unlink(jsonPath).catch(() => {});
  });

  it('should not remove .lock file when holder process is alive', async () => {
    const jsonPath = resolve(CHAT_DIR, 'active-test-789.json');
    const lockPath = resolve(CHAT_DIR, 'active-test-789.json.lock');
    createdFiles.push(jsonPath, lockPath);

    // Create a valid .json file
    await writeFile(jsonPath, JSON.stringify({
      id: 'active-test-789',
      status: 'active',
      chatId: null,
      createdAt: '2026-04-20T10:00:00Z',
      activatedAt: null,
      expiresAt: '2026-04-21T10:00:00Z',
      expiredAt: null,
      createGroup: { name: 'Test Group', members: ['ou_test'] },
      context: {},
      response: null,
      activationAttempts: 0,
      lastActivationError: null,
      failedAt: null,
    }, null, 2) + '\n');

    // Create a .lock file with current PID (alive)
    await writeFile(lockPath, `${pid}\n${Date.now()}\n`);

    const result = await runScript();
    expect(result.exitCode).toBe(0);

    // Verify the lock was NOT deleted
    await expect(stat(lockPath)).resolves.toBeDefined();
  });

  it('should remove corrupted .lock files', async () => {
    const jsonPath = resolve(CHAT_DIR, 'corrupt-test-abc.json');
    const lockPath = resolve(CHAT_DIR, 'corrupt-test-abc.json.lock');
    createdFiles.push(jsonPath, lockPath);

    // Create a valid .json file
    await writeFile(jsonPath, JSON.stringify({
      id: 'corrupt-test-abc',
      status: 'active',
      chatId: null,
      createdAt: '2026-04-20T10:00:00Z',
      activatedAt: null,
      expiresAt: '2026-04-21T10:00:00Z',
      expiredAt: null,
      createGroup: { name: 'Test Group', members: ['ou_test'] },
      context: {},
      response: null,
      activationAttempts: 0,
      lastActivationError: null,
      failedAt: null,
    }, null, 2) + '\n');

    // Create a corrupted .lock file (invalid content)
    await writeFile(lockPath, 'not a valid lock file');

    const result = await runScript();
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('Removed corrupted lock');

    // Verify the lock was deleted
    await expect(stat(lockPath)).rejects.toThrow();
  });

  it('should remove old .stale.* files', async () => {
    const stalePath = resolve(CHAT_DIR, 'test-stale-123.json.stale.99999');
    createdFiles.push(stalePath);

    // Create a stale file (use env to set zero threshold)
    await writeFile(stalePath, `${pid}\n`);

    const result = await runScript({ CHAT_STALE_MAX_AGE_MS: '0' });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('Removed stale file');

    // Verify the file was deleted
    await expect(stat(stalePath)).rejects.toThrow();
  });

  it('should not remove recent .stale.* files', async () => {
    const stalePath = resolve(CHAT_DIR, 'test-recent-stale-456.json.stale.99999');
    createdFiles.push(stalePath);

    // Create a very recent stale file with a large threshold
    await writeFile(stalePath, `${pid}\n`);

    const result = await runScript({ CHAT_STALE_MAX_AGE_MS: '999999999' });
    expect(result.exitCode).toBe(0);

    // Verify the file was NOT deleted
    await expect(stat(stalePath)).resolves.toBeDefined();
  });
});
