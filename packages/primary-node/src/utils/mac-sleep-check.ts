/**
 * macOS Auto-Sleep Detection Utility.
 *
 * Issue #2263: Detects macOS auto-sleep settings at startup and logs
 * a WARNING if sleep is enabled. macOS sleep silently breaks all
 * long-lived connections (WebSocket, Unix Socket IPC, TCP keep-alive, etc.).
 *
 * This is a system-level check, gated only by `process.platform === 'darwin'`.
 * It does NOT depend on any channel configuration.
 *
 * @module utils/mac-sleep-check
 */

import { execSync } from 'node:child_process';
import { createLogger } from '@disclaude/core';

const logger = createLogger('MacSleepCheck');

/**
 * Check macOS auto-sleep setting and warn if enabled.
 *
 * Uses `pmset -g` to read the current power management settings.
 * Only runs on macOS (`process.platform === 'darwin'`).
 * Failures are silently ignored to avoid blocking startup.
 *
 * Detection logic:
 * - Parses `pmset -g` output for a line matching `^\s*sleep\s+(\d+)`
 * - If the value is > 0, auto-sleep is enabled → log WARNING
 * - If the value is 0 or the line is absent, auto-sleep is disabled → silent
 */
export function checkMacAutoSleep(): void {
  if (process.platform !== 'darwin') {
    return;
  }

  try {
    const output = execSync('pmset -g', {
      encoding: 'utf-8',
      timeout: 5000,
    });

    const sleepMatch = output.match(/^\s*sleep\s+(\d+)/m);
    if (sleepMatch && parseInt(sleepMatch[1], 10) > 0) {
      const sleepMinutes = parseInt(sleepMatch[1], 10);
      logger.warn(
        { sleepMinutes },
        'macOS auto-sleep is enabled. This may cause long-lived connections ' +
        '(WebSocket, IPC, etc.) to drop silently when the system sleeps. ' +
        'Consider: sudo pmset -a sleep 0'
      );
    }
  } catch {
    // pmset not available, permission denied, or timeout — silently skip
  }
}
