/**
 * File lock utilities using PID-based lock files (zero dependencies).
 *
 * Uses atomic file creation (`open(path, 'wx')`) for exclusive lock acquisition.
 * Stale locks from dead processes are automatically detected and cleaned up
 * using `process.kill(pid, 0)` liveness checks (C1 fix from PR #2229 review).
 *
 * Error handling follows strict EEXIST-only swallowing (C2 fix from PR #2229 review).
 *
 * Trade-off: shared locks are implemented as exclusive locks for simplicity.
 * This is acceptable because these scripts are low-concurrency CLI tools where
 * reads are idempotent and contention is minimal.
 */

import { open, readFile, unlink, rename, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { pid } from 'node:process';

// ---- Constants ----

const DEFAULT_ACQUIRE_TIMEOUT = 5000; // ms
const POLL_INTERVAL_MS = 50; // ms between lock acquisition retries

// ---- Types ----

export interface FileLock {
  /** Release the lock and delete the lock file */
  release(): Promise<void>;
}

interface LockInfo {
  holderPid: number;
  acquiredAt: number;
}

// ---- Internal helpers ----

/**
 * Check if a process is alive by sending signal 0.
 * Returns true if the process exists and we have permission to signal it.
 */
function isProcessAlive(checkPid: number): boolean {
  try {
    process.kill(checkPid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Parse lock file content (format: "PID\ntimestamp\n").
 * Returns null if content is invalid or incomplete.
 */
function parseLockContent(content: string): LockInfo | null {
  const lines = content.trim().split('\n');
  if (lines.length < 2) return null;
  const holderPid = parseInt(lines[0], 10);
  const acquiredAt = parseInt(lines[1], 10);
  if (isNaN(holderPid) || isNaN(acquiredAt)) return null;
  return { holderPid, acquiredAt };
}

/**
 * Ensure the parent directory of a file exists.
 *
 * C2 fix from PR #2229 review: only ignores EEXIST, all other errors
 * (permissions, disk full, etc.) are propagated to the caller.
 */
async function ensureDir(filePath: string): Promise<void> {
  const dir = dirname(filePath);
  try {
    await mkdir(dir, { recursive: true });
  } catch (err: unknown) {
    const nodeErr = err as { code?: string };
    // With recursive: true, EEXIST shouldn't occur, but we handle it defensively
    if (nodeErr.code === 'EEXIST') return;
    throw err;
  }
}

/**
 * Attempt to atomically create a lock file and write PID + timestamp.
 *
 * Uses `open(path, 'wx')` which fails with EEXIST if the file already exists,
 * providing atomic lock acquisition on POSIX local filesystems.
 *
 * @returns true if lock was acquired, false if file already exists
 */
async function tryAcquireLock(lockPath: string): Promise<boolean> {
  let handle;
  try {
    handle = await open(lockPath, 'wx');
  } catch (err: unknown) {
    const nodeErr = err as { code?: string };
    if (nodeErr.code === 'EEXIST') {
      return false;
    }
    throw err;
  }

  try {
    await handle.writeFile(`${pid}\n${Date.now()}\n`);
  } finally {
    await handle.close();
  }

  return true;
}

/**
 * Try to remove a stale lock file whose holder process is no longer alive.
 *
 * Uses atomic rename to avoid race conditions when multiple processes
 * detect the same stale lock simultaneously.
 *
 * C1 fix from PR #2229 review: always calls isProcessAlive() before removing.
 *
 * @returns true if stale lock was successfully removed
 */
async function tryRemoveStaleLock(lockPath: string): Promise<boolean> {
  let content: string;
  try {
    content = await readFile(lockPath, 'utf-8');
  } catch {
    // File was removed by another process between our EEXIST check and here
    return false;
  }

  const info = parseLockContent(content);

  // Remove if content is invalid (corrupted/empty) or holder is confirmed dead
  const shouldRemove = !info || !isProcessAlive(info.holderPid);
  if (!shouldRemove) return false;

  // Atomic rename to claim sole responsibility for cleanup
  // Prevents two processes from both trying to remove the same lock
  const stalePath = `${lockPath}.stale.${pid}`;
  try {
    await rename(lockPath, stalePath);
  } catch {
    // Another process won the rename race, or file was already removed
    return false;
  }

  // We won the race — clean up the renamed file
  try {
    await unlink(stalePath);
  } catch {
    // Best-effort cleanup; failure is not critical
  }

  return true;
}

// ---- Public API ----

/**
 * Check if file locking is available.
 *
 * Always returns true with the PID-based implementation (unlike the old
 * fs.flock-based version which could return false when fs.flock was unavailable).
 */
export function isFlockAvailable(): boolean {
  return true;
}

/**
 * Acquire a file lock.
 *
 * @param lockPath - Path to the lock file (typically `${targetFile}.lock`)
 * @param mode - 'exclusive' (default) or 'shared'
 *   Note: both modes use exclusive locking for simplicity, since these
 *   scripts are low-concurrency CLI tools where read operations are idempotent.
 * @param timeout - Max wait time in ms (default: 5000, 0 = non-blocking)
 * @throws Error if lock cannot be acquired within timeout
 */
export async function acquireLock(
  lockPath: string,
  mode: 'exclusive' | 'shared' = 'exclusive',
  timeout: number = DEFAULT_ACQUIRE_TIMEOUT,
): Promise<FileLock> {
  await ensureDir(lockPath);

  const startTime = Date.now();

  while (true) {
    // Try atomic lock file creation
    if (await tryAcquireLock(lockPath)) {
      return {
        release: async () => {
          await unlink(lockPath).catch(() => {
            // Ignore — lock file may have been cleaned up by another process
          });
        },
      };
    }

    // Lock file exists — check if it's stale (dead holder)
    const staleRemoved = await tryRemoveStaleLock(lockPath);
    if (staleRemoved) {
      // Stale lock removed, retry immediately
      continue;
    }

    // Lock is held by a live process
    if (timeout === 0) {
      throw new Error(
        `Failed to acquire ${mode} lock for '${lockPath}' (already locked)`,
      );
    }

    // Check timeout
    const elapsed = Date.now() - startTime;
    if (elapsed >= timeout) {
      throw new Error(
        `Failed to acquire ${mode} lock for '${lockPath}' (timed out after ${timeout}ms)`,
      );
    }

    // Wait before retrying (respect remaining timeout)
    await new Promise((resolve) =>
      setTimeout(resolve, Math.min(POLL_INTERVAL_MS, timeout - elapsed)),
    );
  }
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
 * Note: Implemented as exclusive lock for simplicity (see acquireLock docs).
 *
 * @param lockPath - Path to the lock file
 * @param fn - Function to execute while holding the lock
 * @param timeout - Lock acquisition timeout in ms (default: 5000)
 */
export async function withSharedLock<T>(
  lockPath: string,
  fn: () => Promise<T>,
  timeout: number = DEFAULT_ACQUIRE_TIMEOUT,
): Promise<T> {
  const lock = await acquireLock(lockPath, 'shared', timeout);
  try {
    return await fn();
  } finally {
    await lock.release();
  }
}
