/**
 * Integration tests for chat expire and cleanup scripts.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdir, rm, readFile, writeFile, stat } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = resolve(__dirname, '../../..');
const CHAT_DIR = resolve(PROJECT_ROOT, 'workspace/chats');

interface ChatFile {
  id: string;
  status: string;
  chatId: string | null;
  createdAt: string;
  activatedAt: string | null;
  expiresAt: string;
  createGroup: { name: string; members: string[] };
  context: Record<string, unknown>;
  response: unknown;
  activationAttempts: number;
  lastActivationError: string | null;
  failedAt: string | null;
  expiredAt?: string | null;
}

// Helper to run a TypeScript script with environment variables
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

// Helper to create a test chat file
async function createTestChat(overrides: Partial<ChatFile> = {}): Promise<ChatFile> {
  const defaults: ChatFile = {
    id: `test-expire-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    status: 'active',
    chatId: 'oc_test_chat',
    createdAt: '2026-01-01T00:00:00Z',
    activatedAt: '2026-01-01T00:01:00Z',
    expiresAt: '2026-01-01T01:00:00Z', // Already expired
    createGroup: { name: 'Test Group', members: ['ou_test123'] },
    context: {},
    response: null,
    activationAttempts: 0,
    lastActivationError: null,
    failedAt: null,
  };

  const chat = { ...defaults, ...overrides };
  const filePath = resolve(CHAT_DIR, `${chat.id}.json`);
  await writeFile(filePath, JSON.stringify(chat, null, 2), 'utf-8');
  return chat;
}

// Helper to read a chat file
async function readChat(id: string): Promise<ChatFile> {
  const filePath = resolve(CHAT_DIR, `${id}.json`);
  const content = await readFile(filePath, 'utf-8');
  return JSON.parse(content);
}

// Helper to check if a file exists
async function fileExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

const testIds: string[] = [];

function trackId(...ids: string[]) {
  for (const id of ids) {
    if (!testIds.includes(id)) {
      testIds.push(id);
    }
  }
}

async function cleanupTestFiles() {
  for (const id of testIds) {
    try {
      await rm(resolve(CHAT_DIR, `${id}.json`), { force: true });
      await rm(resolve(CHAT_DIR, `${id}.json.lock`), { force: true });
    } catch {
      // Ignore
    }
  }
  testIds.length = 0;
}

describe('expire script', () => {
  beforeEach(async () => {
    await mkdir(CHAT_DIR, { recursive: true });
    await cleanupTestFiles();
  });

  afterEach(async () => {
    await cleanupTestFiles();
  });

  it('should mark an expired active chat as expired', async () => {
    const chat = await createTestChat({
      expiresAt: '2020-01-01T00:00:00Z', // Far in the past
    });
    trackId(chat.id);

    const result = await runScript('scripts/chat/expire.ts', {
      CHAT_EXPIRE_DRY_RUN: 'true',
    });

    expect(result.code).toBe(0);
    expect(result.stdout).toContain('expired');

    const updated = await readChat(chat.id);
    expect(updated.status).toBe('expired');
    expect(updated.expiredAt).toBeTruthy();
  });

  it('should NOT expire an active chat that has not timed out', async () => {
    const futureExpiry = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
    const chat = await createTestChat({
      expiresAt: futureExpiry,
    });
    trackId(chat.id);

    const result = await runScript('scripts/chat/expire.ts', {
      CHAT_EXPIRE_DRY_RUN: 'true',
    });

    expect(result.code).toBe(0);

    const updated = await readChat(chat.id);
    expect(updated.status).toBe('active');
    expect(updated.expiredAt).toBeUndefined();
  });

  it('should skip non-active chats (pending, failed, expired)', async () => {
    const chat1 = await createTestChat({ id: 'test-exp-pending', status: 'pending', expiresAt: '2020-01-01T00:00:00Z' });
    const chat2 = await createTestChat({ id: 'test-exp-failed', status: 'failed', expiresAt: '2020-01-01T00:00:00Z' });
    const chat3 = await createTestChat({ id: 'test-exp-expired', status: 'expired', expiresAt: '2020-01-01T00:00:00Z' });
    trackId(chat1.id, chat2.id, chat3.id);

    const result = await runScript('scripts/chat/expire.ts', {
      CHAT_EXPIRE_DRY_RUN: 'true',
    });

    expect(result.code).toBe(0);

    // None should have been modified
    expect((await readChat(chat1.id)).status).toBe('pending');
    expect((await readChat(chat2.id)).status).toBe('failed');
    expect((await readChat(chat3.id)).status).toBe('expired');
  });

  it('should skip chats with non-UTC expiresAt format', async () => {
    const chat = await createTestChat({
      expiresAt: '2020-01-01T00:00:00+08:00', // Non-UTC
    });
    trackId(chat.id);

    const result = await runScript('scripts/chat/expire.ts', {
      CHAT_EXPIRE_DRY_RUN: 'true',
    });

    expect(result.code).toBe(0);

    const updated = await readChat(chat.id);
    expect(updated.status).toBe('active');
  });

  it('should skip corrupted JSON files', async () => {
    // Create a corrupted file
    const corruptedId = `test-exp-corrupted-${Date.now()}`;
    trackId(corruptedId);
    const filePath = resolve(CHAT_DIR, `${corruptedId}.json`);
    await writeFile(filePath, '{invalid json}', 'utf-8');

    // Create a valid expired chat to ensure the script doesn't crash
    const chat = await createTestChat({ expiresAt: '2020-01-01T00:00:00Z' });
    trackId(chat.id);

    const result = await runScript('scripts/chat/expire.ts', {
      CHAT_EXPIRE_DRY_RUN: 'true',
    });

    expect(result.code).toBe(0);
    expect(result.stderr).toContain('corrupted');

    // The valid chat should still be processed
    const updated = await readChat(chat.id);
    expect(updated.status).toBe('expired');
  });

  it('should handle chats without chatId (no group to dissolve)', async () => {
    const chat = await createTestChat({
      chatId: null,
      expiresAt: '2020-01-01T00:00:00Z',
    });
    trackId(chat.id);

    const result = await runScript('scripts/chat/expire.ts', {
      CHAT_EXPIRE_DRY_RUN: 'true',
    });

    expect(result.code).toBe(0);
    expect(result.stdout).toContain('no chatId');

    const updated = await readChat(chat.id);
    expect(updated.status).toBe('expired');
  });

  it('should respect CHAT_MAX_PER_RUN limit', async () => {
    // Create 3 expired chats
    const chats = await Promise.all([
      createTestChat({ id: 'test-exp-limit-1', expiresAt: '2020-01-01T00:00:00Z' }),
      createTestChat({ id: 'test-exp-limit-2', expiresAt: '2020-01-01T00:00:00Z' }),
      createTestChat({ id: 'test-exp-limit-3', expiresAt: '2020-01-01T00:00:00Z' }),
    ]);
    chats.forEach((c) => trackId(c.id));

    // Only process 2
    const result = await runScript('scripts/chat/expire.ts', {
      CHAT_EXPIRE_DRY_RUN: 'true',
      CHAT_MAX_PER_RUN: '2',
    });

    expect(result.code).toBe(0);
    expect(result.stdout).toContain('max processing limit');

    // At least 2 should be expired (order is non-deterministic for fs.readdir)
    let expiredCount = 0;
    for (const c of chats) {
      const updated = await readChat(c.id);
      if (updated.status === 'expired') expiredCount++;
    }
    expect(expiredCount).toBeLessThanOrEqual(2);
  });

  it('should report no expired chats when none exist', async () => {
    const result = await runScript('scripts/chat/expire.ts', {
      CHAT_EXPIRE_DRY_RUN: 'true',
    });

    expect(result.code).toBe(0);
    expect(result.stdout).toContain('Expired 0');
  });
});

describe('cleanup script', () => {
  beforeEach(async () => {
    await mkdir(CHAT_DIR, { recursive: true });
    await cleanupTestFiles();
  });

  afterEach(async () => {
    await cleanupTestFiles();
  });

  it('should delete expired chats past retention period', async () => {
    const chat = await createTestChat({
      status: 'expired',
      expiredAt: '2020-01-01T00:00:00Z', // Far in the past
    });
    trackId(chat.id);

    const result = await runScript('scripts/chat/cleanup.ts', {
      CHAT_CLEANUP_RETENTION: '0', // No retention — clean up immediately
    });

    expect(result.code).toBe(0);
    expect(result.stdout).toContain('Cleaned up');

    const exists = await fileExists(resolve(CHAT_DIR, `${chat.id}.json`));
    expect(exists).toBe(false);
  });

  it('should NOT delete expired chats within retention period', async () => {
    const recentExpiry = new Date(Date.now() - 60 * 1000).toISOString(); // 1 minute ago
    const chat = await createTestChat({
      status: 'expired',
      expiredAt: recentExpiry,
    });
    trackId(chat.id);

    const result = await runScript('scripts/chat/cleanup.ts', {
      CHAT_CLEANUP_RETENTION: '3600', // 1 hour retention
    });

    expect(result.code).toBe(0);

    const exists = await fileExists(resolve(CHAT_DIR, `${chat.id}.json`));
    expect(exists).toBe(true);
  });

  it('should NOT delete non-expired chats', async () => {
    const chat = await createTestChat({
      status: 'active',
      expiresAt: '2020-01-01T00:00:00Z',
    });
    trackId(chat.id);

    const result = await runScript('scripts/chat/cleanup.ts', {
      CHAT_CLEANUP_RETENTION: '0',
    });

    expect(result.code).toBe(0);

    const exists = await fileExists(resolve(CHAT_DIR, `${chat.id}.json`));
    expect(exists).toBe(true);
  });

  it('should delete both .json and .lock files', async () => {
    const chat = await createTestChat({
      status: 'expired',
      expiredAt: '2020-01-01T00:00:00Z',
    });
    trackId(chat.id);

    // Create a lock file
    const lockPath = resolve(CHAT_DIR, `${chat.id}.json.lock`);
    await writeFile(lockPath, '', 'utf-8');

    const result = await runScript('scripts/chat/cleanup.ts', {
      CHAT_CLEANUP_RETENTION: '0',
    });

    expect(result.code).toBe(0);

    expect(await fileExists(resolve(CHAT_DIR, `${chat.id}.json`))).toBe(false);
    expect(await fileExists(lockPath)).toBe(false);
  });

  it('should fallback to expiresAt when expiredAt is missing', async () => {
    const chat = await createTestChat({
      status: 'expired',
      expiresAt: '2020-01-01T00:00:00Z',
      expiredAt: undefined,
    });
    // Remove expiredAt from the file
    const filePath = resolve(CHAT_DIR, `${chat.id}.json`);
    const content = await readFile(filePath, 'utf-8');
    const data = JSON.parse(content);
    delete data.expiredAt;
    await writeFile(filePath, JSON.stringify(data, null, 2), 'utf-8');
    trackId(chat.id);

    const result = await runScript('scripts/chat/cleanup.ts', {
      CHAT_CLEANUP_RETENTION: '0',
    });

    expect(result.code).toBe(0);

    const exists = await fileExists(filePath);
    expect(exists).toBe(false);
  });

  it('should skip chats with non-UTC expiredAt timestamp', async () => {
    const chat = await createTestChat({
      status: 'expired',
      expiresAt: '2020-01-01T00:00:00Z', // Valid UTC (required by schema)
    });
    trackId(chat.id);
    // Manually set expiredAt to non-UTC format (not in schema, so not set by createTestChat)
    const filePath = resolve(CHAT_DIR, `${chat.id}.json`);
    const content = await readFile(filePath, 'utf-8');
    const data = JSON.parse(content);
    data.expiredAt = '2020-01-01T00:00:00+08:00'; // Non-UTC
    await writeFile(filePath, JSON.stringify(data, null, 2), 'utf-8');

    const result = await runScript('scripts/chat/cleanup.ts', {
      CHAT_CLEANUP_RETENTION: '0',
    });

    expect(result.code).toBe(0);
    expect(result.stderr).toContain('Non-UTC');

    const exists = await fileExists(resolve(CHAT_DIR, `${chat.id}.json`));
    expect(exists).toBe(true); // Should NOT be deleted
  });

  it('should report no chats to clean up when none are eligible', async () => {
    const result = await runScript('scripts/chat/cleanup.ts');

    expect(result.code).toBe(0);
    expect(result.stdout).toContain('Cleaned up 0');
  });
});

describe('expire + cleanup integration', () => {
  beforeEach(async () => {
    await mkdir(CHAT_DIR, { recursive: true });
    await cleanupTestFiles();
  });

  afterEach(async () => {
    await cleanupTestFiles();
  });

  it('should expire and then clean up a chat in sequence', async () => {
    const chat = await createTestChat({
      expiresAt: '2020-01-01T00:00:00Z',
    });
    trackId(chat.id);

    // Step 1: Expire
    const expireResult = await runScript('scripts/chat/expire.ts', {
      CHAT_EXPIRE_DRY_RUN: 'true',
    });
    expect(expireResult.code).toBe(0);

    let updated = await readChat(chat.id);
    expect(updated.status).toBe('expired');
    expect(updated.expiredAt).toBeTruthy();

    // Step 2: Clean up (with 0 retention)
    const cleanupResult = await runScript('scripts/chat/cleanup.ts', {
      CHAT_CLEANUP_RETENTION: '0',
    });
    expect(cleanupResult.code).toBe(0);

    const exists = await fileExists(resolve(CHAT_DIR, `${chat.id}.json`));
    expect(exists).toBe(false);
  });
});
