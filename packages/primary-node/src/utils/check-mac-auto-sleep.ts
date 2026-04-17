/**
 * macOS Auto-Sleep Detection.
 *
 * Checks macOS power management settings at startup. If auto-sleep is enabled
 * (pmset sleep > 0), logs a WARNING because system sleep can disrupt
 * long-lived connections (WebSocket, Unix Socket IPC, etc.).
 *
 * Issue #2263: Startup check for macOS auto-sleep setting.
 *
 * Design decisions:
 * - Only runs on macOS (process.platform === 'darwin')
 * - Not tied to any specific channel (applies to ALL long connections)
 * - Non-blocking: pure warning, does not affect service startup
 * - Silently skips if pmset is unavailable or permission denied
 */

import { execSync } from 'child_process';
import { createLogger } from '@disclaude/core';

const logger = createLogger('MacSleepCheck');

/**
 * Result of the macOS auto-sleep check.
 */
export interface MacSleepCheckResult {
  /** Whether the check was performed (only on macOS) */
  checked: boolean;
  /** Whether auto-sleep is enabled */
  sleepEnabled: boolean;
  /** Sleep timer value in minutes (0 = never sleep) */
  sleepMinutes: number | null;
}

/**
 * Check if macOS auto-sleep is enabled.
 *
 * On non-macOS platforms, returns immediately without performing any check.
 * On macOS, runs `pmset -g` and parses the sleep setting.
 * Failures (pmset unavailable, permission denied, etc.) are silently ignored.
 *
 * @returns Check result with sleep status information
 */
export function checkMacAutoSleep(): MacSleepCheckResult {
  // Only check on macOS
  if (process.platform !== 'darwin') {
    return { checked: false, sleepEnabled: false, sleepMinutes: null };
  }

  try {
    const output = execSync('pmset -g', { encoding: 'utf-8' });
    const sleepMatch = output.match(/^\s*sleep\s+(\d+)/m);

    if (!sleepMatch) {
      // No sleep line found — setting may be managed differently
      return { checked: true, sleepEnabled: false, sleepMinutes: null };
    }

    const sleepMinutes = parseInt(sleepMatch[1], 10);

    if (sleepMinutes > 0) {
      logger.warn(
        { sleepMinutes },
        'macOS auto-sleep is enabled. This may cause long-lived connection ' +
        'disruptions (WebSocket, IPC, etc.) when the system sleeps. ' +
        'Consider running: sudo pmset -a sleep 0'
      );
      return { checked: true, sleepEnabled: true, sleepMinutes };
    }

    // Sleep is disabled (sleep = 0)
    return { checked: true, sleepEnabled: false, sleepMinutes: 0 };
  } catch {
    // pmset not available or permission denied — silently skip
    return { checked: true, sleepEnabled: false, sleepMinutes: null };
  }
}
