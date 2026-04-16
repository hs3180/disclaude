/**
 * macOS Auto-Sleep Detection Utility
 *
 * Issue #2263: Detects macOS auto-sleep settings at startup and logs
 * a WARNING when sleep is enabled (pmset sleep > 0).
 *
 * This is a system-level warning — macOS sleep affects ALL long-lived
 * connections (WebSocket, Unix Socket IPC, etc.), not just Feishu.
 * Therefore the check runs unconditionally on macOS, gated only by
 * process.platform === 'darwin'.
 *
 * @module primary-node/utils/mac-sleep-check
 */

import { execSync } from 'node:child_process';
import { createLogger } from '@disclaude/core';

const logger = createLogger('MacSleepCheck');

/** Timeout for pmset command execution (ms) */
const PMSET_TIMEOUT_MS = 5000;

/**
 * Check if macOS auto-sleep is enabled and log a warning if so.
 *
 * This function is safe to call on any platform — it will silently
 * return on non-macOS systems. On macOS, it runs `pmset -g` to
 * read the current sleep setting and logs a WARNING if sleep > 0.
 *
 * Errors (pmset unavailable, permission denied, etc.) are silently
 * ignored to avoid blocking startup.
 */
export function checkMacAutoSleep(): void {
  // Only check on macOS
  if (process.platform !== 'darwin') {
    return;
  }

  try {
    const output = execSync('pmset -g', {
      encoding: 'utf-8',
      timeout: PMSET_TIMEOUT_MS,
    });

    // Match lines like " sleep   1" or "sleep	0" (with various whitespace)
    const sleepMatch = output.match(/^\s*sleep\s+(\d+)/m);
    if (sleepMatch) {
      const sleepMinutes = parseInt(sleepMatch[1], 10);
      if (sleepMinutes > 0) {
        logger.warn(
          { sleepMinutes },
          'macOS auto-sleep is enabled. This may cause WebSocket and IPC disconnections ' +
          'when the system sleeps. Consider running: sudo pmset -a sleep 0'
        );
      }
    }
    // If no sleep line found, silently skip (unusual but not an error)
  } catch {
    // pmset not available, permission denied, or timeout — silently skip
  }
}
