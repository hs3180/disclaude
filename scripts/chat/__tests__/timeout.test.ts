/**
 * Integration tests for chat timeout script.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdir, rm, readFile, writeFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = resolve(__dirname, '../../..');
const CHAT_DIR = resolve(PROJECT_ROOT, 'workspace/chats');

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

const TEST_IDS = ['test-timeout-1', 'test-timeout-2', 'test-timeout-3', 'test-timeout-4'];

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

/** Format a Date as UTC Z-suffix ISO 8601 without milliseconds (matches UTC_DATETIME_REGEX) */
function toUTC(date: Date): string {
  return date.toISOString().replace(/\.\d{3}Z$/, 'Z');
}

function makeExpiredChat(id: string, overrides: Record<string, unknown> = {}) {
  const now = new Date();
  const expiredAt = new Date(now.getTime() - 2 * 60 * 60 * 1000); // 2 hours ago
  return {
    id,
    status: 'active',
    chatId: `oc_test_${id}`,
    createdAt: toUTC(new Date(now.getTime() - 24 * 60 * 60 * 1000)),
    activatedAt: toUTC(new Date(now.getTime() - 23 * 60 * 60 * 1000)),
    expiresAt: toUTC(expiredAt),
    createGroup: { name: 'Test Group', members: ['ou_test123'] },
    context: {},
    response: null,
    activationAttempts: 0,
    lastActivationError: null,
    failedAt: null,
    ...overrides,
  };
}

function makeActiveChat(id: string) {
  const now = new Date();
  const futureExpiry = new Date(now.getTime() + 24 * 60 * 60 * 1000); // 24 hours from now
  return makeExpiredChat(id, { expiresAt: toUTC(futureExpiry) });
}

describe('chat timeout', () => {
  beforeEach(async () => {
    await mkdir(CHAT_DIR, { recursive: true });
    await cleanupTestFiles();
  });

  afterEach(async () => {
    await cleanupTestFiles();
  });

  describe('timeout script', () => {
    it('should mark expired active chats without response as expired', async () => {
      const chatData = makeExpiredChat('test-timeout-1');
      await writeFile(
        resolve(CHAT_DIR, 'test-timeout-1.json'),
        JSON.stringify(chatData, null, 2),
        'utf-8',
      );

      const result = await runScript('scripts/chat/timeout.ts');

      expect(result.code).toBe(0);
      expect(result.stdout).toContain('expired');

      // Verify status changed
      const content = await readFile(resolve(CHAT_DIR, 'test-timeout-1.json'), 'utf-8');
      const data = JSON.parse(content);
      expect(data.status).toBe('expired');
      expect(data.expiredAt).toBeTruthy();
    });

    it('should mark expired active chats with response as expired (without dissolution)', async () => {
      const chatData = makeExpiredChat('test-timeout-2', {
        response: {
          content: 'Approved',
          responder: 'ou_test123',
          repliedAt: new Date().toISOString(),
        },
      });
      await writeFile(
        resolve(CHAT_DIR, 'test-timeout-2.json'),
        JSON.stringify(chatData, null, 2),
        'utf-8',
      );

      const result = await runScript('scripts/chat/timeout.ts');

      expect(result.code).toBe(0);
      expect(result.stdout).toContain('user responded');

      // Verify status changed
      const content = await readFile(resolve(CHAT_DIR, 'test-timeout-2.json'), 'utf-8');
      const data = JSON.parse(content);
      expect(data.status).toBe('expired');
      expect(data.expiredAt).toBeTruthy();
    });

    it('should skip chats that are not yet expired', async () => {
      const chatData = makeActiveChat('test-timeout-3');
      await writeFile(
        resolve(CHAT_DIR, 'test-timeout-3.json'),
        JSON.stringify(chatData, null, 2),
        'utf-8',
      );

      const result = await runScript('scripts/chat/timeout.ts');

      expect(result.code).toBe(0);
      expect(result.stdout).toContain('not yet expired');

      // Verify status unchanged
      const content = await readFile(resolve(CHAT_DIR, 'test-timeout-3.json'), 'utf-8');
      const data = JSON.parse(content);
      expect(data.status).toBe('active');
    });

    it('should skip chats with non-active status', async () => {
      const chatData = makeExpiredChat('test-timeout-4', { status: 'pending' });
      await writeFile(
        resolve(CHAT_DIR, 'test-timeout-4.json'),
        JSON.stringify(chatData, null, 2),
        'utf-8',
      );

      const result = await runScript('scripts/chat/timeout.ts');

      expect(result.code).toBe(0);

      // Verify status unchanged
      const content = await readFile(resolve(CHAT_DIR, 'test-timeout-4.json'), 'utf-8');
      const data = JSON.parse(content);
      expect(data.status).toBe('pending');
    });

    it('should respect CHAT_DRY_RUN and not modify files', async () => {
      const chatData = makeExpiredChat('test-timeout-1');
      await writeFile(
        resolve(CHAT_DIR, 'test-timeout-1.json'),
        JSON.stringify(chatData, null, 2),
        'utf-8',
      );

      const result = await runScript('scripts/chat/timeout.ts', { CHAT_DRY_RUN: '1' });

      expect(result.code).toBe(0);
      expect(result.stdout).toContain('DRY RUN');

      // Verify status unchanged
      const content = await readFile(resolve(CHAT_DIR, 'test-timeout-1.json'), 'utf-8');
      const data = JSON.parse(content);
      expect(data.status).toBe('active');
    });

    it('should report no active chats when directory is empty', async () => {
      const result = await runScript('scripts/chat/timeout.ts');

      expect(result.code).toBe(0);
      expect(result.stdout).toContain('No active chats');
    });
  });
});
