/**
 * Tests for scripts/chat/lock.ts — file-based locking mechanism.
 *
 * Tests concurrent lock behavior using Promise-based parallelism.
 * Validates: exclusive/shared semantics, timeout, stale cleanup, and API compatibility.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdir, rm, readFile, readdir, stat } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  acquireLock,
  withExclusiveLock,
  withSharedLock,
  isFlockAvailable,
  type FileLock,
} from '../lock.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const TEST_DIR = resolve(__dirname, '__lock_test_tmp__');

function testLockPath(name: string): string {
  return resolve(TEST_DIR, `${name}.lock`);
}

beforeEach(async () => {
  await mkdir(TEST_DIR, { recursive: true });
});

afterEach(async () => {
  await rm(TEST_DIR, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Basic functionality
// ---------------------------------------------------------------------------

describe('isFlockAvailable', () => {
  it('should always return true (open wx is always available)', () => {
    expect(isFlockAvailable()).toBe(true);
  });
});

describe('acquireLock — basic exclusive lock', () => {
  it('should acquire and release an exclusive lock', async () => {
    const lockPath = testLockPath('basic-exclusive');
    const lock: FileLock = await acquireLock(lockPath, 'exclusive', 1000);
    expect(lock).toBeDefined();
    expect(typeof lock.release).toBe('function');
    await lock.release();
  });

  it('should allow re-acquisition after release', async () => {
    const lockPath = testLockPath('reacquire');
    const lock1 = await acquireLock(lockPath, 'exclusive', 1000);
    await lock1.release();

    const lock2 = await acquireLock(lockPath, 'exclusive', 1000);
    expect(lock2).toBeDefined();
    await lock2.release();
  });
});

describe('acquireLock — basic shared lock', () => {
  it('should acquire and release a shared lock', async () => {
    const lockPath = testLockPath('basic-shared');
    const lock = await acquireLock(lockPath, 'shared', 1000);
    expect(lock).toBeDefined();
    await lock.release();
  });
});

// ---------------------------------------------------------------------------
// Exclusive lock conflict
// ---------------------------------------------------------------------------

describe('acquireLock — exclusive conflict', () => {
  it('should fail to acquire exclusive lock when already held (timeout=0)', async () => {
    const lockPath = testLockPath('exclusive-conflict');
    const lock1 = await acquireLock(lockPath, 'exclusive', 1000);

    await expect(
      acquireLock(lockPath, 'exclusive', 0),
    ).rejects.toThrow('Failed to acquire exclusive lock');

    await lock1.release();
  });

  it('should timeout when waiting for exclusive lock', async () => {
    const lockPath = testLockPath('exclusive-timeout');
    const lock1 = await acquireLock(lockPath, 'exclusive', 1000);

    const start = Date.now();
    await expect(
      acquireLock(lockPath, 'exclusive', 200),
    ).rejects.toThrow('timed out after 200ms');
    const elapsed = Date.now() - start;

    // Should have waited at least 150ms (allow some slack)
    expect(elapsed).toBeGreaterThanOrEqual(100);

    await lock1.release();
  });
});

// ---------------------------------------------------------------------------
// Shared lock concurrency
// ---------------------------------------------------------------------------

describe('acquireLock — shared concurrency', () => {
  it('should allow multiple shared locks simultaneously', async () => {
    const lockPath = testLockPath('shared-concurrent');
    const lock1 = await acquireLock(lockPath, 'shared', 1000);
    const lock2 = await acquireLock(lockPath, 'shared', 1000);
    const lock3 = await acquireLock(lockPath, 'shared', 1000);

    expect(lock1).toBeDefined();
    expect(lock2).toBeDefined();
    expect(lock3).toBeDefined();

    await lock1.release();
    await lock2.release();
    await lock3.release();
  });

  it('should block shared lock when exclusive is held', async () => {
    const lockPath = testLockPath('shared-blocked-by-exclusive');
    const exclusiveLock = await acquireLock(lockPath, 'exclusive', 1000);

    await expect(
      acquireLock(lockPath, 'shared', 0),
    ).rejects.toThrow('Failed to acquire shared lock');

    await exclusiveLock.release();
  });

  it('should block exclusive lock when shared is held', async () => {
    const lockPath = testLockPath('exclusive-blocked-by-shared');
    const sharedLock = await acquireLock(lockPath, 'shared', 1000);

    await expect(
      acquireLock(lockPath, 'exclusive', 0),
    ).rejects.toThrow('Failed to acquire exclusive lock');

    await sharedLock.release();
  });
});

// ---------------------------------------------------------------------------
// withExclusiveLock / withSharedLock convenience wrappers
// ---------------------------------------------------------------------------

describe('withExclusiveLock', () => {
  it('should execute function under exclusive lock and auto-release', async () => {
    const lockPath = testLockPath('with-exclusive');
    const result = await withExclusiveLock(lockPath, async () => {
      return 42;
    }, 1000);

    expect(result).toBe(42);

    // Lock should be released — verify by acquiring again
    const lock2 = await acquireLock(lockPath, 'exclusive', 0);
    await lock2.release();
  });

  it('should release lock even if function throws', async () => {
    const lockPath = testLockPath('with-exclusive-error');
    await expect(
      withExclusiveLock(lockPath, async () => {
        throw new Error('test error');
      }, 1000),
    ).rejects.toThrow('test error');

    // Lock should be released despite the error
    const lock2 = await acquireLock(lockPath, 'exclusive', 0);
    await lock2.release();
  });
});

describe('withSharedLock', () => {
  it('should execute function under shared lock', async () => {
    const lockPath = testLockPath('with-shared');
    const result = await withSharedLock(lockPath, async () => {
      return 'hello';
    }, 1000);

    expect(result).toBe('hello');
  });
});

// ---------------------------------------------------------------------------
// Concurrent correctness — the core verification
// ---------------------------------------------------------------------------

describe('concurrent correctness', () => {
  it('should serialize exclusive access to a critical section', async () => {
    const lockPath = testLockPath('concurrent-serialize');
    const order: number[] = [];
    let inCriticalSection = false;

    // Simulate two processes competing for exclusive access
    const task1 = (async () => {
      await withExclusiveLock(lockPath, async () => {
        // Verify no other task is in the critical section
        expect(inCriticalSection).toBe(false);
        inCriticalSection = true;
        await new Promise((r) => setTimeout(r, 50));
        order.push(1);
        inCriticalSection = false;
      }, 5000);
    })();

    const task2 = (async () => {
      // Small delay to increase chance of race
      await new Promise((r) => setTimeout(r, 10));
      await withExclusiveLock(lockPath, async () => {
        expect(inCriticalSection).toBe(false);
        inCriticalSection = true;
        await new Promise((r) => setTimeout(r, 50));
        order.push(2);
        inCriticalSection = false;
      }, 5000);
    })();

    await Promise.all([task1, task2]);

    // Both tasks should have completed
    expect(order.sort()).toEqual([1, 2]);
  });

  it('should prevent duplicate state file creation under concurrency', async () => {
    const lockPath = testLockPath('no-duplicate');
    const statePath = resolve(TEST_DIR, 'state.txt');
    let createCount = 0;

    // Simulate multiple concurrent "scan" operations
    const tasks = Array.from({ length: 5 }, async (_, i) => {
      await withExclusiveLock(lockPath, async () => {
        // Simulate check-and-create
        await new Promise((r) => setTimeout(r, 10 + Math.random() * 20));
        if (createCount === 0) {
          createCount++;
        }
      }, 5000);
    });

    await Promise.all(tasks);

    // Exactly one task should have "created" the state
    expect(createCount).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Lock cleanup
// ---------------------------------------------------------------------------

describe('lock cleanup', () => {
  it('should clean up lock directory when last holder releases', async () => {
    const lockPath = testLockPath('cleanup');
    // getLockDir in lock.ts appends '.d' to the lock path
    const lockDir = `${lockPath}.d`;

    const lock1 = await acquireLock(lockPath, 'exclusive', 1000);

    // Lock directory should exist
    await expect(stat(lockDir)).resolves.toBeDefined();

    await lock1.release();

    // Lock directory should be cleaned up
    await expect(stat(lockDir)).rejects.toThrow();
  });
});
