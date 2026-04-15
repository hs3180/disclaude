/**
 * macOS Auto-Sleep Detection Module
 *
 * Detects if macOS auto-sleep is enabled at startup and logs a warning.
 * System sleep causes all long-lived connections (WebSocket, Unix Socket IPC, etc.)
 * to drop silently, which is non-obvious to users.
 *
 * Detection uses `pmset -g` to read the current power management sleep setting.
 * A value > 0 means auto-sleep is enabled.
 *
 * Conditions:
 * - Only runs on macOS (process.platform === 'darwin')
 * - Unconditional: runs regardless of channel configuration
 * - Non-blocking: purely informational, does not affect startup
 *
 * @see Issue #2263
 * @see Issue #2259 — macOS sleep causes WS disconnections
 * @module utils/mac-sleep-check
 */

import { execSync } from 'child_process';
import { createLogger } from '@disclaude/core';

const logger = createLogger('MacSleepCheck');

/**
 * Check if macOS auto-sleep is enabled and log a warning if so.
 *
 * Safe to call on any platform — returns immediately on non-macOS.
 * Silently skips if pmset is unavailable or permission is denied.
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
          'macOS auto-sleep is enabled. This may cause long-lived connections ' +
            '(WebSocket, IPC, etc.) to drop silently. Consider: sudo pmset -a sleep 0'
        );
      }
    }
  } catch {
    // pmset not available or permission denied — silently skip
  }
}
