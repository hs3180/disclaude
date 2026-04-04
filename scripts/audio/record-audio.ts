#!/usr/bin/env tsx
/**
 * audio/record-audio.ts — TCC-safe audio recording for macOS PM2 environments.
 *
 * When disclaude runs under PM2 on macOS, the TCC (Transparency, Consent, and
 * Control) system silently blocks microphone access for the entire process chain
 * because the node/PM2 ancestor process lacks microphone permission. Audio
 * recording returns all-zero data without any error or permission dialog.
 *
 * This script detects the PM2 process chain and, when detected, delegates
 * recording to an independent Terminal.app process via osascript, bypassing
 * the TCC restriction.
 *
 * See: https://github.com/hs3180/disclaude/issues/1957
 *
 * Environment variables:
 *   OUTPUT         (required) Output file path for the recorded audio (.wav)
 *   DURATION       (optional) Recording duration in seconds (default: 5)
 *   DEVICE         (optional) Audio device index for ffmpeg avfoundation (default: system default)
 *   NO_PM2_BYPASS  (optional) If "true", skip PM2 detection and record directly
 *
 * Exit codes:
 *   0 — success
 *   1 — validation error or recording failure
 *   2 — PM2/TCC detected but cannot bypass (non-macOS or osascript unavailable)
 *   3 — ffmpeg not found
 */

import { existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { execSync, execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

// ---- Types ----

export interface RecordAudioOptions {
  /** Output file path for the recorded audio */
  output: string;
  /** Recording duration in seconds (default: 5) */
  duration?: number;
  /** Audio device index for ffmpeg avfoundation input */
  device?: string;
  /** If true, skip PM2 detection and record directly */
  noPm2Bypass?: boolean;
}

export interface Pm2DetectionResult {
  /** Whether the current process is running under a PM2 chain */
  isUnderPm2: boolean;
  /** The platform (darwin, linux, win32) */
  platform: string;
  /** Human-readable description of the detection result */
  description: string;
}

// ---- Constants ----

const DEFAULT_DURATION = 5;
const MAX_DURATION = 3600; // 1 hour max
const WAIT_INTERVAL_MS = 500;
const WAIT_TIMEOUT_MULTIPLIER = 3; // Wait up to 3x duration for file to appear

// ---- Exit helper ----

function exit(code: number, msg: string): never {
  console.error(`ERROR: ${msg}`);
  process.exit(code);
}

// ---- PM2 Process Chain Detection ----

/**
 * Detect whether the current process is running under a PM2 process chain.
 *
 * On macOS, TCC checks the entire process ancestor chain. If any ancestor
 * is a PM2 node process without microphone permission, all descendants are
 * silently blocked from microphone access.
 *
 * Detection walks up the process tree via PPID, checking each ancestor's
 * command line for PM2-related patterns.
 */
export function detectPm2Chain(): Pm2DetectionResult {
  const platform = process.platform;

  // PM2/TCC issue is macOS-specific
  if (platform !== 'darwin') {
    return {
      isUnderPm2: false,
      platform,
      description: `Not macOS (${platform}) — PM2/TCC issue does not apply`,
    };
  }

  // Walk up the process tree
  let pid = process.pid;
  const maxDepth = 15;

  for (let depth = 0; depth < maxDepth && pid > 1; depth++) {
    try {
      // Read /proc-style or use ps command
      const ppid = getParentPid(pid);
      if (ppid <= 0 || ppid === pid) break;

      const cmdline = getProcessCommand(pid);
      if (isPm2Process(cmdline)) {
        return {
          isUnderPm2: true,
          platform,
          description: `PM2 process detected at PID ${pid}: ${cmdline}`,
        };
      }

      pid = ppid;
    } catch {
      // Process may have exited between checks
      break;
    }
  }

  return {
    isUnderPm2: false,
    platform,
    description: 'No PM2 process found in ancestor chain',
  };
}

/**
 * Get parent PID of a process. Uses /proc on Linux, ps on macOS.
 */
function getParentPid(pid: number): number {
  try {
    // Try /proc first (Linux)
    const stat = require('node:fs').readFileSync(`/proc/${pid}/stat`, 'utf-8');
    // Format: pid (comm) state ppid ...
    const match = stat.match(/\d+\s+\([^)]+\)\s+\w+\s+(\d+)/);
    if (match) return parseInt(match[1], 10);
  } catch {
    // Not Linux or /proc not available
  }

  try {
    // Fallback to ps command (macOS)
    const result = execSync(`ps -p ${pid} -o ppid=`, {
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    return parseInt(result.trim(), 10) || 0;
  } catch {
    return 0;
  }
}

/**
 * Get the command line of a process.
 */
function getProcessCommand(pid: number): string {
  try {
    const result = execSync(`ps -p ${pid} -o command=`, {
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    return result.trim();
  } catch {
    return '';
  }
}

/**
 * Check if a command line represents a PM2 process.
 */
function isPm2Process(cmdline: string): boolean {
  if (!cmdline) return false;
  const lower = cmdline.toLowerCase();
  return (
    lower.includes('pm2') ||
    lower.includes('god daemon') ||
    /node.*\.pm2/i.test(cmdline) ||
    /pm2-[a-z]/i.test(cmdline)
  );
}

// ---- FFmpeg Detection ----

/**
 * Check if ffmpeg is available in PATH.
 */
export function isFfmpegAvailable(): boolean {
  try {
    execSync('ffmpeg -version', {
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    return true;
  } catch {
    return false;
  }
}

// ---- Input Validation ----

export interface ValidationResult {
  valid: boolean;
  error?: string;
}

/**
 * Validate recording options.
 */
export function validateOptions(options: Partial<RecordAudioOptions>): ValidationResult {
  if (!options.output) {
    return { valid: false, error: 'OUTPUT is required' };
  }

  const outputDir = dirname(options.output);
  if (!existsSync(outputDir)) {
    return { valid: false, error: `Output directory '${outputDir}' does not exist` };
  }

  const duration = options.duration ?? DEFAULT_DURATION;
  if (!Number.isInteger(duration) || duration <= 0) {
    return { valid: false, error: `DURATION must be a positive integer, got ${duration}` };
  }
  if (duration > MAX_DURATION) {
    return { valid: false, error: `DURATION exceeds maximum (${MAX_DURATION}s)` };
  }

  return { valid: true };
}

// ---- FFmpeg Command Builder ----

/**
 * Build the ffmpeg command arguments for recording.
 */
export function buildFfmpegArgs(options: {
  duration: number;
  device?: string;
  output: string;
}): string[] {
  const args: string[] = [];

  // Input: avfoundation on macOS, alsa/pulseaudio on Linux
  if (process.platform === 'darwin') {
    args.push('-f', 'avfoundation');
    if (options.device) {
      args.push('-i', `:${options.device}`);
    } else {
      args.push('-i', ':default');
    }
  } else if (process.platform === 'linux') {
    args.push('-f', 'pulse');
    if (options.device) {
      args.push('-i', options.device);
    } else {
      args.push('-i', 'default');
    }
  } else {
    // Fallback: let ffmpeg auto-detect
    args.push('-i', options.device || 'default');
  }

  args.push('-t', String(options.duration));
  args.push('-y');
  args.push(options.output);

  return args;
}

/**
 * Build the osascript command for spawning recording in Terminal.app.
 * This bypasses the TCC restriction by running in an independent process context.
 */
export function buildOsascriptCommand(ffmpegArgs: string[]): string[] {
  // Escape and join ffmpeg args into a shell-safe string
  const ffmpegCmd = ['ffmpeg', ...ffmpegArgs]
    .map((arg) => `'${arg.replace(/'/g, "'\"'\"'")}'`)
    .join(' ');

  return [
    'osascript',
    '-e',
    `tell application "Terminal" to do script "${ffmpegCmd.replace(/"/g, '\\"')}"`,
  ];
}

// ---- Recording ----

/**
 * Wait for a file to appear on disk with timeout.
 */
function waitForFile(filePath: string, timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const check = () => {
      if (existsSync(filePath)) {
        resolve();
        return;
      }
      if (Date.now() - start > timeoutMs) {
        reject(new Error(`Recording timed out after ${timeoutMs}ms`));
        return;
      }
      setTimeout(check, WAIT_INTERVAL_MS);
    };
    check();
  });
}

/**
 * Record audio directly using ffmpeg (not under PM2).
 */
async function recordDirect(options: RecordAudioOptions): Promise<void> {
  const duration = options.duration ?? DEFAULT_DURATION;
  const args = buildFfmpegArgs({
    duration,
    device: options.device,
    output: options.output,
  });

  return new Promise((resolve, reject) => {
    const proc = spawn('ffmpeg', args, {
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let stderr = '';
    proc.stderr?.on('data', (data: Buffer) => {
      stderr += data.toString();
    });

    proc.on('close', (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`ffmpeg exited with code ${code}: ${stderr.slice(-200)}`));
      }
    });

    proc.on('error', (err) => {
      reject(new Error(`Failed to spawn ffmpeg: ${err.message}`));
    });
  });
}

/**
 * Record audio via Terminal.app osascript (bypasses PM2/TCC on macOS).
 */
async function recordViaTerminal(options: RecordAudioOptions): Promise<void> {
  const duration = options.duration ?? DEFAULT_DURATION;
  const ffmpegArgs = buildFfmpegArgs({
    duration,
    device: options.device,
    output: options.output,
  });
  const osascriptArgs = buildOsascriptCommand(ffmpegArgs);

  // Spawn osascript to launch recording in Terminal.app
  return new Promise((resolve, reject) => {
    const proc = spawn(osascriptArgs[0], osascriptArgs.slice(1), {
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let stderr = '';
    proc.stderr?.on('data', (data: Buffer) => {
      stderr += data.toString();
    });

    proc.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(`osascript exited with code ${code}: ${stderr}`));
        return;
      }

      // Wait for the recording file to appear
      const timeoutMs = duration * 1000 * WAIT_TIMEOUT_MULTIPLIER;
      waitForFile(options.output, timeoutMs).then(resolve).catch(reject);
    });

    proc.on('error', (err) => {
      reject(new Error(`Failed to spawn osascript: ${err.message}`));
    });
  });
}

// ---- Main ----

/**
 * Record audio with automatic PM2/TCC bypass on macOS.
 *
 * This is the primary entry point for programmatic use.
 */
export async function recordAudio(options: RecordAudioOptions): Promise<void> {
  // Validate
  const validation = validateOptions(options);
  if (!validation.valid) {
    throw new Error(validation.error);
  }

  // Check ffmpeg
  if (!isFfmpegAvailable()) {
    throw new Error('ffmpeg is required but not found in PATH');
  }

  // Detect PM2 chain
  const noPm2Bypass = options.noPm2Bypass ?? false;
  const detection = detectPm2Chain();

  if (detection.isUnderPm2 && !noPm2Bypass) {
    if (process.platform !== 'darwin') {
      throw new Error(
        'Running under PM2 but not on macOS — cannot bypass TCC. ' +
          'Set noPm2Bypass=true to attempt direct recording.'
      );
    }

    console.error(`WARN: ${detection.description}`);
    console.error('Using Terminal.app bypass for TCC-safe recording...');
    await recordViaTerminal(options);
  } else {
    await recordDirect(options);
  }
}

/**
 * CLI entry point — reads options from environment variables.
 */
async function main() {
  const output = process.env.OUTPUT;
  const duration = process.env.DURATION ? parseInt(process.env.DURATION, 10) : undefined;
  const device = process.env.DEVICE;
  const noPm2Bypass = process.env.NO_PM2_BYPASS === 'true';

  const options: RecordAudioOptions = {
    output: output ?? '',
    duration,
    device,
    noPm2Bypass,
  };

  try {
    await recordAudio(options);
    console.log(`OK: Recording saved to ${options.output}`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes('ffmpeg is required')) {
      exit(3, msg);
    }
    if (msg.includes('cannot bypass TCC')) {
      exit(2, msg);
    }
    exit(1, msg);
  }
}

// Only run main() when executed directly (not when imported for testing)
import { fileURLToPath as _fileURLToPath } from 'node:url';
const _isMain = process.argv[1] && resolve(process.argv[1]) === resolve(_fileURLToPath(import.meta.url));
if (_isMain) {
  main();
}
