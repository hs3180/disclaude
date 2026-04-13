/**
 * Integration tests for chats-cleanup script.
 *
 * Tests the orphaned .lock file cleanup logic.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdir, rm, writeFile, stat, readFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { pid } from 'node:process';

const execFileAsync = promisify(execFile);

// Derive project root from current file location
const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = resolve(__dirname, '../../..');
const CHAT_DIR = resolve(PROJECT_ROOT, 'workspace/chats');

// Helper to run a script with environment variables
async function runScript(script: string, env: Record<string, string>): Promise<{ stdout: string; stderr: string; code: number }> {
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
  'test-cleanup-orphan',
  'test-cleanup-stale',
  'test-cleanup-active',
  'test-cleanup-invalid',
  'test-cleanup-limit-1',
  'test-cleanup-limit-2',
  'test-cleanup-limit-3',
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
}

function createChatJson(id: string, overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    id,
    status: 'active',
    chatId: 'oc_test',
    createdAt: '2026-01-01T00:00:00Z',
    activatedAt: '2026-01-01T00:01:00Z',
    expiresAt: '2099-12-31T23:59:59Z',
    expiredAt: null,
    createGroup: { name: 'Test', members: ['ou_test123'] },
    context: {},
    response: null,
    activationAttempts: 0,
    lastActivationError: null,
    failedAt: null,
    ...overrides,
  }, null, 2);
}

function createLockContent(holderPid: number = pid): string {
  return `${holderPid}\n${Date.now()}\n`;
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
    const result = await runScript('skills/chat/chats-cleanup.ts', {});
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('No chats directory');
  });

  it('should report no lock files when directory is empty', async () => {
    // Directory exists but no files
    const result = await runScript('skills/chat/chats-cleanup.ts', {});
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('No lock files found');
  });

  it('should clean up orphaned lock file (no corresponding .json)', async () => {
    // Create only the lock file, no .json file
    await writeFile(
      resolve(CHAT_DIR, 'test-cleanup-orphan.json.lock'),
      createLockContent(999999), // PID that definitely doesn't exist
    );

    const result = await runScript('skills/chat/chats-cleanup.ts', {});
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('Cleaned up orphaned lock');

    // Verify lock file was deleted
    await expect(stat(resolve(CHAT_DIR, 'test-cleanup-orphan.json.lock'))).rejects.toThrow();
  });

  it('should clean up stale lock file with dead holder (json exists)', async () => {
    // Create both .json and .lock files
    await writeFile(
      resolve(CHAT_DIR, 'test-cleanup-stale.json'),
      createChatJson('test-cleanup-stale'),
    );
    await writeFile(
      resolve(CHAT_DIR, 'test-cleanup-stale.json.lock'),
      createLockContent(999999), // PID that definitely doesn't exist
    );

    const result = await runScript('skills/chat/chats-cleanup.ts', {});
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('Cleaned up stale lock');

    // Verify lock file was deleted
    await expect(stat(resolve(CHAT_DIR, 'test-cleanup-stale.json.lock'))).rejects.toThrow();

    // Verify .json file was NOT deleted
    const content = await readFile(resolve(CHAT_DIR, 'test-cleanup-stale.json'), 'utf-8');
    expect(JSON.parse(content).id).toBe('test-cleanup-stale');
  });

  it('should not delete lock file with live holder', async () => {
    // Create lock file with current process PID (definitely alive)
    await writeFile(
      resolve(CHAT_DIR, 'test-cleanup-active.json.lock'),
      createLockContent(pid),
    );
    // No .json file (orphaned but live holder)

    const result = await runScript('skills/chat/chats-cleanup.ts', {});
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('Skipping orphaned lock with live holder');

    // Verify lock file still exists
    const content = await readFile(resolve(CHAT_DIR, 'test-cleanup-active.json.lock'), 'utf-8');
    expect(content).toContain(String(pid));
  });

  it('should clean up lock with invalid content', async () => {
    // Create lock file with invalid content
    await writeFile(
      resolve(CHAT_DIR, 'test-cleanup-invalid.json.lock'),
      'invalid lock content',
    );
    // No .json file

    const result = await runScript('skills/chat/chats-cleanup.ts', {});
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('Cleaned up orphaned lock');

    // Verify lock file was deleted
    await expect(stat(resolve(CHAT_DIR, 'test-cleanup-invalid.json.lock'))).rejects.toThrow();
  });

  it('should respect CHAT_MAX_PER_RUN limit', async () => {
    // Create multiple orphaned lock files
    for (let i = 1; i <= 3; i++) {
      await writeFile(
        resolve(CHAT_DIR, `test-cleanup-limit-${i}.json.lock`),
        createLockContent(999999),
      );
    }

    const result = await runScript('skills/chat/chats-cleanup.ts', {
      CHAT_MAX_PER_RUN: '2',
    });
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('Reached max processing limit');
    expect(result.stdout).toContain('Cleaned up 2 lock file(s)');

    // One lock file should remain
    const remaining = await readFile(resolve(CHAT_DIR, 'test-cleanup-limit-3.json.lock'), 'utf-8');
    expect(remaining).toBeTruthy();
  });

  it('should handle empty lock file gracefully', async () => {
    // Create an empty lock file
    await writeFile(
      resolve(CHAT_DIR, 'test-cleanup-orphan.json.lock'),
      '',
    );

    const result = await runScript('skills/chat/chats-cleanup.ts', {});
    expect(result.code).toBe(0);
    // Empty file is invalid content — should be cleaned up
    expect(result.stdout).toContain('Cleaned up');
  });

  it('should not affect .json files', async () => {
    // Create .json files without locks
    await writeFile(
      resolve(CHAT_DIR, 'test-cleanup-orphan.json'),
      createChatJson('test-cleanup-orphan'),
    );

    // Also create one orphaned lock
    await writeFile(
      resolve(CHAT_DIR, 'test-cleanup-stale.json.lock'),
      createLockContent(999999),
    );

    const result = await runScript('skills/chat/chats-cleanup.ts', {});
    expect(result.code).toBe(0);

    // .json file should still exist
    const content = await readFile(resolve(CHAT_DIR, 'test-cleanup-orphan.json'), 'utf-8');
    expect(JSON.parse(content).id).toBe('test-cleanup-orphan');
  });
});
