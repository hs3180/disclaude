/**
 * Tests for scripts/chats-cleanup.ts — Orphaned .lock file cleanup.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdir, writeFile, stat, readFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { rm } from 'node:fs/promises';

const execFileAsync = promisify(execFile);

// Test directory — isolated from real workspace/chats
const TEST_DIR = resolve('workspace/test-chats-cleanup');
const SCRIPT = resolve('scripts/chats-cleanup.ts');

// Override CHAT_DIR via env is not possible (it's a constant),
// so we test via the script's behavior on the actual workspace/chats.
// Instead, we'll test the cleanup logic by creating lock files in workspace/chats
// and verifying the script handles them correctly.

const CHAT_DIR = resolve('workspace/chats');

describe('chats-cleanup script', () => {
  beforeEach(async () => {
    await mkdir(CHAT_DIR, { recursive: true });
  });

  afterEach(async () => {
    // Clean up test files
    try {
      const files = [
        'test-orphaned.json',
        'test-orphaned.json.lock',
        'test-stale-dead.json',
        'test-stale-dead.json.lock',
        'test-active-lock.json',
        'test-active-lock.json.lock',
        'test-invalid-lock.json',
        'test-invalid-lock.json.lock',
      ];
      for (const f of files) {
        try { await rm(resolve(CHAT_DIR, f)); } catch { /* ignore */ }
      }
    } catch { /* ignore */ }
  });

  it('should remove orphaned .lock file when .json is missing', async () => {
    // Create only the .lock file (no .json)
    const lockContent = `${process.pid}\n${Date.now()}\n`;
    await writeFile(resolve(CHAT_DIR, 'test-orphaned.json.lock'), lockContent, 'utf-8');

    // Run cleanup script
    const { stdout } = await execFileAsync('npx', ['tsx', SCRIPT], {
      timeout: 30000,
      env: { ...process.env, CHAT_LOCK_MAX_AGE_MS: '0' },
    });

    expect(stdout).toContain('Removed orphaned lock file');

    // Lock file should be removed
    await expect(stat(resolve(CHAT_DIR, 'test-orphaned.json.lock'))).rejects.toThrow();
  });

  it('should remove stale .lock file when holder process is dead', async () => {
    // Create .json file
    const chatData = {
      id: 'test-stale-dead',
      status: 'expired',
      chatId: null,
      createdAt: new Date().toISOString(),
      activatedAt: null,
      expiresAt: new Date().toISOString(),
      expiredAt: new Date().toISOString(),
      createGroup: { name: 'Test', members: ['ou_test'] },
      context: {},
      response: null,
      activationAttempts: 0,
      lastActivationError: null,
      failedAt: null,
    };
    await writeFile(resolve(CHAT_DIR, 'test-stale-dead.json'), JSON.stringify(chatData, null, 2) + '\n', 'utf-8');

    // Create .lock file with a dead PID and old timestamp
    const deadPid = 99999999; // Very unlikely to be a real PID
    const oldTimestamp = Date.now() - 7200000; // 2 hours ago
    await writeFile(resolve(CHAT_DIR, 'test-stale-dead.json.lock'), `${deadPid}\n${oldTimestamp}\n`, 'utf-8');

    const { stdout } = await execFileAsync('npx', ['tsx', SCRIPT], {
      timeout: 30000,
      env: { ...process.env, CHAT_LOCK_MAX_AGE_MS: '0' },
    });

    expect(stdout).toContain('Removed stale lock file');

    // Lock file should be removed
    await expect(stat(resolve(CHAT_DIR, 'test-stale-dead.json.lock'))).rejects.toThrow();

    // .json file should still exist
    await expect(stat(resolve(CHAT_DIR, 'test-stale-dead.json'))).resolves.toBeDefined();
  });

  it('should retain active .lock file held by live process', async () => {
    // Create .json file
    const chatData = {
      id: 'test-active-lock',
      status: 'pending',
      chatId: null,
      createdAt: new Date().toISOString(),
      activatedAt: null,
      expiresAt: new Date(Date.now() + 3600000).toISOString().replace(/\.\d{3}Z$/, 'Z'),
      expiredAt: null,
      createGroup: { name: 'Test', members: ['ou_test'] },
      context: {},
      response: null,
      activationAttempts: 0,
      lastActivationError: null,
      failedAt: null,
    };
    await writeFile(resolve(CHAT_DIR, 'test-active-lock.json'), JSON.stringify(chatData, null, 2) + '\n', 'utf-8');

    // Create .lock file with current process PID and recent timestamp
    const lockContent = `${process.pid}\n${Date.now()}\n`;
    await writeFile(resolve(CHAT_DIR, 'test-active-lock.json.lock'), lockContent, 'utf-8');

    const { stdout } = await execFileAsync('npx', ['tsx', SCRIPT], {
      timeout: 30000,
      env: { ...process.env, CHAT_LOCK_MAX_AGE_MS: '0' },
    });

    // Lock should be retained (live process)
    await expect(stat(resolve(CHAT_DIR, 'test-active-lock.json.lock'))).resolves.toBeDefined();
  });

  it('should remove invalid .lock file with malformed content', async () => {
    // Create .json file
    const chatData = {
      id: 'test-invalid-lock',
      status: 'expired',
      chatId: null,
      createdAt: new Date().toISOString(),
      activatedAt: null,
      expiresAt: new Date().toISOString(),
      expiredAt: new Date().toISOString(),
      createGroup: { name: 'Test', members: ['ou_test'] },
      context: {},
      response: null,
      activationAttempts: 0,
      lastActivationError: null,
      failedAt: null,
    };
    await writeFile(resolve(CHAT_DIR, 'test-invalid-lock.json'), JSON.stringify(chatData, null, 2) + '\n', 'utf-8');

    // Create .lock file with invalid content
    await writeFile(resolve(CHAT_DIR, 'test-invalid-lock.json.lock'), 'not-valid-content', 'utf-8');

    const { stdout } = await execFileAsync('npx', ['tsx', SCRIPT], {
      timeout: 30000,
      env: { ...process.env, CHAT_LOCK_MAX_AGE_MS: '0' },
    });

    expect(stdout).toContain('Removed invalid lock file');

    // Lock file should be removed
    await expect(stat(resolve(CHAT_DIR, 'test-invalid-lock.json.lock'))).rejects.toThrow();
  });

  it('should handle empty chat directory gracefully', async () => {
    // workspace/chats exists but has no .lock files
    const { stdout } = await execFileAsync('npx', ['tsx', SCRIPT], {
      timeout: 30000,
    });

    expect(stdout).toContain('No .lock files found');
  });
});
