/**
 * Process Lock — PID file-based singleton enforcement.
 *
 * Prevents multiple instances of the same service from running concurrently.
 * Uses a PID (Process ID) file to detect stale or active previous instances.
 *
 * Flow:
 *   1. Check if PID file exists
 *   2. If exists, read PID and check if process is still running
 *   3. If running → refuse to start (return false)
 *   4. If not running → stale file, remove it
 *   5. Write our own PID to the file
 *   6. On shutdown, clean up the PID file
 *
 * Issue #3417: Prevents launchd KeepAlive crash-restart from spawning
 * duplicate processes while the old one is still exiting.
 *
 * @module utils/process-lock
 */

import fs from 'node:fs';
import path from 'node:path';
import type { Logger } from 'pino';

/**
 * Options for creating a ProcessLock.
 */
export interface ProcessLockOptions {
  /** Absolute path to the PID lock file */
  lockfilePath: string;
  /** Pino logger instance */
  logger: Logger;
}

/**
 * PID file-based process lock to prevent multiple concurrent instances.
 *
 * @example
 * ```typescript
 * const lock = new ProcessLock({
 *   lockfilePath: '/var/run/disclaude.pid',
 *   logger,
 * });
 *
 * if (!lock.acquire()) {
 *   process.exit(1);
 * }
 *
 * // ... run service ...
 *
 * // On shutdown:
 * lock.release();
 * ```
 */
export class ProcessLock {
  private readonly lockfilePath: string;
  private readonly logger: Logger;
  private acquired = false;

  constructor(options: ProcessLockOptions) {
    this.lockfilePath = options.lockfilePath;
    this.logger = options.logger;
  }

  /**
   * Try to acquire the process lock.
   *
   * @returns `true` if lock was acquired successfully,
   *          `false` if another instance is already running.
   */
  acquire(): boolean {
    if (fs.existsSync(this.lockfilePath)) {
      const existingPid = this.readPidFile();

      if (existingPid !== null && this.isProcessRunning(existingPid)) {
        this.logger.error(
          { pid: existingPid, lockfile: this.lockfilePath },
          `Another instance is already running (PID ${existingPid}). Exiting to prevent duplicate.`
        );
        return false;
      }

      // Stale PID file — old process is dead, safe to remove
      this.logger.warn(
        { stalePid: existingPid, lockfile: this.lockfilePath },
        'Stale PID file found (process no longer running). Removing stale lock.'
      );
      try {
        fs.unlinkSync(this.lockfilePath);
      } catch {
        this.logger.warn(
          { lockfile: this.lockfilePath },
          'Failed to remove stale PID file, will attempt to overwrite'
        );
      }
    }

    // Write our PID
    const dir = path.dirname(this.lockfilePath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    fs.writeFileSync(this.lockfilePath, String(process.pid), 'utf-8');
    this.acquired = true;

    this.logger.info(
      { pid: process.pid, lockfile: this.lockfilePath },
      'Process lock acquired'
    );
    return true;
  }

  /**
   * Release the process lock (remove PID file).
   * Should be called during graceful shutdown.
   */
  release(): void {
    if (!this.acquired) {
      return;
    }

    try {
      if (fs.existsSync(this.lockfilePath)) {
        const filePid = this.readPidFile();
        // Only remove if the PID matches ours (avoid race condition)
        if (filePid === process.pid) {
          fs.unlinkSync(this.lockfilePath);
          this.logger.info(
            { lockfile: this.lockfilePath },
            'Process lock released'
          );
        } else {
          this.logger.warn(
            { filePid, ourPid: process.pid, lockfile: this.lockfilePath },
            'PID file belongs to another process, not removing'
          );
        }
      }
    } catch (err) {
      this.logger.warn(
        { err, lockfile: this.lockfilePath },
        'Failed to release process lock during shutdown'
      );
    } finally {
      this.acquired = false;
    }
  }

  /**
   * Whether the lock is currently held by this process.
   */
  get isAcquired(): boolean {
    return this.acquired;
  }

  /**
   * Read the PID from the lock file.
   *
   * @returns The PID number, or `null` if file doesn't exist or is invalid.
   */
  private readPidFile(): number | null {
    try {
      const content = fs.readFileSync(this.lockfilePath, 'utf-8').trim();
      const pid = parseInt(content, 10);
      return Number.isNaN(pid) ? null : pid;
    } catch {
      return null;
    }
  }

  /**
   * Check if a process with the given PID is still running.
   *
   * Uses `process.kill(pid, 0)` which sends signal 0 — it doesn't
   * kill the process, just checks if it exists and we have permission
   * to signal it.
   *
   * @param pid - Process ID to check
   * @returns `true` if process is alive
   */
  private isProcessRunning(pid: number): boolean {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  }
}
