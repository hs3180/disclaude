/**
 * Integration tests for chat list script.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdir, rm, writeFile } from 'node:fs/promises';
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

const TEST_IDS = ['test-list-a', 'test-list-b', 'test-list-c', 'test-list-d'];

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

function makeChatData(id: string, status: string) {
  return {
    id,
    status,
    chatId: status === 'active' ? 'oc_existing' : null,
    createdAt: '2026-01-01T00:00:00Z',
    activatedAt: status === 'active' ? '2026-01-01T00:01:00Z' : null,
    expiresAt: '2099-12-31T23:59:59Z',
    createGroup: { name: 'Test', members: ['ou_test123'] },
    context: {},
    response: null,
    activationAttempts: 0,
    lastActivationError: null,
    failedAt: null,
    expiredAt: null,
  };
}

describe('list script', () => {
  beforeEach(async () => {
    await mkdir(CHAT_DIR, { recursive: true });
    await cleanupTestFiles();
  });

  afterEach(async () => {
    await cleanupTestFiles();
  });

  it('should list all chats when no filter is provided', async () => {
    await writeFile(resolve(CHAT_DIR, 'test-list-a.json'), JSON.stringify(makeChatData('test-list-a', 'pending'), null, 2), 'utf-8');
    await writeFile(resolve(CHAT_DIR, 'test-list-b.json'), JSON.stringify(makeChatData('test-list-b', 'active'), null, 2), 'utf-8');

    const result = await runScript('scripts/chat/list.ts');

    expect(result.code).toBe(0);
    expect(result.stdout).toContain('test-list-a.json');
    expect(result.stdout).toContain('test-list-b.json');
  });

  it('should filter chats by status', async () => {
    await writeFile(resolve(CHAT_DIR, 'test-list-a.json'), JSON.stringify(makeChatData('test-list-a', 'pending'), null, 2), 'utf-8');
    await writeFile(resolve(CHAT_DIR, 'test-list-b.json'), JSON.stringify(makeChatData('test-list-b', 'active'), null, 2), 'utf-8');
    await writeFile(resolve(CHAT_DIR, 'test-list-c.json'), JSON.stringify(makeChatData('test-list-c', 'expired'), null, 2), 'utf-8');

    const result = await runScript('scripts/chat/list.ts', { CHAT_STATUS: 'active' });

    expect(result.code).toBe(0);
    expect(result.stdout).toContain('test-list-b.json');
    expect(result.stdout).not.toContain('test-list-a.json');
    expect(result.stdout).not.toContain('test-list-c.json');
  });

  it('should return empty when no chats match filter', async () => {
    await writeFile(resolve(CHAT_DIR, 'test-list-a.json'), JSON.stringify(makeChatData('test-list-a', 'pending'), null, 2), 'utf-8');

    const result = await runScript('scripts/chat/list.ts', { CHAT_STATUS: 'active' });

    expect(result.code).toBe(0);
    expect(result.stdout).not.toContain('test-list-a.json');
  });

  it('should reject invalid CHAT_STATUS', async () => {
    const result = await runScript('scripts/chat/list.ts', { CHAT_STATUS: 'invalid' });

    expect(result.code).toBe(1);
    expect(result.stderr).toContain('Invalid CHAT_STATUS');
  });

  it('should skip corrupted JSON files', async () => {
    await writeFile(resolve(CHAT_DIR, 'test-list-a.json'), JSON.stringify(makeChatData('test-list-a', 'pending'), null, 2), 'utf-8');
    await writeFile(resolve(CHAT_DIR, 'test-list-b.json'), 'not valid json{{{', 'utf-8');

    const result = await runScript('scripts/chat/list.ts');

    expect(result.code).toBe(0);
    expect(result.stdout).toContain('test-list-a.json');
    expect(result.stdout).not.toContain('test-list-b.json');
    expect(result.stderr).toContain('corrupted');
  });

  it('should handle empty chat directory', async () => {
    const result = await runScript('scripts/chat/list.ts');

    expect(result.code).toBe(0);
    expect(result.stdout).toBe('');
  });
});
