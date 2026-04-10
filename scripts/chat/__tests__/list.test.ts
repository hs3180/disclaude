/**
 * Integration tests for chat list script.
 *
 * Tests cover: listing all chats, status filtering, empty directory,
 * corrupted files, and non-JSON file handling.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdir, rm, writeFile } from 'node:fs/promises';
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
async function runScript(script: string, env: Record<string, string> = {}): Promise<{
  stdout: string;
  stderr: string;
  code: number;
}> {
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

// Helper to create a chat file
async function createTestChat(overrides: Record<string, unknown> = {}) {
  const defaults = {
    id: `test-list-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
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
  const chatData = { ...defaults, ...overrides };
  const filePath = resolve(CHAT_DIR, `${chatData.id}.json`);
  await writeFile(filePath, JSON.stringify(chatData, null, 2), 'utf-8');
  return { chatData, filePath };
}

// Track created files for cleanup
const createdFiles: string[] = [];

async function cleanupTestFiles() {
  for (const f of createdFiles) {
    try {
      await rm(f, { force: true });
      await rm(`${f}.lock`, { force: true });
    } catch {
      // Ignore
    }
  }
  createdFiles.length = 0;
}

describe('chat list', () => {
  beforeEach(async () => {
    await mkdir(CHAT_DIR, { recursive: true });
    await cleanupTestFiles();
  });

  afterEach(async () => {
    await cleanupTestFiles();
  });

  it('should list all chats when no filter is provided', async () => {
    const { filePath: fp1 } = await createTestChat({ id: 'list-all-1', status: 'pending' });
    createdFiles.push(fp1);
    const { filePath: fp2 } = await createTestChat({ id: 'list-all-2', status: 'active' });
    createdFiles.push(fp2);
    const { filePath: fp3 } = await createTestChat({ id: 'list-all-3', status: 'expired' });
    createdFiles.push(fp3);

    const result = await runScript('scripts/chat/list.ts');

    expect(result.code).toBe(0);
    expect(result.stdout).toContain('list-all-1.json');
    expect(result.stdout).toContain('list-all-2.json');
    expect(result.stdout).toContain('list-all-3.json');
  });

  it('should filter chats by status', async () => {
    const { filePath: fp1 } = await createTestChat({ id: 'filter-pending', status: 'pending' });
    createdFiles.push(fp1);
    const { filePath: fp2 } = await createTestChat({ id: 'filter-active', status: 'active' });
    createdFiles.push(fp2);
    const { filePath: fp3 } = await createTestChat({ id: 'filter-expired', status: 'expired' });
    createdFiles.push(fp3);
    const { filePath: fp4 } = await createTestChat({ id: 'filter-failed', status: 'failed' });
    createdFiles.push(fp4);

    // Filter by active
    const result = await runScript('scripts/chat/list.ts', { CHAT_STATUS: 'active' });

    expect(result.code).toBe(0);
    expect(result.stdout).toContain('filter-active.json');
    expect(result.stdout).not.toContain('filter-pending.json');
    expect(result.stdout).not.toContain('filter-expired.json');
    expect(result.stdout).not.toContain('filter-failed.json');
  });

  it('should filter by each status type independently', async () => {
    const statuses = ['pending', 'active', 'expired', 'failed'] as const;
    const filePaths: string[] = [];

    for (const status of statuses) {
      const { filePath } = await createTestChat({
        id: `status-test-${status}`,
        status,
      });
      filePaths.push(filePath);
    }
    createdFiles.push(...filePaths);

    for (const status of statuses) {
      const result = await runScript('scripts/chat/list.ts', { CHAT_STATUS: status });
      expect(result.code).toBe(0);
      expect(result.stdout).toContain(`status-test-${status}.json`);
      // Should NOT contain other statuses
      for (const other of statuses) {
        if (other !== status) {
          expect(result.stdout).not.toContain(`status-test-${other}.json`);
        }
      }
    }
  });

  it('should reject invalid CHAT_STATUS filter', async () => {
    const result = await runScript('scripts/chat/list.ts', { CHAT_STATUS: 'invalid' });

    expect(result.code).toBe(1);
    expect(result.stderr).toContain('Invalid CHAT_STATUS');
  });

  it('should return empty output for empty directory', async () => {
    const result = await runScript('scripts/chat/list.ts');

    expect(result.code).toBe(0);
    expect(result.stdout.trim()).toBe('');
  });

  it('should skip corrupted JSON files', async () => {
    const { filePath: fp1 } = await createTestChat({ id: 'list-valid', status: 'active' });
    createdFiles.push(fp1);

    // Create a corrupted file
    const corruptedPath = resolve(CHAT_DIR, 'list-corrupted.json');
    await writeFile(corruptedPath, '{invalid json content', 'utf-8');
    createdFiles.push(corruptedPath);

    const result = await runScript('scripts/chat/list.ts');

    expect(result.code).toBe(0);
    expect(result.stdout).toContain('list-valid.json');
    expect(result.stdout).not.toContain('list-corrupted.json');
    expect(result.stderr).toContain('corrupted');
  });

  it('should skip non-JSON files', async () => {
    const { filePath: fp1 } = await createTestChat({ id: 'list-json', status: 'active' });
    createdFiles.push(fp1);

    // Create a non-JSON file
    const txtPath = resolve(CHAT_DIR, 'not-a-chat.txt');
    await writeFile(txtPath, 'This is not a JSON file', 'utf-8');
    createdFiles.push(txtPath);

    // Create a lock file (not JSON)
    const lockPath = resolve(CHAT_DIR, 'some-chat.json.lock');
    await writeFile(lockPath, '', 'utf-8');
    createdFiles.push(lockPath);

    const result = await runScript('scripts/chat/list.ts');

    expect(result.code).toBe(0);
    expect(result.stdout).toContain('list-json.json');
    expect(result.stdout).not.toContain('not-a-chat.txt');
    expect(result.stdout).not.toContain('some-chat.json.lock');
  });

  it('should output one file path per line', async () => {
    const { filePath: fp1 } = await createTestChat({ id: 'format-1', status: 'pending' });
    createdFiles.push(fp1);
    const { filePath: fp2 } = await createTestChat({ id: 'format-2', status: 'pending' });
    createdFiles.push(fp2);

    const result = await runScript('scripts/chat/list.ts');
    const lines = result.stdout.trim().split('\n').filter((l) => l.length > 0);

    expect(result.code).toBe(0);
    expect(lines.length).toBe(2);
    // Each line should end with .json
    for (const line of lines) {
      expect(line.trim()).toMatch(/\.json$/);
    }
  });

  it('should handle chat with all valid status transitions', async () => {
    // Create chats in different states to verify list sees them all
    const states = [
      { id: 'lifecycle-pending', status: 'pending' },
      { id: 'lifecycle-active', status: 'active', chatId: 'oc_test', activatedAt: '2026-01-01T00:01:00Z' },
      { id: 'lifecycle-expired', status: 'expired', chatId: 'oc_test', activatedAt: '2026-01-01T00:01:00Z', expiredAt: '2026-01-02T00:00:00Z' },
      { id: 'lifecycle-failed', status: 'failed', activationAttempts: 5, lastActivationError: 'API error', failedAt: '2026-01-02T00:00:00Z' },
    ] as const;

    for (const state of states) {
      const { filePath } = await createTestChat(state);
      createdFiles.push(filePath);
    }

    // List all — should see all 4
    const allResult = await runScript('scripts/chat/list.ts');
    expect(allResult.code).toBe(0);
    const allLines = allResult.stdout.trim().split('\n').filter((l) => l.length > 0);
    expect(allLines.length).toBe(4);

    // Filter by pending — should see only 1
    const pendingResult = await runScript('scripts/chat/list.ts', { CHAT_STATUS: 'pending' });
    expect(pendingResult.code).toBe(0);
    const pendingLines = pendingResult.stdout.trim().split('\n').filter((l) => l.length > 0);
    expect(pendingLines.length).toBe(1);
    expect(pendingResult.stdout).toContain('lifecycle-pending.json');
  });
});
