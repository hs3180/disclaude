/**
 * File locking utility for survey operations.
 *
 * Uses mkdir-based exclusive locking (POSIX atomic operation).
 * Zero-dependency alternative to fs.flock which does not exist in Node.js.
 */

import { mkdir, rmdir } from 'node:fs/promises';
import { resolve } from 'node:path';

const LOCK_TIMEOUT_MS = 5_000;
const LOCK_RETRY_MS = 50;

/**
 * Acquire an exclusive lock using mkdir (atomic on POSIX).
 * Retries with timeout to handle concurrent access.
 */
export async function withExclusiveLock<T>(
  lockPath: string,
  fn: () => Promise<T>,
): Promise<T> {
  const absolute = resolve(lockPath);
  const deadline = Date.now() + LOCK_TIMEOUT_MS;

  // Try to acquire lock
  while (true) {
    try {
      await mkdir(absolute, { recursive: false });
      break; // Lock acquired
    } catch (err: unknown) {
      const nodeErr = err as { code?: string };
      if (nodeErr.code !== 'EEXIST') {
        throw new Error(`Failed to acquire lock at ${lockPath}: ${err}`);
      }
      if (Date.now() >= deadline) {
        throw new Error(`Lock timeout for ${lockPath} (${LOCK_TIMEOUT_MS}ms)`);
      }
      await new Promise((r) => setTimeout(r, LOCK_RETRY_MS));
    }
  }

  try {
    return await fn();
  } finally {
    try {
      await rmdir(absolute);
    } catch {
      // Best-effort cleanup
    }
  }
}
