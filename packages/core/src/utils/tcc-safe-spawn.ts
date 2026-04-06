/**
 * TCC-safe process spawning utility for macOS.
 *
 * When running under PM2 on macOS, the TCC (Transparency, Consent, and Control)
 * system silently denies access to protected resources (microphone, camera, etc.)
 * for child processes in the PM2 process chain. This utility detects such
 * environments and provides workarounds by spawning commands in a
 * Terminal.app context via osascript.
 *
 * @see {@link https://github.com/hs3180/disclaude/issues/1957}
 *
 * Root cause:
 *   PM2(node/PID) → claude → zsh → python
 *   TCC traces the full process chain. When an ancestor process (PM2's node)
 *   lacks microphone TCC permission, ALL descendant processes are silently
 *   blocked — no error, no permission dialog, just empty data.
 *
 * Solution:
 *   Detect PM2 environment and use `osascript` to spawn commands directly
 *   in Terminal.app context, bypassing the PM2 process chain entirely.
 */

import {
  spawn,
  execFile,
  execFileSync,
  type ChildProcess,
  type SpawnOptions,
} from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const execFileAsync = promisify(execFile);

// ─── Types ────────────────────────────────────────────────────────────────────

/**
 * TCC-protected resource types on macOS.
 */
export type TCCResource = 'microphone' | 'camera' | 'screen' | 'accessibility' | 'location';

/**
 * Options for TCC-safe spawn.
 */
export interface TccSafeSpawnOptions extends SpawnOptions {
  /**
   * The TCC-protected resource this command needs access to.
   * If not specified, the utility will still detect PM2 but won't
   * apply the osascript workaround unless the process tree requires it.
   */
  tccResource?: TCCResource;
  /**
   * Force the use of osascript workaround even if not under PM2.
   * Useful for testing or when you know TCC will be an issue.
   * @default false
   */
  forceOsascript?: boolean;
  /**
   * Timeout in milliseconds for the osascript command itself.
   * @default 30000
   */
  osascriptTimeout?: number;
}

/**
 * Options for TCC-safe exec.
 */
export interface TccSafeExecOptions {
  /**
   * The TCC-protected resource this command needs access to.
   */
  tccResource?: TCCResource;
  /**
   * Force the use of osascript workaround.
   * @default false
   */
  forceOsascript?: boolean;
  /**
   * Timeout in milliseconds.
   * @default 60000
   */
  timeout?: number;
  /**
   * Current working directory.
   */
  cwd?: string;
  /**
   * Environment variables.
   */
  env?: NodeJS.ProcessEnv;
}

/**
 * Result of PM2 detection.
 */
export interface PM2DetectionResult {
  /** Whether the current process is running under PM2 */
  isUnderPM2: boolean;
  /** The PID of the PM2 ancestor process, if found */
  pm2Pid?: number;
  /** The depth of the PM2 ancestor in the process tree */
  pm2Depth?: number;
}

// ─── Platform detection ───────────────────────────────────────────────────────

/**
 * Check if the current platform is macOS (Darwin).
 */
export function isMacOS(): boolean {
  return process.platform === 'darwin';
}

// ─── PM2 detection ────────────────────────────────────────────────────────────

/** Cache for PM2 detection result */
let pm2DetectionCache: PM2DetectionResult | null = null;

/**
 * Detect whether the current process is running under PM2 management.
 *
 * This works by walking up the process tree (via `ps -o ppid=`)
 * and checking each ancestor for the PM2 process name pattern.
 *
 * @param forceRefresh - Ignore cached result and re-detect
 * @returns Detection result with PM2 status and process details
 */
export function isUnderPM2(forceRefresh = false): PM2DetectionResult {
  if (!forceRefresh && pm2DetectionCache !== null) {
    return pm2DetectionCache;
  }

  const result: PM2DetectionResult = { isUnderPM2: false };

  if (!isMacOS()) {
    pm2DetectionCache = result;
    return result;
  }

  try {
    let currentPid = process.pid;
    let depth = 0;
    const maxDepth = 20; // Safety limit for process tree walking

    while (currentPid > 1 && depth < maxDepth) {
      try {
        const ppid = getParentPid(currentPid);
        if (ppid === null || ppid <= 0) break;

        // Check if this ancestor is a PM2 process
        const procName = getProcessName(ppid);
        if (procName !== null && isPM2Process(procName)) {
          result.isUnderPM2 = true;
          result.pm2Pid = ppid;
          result.pm2Depth = depth;
          break;
        }

        currentPid = ppid;
        depth++;
      } catch {
        // Process no longer exists or permission denied
        break;
      }
    }
  } catch {
    // ps command failed — assume not under PM2
  }

  pm2DetectionCache = result;
  return result;
}

/**
 * Get the parent PID of a process.
 */
function getParentPid(pid: number): number | null {
  try {
    const stdout = execFileSync('/bin/ps', ['-o', 'ppid=', '-p', String(pid)], {
      encoding: 'utf-8',
      timeout: 5000,
    });
    const ppid = parseInt(stdout.trim(), 10);
    return isNaN(ppid) ? null : ppid;
  } catch {
    return null;
  }
}

/**
 * Get the process name for a given PID.
 */
function getProcessName(pid: number): string | null {
  try {
    const stdout = execFileSync('/bin/ps', ['-o', 'comm=', '-p', String(pid)], {
      encoding: 'utf-8',
      timeout: 5000,
    });
    return stdout.trim() || null;
  } catch {
    return null;
  }
}

/**
 * Check if a process name matches PM2 patterns.
 *
 * PM2 God Daemon runs as `PM2 vX.X.X: God Daemon` or similar.
 */
function isPM2Process(procName: string): boolean {
  const name = procName.toLowerCase();
  return name.includes('pm2') || name.includes('god daemon');
}

/**
 * Reset the PM2 detection cache. Useful for testing.
 */
export function resetPM2DetectionCache(): void {
  pm2DetectionCache = null;
}

// ─── TCC-safe spawn ──────────────────────────────────────────────────────────

/**
 * Spawn a command in a TCC-safe manner.
 *
 * On macOS under PM2, this uses `osascript` to launch the command in
 * Terminal.app context, bypassing TCC restrictions from the PM2 process chain.
 * On other platforms or when not under PM2, this behaves like a normal `spawn`.
 *
 * @param command - The command to execute
 * @param args - Arguments for the command
 * @param options - Spawn options including TCC resource specification
 * @returns ChildProcess instance
 *
 * @example
 * ```typescript
 * // Record audio safely under PM2
 * const child = tccSafeSpawn('python3', ['record.py', '--output', '/tmp/audio.wav'], {
 *   tccResource: 'microphone',
 * });
 * ```
 */
export function tccSafeSpawn(
  command: string,
  args: string[],
  options: TccSafeSpawnOptions = {},
): ChildProcess {
  const {
    tccResource: _tccResource,
    forceOsascript = false,
    osascriptTimeout = 30000,
    ...spawnOptions
  } = options;

  void _tccResource; // Used for documentation/future TCC resource validation

  const needsWorkaround = forceOsascript || (isMacOS() && isUnderPM2().isUnderPM2);

  if (!needsWorkaround) {
    return spawn(command, args, spawnOptions);
  }

  // Build the shell command that will run in Terminal.app
  const fullCommand = buildShellCommand(command, args, {
    cwd: typeof spawnOptions.cwd === 'string' ? spawnOptions.cwd : undefined,
    env: spawnOptions.env,
  });

  // Use osascript to run in Terminal.app context
  const osascriptArgs = [
    '-e',
    `tell application "Terminal" to do script "${escapeAppleScriptString(fullCommand)}"`,
  ];

  return spawn('osascript', osascriptArgs, {
    timeout: osascriptTimeout,
    ...spawnOptions,
  });
}

/**
 * Execute a command in a TCC-safe manner and collect its output.
 *
 * This is the exec-style counterpart to `tccSafeSpawn`. It waits for
 * the command to complete and returns stdout/stderr.
 *
 * @param command - The command to execute
 * @param args - Arguments for the command
 * @param options - Exec options including TCC resource specification
 * @returns Promise resolving to { stdout, stderr }
 *
 * @example
 * ```typescript
 * // Get microphone access test output safely
 * const { stdout } = await tccSafeExec('python3', ['mic_test.py'], {
 *   tccResource: 'microphone',
 *   timeout: 10000,
 * });
 * ```
 */
export async function tccSafeExec(
  command: string,
  args: string[],
  options: TccSafeExecOptions = {},
): Promise<{ stdout: string; stderr: string }> {
  const { tccResource: _tccResource, forceOsascript = false, timeout = 60000, cwd, env } = options;

  void _tccResource; // Used for documentation/future TCC resource validation

  const needsWorkaround = forceOsascript || (isMacOS() && isUnderPM2().isUnderPM2);

  if (!needsWorkaround) {
    return execFileAsync(command, args, { timeout, cwd, env });
  }

  // For osascript mode, we can't directly capture stdout from Terminal.app.
  // Use temp files to capture output.
  const outputFile = path.join(
    os.tmpdir(),
    `tcc-safe-${Date.now()}-${Math.random().toString(36).slice(2)}.txt`,
  );
  const errorFile = path.join(
    os.tmpdir(),
    `tcc-safe-err-${Date.now()}-${Math.random().toString(36).slice(2)}.txt`,
  );

  try {
    const fullCommand = buildShellCommand(command, args, { cwd, env });
    const wrappedCommand = `${fullCommand} > "${outputFile}" 2> "${errorFile}"`;

    await execFileAsync('osascript', [
      '-e',
      `tell application "Terminal" to do script "${escapeAppleScriptString(wrappedCommand)}"`,
    ], { timeout });

    // Brief delay for the spawned command to start writing
    await new Promise(resolve => setTimeout(resolve, 1000));

    const stdout = fs.existsSync(outputFile) ? fs.readFileSync(outputFile, 'utf-8') : '';
    const stderr = fs.existsSync(errorFile) ? fs.readFileSync(errorFile, 'utf-8') : '';

    return { stdout, stderr };
  } finally {
    // Clean up temp files
    try { fs.unlinkSync(outputFile); } catch { /* ignore cleanup errors */ }
    try { fs.unlinkSync(errorFile); } catch { /* ignore cleanup errors */ }
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Build a shell command string from command, args, and options.
 */
function buildShellCommand(
  command: string,
  args: string[],
  options: { cwd?: string; env?: NodeJS.ProcessEnv },
): string {
  const parts = [command, ...args.map(a => `'${a.replace(/'/g, "'\\''")}'`)];
  let cmd = parts.join(' ');

  if (options.cwd) {
    cmd = `cd '${options.cwd}' && ${cmd}`;
  }

  // Export relevant environment variables
  if (options.env) {
    const envExports = Object.entries(options.env)
      .filter(([key]) => key !== 'PATH') // Don't override PATH
      .map(([key, value]) => `export ${key}='${String(value).replace(/'/g, "'\\''")}'`)
      .join('; ');
    if (envExports) {
      cmd = `${envExports} && ${cmd}`;
    }
  }

  return cmd;
}

/**
 * Escape a string for safe use in an AppleScript string literal.
 */
function escapeAppleScriptString(str: string): string {
  return str
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"');
}
