/**
 * TCC-Safe Process Spawning Utility (Issue #1957)
 *
 * macOS TCC (Transparency, Consent, and Control) tracks the entire process chain.
 * When running under PM2, child processes that request TCC-protected resources
 * (microphone, camera, screen recording, etc.) are silently denied access —
 * no error, no permission dialog, just zero-length data.
 *
 * Root cause: PM2 fork mode creates a chain like:
 *   PM2(node) → claude → zsh → python/audio-tool
 * macOS TCC denies access because the ancestor PM2 node process lacks
 * the relevant TCC permission, and the denial is inherited by all descendants.
 *
 * This utility provides:
 * 1. Detection of PM2 + macOS TCC-restricted environments
 * 2. A spawn wrapper that launches processes via Terminal.app on macOS + PM2,
 *    breaking the TCC chain (Terminal.app has its own TCC entry)
 * 3. A helper script generator for more complex capture-output scenarios
 *
 * Usage:
 *   import { tccSafeSpawn, needsTccSafeSpawn } from './tcc-safe-spawn.js';
 *
 *   if (needsTccSafeSpawn()) {
 *     logger.warn('Running under PM2 on macOS — using TCC-safe spawn for audio');
 *   }
 *
 *   const child = tccSafeSpawn({
 *     command: 'python3',
 *     args: ['record_audio.py', '--output', '/tmp/audio.wav'],
 *     cwd: '/path/to/project',
 *   });
 *
 * @module utils/tcc-safe-spawn
 */

import { spawn, type ChildProcess } from 'child_process';
import os from 'os';
import path from 'path';
import fs from 'fs';
import { createLogger } from './logger.js';

const logger = createLogger('TccSafeSpawn');

/**
 * TCC-protected resource categories on macOS.
 */
export type TccResource = 'microphone' | 'camera' | 'screen' | 'accessibility' | 'location';

/**
 * Result of a TCC environment check.
 */
export interface TccEnvironmentInfo {
  /** Whether the process is running on macOS */
  isMacOS: boolean;
  /** Whether the process is managed by PM2 */
  isPm2Managed: boolean;
  /** Whether TCC-safe spawning is recommended */
  needsTccSafeSpawn: boolean;
  /** Known PM2 environment variables present */
  pm2EnvVars: string[];
}

/**
 * Options for TCC-safe process spawning.
 */
export interface TccSafeSpawnOptions {
  /** Command to execute */
  command: string;
  /** Arguments for the command */
  args?: string[];
  /** Working directory */
  cwd?: string;
  /** Additional environment variables */
  env?: Record<string, string>;
  /** Force TCC-safe mode even when not in PM2 */
  forceTccSafe?: boolean;
}

/**
 * Options for creating a TCC-safe helper script.
 */
export interface TccSafeScriptOptions {
  /** Command to execute */
  command: string;
  /** Arguments for the command */
  args?: string[];
  /** Working directory */
  cwd?: string;
  /** Additional environment variables */
  env?: Record<string, string>;
  /** File path to redirect stdout/stderr into */
  outputPath?: string;
  /** Directory for the generated script (default: os.tmpdir()) */
  scriptDir?: string;
}

/**
 * Detect if the current process is running under PM2.
 *
 * PM2 sets several environment variables in managed processes:
 * - `PM2_HOME`: PM2 home directory path
 * - `pm_id`: Process ID within PM2
 * - `pm2_home`: Lowercase variant (older PM2 versions)
 * - `name`: Process name in PM2 ecosystem
 */
export function isPm2Managed(): boolean {
  return !!(
    process.env.PM2_HOME ||
    process.env.pm_id ||
    process.env.pm2_home ||
    process.env.PM2_PROC_TITLE
  );
}

/**
 * Detect if running on macOS.
 */
export function isMacOS(): boolean {
  return os.platform() === 'darwin';
}

/**
 * Check if TCC-safe spawning is needed.
 *
 * Returns true when running on macOS under PM2, which means
 * TCC-protected resources (microphone, camera, etc.) will be
 * silently denied to child processes.
 */
export function needsTccSafeSpawn(): boolean {
  return isMacOS() && isPm2Managed();
}

/**
 * Get detailed information about the current TCC environment.
 */
export function getTccEnvironmentInfo(): TccEnvironmentInfo {
  const pm2EnvVars: string[] = [];
  const pm2Keys = ['PM2_HOME', 'pm_id', 'pm2_home', 'PM2_PROC_TITLE', 'PM2_JSON_PROCESSING'];
  for (const key of pm2Keys) {
    if (process.env[key]) {
      pm2EnvVars.push(key);
    }
  }

  return {
    isMacOS: isMacOS(),
    isPm2Managed: isPm2Managed(),
    needsTccSafeSpawn: needsTccSafeSpawn(),
    pm2EnvVars,
  };
}

/**
 * Escape a string for use inside an AppleScript double-quoted string.
 */
function escapeAppleScriptString(str: string): string {
  return str.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

/**
 * Escape a string for use inside a bash single-quoted string.
 */
function escapeBashSingle(str: string): string {
  return str.replace(/'/g, "'\\''");
}

/**
 * Spawn a process that needs TCC-protected resources (microphone, camera, etc.).
 *
 * **On macOS + PM2**: Uses `osascript` to launch the command via Terminal.app,
 * breaking the PM2 process chain. Terminal.app has its own TCC entry, so
 * child processes launched from it can access TCC-protected resources normally.
 *
 * **On other platforms**: Falls back to standard `child_process.spawn`.
 *
 * @example
 * ```typescript
 * // Record audio safely under PM2
 * const child = tccSafeSpawn({
 *   command: 'python3',
 *   args: ['record.py', '--duration', '5'],
 *   cwd: '/path/to/voice/scripts',
 * });
 * ```
 *
 * @note When using TCC-safe mode (osascript), stdio capture is limited.
 *       The process runs in a separate Terminal window, and the returned
 *       ChildProcess is the osascript process, not the actual command.
 *       For full output capture, use `createTccSafeScript()` + `open`.
 */
export function tccSafeSpawn(options: TccSafeSpawnOptions): ChildProcess {
  const shouldUseTccSafe = options.forceTccSafe || needsTccSafeSpawn();

  if (shouldUseTccSafe && isMacOS()) {
    logger.info(
      { command: options.command, args: options.args },
      'Detected macOS + PM2 environment — using TCC-safe spawn via Terminal.app'
    );
    return spawnViaTerminal(options);
  }

  // Standard spawn for non-PM2 or non-macOS environments
  return spawn(options.command, options.args || [], {
    cwd: options.cwd,
    env: options.env
      ? { ...process.env, ...options.env }
      : process.env,
  });
}

/**
 * Spawn a process via Terminal.app using osascript.
 *
 * This breaks the PM2 → node → claude process chain by launching the
 * command in a fresh Terminal.app context. Since Terminal.app has its
 * own TCC entry (user can grant microphone permission to Terminal),
 * the spawned process can access TCC-protected resources.
 *
 * @internal
 */
function spawnViaTerminal(options: TccSafeSpawnOptions): ChildProcess {
  // Build environment variable exports
  const envPrefix = options.env
    ? Object.entries(options.env)
        .map(([k, v]) => `export ${k}='${escapeBashSingle(v)}'`)
        .join(' && ') + ' && '
    : '';

  // Build working directory change
  const cwdPrefix = options.cwd
    ? `cd '${escapeBashSingle(options.cwd)}' && `
    : '';

  // Build the full shell command
  const cmdArgs = (options.args || []).map(a => `'${escapeBashSingle(a)}'`).join(' ');
  const fullCommand = `${cwdPrefix}${envPrefix}${options.command} ${cmdArgs}`.trim();

  // Escape for AppleScript string literal
  const escapedCommand = escapeAppleScriptString(fullCommand);
  const script = `tell application "Terminal" to do script "${escapedCommand}"`;

  logger.debug({ script }, 'TCC-safe spawn AppleScript');

  return spawn('osascript', ['-e', script], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

/**
 * Create a standalone shell script that can be executed outside the PM2
 * process chain to access TCC-protected resources.
 *
 * The generated script can be:
 * - Opened with `open script.sh` (launches in Terminal.app)
 * - Double-clicked in Finder
 * - Sourced from any TCC-clean process
 *
 * @example
 * ```typescript
 * const scriptPath = createTccSafeScript({
 *   command: 'python3',
 *   args: ['record.py'],
 *   cwd: '/path/to/project',
 *   outputPath: '/tmp/recording-output.txt',
 * });
 *
 * // Execute via Terminal.app
 * import { execSync } from 'child_process';
 * execSync(`open "${scriptPath}"`);
 * ```
 *
 * @returns The path to the generated shell script
 */
export function createTccSafeScript(options: TccSafeScriptOptions): string {
  const scriptDir = options.scriptDir || os.tmpdir();
  const scriptPath = path.join(scriptDir, `tcc-safe-${Date.now()}.sh`);

  const lines: string[] = [
    '#!/bin/bash',
    '# TCC-safe execution script (generated by @disclaude/core)',
    '# This script runs outside the PM2 process chain to access',
    '# TCC-protected resources (microphone, camera, etc.) on macOS.',
    '# See: https://github.com/hs3180/disclaude/issues/1957',
    '',
    `set -euo pipefail`,
    '',
  ];

  // Environment variables
  if (options.env && Object.keys(options.env).length > 0) {
    lines.push('# Environment variables');
    for (const [key, value] of Object.entries(options.env)) {
      lines.push(`export ${key}="${value.replace(/"/g, '\\"')}"`);
    }
    lines.push('');
  }

  // Working directory
  if (options.cwd) {
    lines.push(`cd "${options.cwd}"`);
    lines.push('');
  }

  // Command with optional output capture
  const cmdArgs = (options.args || []).map(a => `"${a.replace(/"/g, '\\"')}"`).join(' ');
  const fullCommand = `${options.command} ${cmdArgs}`.trim();

  if (options.outputPath) {
    lines.push(`# Redirect output to: ${options.outputPath}`);
    lines.push(`${fullCommand} > "${options.outputPath}" 2>&1`);
  } else {
    lines.push(fullCommand);
  }

  fs.writeFileSync(scriptPath, lines.join('\n') + '\n', { mode: 0o755 });
  logger.debug({ scriptPath }, 'Created TCC-safe helper script');

  return scriptPath;
}

/**
 * Remove a TCC-safe script file (cleanup utility).
 */
export function removeTccSafeScript(scriptPath: string): void {
  try {
    fs.unlinkSync(scriptPath);
    logger.debug({ scriptPath }, 'Removed TCC-safe helper script');
  } catch {
    // File may already be deleted or never created — ignore
  }
}
