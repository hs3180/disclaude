/**
 * Integration tests for chat-timeout script.
 *
 * Tests the timeout detection, group dissolution, and cleanup logic
 * without actually calling lark-cli (tests run with network isolation).
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
async function runScript(script: string, env: Record<string, string>): Promise<{ stdout: string; stderr: string; code: number }> {
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
    id: 'test-timeout-1',
    status: 'active',
    chatId: 'oc_test_group',
    createdAt: '2026-01-01T00:00:00Z',
    activatedAt: '2026-01-01T00:01:00Z',
    expiresAt: '2020-01-01T00:00:00Z', // Far in the past — guaranteed expired
    createGroup: { name: 'Test Group', members: ['ou_test123'] },
    context: {},
    response: null,
    activationAttempts: 0,
    lastActivationError: null,
    failedAt: null,
    expiredAt: null,
  };
  return JSON.stringify({ ...defaults, ...overrides }, null, 2);
}

const TEST_IDS = ['test-timeout-1', 'test-timeout-2', 'test-timeout-3', 'test-timeout-4', 'test-timeout-cleanup'];

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

describe('chat-timeout script', () => {
  beforeEach(async () => {
    await mkdir(CHAT_DIR, { recursive: true });
    await cleanupTestFiles();
  });

  afterEach(async () => {
    await cleanupTestFiles();
  });

  it('should exit successfully when no chats directory exists', async () => {
    // Remove the chats directory temporarily
    await rm(CHAT_DIR, { recursive: true, force: true });
    const result = await runScript('scripts/schedule/chat-timeout.ts', {});
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('No chats directory');
  });

  it('should report no expired chats when all are pending', async () => {
    await writeFile(
      resolve(CHAT_DIR, 'test-timeout-1.json'),
      createChatData({ id: 'test-timeout-1', status: 'pending', expiresAt: '2099-12-31T23:59:59Z' }),
    );
    const result = await runScript('scripts/schedule/chat-timeout.ts', {});
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('No expired chats');
  });

  it('should detect and mark expired active chat without response', async () => {
    await writeFile(
      resolve(CHAT_DIR, 'test-timeout-1.json'),
      createChatData({ id: 'test-timeout-1', response: null }),
    );
    const result = await runScript('scripts/schedule/chat-timeout.ts', {});
    expect(result.code).toBe(0);

    // Verify status was updated to expired
    const content = await readFile(resolve(CHAT_DIR, 'test-timeout-1.json'), 'utf-8');
    const data = JSON.parse(content);
    expect(data.status).toBe('expired');
    expect(data.expiredAt).toBeTruthy();
  });

  it('should detect and mark expired active chat with response (without dissolving group)', async () => {
    await writeFile(
      resolve(CHAT_DIR, 'test-timeout-1.json'),
      createChatData({
        id: 'test-timeout-1',
        response: {
          content: 'Approved',
          responder: 'ou_test123',
          repliedAt: '2026-01-01T10:00:00Z',
        },
      }),
    );
    const result = await runScript('scripts/schedule/chat-timeout.ts', {});
    expect(result.code).toBe(0);

    // Verify status was updated to expired
    const content = await readFile(resolve(CHAT_DIR, 'test-timeout-1.json'), 'utf-8');
    const data = JSON.parse(content);
    expect(data.status).toBe('expired');
    expect(data.expiredAt).toBeTruthy();
    // Response should be preserved
    expect(data.response).not.toBeNull();
    expect(data.response.content).toBe('Approved');
  });

  it('should not process non-expired active chats', async () => {
    await writeFile(
      resolve(CHAT_DIR, 'test-timeout-1.json'),
      createChatData({ id: 'test-timeout-1', expiresAt: '2099-12-31T23:59:59Z' }),
    );
    const result = await runScript('scripts/schedule/chat-timeout.ts', {});
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('No expired chats');

    // Verify status is still active
    const content = await readFile(resolve(CHAT_DIR, 'test-timeout-1.json'), 'utf-8');
    const data = JSON.parse(content);
    expect(data.status).toBe('active');
  });

  it('should not process already expired chats again', async () => {
    await writeFile(
      resolve(CHAT_DIR, 'test-timeout-1.json'),
      createChatData({ id: 'test-timeout-1', status: 'expired', expiredAt: '2020-01-01T01:00:00Z' }),
    );
    const result = await runScript('scripts/schedule/chat-timeout.ts', {});
    expect(result.code).toBe(0);
    // Should not process as expired active
    expect(result.stdout).not.toContain('marked as expired');
  });

  it('should skip corrupted JSON files', async () => {
    await writeFile(resolve(CHAT_DIR, 'test-timeout-1.json'), 'not valid json {{{');
    const result = await runScript('scripts/schedule/chat-timeout.ts', {});
    expect(result.code).toBe(0);
    expect(result.stderr).toContain('corrupted');
  });

  it('should respect CHAT_MAX_PER_RUN limit', async () => {
    // Create multiple expired active chats
    for (let i = 1; i <= 3; i++) {
      await writeFile(
        resolve(CHAT_DIR, `test-timeout-${i}.json`),
        createChatData({ id: `test-timeout-${i}` }),
      );
    }

    const result = await runScript('scripts/schedule/chat-timeout.ts', {
      CHAT_MAX_PER_RUN: '2',
    });
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('Reached max processing limit');
  });

  it('should clean up expired files past retention period', async () => {
    // Create an expired chat with expiredAt far in the past
    await writeFile(
      resolve(CHAT_DIR, 'test-timeout-cleanup.json'),
      createChatData({
        id: 'test-timeout-cleanup',
        status: 'expired',
        expiredAt: '2020-01-01T00:00:00Z',
        expiresAt: '2020-01-01T00:00:00Z',
      }),
    );

    const result = await runScript('scripts/schedule/chat-timeout.ts', {
      CHAT_EXPIRED_RETENTION_HOURS: '1',
    });
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('Cleaned up');

    // Verify file was deleted
    await expect(stat(resolve(CHAT_DIR, 'test-timeout-cleanup.json'))).rejects.toThrow();
  });

  it('should not clean up recently expired files', async () => {
    // Create an expired chat with expiredAt in the recent past (within retention)
    const recentTime = new Date(Date.now() - 10 * 60 * 1000).toISOString(); // 10 minutes ago
    await writeFile(
      resolve(CHAT_DIR, 'test-timeout-cleanup.json'),
      createChatData({
        id: 'test-timeout-cleanup',
        status: 'expired',
        expiredAt: recentTime,
        expiresAt: recentTime,
      }),
    );

    const result = await runScript('scripts/schedule/chat-timeout.ts', {
      CHAT_EXPIRED_RETENTION_HOURS: '1',
    });
    expect(result.code).toBe(0);

    // File should still exist
    const content = await readFile(resolve(CHAT_DIR, 'test-timeout-cleanup.json'), 'utf-8');
    expect(JSON.parse(content).status).toBe('expired');
  });

  it('should not process active chat without chatId', async () => {
    await writeFile(
      resolve(CHAT_DIR, 'test-timeout-1.json'),
      createChatData({ id: 'test-timeout-1', chatId: null }),
    );
    const result = await runScript('scripts/schedule/chat-timeout.ts', {});
    expect(result.code).toBe(0);

    // Should still mark as expired (no group to dissolve)
    const content = await readFile(resolve(CHAT_DIR, 'test-timeout-1.json'), 'utf-8');
    const data = JSON.parse(content);
    expect(data.status).toBe('expired');
  });

  it('should handle expired active chat with non-UTC expiresAt gracefully', async () => {
    await writeFile(
      resolve(CHAT_DIR, 'test-timeout-1.json'),
      createChatData({
        id: 'test-timeout-1',
        expiresAt: '2020-01-01T00:00:00+08:00', // Non-UTC format
      }),
    );
    const result = await runScript('scripts/schedule/chat-timeout.ts', {});
    expect(result.code).toBe(0);

    // Non-UTC format should be skipped (fail-open)
    expect(result.stdout).toContain('No expired chats');
  });

  it('should handle failed chats gracefully (skip them)', async () => {
    await writeFile(
      resolve(CHAT_DIR, 'test-timeout-1.json'),
      createChatData({
        id: 'test-timeout-1',
        status: 'failed',
        failedAt: '2020-01-01T00:00:00Z',
        expiresAt: '2020-01-01T00:00:00Z',
      }),
    );
    const result = await runScript('scripts/schedule/chat-timeout.ts', {});
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('No expired chats');
  });
});
