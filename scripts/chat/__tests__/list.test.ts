/**
 * Integration tests for chat list.ts script.
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

async function createChat(id: string, status: string): Promise<void> {
  const chatData = {
    id,
    status,
    chatId: status === 'active' ? 'oc_existing' : null,
    createdAt: '2026-01-01T00:00:00Z',
    activatedAt: status === 'active' ? '2026-01-01T00:01:00Z' : null,
    expiresAt: status === 'expired' ? '2020-01-01T00:00:00Z' : '2099-12-31T23:59:59Z',
    createGroup: { name: `Test ${id}`, members: ['ou_test123'] },
    context: {},
    response: null,
    activationAttempts: status === 'failed' ? 5 : 0,
    lastActivationError: status === 'failed' ? 'Max retries exceeded' : null,
    failedAt: status === 'failed' ? '2026-01-01T00:01:00Z' : null,
  };
  await writeFile(resolve(CHAT_DIR, `${id}.json`), JSON.stringify(chatData, null, 2), 'utf-8');
}

const LIST_TEST_IDS = ['list-pending-1', 'list-active-1', 'list-expired-1', 'list-failed-1', 'list-corrupted-1'];

async function cleanupListTestFiles() {
  for (const id of LIST_TEST_IDS) {
    try {
      await rm(resolve(CHAT_DIR, `${id}.json`), { force: true });
      await rm(resolve(CHAT_DIR, `${id}.json.lock`), { force: true });
    } catch {
      // Ignore
    }
  }
}

describe('chat list script', () => {
  beforeEach(async () => {
    await mkdir(CHAT_DIR, { recursive: true });
    await cleanupListTestFiles();
  });

  afterEach(async () => {
    await cleanupListTestFiles();
  });

  it('should list all chats without filter', async () => {
    await createChat('list-pending-1', 'pending');
    await createChat('list-active-1', 'active');
    await createChat('list-expired-1', 'expired');

    const result = await runScript('scripts/chat/list.ts');

    expect(result.code).toBe(0);
    expect(result.stdout).toContain('list-pending-1.json');
    expect(result.stdout).toContain('list-active-1.json');
    expect(result.stdout).toContain('list-expired-1.json');
  });

  it('should filter chats by status', async () => {
    await createChat('list-pending-1', 'pending');
    await createChat('list-active-1', 'active');
    await createChat('list-expired-1', 'expired');
    await createChat('list-failed-1', 'failed');

    const result = await runScript('scripts/chat/list.ts', { CHAT_STATUS: 'active' });

    expect(result.code).toBe(0);
    expect(result.stdout).toContain('list-active-1.json');
    expect(result.stdout).not.toContain('list-pending-1.json');
    expect(result.stdout).not.toContain('list-expired-1.json');
    expect(result.stdout).not.toContain('list-failed-1.json');
  });

  it('should filter by pending status', async () => {
    await createChat('list-pending-1', 'pending');
    await createChat('list-active-1', 'active');

    const result = await runScript('scripts/chat/list.ts', { CHAT_STATUS: 'pending' });

    expect(result.code).toBe(0);
    expect(result.stdout).toContain('list-pending-1.json');
    expect(result.stdout).not.toContain('list-active-1.json');
  });

  it('should filter by failed status', async () => {
    await createChat('list-failed-1', 'failed');
    await createChat('list-active-1', 'active');

    const result = await runScript('scripts/chat/list.ts', { CHAT_STATUS: 'failed' });

    expect(result.code).toBe(0);
    expect(result.stdout).toContain('list-failed-1.json');
    expect(result.stdout).not.toContain('list-active-1.json');
  });

  it('should skip corrupted JSON files', async () => {
    await createChat('list-active-1', 'active');
    await writeFile(resolve(CHAT_DIR, 'list-corrupted-1.json'), 'not valid json', 'utf-8');

    const result = await runScript('scripts/chat/list.ts');

    expect(result.code).toBe(0);
    expect(result.stdout).toContain('list-active-1.json');
    expect(result.stderr).toContain('corrupted');
  });

  it('should return empty output when no chats exist', async () => {
    const result = await runScript('scripts/chat/list.ts');

    expect(result.code).toBe(0);
    expect(result.stdout).toBe('');
  });

  it('should return empty output when filter matches nothing', async () => {
    await createChat('list-pending-1', 'pending');

    const result = await runScript('scripts/chat/list.ts', { CHAT_STATUS: 'expired' });

    expect(result.code).toBe(0);
    expect(result.stdout).toBe('');
  });

  it('should reject invalid CHAT_STATUS value', async () => {
    await createChat('list-active-1', 'active');

    const result = await runScript('scripts/chat/list.ts', { CHAT_STATUS: 'invalid_status' });

    expect(result.code).toBe(1);
    expect(result.stderr).toContain('Invalid CHAT_STATUS');
  });

  it('should skip non-JSON files in chat directory', async () => {
    await createChat('list-active-1', 'active');
    await writeFile(resolve(CHAT_DIR, 'readme.txt'), 'This is a readme', 'utf-8');
    await writeFile(resolve(CHAT_DIR, '.gitkeep'), '', 'utf-8');

    const result = await runScript('scripts/chat/list.ts');

    expect(result.code).toBe(0);
    expect(result.stdout).toContain('list-active-1.json');
    expect(result.stdout).not.toContain('readme.txt');
    expect(result.stdout).not.toContain('.gitkeep');
  });
});
