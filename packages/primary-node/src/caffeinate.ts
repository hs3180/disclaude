/**
 * macOS caffeinate management for disclaude.
 *
 * Spawns `caffeinate -s` on macOS to prevent system sleep while the service
 * is running. This is especially important for long-running WebSocket
 * connections and scheduled tasks that would be disrupted by system sleep.
 *
 * The caffeinate process is automatically killed when the parent Node process
 * exits (including on SIGINT/SIGTERM), so no explicit cleanup is needed.
 *
 * On non-macOS platforms (Linux, Windows), this module is a no-op.
 *
 * Issue #2975
 *
 * @module primary-node/caffeinate
 */

import { spawn, execSync, type ChildProcess } from 'node:child_process';
import { platform } from 'node:os';
import { createLogger } from '@disclaude/core';

const logger = createLogger('Caffeinate');

/**
 * Check whether caffeinate is available on this system.
 * Only meaningful on macOS; always returns false on other platforms.
 *
 * @returns true if the caffeinate command is available
 */
export function isCaffeinateAvailable(): boolean {
  if (platform() !== 'darwin') {return false;}
  try {
    execSync('which caffeinate', { encoding: 'utf-8', stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
}

/**
 * Spawn a caffeinate -s process to prevent macOS system sleep.
 *
 * The `-s` flag prevents system sleep (even when the display is off).
 * The caffeinate process automatically exits when the parent process dies,
 * because it is spawned as a child process with an implicit IPC lifecycle.
 *
 * @returns The spawned ChildProcess, or null if caffeinate is not available
 */
export function spawnCaffeinate(): ChildProcess | null {
  if (!isCaffeinateAvailable()) {
    logger.debug('caffeinate not available (non-macOS or command not found)');
    return null;
  }

  try {
    const child = spawn('caffeinate', ['-s'], {
      stdio: 'ignore',
      detached: false, // child dies with parent
    });

    child.on('error', (err) => {
      logger.warn({ err }, 'caffeinate process error');
    });

    child.on('exit', (code, signal) => {
      if (code !== 0 && code !== null) {
        logger.warn({ code, signal }, 'caffeinate process exited unexpectedly');
      }
    });

    logger.info({ pid: child.pid }, 'caffeinate -s spawned');
    return child;
  } catch (err) {
    logger.warn({ err }, 'Failed to spawn caffeinate');
    return null;
  }
}
