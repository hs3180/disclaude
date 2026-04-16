/**
 * Unit tests for chats-cleanup schedule script.
 *
 * Tests the orphaned .lock file cleanup logic by creating various
 * combinations of .json/.lock files and verifying correct behavior.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdir, rm, writeFile, readFile, stat } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { CHAT_DIR } from '../schema.js';

const execFileAsync = promisify(execFile);

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = resolve(__dirname, '../../..');
const CHAT_DIR_RESOLVED = resolve(PROJECT_ROOT, CHAT_DIR);

const TEST_PREFIX = 'test-cleanup';

async function cleanupTestFiles() {
  let files: string[];
  try {
    files = await import('node:fs/promises').then((fs) => fs.readdir(CHAT_DIR_RESOLVED));
  } catch {
    return;
  }
  for (const f of files) {
    if (f.startsWith(TEST_PREFIX)) {
      try {
        await rm(resolve(CHAT_DIR_RESOLVED, f), { force: true });
      } catch {
        // Ignore
      }
    }
  }
}

function makeChatData(id: string, status: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    status,
    chatId: status === 'active' ? 'oc_test' : null,
    createdAt: '2026-01-01T00:00:00Z',
    activatedAt: null,
    expiresAt: '2026-01-02T00:00:00Z',
    createGroup: { name: 'Test Group', members: ['ou_test123'] },
    context: {},
    response: null,
    activationAttempts: 0,
    lastActivationError: null,
    failedAt: null,
    expiredAt: null,
    ...overrides,
  };
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

describe('chats-cleanup script', () => {
  beforeEach(async () => {
    await mkdir(CHAT_DIR_RESOLVED, { recursive: true });
    await cleanupTestFiles();
  });

  afterEach(async () => {
    await cleanupTestFiles();
  });

  it('should exit successfully when no chats directory exists', async () => {
    // Use a non-existent directory via environment override
    const { stdout, stderr } = await execFileAsync(
      'npx',
      ['tsx', 'skills/chat/chats-cleanup.ts'],
      {
        cwd: PROJECT_ROOT,
        env: { ...process.env, CHAT_DIR: '/tmp/nonexistent-chats-dir-' + Date.now() },
        timeout: 15000,
      },
    );
    expect(stdout).toContain('No chats directory found');
  });

  it('should report no orphaned locks when all .lock files have corresponding .json', async () => {
    const id = `${TEST_PREFIX}-with-json`;
    const jsonPath = resolve(CHAT_DIR_RESOLVED, `${id}.json`);
    const lockPath = resolve(CHAT_DIR_RESOLVED, `${id}.json.lock`);

    await writeFile(jsonPath, JSON.stringify(makeChatData(id, 'active'), null, 2));
    await writeFile(lockPath, `${process.pid}\n${Date.now()}\n`);

    const { stdout } = await execFileAsync(
      'npx',
      ['tsx', 'skills/chat/chats-cleanup.ts'],
      { cwd: PROJECT_ROOT, timeout: 15000 },
    );

    // Lock should NOT be removed since .json exists
    expect(await fileExists(lockPath)).toBe(true);
    expect(stdout).toContain('skipped');
  });

  it('should remove orphaned .lock file when .json is gone and holder is dead', async () => {
    const id = `${TEST_PREFIX}-orphaned`;
    const lockPath = resolve(CHAT_DIR_RESOLVED, `${id}.json.lock`);

    // Create lock file with a dead PID
    await writeFile(lockPath, '999999999\n' + Date.now() + '\n');

    const { stdout } = await execFileAsync(
      'npx',
      ['tsx', 'skills/chat/chats-cleanup.ts'],
      { cwd: PROJECT_ROOT, env: { ...process.env, CHAT_SKIP_LIVE_CHECK: '1' }, timeout: 15000 },
    );

    expect(await fileExists(lockPath)).toBe(false);
    expect(stdout).toContain('Removed orphaned lock file');
  });

  it('should not remove .lock file when holder process is alive', async () => {
    const id = `${TEST_PREFIX}-alive-holder`;
    const lockPath = resolve(CHAT_DIR_RESOLVED, `${id}.json.lock`);

    // Create lock file with current process PID (which is alive)
    await writeFile(lockPath, `${process.pid}\n${Date.now()}\n`);

    const { stdout } = await execFileAsync(
      'npx',
      ['tsx', 'skills/chat/chats-cleanup.ts'],
      { cwd: PROJECT_ROOT, timeout: 15000 },
    );

    // Lock should NOT be removed since holder is alive
    expect(await fileExists(lockPath)).toBe(true);
    expect(stdout).toContain('alive');
  });

  it('should clean up .stale.* artifacts', async () => {
    const stalePath = resolve(CHAT_DIR_RESOLVED, `${TEST_PREFIX}-stale.json.lock.stale.12345`);

    await writeFile(stalePath, `${process.pid}\n${Date.now()}\n`);

    const { stdout } = await execFileAsync(
      'npx',
      ['tsx', 'skills/chat/chats-cleanup.ts'],
      { cwd: PROJECT_ROOT, timeout: 15000 },
    );

    expect(await fileExists(stalePath)).toBe(false);
    expect(stdout).toContain('Removed stale artifact');
  });

  it('should handle corrupted lock files gracefully', async () => {
    const id = `${TEST_PREFIX}-corrupted`;
    const lockPath = resolve(CHAT_DIR_RESOLVED, `${id}.json.lock`);

    await writeFile(lockPath, 'not valid lock content');

    const { stdout } = await execFileAsync(
      'npx',
      ['tsx', 'skills/chat/chats-cleanup.ts'],
      { cwd: PROJECT_ROOT, env: { ...process.env, CHAT_SKIP_LIVE_CHECK: '1' }, timeout: 15000 },
    );

    // Corrupted lock with no .json should be removed
    expect(await fileExists(lockPath)).toBe(false);
    expect(stdout).toContain('Removed orphaned lock file');
  });

  it('should report no orphaned locks when directory is empty', async () => {
    const { stdout } = await execFileAsync(
      'npx',
      ['tsx', 'skills/chat/chats-cleanup.ts'],
      { cwd: PROJECT_ROOT, timeout: 15000 },
    );

    // Either "No orphaned lock files found" (early exit) or "0 orphaned" in summary
    const noOrphans = stdout.includes('No orphaned lock files found') || stdout.includes('0 orphaned lock(s)');
    expect(noOrphans).toBe(true);
  });

  it('should handle mixed scenario with orphaned and valid locks', async () => {
    const validId = `${TEST_PREFIX}-valid`;
    const orphanedId = `${TEST_PREFIX}-orphaned-mixed`;
    const staleId = `${TEST_PREFIX}-stale-mixed`;

    // Valid: .json exists + .lock exists
    await writeFile(
      resolve(CHAT_DIR_RESOLVED, `${validId}.json`),
      JSON.stringify(makeChatData(validId, 'active'), null, 2),
    );
    await writeFile(
      resolve(CHAT_DIR_RESOLVED, `${validId}.json.lock`),
      `${process.pid}\n${Date.now()}\n`,
    );

    // Orphaned: .lock exists but .json doesn't
    await writeFile(
      resolve(CHAT_DIR_RESOLVED, `${orphanedId}.json.lock`),
      '999999999\n' + Date.now() + '\n',
    );

    // Stale artifact
    await writeFile(
      resolve(CHAT_DIR_RESOLVED, `${staleId}.json.lock.stale.99999`),
      `${process.pid}\n${Date.now()}\n`,
    );

    const { stdout } = await execFileAsync(
      'npx',
      ['tsx', 'skills/chat/chats-cleanup.ts'],
      { cwd: PROJECT_ROOT, env: { ...process.env, CHAT_SKIP_LIVE_CHECK: '1' }, timeout: 15000 },
    );

    // Valid lock should remain
    expect(await fileExists(resolve(CHAT_DIR_RESOLVED, `${validId}.json.lock`))).toBe(true);
    // Orphaned lock should be removed
    expect(await fileExists(resolve(CHAT_DIR_RESOLVED, `${orphanedId}.json.lock`))).toBe(false);
    // Stale artifact should be removed
    expect(await fileExists(resolve(CHAT_DIR_RESOLVED, `${staleId}.json.lock.stale.99999`))).toBe(false);

    expect(stdout).toContain('orphaned lock(s)');
    expect(stdout).toContain('stale artifact(s)');
    expect(stdout).toContain('skipped');
  });
});
