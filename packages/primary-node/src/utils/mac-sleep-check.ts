/**
 * macOS auto-sleep detection utility.
 *
 * Checks whether macOS automatic sleep is enabled at system startup.
 * When sleep is enabled (`pmset sleep > 0`), the system may enter sleep
 * and disconnect all long-lived connections (WebSocket, Unix Socket IPC, etc.).
 *
 * This is a system-level check — it is NOT limited to any specific channel type.
 * Only condition: `process.platform === 'darwin'`.
 *
 * Issue #2263: Startup warning for macOS auto-sleep.
 */

import { execSync } from 'node:child_process';
import { createLogger } from '@disclaude/core';

const logger = createLogger('MacSleepCheck');

/**
 * Check macOS auto-sleep setting and log a warning if enabled.
 *
 * - Only runs on macOS (`process.platform === 'darwin'`)
 * - Reads `pmset -g` output to find the `sleep` setting
 * - Logs a WARNING if sleep > 0
 * - Silently skips on non-macOS, pmset unavailable, or parse errors
 * - Does NOT block startup under any circumstances
 */
export function checkMacAutoSleep(): void {
  if (process.platform !== 'darwin') {
    return;
  }

  try {
    const output = execSync('pmset -g', { encoding: 'utf-8', timeout: 5000 });
    const sleepMatch = output.match(/^\s*sleep\s+(\d+)/m);
    if (sleepMatch) {
      const sleepMinutes = parseInt(sleepMatch[1], 10);
      if (sleepMinutes > 0) {
        logger.warn(
          { sleepMinutes },
          'macOS auto-sleep is enabled. This may cause network disconnections ' +
          'when the system sleeps. Consider: sudo pmset -a sleep 0',
        );
      }
    }
    // sleep=0 or no sleep line found → no warning needed
  } catch {
    // pmset not available, permission denied, or timeout — silently skip
  }
}
