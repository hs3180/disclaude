/**
 * Tests for file lock utilities using PID-based lock files.
 *
 * Verifies acquireLock, withExclusiveLock, withSharedLock,
 * and stale lock detection/cleanup logic.
 *
 * Uses real temp directories for file system operations.
 *
 * Issue #1617: Phase 2 — skills/chat/lock test coverage.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, stat, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  acquireLock,
  withExclusiveLock,
  withSharedLock,
  isFlockAvailable,
} from './lock.js';

let testDir: string;

beforeEach(async () => {
  testDir = await mkdtemp(join(tmpdir(), 'lock-test-'));
});

afterEach(async () => {
  await rm(testDir, { recursive: true, force: true }).catch(() => {});
});

describe('isFlockAvailable', () => {
  it('should always return true with PID-based implementation', () => {
    expect(isFlockAvailable()).toBe(true);
  });
});

describe('acquireLock', () => {
  it('should acquire a lock and create a lock file', async () => {
    const lockPath = join(testDir, 'test.lock');
    const lock = await acquireLock(lockPath);

    // Lock file should exist
    const fileStat = await stat(lockPath);
    expect(fileStat.isFile()).toBe(true);

    // Lock file should contain PID and timestamp
    const content = await readFile(lockPath, 'utf-8');
    const lines = content.trim().split('\n');
    expect(lines.length).toBe(2);
    expect(parseInt(lines[0], 10)).toBe(process.pid);
    expect(parseInt(lines[1], 10)).not.toBeNaN();

    await lock.release();
  });

  it('should release a lock and delete the lock file', async () => {
    const lockPath = join(testDir, 'release.lock');
    const lock = await acquireLock(lockPath);

    await lock.release();

    // Lock file should be removed
    await expect(stat(lockPath)).rejects.toThrow();
  });

  it('should not throw on double release', async () => {
    const lockPath = join(testDir, 'double-release.lock');
    const lock = await acquireLock(lockPath);

    await lock.release();
    // Second release should not throw
    await expect(lock.release()).resolves.toBeUndefined();
  });

  it('should throw when acquiring non-blocking lock on already locked file', async () => {
    const lockPath = join(testDir, 'contention.lock');
    const lock1 = await acquireLock(lockPath, 'exclusive', 0);

    try {
      await expect(acquireLock(lockPath, 'exclusive', 0)).rejects.toThrow(
        /already locked/
      );
    } finally {
      await lock1.release();
    }
  });

  it('should throw with timeout message when lock acquisition times out', async () => {
    const lockPath = join(testDir, 'timeout.lock');
    const lock1 = await acquireLock(lockPath, 'exclusive', 500);

    try {
      await expect(acquireLock(lockPath, 'exclusive', 100)).rejects.toThrow(
        /timed out/
      );
    } finally {
      await lock1.release();
    }
  });

  it('should acquire lock after previous lock is released', async () => {
    const lockPath = join(testDir, 'sequential.lock');

    const lock1 = await acquireLock(lockPath);
    await lock1.release();

    // Should be able to acquire the same lock now
    const lock2 = await acquireLock(lockPath);
    await lock2.release();
  });

  it('should auto-cleanup stale locks from dead processes', async () => {
    const lockPath = join(testDir, 'stale.lock');

    // Create a lock file with a dead PID (99999999 is unlikely to exist)
    const deadPid = 99999999;
    const timestamp = Date.now();
    await writeFile(lockPath, `${deadPid}\n${timestamp}\n`);

    // Should be able to acquire the lock (stale lock should be cleaned)
    const lock = await acquireLock(lockPath, 'exclusive', 2000);
    await lock.release();
  });

  it('should handle shared mode (same as exclusive in this implementation)', async () => {
    const lockPath = join(testDir, 'shared.lock');
    const lock = await acquireLock(lockPath, 'shared', 1000);
    expect(lock).toBeDefined();
    await lock.release();
  });

  it('should create parent directories if needed', async () => {
    const lockPath = join(testDir, 'nested', 'dir', 'test.lock');
    const lock = await acquireLock(lockPath);
    await lock.release();
  });
});

describe('withExclusiveLock', () => {
  it('should execute function while holding the lock', async () => {
    const lockPath = join(testDir, 'with-exclusive.lock');
    const result = await withExclusiveLock(lockPath, async () => {
      // Lock file should exist while inside the callback
      const fileStat = await stat(lockPath);
      expect(fileStat.isFile()).toBe(true);
      return 42;
    });

    expect(result).toBe(42);
  });

  it('should release lock after function completes', async () => {
    const lockPath = join(testDir, 'with-exclusive-cleanup.lock');

    await withExclusiveLock(lockPath, async () => {
      // do something
    });

    // Lock file should be removed
    await expect(stat(lockPath)).rejects.toThrow();
  });

  it('should release lock even if function throws', async () => {
    const lockPath = join(testDir, 'with-exclusive-error.lock');

    await expect(
      withExclusiveLock(lockPath, async () => {
        throw new Error('test error');
      })
    ).rejects.toThrow('test error');

    // Lock should still be released
    await expect(stat(lockPath)).rejects.toThrow();
  });

  it('should serialize concurrent access', async () => {
    const lockPath = join(testDir, 'serial.lock');
    const executionOrder: number[] = [];

    const task1 = withExclusiveLock(lockPath, async () => {
      executionOrder.push(1);
      await new Promise(r => setTimeout(r, 100));
      executionOrder.push(2);
    }, 5000);

    // Small delay to ensure task1 acquires the lock first
    await new Promise(r => setTimeout(r, 20));

    const task2 = withExclusiveLock(lockPath, async () => {
      executionOrder.push(3);
    }, 5000);

    await Promise.all([task1, task2]);

    // task1 should complete before task2 starts
    expect(executionOrder).toEqual([1, 2, 3]);
  });
});

describe('withSharedLock', () => {
  it('should execute function and release lock', async () => {
    const lockPath = join(testDir, 'with-shared.lock');
    const result = await withSharedLock(lockPath, async () => 'shared-result');

    expect(result).toBe('shared-result');
    // Lock should be released
    await expect(stat(lockPath)).rejects.toThrow();
  });

  it('should release lock even if function throws', async () => {
    const lockPath = join(testDir, 'with-shared-error.lock');

    await expect(
      withSharedLock(lockPath, async () => {
        throw new Error('shared error');
      })
    ).rejects.toThrow('shared error');

    await expect(stat(lockPath)).rejects.toThrow();
  });
});

describe('stale lock edge cases', () => {
  it('should handle corrupted lock file content', async () => {
    const lockPath = join(testDir, 'corrupted.lock');

    // Write invalid content
    await writeFile(lockPath, 'not-a-pid\nnot-a-timestamp\n');

    // Should be able to acquire (corrupted content should trigger removal)
    const lock = await acquireLock(lockPath, 'exclusive', 2000);
    await lock.release();
  });

  it('should handle empty lock file', async () => {
    const lockPath = join(testDir, 'empty.lock');

    await writeFile(lockPath, '');

    const lock = await acquireLock(lockPath, 'exclusive', 2000);
    await lock.release();
  });

  it('should handle lock file with only one line', async () => {
    const lockPath = join(testDir, 'one-line.lock');

    await writeFile(lockPath, '12345\n');

    const lock = await acquireLock(lockPath, 'exclusive', 2000);
    await lock.release();
  });
});
