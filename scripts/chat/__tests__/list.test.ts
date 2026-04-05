/**
 * Integration tests for chat list script.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdir, rm, readFile, writeFile, readdir } from 'node:fs/promises';
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

function makeChatFile(overrides: Record<string, unknown> = {}): string {
  const defaults = {
    id: 'test-list-1',
    status: 'pending',
    chatId: null,
    createdAt: '2026-01-01T00:00:00Z',
    activatedAt: null,
    expiresAt: '2099-12-31T23:59:59Z',
    createGroup: { name: 'Test Group', members: ['ou_test123'] },
    context: {},
    response: null,
    activationAttempts: 0,
    lastActivationError: null,
    failedAt: null,
  };
  return JSON.stringify({ ...defaults, ...overrides }, null, 2);
}

/**
 * Remove ALL files from the chat directory (needed because tests run in
 * single-fork mode and other test suites may leave files behind).
 */
async function cleanChatDir() {
  try {
    const files = await readdir(CHAT_DIR);
    for (const file of files) {
      await rm(resolve(CHAT_DIR, file), { force: true });
    }
  } catch {
    // Ignore if directory doesn't exist
  }
}

describe('chat list', () => {
  beforeEach(async () => {
    await mkdir(CHAT_DIR, { recursive: true });
    await cleanChatDir();
  });

  afterEach(async () => {
    await cleanChatDir();
  });

  it('should list all chat files', async () => {
    // Create chats with different statuses
    await writeFile(resolve(CHAT_DIR, 'test-list-1.json'), makeChatFile({ id: 'test-list-1', status: 'pending' }), 'utf-8');
    await writeFile(resolve(CHAT_DIR, 'test-list-2.json'), makeChatFile({ id: 'test-list-2', status: 'active' }), 'utf-8');
    await writeFile(resolve(CHAT_DIR, 'test-list-3.json'), makeChatFile({ id: 'test-list-3', status: 'expired' }), 'utf-8');

    const result = await runScript('scripts/chat/list.ts');

    expect(result.code).toBe(0);
    expect(result.stdout).toContain('test-list-1.json');
    expect(result.stdout).toContain('test-list-2.json');
    expect(result.stdout).toContain('test-list-3.json');
  });

  it('should filter by status', async () => {
    await writeFile(resolve(CHAT_DIR, 'test-list-1.json'), makeChatFile({ id: 'test-list-1', status: 'pending' }), 'utf-8');
    await writeFile(resolve(CHAT_DIR, 'test-list-2.json'), makeChatFile({ id: 'test-list-2', status: 'active' }), 'utf-8');
    await writeFile(resolve(CHAT_DIR, 'test-list-3.json'), makeChatFile({ id: 'test-list-3', status: 'expired' }), 'utf-8');

    const result = await runScript('scripts/chat/list.ts', { CHAT_STATUS: 'active' });

    expect(result.code).toBe(0);
    expect(result.stdout).toContain('test-list-2.json');
    expect(result.stdout).not.toContain('test-list-1.json');
    expect(result.stdout).not.toContain('test-list-3.json');
  });

  it('should filter by pending status', async () => {
    await writeFile(resolve(CHAT_DIR, 'test-list-1.json'), makeChatFile({ id: 'test-list-1', status: 'pending' }), 'utf-8');
    await writeFile(resolve(CHAT_DIR, 'test-list-2.json'), makeChatFile({ id: 'test-list-2', status: 'active' }), 'utf-8');
    await writeFile(resolve(CHAT_DIR, 'test-list-3.json'), makeChatFile({ id: 'test-list-3', status: 'failed' }), 'utf-8');

    const result = await runScript('scripts/chat/list.ts', { CHAT_STATUS: 'pending' });

    expect(result.code).toBe(0);
    expect(result.stdout).toContain('test-list-1.json');
    expect(result.stdout).not.toContain('test-list-2.json');
    expect(result.stdout).not.toContain('test-list-3.json');
  });

  it('should filter by expired status', async () => {
    await writeFile(resolve(CHAT_DIR, 'test-list-1.json'), makeChatFile({ id: 'test-list-1', status: 'active' }), 'utf-8');
    await writeFile(resolve(CHAT_DIR, 'test-list-2.json'), makeChatFile({ id: 'test-list-2', status: 'expired' }), 'utf-8');
    await writeFile(resolve(CHAT_DIR, 'test-list-3.json'), makeChatFile({ id: 'test-list-3', status: 'expired' }), 'utf-8');

    const result = await runScript('scripts/chat/list.ts', { CHAT_STATUS: 'expired' });

    expect(result.code).toBe(0);
    expect(result.stdout).toContain('test-list-2.json');
    expect(result.stdout).toContain('test-list-3.json');
    expect(result.stdout).not.toContain('test-list-1.json');
  });

  it('should filter by failed status', async () => {
    await writeFile(resolve(CHAT_DIR, 'test-list-1.json'), makeChatFile({ id: 'test-list-1', status: 'failed' }), 'utf-8');
    await writeFile(resolve(CHAT_DIR, 'test-list-2.json'), makeChatFile({ id: 'test-list-2', status: 'active' }), 'utf-8');

    const result = await runScript('scripts/chat/list.ts', { CHAT_STATUS: 'failed' });

    expect(result.code).toBe(0);
    expect(result.stdout).toContain('test-list-1.json');
    expect(result.stdout).not.toContain('test-list-2.json');
  });

  it('should return empty result for non-matching filter', async () => {
    await writeFile(resolve(CHAT_DIR, 'test-list-1.json'), makeChatFile({ id: 'test-list-1', status: 'pending' }), 'utf-8');

    const result = await runScript('scripts/chat/list.ts', { CHAT_STATUS: 'expired' });

    expect(result.code).toBe(0);
    expect(result.stdout.trim()).toBe('');
  });

  it('should reject invalid CHAT_STATUS', async () => {
    await writeFile(resolve(CHAT_DIR, 'test-list-1.json'), makeChatFile(), 'utf-8');

    const result = await runScript('scripts/chat/list.ts', { CHAT_STATUS: 'invalid_status' });

    expect(result.code).toBe(1);
    expect(result.stderr).toContain('Invalid CHAT_STATUS');
  });

  it('should skip corrupted JSON files', async () => {
    await writeFile(resolve(CHAT_DIR, 'test-list-1.json'), makeChatFile({ id: 'test-list-1', status: 'active' }), 'utf-8');
    await writeFile(resolve(CHAT_DIR, 'test-list-2.json'), 'not valid json {{{', 'utf-8');

    const result = await runScript('scripts/chat/list.ts');

    expect(result.code).toBe(0);
    expect(result.stdout).toContain('test-list-1.json');
    expect(result.stderr).toContain('corrupted');
    expect(result.stdout).not.toContain('test-list-2.json');
  });

  it('should skip non-JSON files in chat directory', async () => {
    await writeFile(resolve(CHAT_DIR, 'test-list-1.json'), makeChatFile({ id: 'test-list-1', status: 'active' }), 'utf-8');
    await writeFile(resolve(CHAT_DIR, 'readme.txt'), 'This is a text file', 'utf-8');
    await writeFile(resolve(CHAT_DIR, '.hidden'), '', 'utf-8');

    const result = await runScript('scripts/chat/list.ts');

    expect(result.code).toBe(0);
    expect(result.stdout).toContain('test-list-1.json');
    expect(result.stdout).not.toContain('readme.txt');
    expect(result.stdout).not.toContain('.hidden');
  });

  it('should output one file path per line', async () => {
    await writeFile(resolve(CHAT_DIR, 'test-list-1.json'), makeChatFile({ id: 'test-list-1' }), 'utf-8');
    await writeFile(resolve(CHAT_DIR, 'test-list-2.json'), makeChatFile({ id: 'test-list-2' }), 'utf-8');

    const result = await runScript('scripts/chat/list.ts');
    const lines = result.stdout.trim().split('\n').filter((l) => l.length > 0);

    expect(result.code).toBe(0);
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatch(/test-list-\d\.json$/);
    expect(lines[1]).toMatch(/test-list-\d\.json$/);
  });

  it('should handle empty chat directory gracefully', async () => {
    const result = await runScript('scripts/chat/list.ts');

    expect(result.code).toBe(0);
    expect(result.stdout.trim()).toBe('');
  });
});
