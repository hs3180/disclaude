/**
 * macOS TCC (Transparency, Consent, and Control) bypass utility.
 *
 * When disclaude runs under PM2 fork mode, macOS TCC traces the entire
 * process chain and silently denies permissions (microphone, camera, etc.)
 * if any ancestor process lacks the required TCC entry.
 *
 * Process chain when running under PM2:
 *   PM2 (node) → claude → zsh → python/audio-tool  ← TCC denied
 *
 * This module provides a utility to spawn commands in an independent
 * Terminal.app context, bypassing the PM2 process chain:
 *   Terminal.app → python/audio-tool  ← TCC granted
 *
 * @see {@link https://github.com/hs3180/disclaude/issues/1957}
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

/**
 * Result of a TCC bypass spawn operation.
 */
export interface TccBypassResult {
  /** Whether the command was launched successfully */
  success: boolean;
  /** Human-readable message describing the outcome */
  message: string;
  /** The PID of the spawned Terminal process (if available) */
  pid?: number;
}

/**
 * Options for TCC bypass spawning.
 */
export interface TccBypassOptions {
  /**
   * Timeout in milliseconds for the osascript launch command (default: 10000).
   * This only covers the launch itself, not the execution of the target command.
   */
  timeoutMs?: number;
  /**
   * Whether to use 'open' instead of osascript for launching.
   * 'open' launches a new Terminal window but gives less control over the command.
   * Default: false (use osascript).
   */
  useOpen?: boolean;
}

/**
 * Check if the current platform is macOS (Darwin).
 *
 * @returns true if running on macOS
 */
export function isMacOS(): boolean {
  return process.platform === 'darwin';
}

/**
 * Check if the current process is running under PM2.
 *
 * PM2 sets the `PM2_HOME` or `pm_id` environment variable for managed processes.
 *
 * @returns true if running under PM2
 */
export function isRunningUnderPm2(): boolean {
  return 'PM2_HOME' in process.env || 'pm_id' in process.env;
}

/**
 * Detect whether TCC bypass is needed and available.
 *
 * @returns An object describing whether bypass is needed and the reason
 */
export function tccBypassStatus(): {
  needed: boolean;
  available: boolean;
  platform: string;
  reason: string;
} {
  const { platform } = process;

  if (platform !== 'darwin') {
    return {
      needed: false,
      available: false,
      platform,
      reason: `TCC bypass is only needed on macOS (current: ${platform})`,
    };
  }

  if (!isRunningUnderPm2()) {
    return {
      needed: false,
      available: true,
      platform,
      reason: 'Not running under PM2, TCC bypass not needed',
    };
  }

  return {
    needed: true,
    available: true,
    platform,
    reason: 'Running under PM2 on macOS — TCC may silently deny permissions for mic, camera, etc.',
  };
}

/**
 * Escape a shell command for safe inclusion in an AppleScript string.
 *
 * Handles double quotes and backslashes that would break the AppleScript string literal.
 *
 * @param command - The shell command to escape
 * @returns The escaped command safe for AppleScript string interpolation
 */
export function escapeAppleScriptString(command: string): string {
  return command.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

/**
 * Spawn a command in a new Terminal.app window, bypassing the PM2 process chain.
 *
 * This launches the command via osascript in a fresh Terminal.app context,
 * which has its own TCC permission entry independent of the PM2 process chain.
 *
 * **Important**: This is a fire-and-forget operation. The command runs in
 * a new Terminal window and this function returns after launch. Use file-based
 * or IPC-based communication to get results back from the spawned command.
 *
 * @param command - The shell command to execute (will be run in a new Terminal window)
 * @param options - Configuration options
 * @returns Result indicating success/failure
 *
 * @example
 * ```typescript
 * const result = await spawnOutsideProcessChain('python3 record.py --output /tmp/audio.wav');
 * if (result.success) {
 *   console.log(`Launched recording in Terminal (PID: ${result.pid})`);
 * }
 * ```
 */
export async function spawnOutsideProcessChain(
  command: string,
  options: TccBypassOptions = {}
): Promise<TccBypassResult> {
  const { timeoutMs = 10000, useOpen = false } = options;

  if (!isMacOS()) {
    return {
      success: false,
      message: `TCC bypass is only available on macOS (current platform: ${process.platform})`,
    };
  }

  const escapedCommand = escapeAppleScriptString(command);

  try {
    if (useOpen) {
      // Alternative: use 'open' to launch Terminal with the command
      // Less control but simpler
      await execFileAsync('open', ['-a', 'Terminal', command], {
        timeout: timeoutMs,
      });
      return {
        success: true,
        message: 'Command launched via Terminal.app (open)',
      };
    }

    // Primary method: use osascript to run command in a new Terminal window
    const appleScript = `tell application "Terminal"\n  do script "${escapedCommand}"\nend tell`;

    const { pid } = await execFileAsync('osascript', ['-e', appleScript], {
      timeout: timeoutMs,
    });

    return {
      success: true,
      message: 'Command launched in new Terminal.app window',
      pid,
    };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    return {
      success: false,
      message: `Failed to launch command via Terminal.app: ${errorMessage}`,
    };
  }
}

/**
 * Build a wrapper script that executes a command and writes its exit status
 * to a status file. This allows the caller to poll for completion.
 *
 * @param command - The command to wrap
 * @param statusFile - Path to write exit status (0 = success, non-zero = failure)
 * @param outputFile - Optional path to capture stdout
 * @returns A shell script string that wraps the command
 *
 * @example
 * ```typescript
 * const script = buildStatusScript(
 *   'python3 record.py --output /tmp/audio.wav',
 *   '/tmp/recording_status',
 *   '/tmp/recording_output'
 * );
 * await spawnOutsideProcessChain(script);
 * // Poll /tmp/recording_status for completion
 * ```
 */
export function buildStatusScript(
  command: string,
  statusFile: string,
  outputFile?: string
): string {
  const outputRedirect = outputFile ? ` > "${outputFile}" 2>&1` : '';
  return `${command}${outputRedirect}; echo $? > "${statusFile}"`;
}

/**
 * Read the exit status from a status file created by {@link buildStatusScript}.
 *
 * @param statusFile - Path to the status file
 * @returns The exit code, or undefined if the file doesn't exist yet
 */
export async function readStatusFile(statusFile: string): Promise<number | undefined> {
  const { readFile } = await import('node:fs/promises');
  try {
    const content = await readFile(statusFile, 'utf-8');
    const code = parseInt(content.trim(), 10);
    return isNaN(code) ? undefined : code;
  } catch {
    // File doesn't exist yet — command hasn't finished
    return undefined;
  }
}

/**
 * Poll a status file until the command finishes or timeout is reached.
 *
 * @param statusFile - Path to the status file
 * @param options - Polling options
 * @returns The exit code, or undefined if timed out
 */
export async function waitForStatusFile(
  statusFile: string,
  options: {
    /** Polling interval in milliseconds (default: 500) */
    intervalMs?: number;
    /** Maximum wait time in milliseconds (default: 60000) */
    timeoutMs?: number;
  } = {}
): Promise<number | undefined> {
  const { intervalMs = 500, timeoutMs = 60000 } = options;
  const startTime = Date.now();

  while (Date.now() - startTime < timeoutMs) {
    const status = await readStatusFile(statusFile);
    if (status !== undefined) {
      return status;
    }
    await new Promise(resolve => setTimeout(resolve, intervalMs));
  }

  return undefined; // Timed out
}
