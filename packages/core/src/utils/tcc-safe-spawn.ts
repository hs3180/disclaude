/**
 * TCC-Safe Process Spawning Utility (Issue #1957)
 *
 * Provides utilities for spawning TCC-sensitive processes (microphone, camera,
 * screen recording, etc.) outside the PM2 process chain on macOS.
 *
 * ## Background
 *
 * macOS TCC (Transparency, Consent, and Control) tracks the entire process
 * call chain. When running under PM2 fork mode, the PM2 node process lacks
 * microphone TCC permission, causing ALL child processes to be silently
 * blocked — returning empty data without errors or permission dialogs.
 *
 * ```
 * TCC check chain:
 *   python (requests mic)
 *     → zsh (Terminal.app, has TCC entry)
 *       → claude (child process)
 *         → node/PM2 (fork mode, no mic permission) ← ❌ chain breaks here
 * ```
 *
 * ## Solution
 *
 * This module provides `spawnTCCSafe()` which launches processes via
 * `osascript` in a Terminal.app context, creating an independent TCC
 * chain that bypasses PM2 restrictions.
 *
 * @module utils/tcc-safe-spawn
 */

import { spawn, type ChildProcess, type SpawnOptions } from 'child_process';
import { createLogger } from './logger.js';

const logger = createLogger('TccSafeSpawn');

/**
 * TCC-sensitive permission categories on macOS.
 */
export type TCCPermission = 'microphone' | 'camera' | 'screen-recording' | 'accessibility' | 'location';

/**
 * Result of a TCC environment check.
 */
export interface TCCEnvironmentInfo {
  /** Whether the current platform is macOS */
  isMacOS: boolean;
  /** Whether the process is running under PM2 */
  isPm2: boolean;
  /** PM2 process name if detected */
  pm2Name?: string;
  /** Whether TCC-safe spawning is available */
  tccSafeAvailable: boolean;
  /** Reason why TCC-safe spawning is not available (if applicable) */
  unavailableReason?: string;
}

/**
 * Options for TCC-safe process spawning.
 */
export interface TCCSafeSpawnOptions {
  /** TCC permission category this operation requires (for logging/auditing) */
  permission?: TCCPermission;
  /** Timeout in milliseconds (default: 30000) */
  timeout?: number;
  /** Working directory for the spawned process */
  cwd?: string;
  /** Environment variables for the spawned process */
  env?: Record<string, string>;
  /** Whether to log debug output (default: true) */
  debug?: boolean;
}

/**
 * Result of a TCC-safe spawn operation.
 */
export interface TCCSafeSpawnResult {
  /** Whether the operation was successful */
  success: boolean;
  /** Exit code of the spawned process (0 = success) */
  exitCode: number | null;
  /** Combined stdout + stderr output */
  output: string;
  /** Error message if failed */
  error?: string;
  /** Whether osascript fallback was used */
  usedTCCSafeMode: boolean;
}

/**
 * Check if the current platform is macOS.
 */
export function isMacOS(): boolean {
  return process.platform === 'darwin';
}

/**
 * Detect if the current process is running under PM2.
 *
 * PM2 sets the following environment variables:
 * - `PM2_HOME`: PM2 home directory
 * - `pm_id`: PM2 process ID
 * - `name`: PM2 app name (via `process.env.name`)
 * - `PM2_PROCESS_DESCRIPTION`: Process description
 * - `exec_interpreter`: Interpreter used
 */
export function detectPm2Environment(): { isPm2: boolean; name?: string } {
  // PM2 sets these environment variables
  const pmId = process.env.pm_id;
  const pm2Home = process.env.PM2_HOME;
  const pmUptime = process.env.pm_uptime;

  // Multiple indicators to avoid false positives
  const indicators = [pmId, pm2Home, pmUptime].filter(Boolean);
  const isPm2 = indicators.length >= 2;

  // Try to get PM2 app name
  const name = process.env.name || undefined;

  return { isPm2, name };
}

/**
 * Get comprehensive TCC environment information.
 *
 * Useful for diagnostics and deciding whether TCC-safe spawning is needed.
 */
export function getTCCEnvironmentInfo(): TCCEnvironmentInfo {
  const isMac = isMacOS();
  const pm2 = detectPm2Environment();

  if (!isMac) {
    return {
      isMacOS: false,
      isPm2: false,
      tccSafeAvailable: false,
      unavailableReason: 'TCC-safe spawning is only available on macOS',
    };
  }

  if (!pm2.isPm2) {
    return {
      isMacOS: true,
      isPm2: false,
      tccSafeAvailable: false,
      unavailableReason: 'Not running under PM2; direct process spawning is sufficient',
    };
  }

  // Check if osascript is available (should be on all macOS)
  // We can't synchronously check, so assume it's available
  return {
    isMacOS: true,
    isPm2: true,
    pm2Name: pm2.name,
    tccSafeAvailable: true,
  };
}

/**
 * Build an osascript command that launches a process in Terminal.app context.
 *
 * This creates an independent TCC chain because Terminal.app has its own
 * TCC permission entry, separate from the PM2 node process chain.
 *
 * @param command - The shell command to execute
 * @param cwd - Working directory (defaults to process.cwd())
 * @returns The osascript command and args
 */
function buildOsascriptCommand(command: string, cwd?: string): { command: string; args: string[] } {
  const workDir = cwd || process.cwd();

  // Use AppleScript to tell Terminal.app to run the command.
  // This creates a new Terminal tab with its own TCC chain.
  const script = [
    `tell application "Terminal"`,
    `  activate`,
    `  do script "cd ${escapeForAppleScript(workDir)} && ${escapeForAppleScript(command)}"`,
    `end tell`,
  ].join('\n');

  return {
    command: 'osascript',
    args: ['-e', script],
  };
}

/**
 * Escape a string for safe inclusion in AppleScript.
 *
 * Handles double quotes, backslashes, and other special characters.
 */
function escapeForAppleScript(str: string): string {
  return str
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\$/g, '\\$')
    .replace(/`/g, '\\`')
    .replace(/\n/g, '\\n');
}

/**
 * Spawn a process using standard Node.js child_process.
 *
 * Used as fallback when TCC-safe mode is not needed (e.g., not on macOS,
 * not running under PM2, or for non-TCC-sensitive operations).
 */
function spawnDirect(
  command: string,
  args: string[],
  options: TCCSafeSpawnOptions,
): Promise<TCCSafeSpawnResult> {
  return new Promise((resolve) => {
    const timeout = options.timeout ?? 30000;
    const spawnOpts: SpawnOptions = {
      cwd: options.cwd,
      env: { ...process.env, ...options.env },
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout,
    };

    if (options.debug !== false) {
      logger.debug({ command, args: args.slice(0, 3) }, 'Spawning direct process');
    }

    const child: ChildProcess = spawn(command, args, spawnOpts);
    let output = '';
    let killed = false;

    const timer = setTimeout(() => {
      killed = true;
      child.kill('SIGKILL');
      logger.warn({ command, timeout }, 'Process timed out');
    }, timeout);

    child.stdout?.on('data', (data: Buffer) => { output += data.toString(); });
    child.stderr?.on('data', (data: Buffer) => { output += data.toString(); });

    child.on('error', (err) => {
      clearTimeout(timer);
      resolve({
        success: false,
        exitCode: null,
        output,
        error: err.message,
        usedTCCSafeMode: false,
      });
    });

    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({
        success: code === 0 && !killed,
        exitCode: code,
        output,
        error: killed
          ? `Process timed out after ${timeout}ms`
          : code !== 0
            ? `Process exited with code ${code}`
            : undefined,
        usedTCCSafeMode: false,
      });
    });
  });
}

/**
 * Spawn a TCC-sensitive process using osascript in Terminal.app context.
 *
 * This bypasses the PM2 process chain by launching the process in a
 * Terminal.app tab, which has its own independent TCC permission entry.
 *
 * **Limitations:**
 * - Terminal.app must be accessible (not available in headless environments)
 * - The spawned process runs in a visible Terminal window
 * - Output collection relies on writing to a temp file
 *
 * @param command - The shell command to execute
 * @param args - Arguments for the command
 * @param options - Spawn options
 * @returns Spawn result with output and status
 */
function spawnViaOsascript(
  command: string,
  args: string[],
  options: TCCSafeSpawnOptions,
): Promise<TCCSafeSpawnResult> {
  return new Promise((resolve) => {
    const timeout = options.timeout ?? 30000;

    // Build the full command string
    const fullCommand = [command, ...args].join(' ');

    // For output capture, we redirect to a temp file
    import('fs').then(fs => {
      const os = require('os') as { tmpdir: () => string };
      const path = require('path') as { join: (...args: string[]) => string };
      import('crypto').then(crypto => {
        const outputFile = path.join(os.tmpdir(), `tcc-safe-${crypto.randomBytes(8).toString('hex')}.txt`);

        // Wrap command with output redirection
        const wrappedCommand = `${fullCommand} > "${escapeForAppleScript(outputFile)}" 2>&1; echo $? > "${escapeForAppleScript(outputFile)}.exit"`;

        const { command: osaCmd, args: osaArgs } = buildOsascriptCommand(wrappedCommand, options.cwd);

        if (options.debug !== false) {
          logger.debug({ command: fullCommand }, 'Spawning TCC-safe process via osascript');
        }

        const child: ChildProcess = spawn(osaCmd, osaArgs, {
          env: { ...process.env, ...options.env },
          stdio: ['pipe', 'pipe', 'pipe'],
        });

        let osaOutput = '';

        const timer = setTimeout(() => {
          child.kill('SIGKILL');
          // Clean up temp files
          try { fs.default.unlinkSync(outputFile); } catch { /* ignore */ }
          try { fs.default.unlinkSync(`${outputFile}.exit`); } catch { /* ignore */ }
          logger.warn({ command: fullCommand, timeout }, 'TCC-safe process timed out');
          resolve({
            success: false,
            exitCode: null,
            output: osaOutput,
            error: `Process timed out after ${timeout}ms`,
            usedTCCSafeMode: true,
          });
        }, timeout);

        child.stdout?.on('data', (data: Buffer) => { osaOutput += data.toString(); });
        child.stderr?.on('data', (data: Buffer) => { osaOutput += data.toString(); });

        child.on('error', (err) => {
          clearTimeout(timer);
          try { fs.default.unlinkSync(outputFile); } catch { /* ignore */ }
          try { fs.default.unlinkSync(`${outputFile}.exit`); } catch { /* ignore */ }
          resolve({
            success: false,
            exitCode: null,
            output: osaOutput,
            error: `osascript failed: ${err.message}`,
            usedTCCSafeMode: true,
          });
        });

        child.on('close', (code) => {
          clearTimeout(timer);

          // Poll for output file with timeout
          const startTime = Date.now();
          const pollInterval = 200;
          const pollTimeout = 5000;

          const poll = () => {
            try {
              const output = fs.default.readFileSync(outputFile, 'utf-8');
              let exitCode: number | null = null;

              try {
                const exitContent = fs.default.readFileSync(`${outputFile}.exit`, 'utf-8').trim();
                exitCode = parseInt(exitContent, 10);
              } catch {
                exitCode = code;
              }

              // Clean up temp files
              try { fs.default.unlinkSync(outputFile); } catch { /* ignore */ }
              try { fs.default.unlinkSync(`${outputFile}.exit`); } catch { /* ignore */ }

              resolve({
                success: exitCode === 0,
                exitCode,
                output,
                error: exitCode !== 0 ? `Process exited with code ${exitCode}` : undefined,
                usedTCCSafeMode: true,
              });
            } catch {
              // File not ready yet, keep polling
              if (Date.now() - startTime > pollTimeout) {
                try { fs.default.unlinkSync(outputFile); } catch { /* ignore */ }
                try { fs.default.unlinkSync(`${outputFile}.exit`); } catch { /* ignore */ }
                resolve({
                  success: false,
                  exitCode: code,
                  output: osaOutput,
                  error: 'Timed out waiting for output file from TCC-safe process',
                  usedTCCSafeMode: true,
                });
              } else {
                setTimeout(poll, pollInterval);
              }
            }
          };

          // Start polling after a short delay to let the command execute
          setTimeout(poll, 500);
        });
      });
    });
  });
}

/**
 * Spawn a process with TCC-safe handling on macOS/PM2.
 *
 * This is the main entry point. It automatically detects the environment
 * and chooses the appropriate spawning strategy:
 *
 * - **macOS + PM2**: Uses `osascript` to spawn in Terminal.app context
 *   (bypasses PM2 TCC chain)
 * - **Other environments**: Uses standard `child_process.spawn`
 *
 * @param command - The command to execute
 * @param args - Command arguments
 * @param options - Spawn options
 * @returns Promise resolving to spawn result
 *
 * @example
 * ```typescript
 * const result = await spawnTCCSafe('python3', ['record_audio.py', '--output', 'recording.wav'], {
 *   permission: 'microphone',
 *   timeout: 60000,
 * });
 *
 * if (result.success) {
 *   console.log('Recording saved successfully');
 * } else {
 *   console.error('Recording failed:', result.error);
 * }
 * ```
 */
export async function spawnTCCSafe(
  command: string,
  args: string[] = [],
  options: TCCSafeSpawnOptions = {},
): Promise<TCCSafeSpawnResult> {
  const envInfo = getTCCEnvironmentInfo();

  if (envInfo.tccSafeAvailable) {
    logger.info(
      {
        command,
        permission: options.permission,
        pm2Name: envInfo.pm2Name,
      },
      'Using TCC-safe spawn (osascript) to bypass PM2 TCC chain',
    );
    return spawnViaOsascript(command, args, options);
  }

  if (envInfo.unavailableReason && options.debug !== false) {
    logger.debug(
      {
        command,
        reason: envInfo.unavailableReason,
      },
      'Using direct spawn (TCC-safe not needed)',
    );
  }

  return spawnDirect(command, args, options);
}

/**
 * Check microphone TCC permission status on macOS.
 *
 * Uses Swift's AVCaptureDevice API to check permission without triggering
 * a permission dialog. This is a diagnostic tool — it will NOT request
 * permission, only report the current status.
 *
 * @returns Promise resolving to permission status
 *
 * @example
 * ```typescript
 * const status = await checkMicrophonePermission();
 * // { status: 'denied', reason: 'PM2 process chain lacks TCC permission' }
 * ```
 */
export async function checkMicrophonePermission(): Promise<{
  status: 'granted' | 'denied' | 'unknown' | 'unsupported';
  detail?: string;
}> {
  if (!isMacOS()) {
    return { status: 'unsupported', detail: 'Microphone permission check is only available on macOS' };
  }

  return new Promise((resolve) => {
    // Use a small Swift snippet to check AVCaptureDevice authorization status
    const swiftCode = `
import AVFoundation
let status = AVCaptureDevice.authorizationStatus(for: .audio)
switch status {
case .authorized: print("granted")
case .denied: print("denied")
case .restricted: print("restricted")
case .notDetermined: print("not_determined")
@unknown default: print("unknown")
}
`;

    const child = spawn('swift', ['-e', swiftCode], {
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: 10000,
    });

    let output = '';
    let error = '';

    child.stdout?.on('data', (data: Buffer) => { output += data.toString().trim(); });
    child.stderr?.on('data', (data: Buffer) => { error += data.toString().trim(); });

    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      resolve({ status: 'unknown', detail: 'Permission check timed out' });
    }, 10000);

    child.on('close', () => {
      clearTimeout(timer);

      if (error) {
        resolve({ status: 'unknown', detail: error });
        return;
      }

      switch (output) {
        case 'granted':
          resolve({ status: 'granted' });
          break;
        case 'denied':
          resolve({
            status: 'denied',
            detail: 'Microphone permission denied. If running under PM2, this may be due to TCC process chain restrictions (see Issue #1957)',
          });
          break;
        case 'restricted':
          resolve({ status: 'denied', detail: 'Microphone access restricted (possibly by MDM policy)' });
          break;
        case 'not_determined':
          resolve({ status: 'unknown', detail: 'Microphone permission not yet requested' });
          break;
        default:
          resolve({ status: 'unknown', detail: `Unexpected output: ${output}` });
      }
    });

    child.on('error', (err) => {
      clearTimeout(timer);
      resolve({ status: 'unknown', detail: `Failed to check permission: ${err.message}` });
    });
  });
}

/**
 * Diagnose TCC-related microphone issues.
 *
 * Performs a comprehensive check of the TCC environment and microphone
 * permission status, providing actionable recommendations.
 *
 * @returns Diagnostic report
 */
export async function diagnoseTCCMicrophoneIssue(): Promise<{
  environment: TCCEnvironmentInfo;
  microphone: Awaited<ReturnType<typeof checkMicrophonePermission>>;
  recommendations: string[];
}> {
  const environment = getTCCEnvironmentInfo();
  const recommendations: string[] = [];

  // Check microphone permission
  const microphone = await checkMicrophonePermission();

  // Generate recommendations based on findings
  if (environment.isPm2 && environment.isMacOS) {
    if (microphone.status === 'denied') {
      recommendations.push(
        '🔴 CRITICAL: Microphone permission is denied. This is likely caused by PM2 TCC chain restriction.',
        '',
        'Fix options:',
        '1. Use spawnTCCSafe() to launch audio recording outside the PM2 process chain',
        '2. Grant microphone permission to Terminal.app in System Settings > Privacy & Security > Microphone',
        '3. Run the bot outside PM2 for audio features (e.g., using launchd or direct node)',
      );
    } else if (microphone.status === 'granted') {
      recommendations.push(
        '✅ Microphone permission is granted. TCC is not blocking access.',
        '',
        'Note: If you still get empty audio data, the issue may be elsewhere (hardware, audio driver, etc.)',
      );
    }
  } else if (!environment.isMacOS) {
    recommendations.push(
      'ℹ️ TCC is a macOS-only feature. Microphone access on this platform uses different permission systems.',
    );
  } else if (!environment.isPm2) {
    recommendations.push(
      '✅ Not running under PM2. TCC chain restrictions do not apply.',
      '   Standard microphone access should work normally.',
    );
  }

  return { environment, microphone, recommendations };
}
