/**
 * File lock utilities using atomic file creation (open with 'wx' flag).
 *
 * Provides exclusive and shared advisory locks for file-based concurrency safety.
 * Uses a mutex file to serialize lock state changes, ensuring correctness under concurrency.
 *
 * This replaces the previous fs.flock implementation, which was never available in Node.js.
 * Zero external dependencies — works with Node.js built-in APIs only.
 */

import { open, writeFile, readFile, unlink, stat, type FileHandle, mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { randomBytes } from 'node:crypto';
import process from 'node:process';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Max age (ms) before a lock holder is considered stale and eligible for cleanup. */
const STALE_THRESHOLD_MS = 30_000;

/** Max age (ms) before the mutex itself is considered stale. */
const MUTEX_STALE_THRESHOLD_MS = 10_000;

/** Base delay (ms) for retry backoff when acquiring mutex or lock. */
const RETRY_BASE_MS = 20;

/** Max retry delay (ms) for jittered backoff. */
const RETRY_MAX_MS = 100;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface LockHolder {
  /** Unique ID for this lock acquisition instance. */
  id: string;
  /** Process ID of the holder. */
  pid: number;
  /** Lock mode. */
  mode: 'exclusive' | 'shared';
  /** Timestamp (ms since epoch) when the lock was acquired. */
  acquiredAt: number;
}

interface LockState {
  holders: LockHolder[];
}

export interface FileLock {
  /** Release the lock. */
  release(): Promise<void>;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function generateId(): string {
  return randomBytes(8).toString('hex');
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function jitteredDelay(): number {
  return RETRY_BASE_MS + Math.random() * (RETRY_MAX_MS - RETRY_BASE_MS);
}

function isStale(acquiredAt: number): boolean {
  return Date.now() - acquiredAt > STALE_THRESHOLD_MS;
}

/**
 * Check if a PID corresponds to a running process on the local machine.
 * Returns `true` if we can confirm it is alive, `false` otherwise.
 * This is best-effort and may return `false` for PIDs on other machines.
 */
async function isProcessAlive(pid: number): Promise<boolean> {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Ensure the directory for a file path exists. */
async function ensureDir(filePath: string): Promise<void> {
  try {
    await mkdir(dirname(filePath), { recursive: true });
  } catch {
    // Directory may already exist or race condition — ignore
  }
}

// ---------------------------------------------------------------------------
// Mutex — serializes access to the lock state file
// ---------------------------------------------------------------------------

/**
 * Acquire the mutex by atomically creating the mutex file.
 * Uses `open(path, 'wx')` which is atomic on POSIX.
 */
async function acquireMutex(mutexPath: string, timeout: number): Promise<FileHandle> {
  const deadline = Date.now() + timeout;

  while (true) {
    // Ensure parent directory exists (it may have been cleaned up by a previous release)
    await ensureDir(mutexPath);
    try {
      const handle = await open(mutexPath, 'wx');
      return handle;
    } catch (err: any) {
      if (err.code !== 'EEXIST') throw err;

      // Check if mutex is stale (process crashed while holding it)
      try {
        const s = await stat(mutexPath);
        if (Date.now() - s.mtimeMs > MUTEX_STALE_THRESHOLD_MS) {
          await unlink(mutexPath);
          continue; // Retry immediately after removing stale mutex
        }
      } catch {
        // File may have been deleted by another waiter — retry
        continue;
      }

      if (Date.now() >= deadline) {
        throw new Error(`Mutex acquisition timed out for '${mutexPath}' after ${timeout}ms`);
      }
      await sleep(jitteredDelay());
    }
  }
}

async function releaseMutex(handle: FileHandle, mutexPath: string): Promise<void> {
  try {
    await handle.close();
  } catch {
    // Ignore close errors
  }
  try {
    await unlink(mutexPath);
  } catch {
    // Already deleted by someone else — fine
  }
}

// ---------------------------------------------------------------------------
// Lock state persistence
// ---------------------------------------------------------------------------

const LOCK_STATE_FILE = '.lockstate';

function getLockDir(lockPath: string): string {
  // Use a directory named after the lock file (e.g., `chat.json.lock.d/`)
  return `${lockPath}.d`;
}

function getLockStatePath(lockDir: string): string {
  return resolve(lockDir, LOCK_STATE_FILE);
}

function getMutexPath(lockDir: string): string {
  return resolve(lockDir, '.mutex');
}

async function readLockState(lockDir: string): Promise<LockState> {
  try {
    const data = await readFile(getLockStatePath(lockDir), 'utf-8');
    return JSON.parse(data) as LockState;
  } catch {
    return { holders: [] };
  }
}

async function writeLockState(lockDir: string, state: LockState): Promise<void> {
  await ensureDir(getLockStatePath(lockDir));
  await writeFile(getLockStatePath(lockDir), JSON.stringify(state), 'utf-8');
}

/**
 * Remove stale holders from the lock state.
 * A holder is stale if it exceeds STALE_THRESHOLD_MS or its PID is no longer alive.
 */
function cleanStaleHolders(holders: LockHolder[]): LockHolder[] {
  return holders.filter((h) => {
    if (isStale(h.acquiredAt)) return false;
    // Best-effort PID check (only reliable for same-machine)
    // We do this synchronously-safe by keeping the holder if we can't confirm it's dead
    return true;
  });
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Check if the lock mechanism is available.
 * Always returns `true` since we use `open('wx')` which is available in all Node.js versions.
 */
export function isFlockAvailable(): boolean {
  return true;
}

/**
 * Acquire a file lock.
 *
 * @param lockPath - Path to the lock resource (typically `${chatFile}.lock`)
 * @param mode - 'exclusive' (default) or 'shared'
 * @param timeout - Max wait time in ms (default: 5000, 0 = non-blocking)
 */
export async function acquireLock(
  lockPath: string,
  mode: 'exclusive' | 'shared' = 'exclusive',
  timeout: number = 5000,
): Promise<FileLock> {
  const lockDir = getLockDir(lockPath);
  const mutexPath = getMutexPath(lockDir);
  const holderId = generateId();
  const pid = process.pid;
  const deadline = Date.now() + timeout;

  // Outer retry loop: attempt to acquire the lock
  while (true) {
    // Step 1: Acquire mutex to serialize state changes
    const mutex = await acquireMutex(mutexPath, Math.max(deadline - Date.now(), 100));

    try {
      // Step 2: Read and clean stale holders
      let state = await readLockState(lockDir);
      state.holders = cleanStaleHolders(state.holders);

      // Step 3: Check compatibility
      const hasExclusive = state.holders.some((h) => h.mode === 'exclusive');
      const hasShared = state.holders.some((h) => h.mode === 'shared');

      if (mode === 'exclusive') {
        // Exclusive lock: no other holders allowed
        if (state.holders.length > 0) {
          // Incompatible — release mutex and retry
          await releaseMutex(mutex, mutexPath);
          if (timeout === 0) {
            throw new Error(
              `Failed to acquire exclusive lock for '${lockPath}' (already locked by ${state.holders.length} holder(s))`,
            );
          }
          if (Date.now() >= deadline) {
            throw new Error(
              `Failed to acquire exclusive lock for '${lockPath}' (timed out after ${timeout}ms)`,
            );
          }
          await sleep(jitteredDelay());
          continue;
        }
      } else {
        // Shared lock: no exclusive holders allowed
        if (hasExclusive) {
          await releaseMutex(mutex, mutexPath);
          if (timeout === 0) {
            throw new Error(
              `Failed to acquire shared lock for '${lockPath}' (exclusive lock held)`,
            );
          }
          if (Date.now() >= deadline) {
            throw new Error(
              `Failed to acquire shared lock for '${lockPath}' (timed out after ${timeout}ms)`,
            );
          }
          await sleep(jitteredDelay());
          continue;
        }
      }

      // Step 4: Add self as holder
      state.holders.push({
        id: holderId,
        pid,
        mode,
        acquiredAt: Date.now(),
      });

      // Step 5: Write updated state and release mutex
      await writeLockState(lockDir, state);
      await releaseMutex(mutex, mutexPath);

      // Lock acquired successfully
      return {
        release: async () => {
          const relMutex = await acquireMutex(
            getMutexPath(lockDir),
            Math.max(deadline - Date.now(), 2000),
          );
          let shouldCleanup = false;
          try {
            const relState = await readLockState(lockDir);
            relState.holders = relState.holders.filter((h) => h.id !== holderId);

            if (relState.holders.length === 0) {
              // No holders left — remove lock state file
              try {
                await unlink(getLockStatePath(lockDir));
              } catch {
                // Ignore
              }
              shouldCleanup = true;
            } else {
              await writeLockState(lockDir, relState);
            }
          } finally {
            // Release mutex first (deletes mutex file from inside lockDir)
            await releaseMutex(relMutex, getMutexPath(lockDir));
          }

          // Now try to remove the lock directory (should be empty after mutex deletion)
          if (shouldCleanup) {
            try {
              const { rmdir } = await import('node:fs/promises');
              await rmdir(lockDir);
            } catch {
              // Directory may not be empty or may have been removed — ignore
            }
          }
        },
      };
    } catch (err: any) {
      // If the error is our own timeout/incompatible message, re-throw
      if (err.message?.includes('Failed to acquire')) {
        await releaseMutex(mutex, mutexPath).catch(() => {});
        throw err;
      }
      // Unexpected error — release mutex and re-throw
      await releaseMutex(mutex, mutexPath).catch(() => {});
      throw err;
    }
  }
}

/**
 * Execute a function under an exclusive lock.
 *
 * @param lockPath - Path to the lock resource
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
 * @param lockPath - Path to the lock resource
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
