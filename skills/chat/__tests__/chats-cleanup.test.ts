/**
 * Integration tests for chats-cleanup schedule script.
 *
 * Tests the orphaned .lock file cleanup, stale residue cleanup,
 * and temp write residue cleanup without external dependencies.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdir, rm, writeFile, stat } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

// Derive project root from current file location
const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = resolve(__dirname, '../../..');
const CHAT_DIR = resolve(PROJECT_ROOT, 'workspace/chats');

// Helper to run the cleanup script
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

// All test file names
const TEST_FILES = [
  'cleanup-orphan.json',
  'cleanup-orphan.json.lock',     // Orphan lock (should be cleaned)
  'cleanup-active.json',
  'cleanup-active.json.lock',     // Active lock (should NOT be cleaned)
  'cleanup-residual.stale.12345', // Stale residue (should be cleaned)
  'cleanup-normal.json.9999999999.tmp', // Temp write residue (should be cleaned)
  'cleanup-normal.json',          // Normal JSON (should NOT be touched)
  'cleanup-normal.json.9999999999.tmp', // Temp write residue (should be cleaned)
];

async function setupTestFiles() {
  await mkdir(CHAT_DIR, { recursive: true });

  // Create JSON files
  await writeFile(resolve(CHAT_DIR, 'cleanup-orphan.json'), JSON.stringify({
    id: 'cleanup-orphan',
    status: 'expired',
    chatId: null,
    createdAt: '2026-01-01T00:00:00Z',
    activatedAt: null,
    expiresAt: '2020-01-01T00:00:00Z',
    expiredAt: '2020-01-02T00:00:00Z',
    createGroup: { name: 'Test', members: ['ou_test'] },
    context: {},
    response: null,
    activationAttempts: 0,
    lastActivationError: null,
    failedAt: null,
  }, null, 2) + '\n');

  await writeFile(resolve(CHAT_DIR, 'cleanup-active.json'), JSON.stringify({
    id: 'cleanup-active',
    status: 'active',
    chatId: 'oc_test',
    createdAt: '2026-01-01T00:00:00Z',
    activatedAt: '2026-01-01T00:01:00Z',
    expiresAt: '2099-12-31T23:59:59Z',
    expiredAt: null,
    createGroup: { name: 'Test Active', members: ['ou_test'] },
    context: {},
    response: null,
    activationAttempts: 0,
    lastActivationError: null,
    failedAt: null,
  }, null, 2) + '\n');

  await writeFile(resolve(CHAT_DIR, 'cleanup-normal.json'), JSON.stringify({
    id: 'cleanup-normal',
    status: 'pending',
    chatId: null,
    createdAt: '2026-01-01T00:00:00Z',
    activatedAt: null,
    expiresAt: '2099-12-31T23:59:59Z',
    expiredAt: null,
    createGroup: { name: 'Test Normal', members: ['ou_test'] },
    context: {},
    response: null,
    activationAttempts: 0,
    lastActivationError: null,
    failedAt: null,
  }, null, 2) + '\n');

  // Create lock files
  await writeFile(resolve(CHAT_DIR, 'cleanup-orphan.json.lock'), '12345\n999999999\n');
  await writeFile(resolve(CHAT_DIR, 'cleanup-active.json.lock'), '12345\n999999999\n');

  // Create stale residue file
  await writeFile(resolve(CHAT_DIR, 'cleanup-residual.stale.12345'), 'stale content');

  // Create temp write residue file (matching atomicWrite pattern: {name}.{timestamp}.tmp)
  await writeFile(resolve(CHAT_DIR, 'cleanup-normal.json.9999999999.tmp'), 'temp content');
}

async function cleanupTestFiles() {
  for (const f of TEST_FILES) {
    try {
      await rm(resolve(CHAT_DIR, f), { force: true });
    } catch {
      // Ignore
    }
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

  it('should exit successfully when no chats directory exists', async () => {
    await rm(CHAT_DIR, { recursive: true, force: true });
    const result = await runCleanup();
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('No chats directory');
  });

  it('should clean up orphaned .lock files', async () => {
    await setupTestFiles();
    // Delete the JSON file to make the lock orphaned
    await rm(resolve(CHAT_DIR, 'cleanup-orphan.json'), { force: true });

    const result = await runCleanup();
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('orphaned lock file');
    expect(result.stdout).toContain('cleanup-orphan.json.lock');

    // Verify the orphan lock was deleted
    await expect(stat(resolve(CHAT_DIR, 'cleanup-orphan.json.lock'))).rejects.toThrow();
  });

  it('should NOT delete .lock files with existing .json files', async () => {
    await setupTestFiles();

    const result = await runCleanup();
    expect(result.code).toBe(0);

    // The active lock should still exist
    const content = await stat(resolve(CHAT_DIR, 'cleanup-active.json.lock'));
    expect(content).toBeTruthy();
  });

  it('should clean up stale residue files', async () => {
    await setupTestFiles();

    const result = await runCleanup();
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('stale lock residue');
    expect(result.stdout).toContain('cleanup-residual.stale.12345');

    // Verify the stale file was deleted
    await expect(stat(resolve(CHAT_DIR, 'cleanup-residual.stale.12345'))).rejects.toThrow();
  });

  it('should clean up temp write residue files', async () => {
    await setupTestFiles();

    const result = await runCleanup();
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('temp write residue');
    expect(result.stdout).toContain('cleanup-normal.json.9999999999.tmp');

    // Verify the temp file was deleted
    await expect(stat(resolve(CHAT_DIR, 'cleanup-normal.json.9999999999.tmp'))).rejects.toThrow();
  });

  it('should NOT delete .json files', async () => {
    await setupTestFiles();

    const result = await runCleanup();
    expect(result.code).toBe(0);

    // All JSON files should still exist
    await expect(stat(resolve(CHAT_DIR, 'cleanup-active.json'))).resolves.toBeTruthy();
    await expect(stat(resolve(CHAT_DIR, 'cleanup-normal.json'))).resolves.toBeTruthy();
  });

  it('should report nothing to clean up for empty directory', async () => {
    const result = await runCleanup();
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('No residual files');
  });

  it('should handle all cleanup types in a single run', async () => {
    await setupTestFiles();
    // Make the orphan lock truly orphaned
    await rm(resolve(CHAT_DIR, 'cleanup-orphan.json'), { force: true });

    const result = await runCleanup();
    expect(result.code).toBe(0);

    // Verify cleanup summary
    expect(result.stdout).toContain('orphan locks: 1');
    expect(result.stdout).toContain('stale files: 1');
    expect(result.stdout).toContain('tmp files: 1');

    // Verify files that should remain
    await expect(stat(resolve(CHAT_DIR, 'cleanup-active.json'))).resolves.toBeTruthy();
    await expect(stat(resolve(CHAT_DIR, 'cleanup-active.json.lock'))).resolves.toBeTruthy();
    await expect(stat(resolve(CHAT_DIR, 'cleanup-normal.json'))).resolves.toBeTruthy();
  });

  it('should be idempotent — running twice produces same result', async () => {
    await setupTestFiles();
    await rm(resolve(CHAT_DIR, 'cleanup-orphan.json'), { force: true });

    // First run
    const result1 = await runCleanup();
    expect(result1.code).toBe(0);
    expect(result1.stdout).toContain('orphan locks: 1');

    // Second run — nothing to clean up (already cleaned)
    const result2 = await runCleanup();
    expect(result2.code).toBe(0);
    expect(result2.stdout).not.toContain('orphan locks: 1');
  });

  it('should only match .json.lock files (not other .lock files)', async () => {
    await mkdir(CHAT_DIR, { recursive: true });
    // Create a non-.json.lock file (e.g., data.lock)
    await writeFile(resolve(CHAT_DIR, 'data.lock'), '12345\n999999\n');

    const result = await runCleanup();
    expect(result.code).toBe(0);

    // data.lock should still exist (not orphan .json.lock)
    await expect(stat(resolve(CHAT_DIR, 'data.lock'))).resolves.toBeTruthy();

    // Cleanup
    await rm(resolve(CHAT_DIR, 'data.lock'), { force: true });
  });
});
