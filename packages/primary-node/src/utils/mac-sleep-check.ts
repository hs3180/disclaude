/**
 * macOS auto-sleep detection utility.
 *
 * Checks whether macOS has automatic sleep enabled (`pmset sleep > 0`) and
 * logs a WARNING if so.  macOS auto-sleep can silently break long-lived
 * connections (WebSocket, Unix Socket IPC, etc.), which is a system-level
 * concern regardless of which channels are active.
 *
 * Issue #2263: System-level startup warning (not limited to Feishu channel).
 * Only gate is `process.platform === 'darwin'`.
 *
 * @module primary-node/utils/mac-sleep-check
 */

import * as child_process from 'node:child_process';
import { createLogger } from '@disclaude/core';

const logger = createLogger('MacSleepCheck');

/** Timeout (ms) for the `pmset -g` subprocess. */
const PMSET_TIMEOUT_MS = 5000;

/**
 * Check macOS auto-sleep setting and log a warning if enabled.
 *
 * - Non-macOS platforms: no-op (returns immediately).
 * - macOS: runs `pmset -g`, parses the `sleep` value, warns if > 0.
 * - Errors (pmset unavailable, permission denied, etc.) are silently ignored
 *   so they never block startup.
 */
export function checkMacAutoSleep(): void {
  if (process.platform !== 'darwin') {
    return;
  }

  try {
    const result = child_process.spawnSync('pmset', ['-g'], {
      encoding: 'utf-8',
      timeout: PMSET_TIMEOUT_MS,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    if (result.error || result.status !== 0) {
      // pmset not available or failed — silently skip
      return;
    }

    const output = result.stdout as string;
    const sleepMatch = output.match(/^\s*sleep\s+(\d+)/m);

    if (sleepMatch) {
      const sleepMinutes = parseInt(sleepMatch[1], 10);
      if (sleepMinutes > 0) {
        logger.warn(
          { sleepMinutes },
          'macOS auto-sleep is enabled. This may cause disconnections ' +
          '(WebSocket, IPC, etc.) when the system sleeps. ' +
          'Consider: sudo pmset -a sleep 0  or  caffeinate -s &',
        );
      }
    }
    // If no `sleep` line is found, assume no issue — silently skip
  } catch {
    // Unexpected error — silently skip to never block startup
  }
}
