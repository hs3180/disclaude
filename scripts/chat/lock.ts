/**
 * File lock utilities using Node.js fs.flock (stable in Node 22+, experimental in Node 20.12+).
 *
 * Provides exclusive and shared advisory locks for file-based concurrency safety.
 * Falls back to a no-op lock with warning if fs.flock is unavailable.
 * This is safe for CLI tools with low concurrency risk (e.g., scripts/chat/).
 */

import { open, type FileHandle } from 'node:fs/promises';

// Type-safe check for fs.flock availability (Node 20.12+)
type FlockFn = (fd: number, options?: { exclusive?: boolean; shared?: boolean; ifPresent?: boolean }) => Promise<void>;
let _flockFn: FlockFn | null = null;

try {
  // Dynamic import to avoid compile-time errors on older Node versions
  const fsPromises = await import('node:fs/promises');
  if (typeof fsPromises.flock === 'function') {
    _flockFn = fsPromises.flock as FlockFn;
  }
} catch {
  // fs.flock not available
}

if (!_flockFn) {
  console.error('WARN: fs.flock not available (requires Node 20.12+). File locking will be disabled.');
}

export function isFlockAvailable(): boolean {
  return _flockFn !== null;
}

/**
 * RAII-style file lock wrapper.
 *
 * Usage:
 *   const lock = await acquireLock(filePath, 'exclusive');
 *   try {
 *     // ... critical section ...
 *   } finally {
 *     await lock.release();
 *   }
 */
export interface FileLock {
  /** Release the lock and close the file descriptor */
  release(): Promise<void>;
}

/**
 * Acquire a file lock.
 *
 * @param lockPath - Path to the lock file (typically `${chatFile}.lock`)
 * @param mode - 'exclusive' (default) or 'shared'
 * @param timeout - Max wait time in ms (default: 5000, 0 = non-blocking)
 */
export async function acquireLock(
  lockPath: string,
  mode: 'exclusive' | 'shared' = 'exclusive',
  timeout: number = 5000,
): Promise<FileLock> {
  if (!_flockFn) {
    // No-op fallback when fs.flock is unavailable.
    // These scripts run as CLI tools with low concurrency risk,
    // so skipping the lock is acceptable.
    return { release: async () => {} };
  }

  const handle: FileHandle = await open(lockPath, 'w');
  const fd = handle.fd;

  const options = {
    exclusive: mode === 'exclusive',
    shared: mode === 'shared',
  };

  // For non-blocking mode, use ifPresent
  if (timeout === 0) {
    try {
      await _flockFn!(fd, { ...options, ifPresent: true });
    } catch {
      await handle.close();
      throw new Error(`Failed to acquire ${mode} lock for '${lockPath}' (already locked)`);
    }
  } else {
    // Blocking with timeout — use a cancellable timer
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const lockPromise = _flockFn!(fd, options);
      await new Promise<void>((resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error(`Lock acquisition timed out after ${timeout}ms`)),
          timeout,
        );
        lockPromise.then(() => {
          if (timer) clearTimeout(timer);
          resolve();
        }, reject);
      });
    } catch (err: unknown) {
      if (timer) clearTimeout(timer);
      await handle.close();
      if (err instanceof Error && err.message.includes('timed out')) {
        throw new Error(`Failed to acquire ${mode} lock for '${lockPath}' (timed out after ${timeout}ms)`);
      }
      throw err;
    }
  }

  return {
    release: async () => {
      try {
        await handle.close(); // closing fd releases the lock
      } catch {
        // Ignore errors during release
      }
    },
  };
}

/**
 * Execute a function under an exclusive lock.
 *
 * @param lockPath - Path to the lock file
 * @param fn - Function to execute while holding the lock
 * @param timeout - Lock acquisition timeout in ms (default: 0, non-blocking)
 */
export async function withExclusiveLock<T>(
  lockPath: string,
  fn: () => Promise<T>,
  timeout: number = 0,
): Promise<T> {
  const lock = await acquireLock(lockPath, 'exclusive', timeout);
  try {
    return await fn();
  } finally {
    await lock.release();
  }
}

/**
 * Execute a function under a shared lock.
 *
 * @param lockPath - Path to the lock file
 * @param fn - Function to execute while holding the lock
 * @param timeout - Lock acquisition timeout in ms (default: 5000)
 */
export async function withSharedLock<T>(
  lockPath: string,
  fn: () => Promise<T>,
  timeout: number = 5000,
): Promise<T> {
  const lock = await acquireLock(lockPath, 'shared', timeout);
  try {
    return await fn();
  } finally {
    await lock.release();
  }
}
