/**
 * Tests for skills/chat/cleanup-locks.ts
 *
 * Tests cleanup of orphaned and stale .lock files in workspace/chats/.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, writeFile, unlink, readdir } from 'node:fs/promises';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { pid } from 'node:process';

const execFileAsync = promisify(execFile);

// Derive project root from current file location
const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = resolve(__dirname, '../../..');
const SCRIPT = resolve(PROJECT_ROOT, 'skills/chat/cleanup-locks.ts');

// Helper to run the cleanup script
async function runCleanup(env: Record<string, string> = {}): Promise<{ stdout: string; stderr: string }> {
  try {
    const result = await execFileAsync('npx', ['tsx', SCRIPT], {
      env: { ...process.env, ...env },
      maxBuffer: 1024 * 1024,
      cwd: PROJECT_ROOT,
      timeout: 30000,
    });
    return { stdout: result.stdout, stderr: result.stderr };
  } catch (err: unknown) {
    const execErr = err as { stdout?: string; stderr?: string };
    return { stdout: execErr.stdout ?? '', stderr: execErr.stderr ?? '' };
  }
}

describe('cleanup-locks script', () => {
  let testDir: string;

  beforeEach(async () => {
    testDir = join(tmpdir(), `chat-cleanup-test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
    await mkdir(testDir, { recursive: true });
  });

  afterEach(async () => {
    // Clean up test directory
    try {
      const files = await readdir(testDir);
      for (const f of files) {
        await unlink(join(testDir, f)).catch(() => {});
      }
      await unlink(testDir).catch(() => {});
    } catch {
      // ignore
    }
  });

  it('should exit successfully when no chats directory exists', async () => {
    const { stdout } = await runCleanup({ CHAT_DIR: join(testDir, 'nonexistent') });
    expect(stdout).toContain('No chats directory found');
  });

  it('should report no lock files when none exist', async () => {
    // Create chats dir with a JSON file but no locks
    await writeFile(join(testDir, 'test.json'), '{}', 'utf-8');

    const { stdout } = await runCleanup({ CHAT_DIR: testDir });
    expect(stdout).toContain('No lock files found');
  });

  it('should remove orphaned lock (no corresponding JSON file)', async () => {
    // Create a lock file without a corresponding JSON file
    const lockContent = `${pid}\n${Date.now()}\n`;
    await writeFile(join(testDir, 'orphan.json.lock'), lockContent, 'utf-8');

    const { stdout } = await runCleanup({ CHAT_DIR: testDir });

    expect(stdout).toContain('Removed orphaned lock');
    expect(stdout).toContain('orphan.json.lock');

    // Verify lock file was deleted
    const files = await readdir(testDir);
    expect(files).not.toContain('orphan.json.lock');
  });

  it('should remove lock with invalid content (corrupted)', async () => {
    // Create a JSON file and a corrupted lock file
    await writeFile(join(testDir, 'test.json'), '{}', 'utf-8');
    await writeFile(join(testDir, 'test.json.lock'), 'corrupted content', 'utf-8');

    const { stdout } = await runCleanup({ CHAT_DIR: testDir });

    expect(stdout).toContain('Removed invalid lock');
    expect(stdout).toContain('test.json.lock');

    const files = await readdir(testDir);
    expect(files).not.toContain('test.json.lock');
    expect(files).toContain('test.json');
  });

  it('should remove stale lock (dead holder + expired age)', async () => {
    // Create a JSON file and a lock with a dead PID and old timestamp
    await writeFile(join(testDir, 'test.json'), '{}', 'utf-8');

    // Use PID 99999 (very unlikely to be alive) and a timestamp 2 hours ago
    const staleTime = Date.now() - 2 * 3600 * 1000;
    await writeFile(join(testDir, 'test.json.lock'), `99999\n${staleTime}\n`, 'utf-8');

    const { stdout } = await runCleanup({ CHAT_DIR: testDir });

    expect(stdout).toContain('Removed stale lock');
    expect(stdout).toContain('test.json.lock');

    const files = await readdir(testDir);
    expect(files).not.toContain('test.json.lock');
    expect(files).toContain('test.json');
  });

  it('should skip lock with live holder process', async () => {
    // Create a JSON file and a lock held by the current process (live PID)
    await writeFile(join(testDir, 'test.json'), '{}', 'utf-8');
    await writeFile(join(testDir, 'test.json.lock'), `${pid}\n${Date.now()}\n`, 'utf-8');

    const { stdout } = await runCleanup({ CHAT_DIR: testDir });

    expect(stdout).toContain('held by live process');

    // Lock should still exist
    const files = await readdir(testDir);
    expect(files).toContain('test.json.lock');
  });

  it('should skip stale lock with dead holder but under age threshold', async () => {
    // Create a JSON file and a lock with dead PID but recent timestamp
    await writeFile(join(testDir, 'test.json'), '{}', 'utf-8');

    // Use PID 99999 (dead) but timestamp from 5 minutes ago (under 1h threshold)
    const recentTime = Date.now() - 5 * 60 * 1000;
    await writeFile(join(testDir, 'test.json.lock'), `99999\n${recentTime}\n`, 'utf-8');

    const { stdout } = await runCleanup({ CHAT_DIR: testDir });

    expect(stdout).toContain('threshold');

    // Lock should still exist
    const files = await readdir(testDir);
    expect(files).toContain('test.json.lock');
  });

  it('should clean up multiple lock files in one run', async () => {
    // Orphaned lock
    await writeFile(join(testDir, 'orphan.json.lock'), `${pid}\n${Date.now()}\n`, 'utf-8');

    // Stale lock (dead PID, old timestamp)
    await writeFile(join(testDir, 'active.json'), '{}', 'utf-8');
    const staleTime = Date.now() - 2 * 3600 * 1000;
    await writeFile(join(testDir, 'active.json.lock'), `99999\n${staleTime}\n`, 'utf-8');

    // Active lock (should be preserved)
    await writeFile(join(testDir, 'keep.json'), '{}', 'utf-8');
    await writeFile(join(testDir, 'keep.json.lock'), `${pid}\n${Date.now()}\n`, 'utf-8');

    const { stdout } = await runCleanup({ CHAT_DIR: testDir });

    expect(stdout).toContain('Cleaned up 2 lock file(s)');
    expect(stdout).toContain('skipped 1');

    const files = await readdir(testDir);
    expect(files).not.toContain('orphan.json.lock');
    expect(files).not.toContain('active.json.lock');
    expect(files).toContain('keep.json.lock'); // preserved
  });

  it('should respect CHAT_LOCK_MAX_AGE_HOURS environment variable', async () => {
    // Create a stale lock with a dead PID and timestamp 30 minutes ago
    await writeFile(join(testDir, 'test.json'), '{}', 'utf-8');
    const thirtyMinAgo = Date.now() - 30 * 60 * 1000;
    await writeFile(join(testDir, 'test.json.lock'), `99999\n${thirtyMinAgo}\n`, 'utf-8');

    // With default 1h threshold, this should be skipped
    const result1 = await runCleanup({ CHAT_DIR: testDir });
    expect(result1.stdout).toContain('threshold');

    // With 0.01h (36 seconds) threshold, this should be cleaned up
    const result2 = await runCleanup({ CHAT_DIR: testDir, CHAT_LOCK_MAX_AGE_HOURS: '0.01' });
    expect(result2.stdout).toContain('Removed stale lock');

    const files = await readdir(testDir);
    expect(files).not.toContain('test.json.lock');
  });
});
