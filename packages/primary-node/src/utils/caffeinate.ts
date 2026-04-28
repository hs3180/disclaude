/**
 * macOS caffeinate management for preventing system sleep.
 *
 * Spawns `caffeinate -s` as a child process on macOS to prevent the system
 * from sleeping while the service is running. This ensures long-lived
 * connections (WebSocket, Unix Socket IPC) remain stable.
 *
 * Key behaviors:
 * - **macOS only**: Silently returns `null` on non-macOS platforms
 * - **Non-blocking**: Does not affect service startup if caffeinate is unavailable
 * - **Automatic cleanup**: The caffeinate child process dies when the parent
 *   Node process exits (even on crash), because `detached: false` (default)
 *   means the child is in the same process group
 * - **Manual cleanup**: Call `stopCaffeinate()` during graceful shutdown
 *   to release the sleep prevention immediately
 *
 * The `-s` flag prevents system sleep even when the display is off,
 * which is critical for headless/server macOS machines.
 *
 * Issue #2975: Prevent macOS sleep during service runtime.
 *
 * @module utils/caffeinate
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { createLogger } from '@disclaude/core';

const logger = createLogger('Caffeinate');

/**
 * Result of a caffeinate start attempt.
 */
export interface CaffeinateHandle {
  /** The spawned child process (null on non-macOS or if caffeinate is unavailable) */
  process: ChildProcess | null;
  /** Whether caffeinate was successfully started */
  active: boolean;
}

/**
 * Start caffeinate to prevent macOS system sleep.
 *
 * On macOS, spawns `caffeinate -s` as a detached child process that
 * prevents sleep. On other platforms, returns immediately with
 * `active: false`.
 *
 * The spawned process is NOT detached (uses default `detached: false`),
 * so it will be killed when the parent Node process exits. However,
 * for graceful shutdown, call `stopCaffeinate()` explicitly.
 *
 * @returns Handle with the child process and active status
 */
export function startCaffeinate(): CaffeinateHandle {
  // Only run on macOS
  if (process.platform !== 'darwin') {
    logger.debug('Skipping caffeinate: not running on macOS');
    return { process: null, active: false };
  }

  try {
    const child = spawn('caffeinate', ['-s'], {
      stdio: 'ignore',
      detached: false,
    });

    child.on('error', (err) => {
      logger.warn(
        { err: err.message },
        'caffeinate process error — system may sleep during idle'
      );
    });

    child.on('exit', (code, signal) => {
      if (code !== 0 || signal !== null) {
        logger.warn(
          { exitCode: code, signal },
          'caffeinate exited unexpectedly — system may sleep during idle'
        );
      }
    });

    logger.info('caffeinate -s started: macOS sleep prevention active');
    return { process: child, active: true };
  } catch (err) {
    logger.warn(
      { err: err instanceof Error ? err.message : String(err) },
      'Failed to start caffeinate — system may sleep during idle'
    );
    return { process: null, active: false };
  }
}

/**
 * Stop a running caffeinate process.
 *
 * Sends SIGTERM to the caffeinate child process for graceful shutdown.
 * Safe to call with `null` (no-op).
 *
 * @param handle - The caffeinate handle returned by startCaffeinate()
 */
export function stopCaffeinate(handle: CaffeinateHandle): void {
  if (!handle.process || !handle.active) {
    return;
  }

  try {
    handle.process.kill('SIGTERM');
    logger.info('caffeinate stopped: macOS sleep prevention released');
  } catch (err) {
    // Process may have already exited — that's fine
    logger.debug(
      { err: err instanceof Error ? err.message : String(err) },
      'caffeinate kill failed (process may have already exited)'
    );
  }
}
