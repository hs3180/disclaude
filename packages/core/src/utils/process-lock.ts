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
   * Check if a process with the given PID is still running **and** is
   * a disclaude-related process.
   *
   * Uses `process.kill(pid, 0)` to check existence, then on Linux
   * verifies via `/proc/{pid}/cmdline` that the process is actually
   * a node/disclaude process. This prevents PID recycling from
   * blocking server startup when an unrelated process reuses the PID
   * from a crashed previous instance.
   *
   * Issue #3494: On CI (Linux), PIDs are aggressively recycled.
   * A stale PID file whose PID now belongs to, e.g., a shell or
   * cron daemon would prevent the test server from starting.
   *
   * @param pid - Process ID to check
   * @returns `true` if process is alive and is a disclaude process
   */
  private isProcessRunning(pid: number): boolean {
    try {
      process.kill(pid, 0);
    } catch {
      return false;
    }

    // process.kill(pid, 0) succeeded — a process with this PID exists.
    // On Linux, verify it's actually a disclaude process to handle PID recycling.
    if (process.platform === 'linux') {
      return this.isDisclaudeProcess(pid);
    }

    // On non-Linux platforms (macOS dev), trust process.kill(pid, 0).
    return true;
  }

  /**
   * Verify that a running process is a Node.js process (which could be
   * a disclaude server instance).
   *
   * Reads `/proc/{pid}/cmdline` to check if the process command line
   * contains "node". If the PID was recycled to a non-Node process
   * (e.g., init, cron, bash), we treat the lock as stale.
   *
   * @param pid - Process ID to verify
   * @returns `true` if the process appears to be a Node.js process
   */
  private isDisclaudeProcess(pid: number): boolean {
    try {
      const cmdline = fs.readFileSync(`/proc/${pid}/cmdline`, 'utf-8');
      // /proc/{pid}/cmdline uses null bytes as separators
      const cmdStr = cmdline.replace(/\0/g, ' ');
      // Check if this is a Node.js process (could be our disclaude server)
      if (cmdStr.includes('node')) {
        return true;
      }
      this.logger.warn(
        { pid, cmdline: cmdStr.substring(0, 200) },
        'PID file references a non-Node.js process (PID recycled). Treating as stale.'
      );
      return false;
    } catch {
      // Can't read cmdline (PID gone or permission denied) —
      // be conservative and assume it IS our process to avoid
      // false positives during legitimate concurrent runs.
      return true;
    }
  }
}
