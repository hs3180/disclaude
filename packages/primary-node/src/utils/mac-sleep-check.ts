/**
 * macOS auto-sleep detection utility.
 *
 * Detects whether macOS automatic sleep is enabled at service startup and
 * emits a WARNING if so. System sleep causes all long-lived connections
 * (WebSocket, Unix Socket IPC, etc.) to silently disconnect, which is
 * confusing for users who see a seemingly healthy service.
 *
 * Related: #2259 (root cause analysis of macOS sleep → WS disconnect)
 * Issue:   #2263
 *
 * @module primary-node/utils/mac-sleep-check
 */

import * as child_process from 'node:child_process';
import { createLogger } from '@disclaude/core';

const logger = createLogger('MacSleepCheck');

/** Command timeout in milliseconds to avoid blocking startup. */
const PMSET_TIMEOUT_MS = 5000;

/**
 * Check whether macOS automatic sleep is enabled and log a warning if so.
 *
 * This is a **system-level** check — it is NOT gated by any particular
 * channel type (e.g. Feishu). Sleep affects every long-lived connection
 * (WebSocket, IPC socket, TCP keep-alive, etc.).
 *
 * The only guard is `process.platform === 'darwin'`; on all other platforms
 * the function returns immediately.
 *
 * Errors (pmset unavailable, permission denied, etc.) are silently swallowed
 * so that the check never blocks or crashes the service.
 */
export function checkMacAutoSleep(): void {
  if (process.platform !== 'darwin') {
    return;
  }

  try {
    const output = child_process.execSync('pmset -g', {
      encoding: 'utf-8',
      timeout: PMSET_TIMEOUT_MS,
    });

    const sleepMatch = output.match(/^\s*sleep\s+(\d+)/m);
    if (sleepMatch) {
      const sleepMinutes = parseInt(sleepMatch[1], 10);
      if (sleepMinutes > 0) {
        logger.warn(
          { sleepMinutes },
          'macOS auto-sleep is enabled. This may cause network disconnections ' +
            '(WebSocket, IPC, etc.) when the system sleeps. ' +
            'Consider: sudo pmset -a sleep 0',
        );
      }
    }
    // If no "sleep" line found (e.g. custom pmset profile), skip silently.
  } catch {
    // pmset not available, permission denied, or timeout — silently skip.
  }
}
