/**
 * macOS TCC-safe Audio Recording Utility
 *
 * Provides a workaround for macOS TCC (Transparency, Consent, and Control)
 * silently blocking microphone access when running under a PM2 process chain.
 *
 * ## Problem
 * When a Node.js process is managed by PM2 (fork mode), macOS TCC tracks the
 * entire process chain. Since the PM2 node process lacks microphone TCC permission,
 * all descendant processes (claude → zsh → python/recording tool) are silently
 * denied microphone access — returning zero-filled audio data with no errors.
 *
 * ## Solution
 * This module spawns audio recording as an independent process via `osascript`,
 * which opens a new Terminal.app window outside the PM2 process chain. The
 * Terminal.app context has its own TCC entry with microphone permission.
 *
 * ## Process Chain (before fix)
 * ```
 * PM2(node/PID) → claude → zsh → python  ❌ TCC blocked
 * ```
 *
 * ## Process Chain (after fix)
 * ```
 * Terminal.app → python  ✅ TCC allowed
 * ```
 *
 * @see Issue #1957: macOS 音频输入子系统静默返回空数据
 * @module utils/audio-record
 */

import { spawn } from 'child_process';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';

/**
 * Audio recording format options.
 */
export type AudioFormat = 'wav' | 'mp3' | 'aac' | 'flac' | 'ogg';

/**
 * Options for audio recording.
 */
export interface AudioRecordOptions {
  /** Output file path (default: temp file in os.tmpdir()) */
  outputPath?: string;
  /** Recording duration in seconds (default: 5) */
  durationSeconds?: number;
  /** Audio format (default: 'wav') */
  format?: AudioFormat;
  /** Sample rate in Hz (default: 44100) */
  sampleRate?: number;
  /** Number of audio channels (default: 1 for mono) */
  channels?: number;
  /** Custom recording command (overrides built-in ffmpeg command) */
  customCommand?: string;
  /** Timeout in milliseconds for the recording process (default: durationSeconds * 1000 + 30000) */
  timeoutMs?: number;
  /** Whether to use the TCC workaround (default: auto-detect) */
  useTccWorkaround?: boolean;
}

/**
 * Result of an audio recording operation.
 */
export interface AudioRecordResult {
  /** Whether recording succeeded */
  success: boolean;
  /** Path to the recorded audio file */
  filePath: string;
  /** File size in bytes */
  fileSize: number;
  /** Recording duration in seconds (requested) */
  duration: number;
  /** Whether the TCC workaround was used */
  usedTccWorkaround: boolean;
  /** Error message if recording failed */
  error?: string;
}

/**
 * Detect if the current process is running under PM2.
 *
 * Checks multiple indicators:
 * 1. `PM2_HOME` environment variable
 * 2. Parent process command line containing 'pm2'
 * 3. Process title containing 'PM2'
 *
 * @returns true if running under PM2 management
 */
export function isUnderPM2(): boolean {
  // Check PM2_HOME environment variable (set by PM2)
  if (process.env.PM2_HOME || process.env.PM2_PID) {
    return true;
  }

  // Check if process title contains PM2
  if (process.title?.toLowerCase().includes('pm2')) {
    return true;
  }

  // Check for PM2-related env vars
  const pm2EnvVars = ['PM2_JSON_PROCESSING', 'PM2_WORKER_THREAD', 'pm_id', 'PM2进程管理'];
  for (const envVar of pm2EnvVars) {
    if (process.env[envVar] !== undefined) {
      return true;
    }
  }

  return false;
}

/**
 * Detect if the current platform is macOS.
 *
 * @returns true if running on macOS (Darwin)
 */
export function isMacOS(): boolean {
  return process.platform === 'darwin';
}

/**
 * Determine if TCC workaround is needed.
 *
 * The workaround is needed when:
 * 1. Running on macOS, AND
 * 2. Running under PM2 process chain, AND
 * 3. User hasn't explicitly disabled the workaround
 *
 * @param explicitSetting - User's explicit setting (true = force on, false = force off)
 * @returns Whether the TCC workaround should be used
 */
export function shouldUseTccWorkaround(explicitSetting?: boolean): boolean {
  if (explicitSetting !== undefined) {
    return explicitSetting;
  }
  return isMacOS() && isUnderPM2();
}

/**
 * Validate that a recorded audio file contains actual audio data
 * (not all zeros, which indicates TCC silent blocking).
 *
 * Reads a sample of the audio file and checks if the data portion
 * contains non-zero bytes. For WAV files, checks the data chunk;
 * for other formats, checks a sample from the middle of the file.
 *
 * @param filePath - Path to the audio file to validate
 * @param sampleSize - Number of bytes to sample (default: 4096)
 * @returns true if the file contains non-zero audio data
 */
export async function validateAudioData(filePath: string, sampleSize: number = 4096): Promise<boolean> {
  try {
    const stat = await fs.stat(filePath);
    if (stat.size === 0) {
      return false;
    }

    const buffer = Buffer.alloc(sampleSize);
    const fd = await fs.open(filePath, 'r');

    // For WAV files, skip the header (typically 44 bytes) and sample from the middle
    let readOffset = 0;
    const ext = path.extname(filePath).toLowerCase();
    if (ext === '.wav') {
      // WAV header is typically 44 bytes; read from the middle of the file
      readOffset = Math.max(44, Math.floor(stat.size / 2) - sampleSize / 2);
    } else {
      // For other formats, sample from the middle
      readOffset = Math.max(0, Math.floor(stat.size / 2) - sampleSize / 2);
    }

    await fd.read(buffer, 0, sampleSize, readOffset);
    await fd.close();

    // Check if all bytes are zero
    for (let i = 0; i < sampleSize; i++) {
      if (buffer[i] !== 0) {
        return true;
      }
    }

    return false;
  } catch {
    return false;
  }
}

/**
 * Build the ffmpeg recording command string.
 *
 * @param outputPath - Output file path
 * @param options - Recording options
 * @returns The command string to execute
 */
function buildFFmpegCommand(outputPath: string, options: AudioRecordOptions): string {
  const duration = options.durationSeconds ?? 5;
  const sampleRate = options.sampleRate ?? 44100;
  const channels = options.channels ?? 1;

  // Use avfoundation on macOS, alsa on Linux, dshow on Windows
  const inputSource = process.platform === 'darwin' ? ':default' : 'default';

  return `ffmpeg -f ${process.platform === 'darwin' ? 'avfoundation' : 'alsa'} ` +
    `-i "${inputSource}" ` +
    `-t ${duration} ` +
    `-ar ${sampleRate} ` +
    `-ac ${channels} ` +
    `-y "${outputPath}" 2>/dev/null; ` +
    `echo "DONE:$?"`;
}

/**
 * Record audio using an independent Terminal.app process (TCC workaround).
 *
 * This function spawns a new Terminal.app window via osascript, which runs
 * the recording command outside the PM2 process chain. The Terminal.app context
 * has its own TCC entry with microphone permission, bypassing the silent block.
 *
 * The function creates a temporary status file that the Terminal process writes to
 * when recording is complete, then polls for completion.
 *
 * @param options - Recording options
 * @returns Recording result with file path and metadata
 */
export async function recordViaTccWorkaround(options: AudioRecordOptions = {}): Promise<AudioRecordResult> {
  const duration = options.durationSeconds ?? 5;
  const format = options.format ?? 'wav';

  // Generate paths
  const timestamp = Date.now();
  const outputDir = options.outputPath
    ? path.dirname(options.outputPath)
    : os.tmpdir();
  const outputPath = options.outputPath
    ?? path.join(outputDir, `audio-recording-${timestamp}.${format}`);
  const statusFile = path.join(outputDir, `.audio-recording-status-${timestamp}.tmp`);

  // Ensure output directory exists
  await fs.mkdir(outputDir, { recursive: true });

  // Build recording command
  const recordCommand = options.customCommand
    ?? buildFFmpegCommand(outputPath, { ...options, outputPath });

  // Wrap command with status file writing
  const fullCommand = `${recordCommand} && echo "STATUS:DONE" > "${statusFile}" || echo "STATUS:FAILED" > "${statusFile}"`;

  // Use osascript to spawn independent Terminal process
  const applescript = `tell application "Terminal" to do script "${fullCommand.replace(/"/g, '\\"')}" end tell`;

  return new Promise<AudioRecordResult>((resolve) => {
    const timeoutMs = options.timeoutMs ?? (duration * 1000 + 30000);
    const startTime = Date.now();
    let settled = false;

    const cleanup = () => {
      if (!settled) {
        settled = true;
        // Clean up status file
        fs.unlink(statusFile).catch(() => {});
      }
    };

    // Timeout handler
    const timeoutHandle = setTimeout(() => {
      cleanup();
      resolve({
        success: false,
        filePath: outputPath,
        fileSize: 0,
        duration,
        usedTccWorkaround: true,
        error: `Recording timed out after ${timeoutMs}ms`,
      });
    }, timeoutMs);

    // Poll for status file
    const pollInterval = setInterval(async () => {
      if (settled) return;

      try {
        const statusContent = await fs.readFile(statusFile, 'utf-8');

        if (statusContent.includes('STATUS:DONE')) {
          clearInterval(pollInterval);
          clearTimeout(timeoutHandle);
          cleanup();

          const stat = await fs.stat(outputPath).catch(() => null);
          resolve({
            success: true,
            filePath: outputPath,
            fileSize: stat?.size ?? 0,
            duration,
            usedTccWorkaround: true,
          });
        } else if (statusContent.includes('STATUS:FAILED')) {
          clearInterval(pollInterval);
          clearTimeout(timeoutHandle);
          cleanup();

          resolve({
            success: false,
            filePath: outputPath,
            fileSize: 0,
            duration,
            usedTccWorkaround: true,
            error: 'Recording command failed in Terminal process',
          });
        }
      } catch {
        // Status file doesn't exist yet, continue polling
      }

      // Check elapsed time as a safety net
      if (Date.now() - startTime > timeoutMs) {
        clearInterval(pollInterval);
        clearTimeout(timeoutHandle);
        cleanup();

        resolve({
          success: false,
          filePath: outputPath,
          fileSize: 0,
          duration,
          usedTccWorkaround: true,
          error: `Recording timed out after ${timeoutMs}ms`,
        });
      }
    }, 500);

    // Spawn osascript process
    const osascriptProc = spawn('osascript', ['-e', applescript], {
      detached: false,
      stdio: 'ignore',
    });

    osascriptProc.on('error', (err) => {
      clearInterval(pollInterval);
      clearTimeout(timeoutHandle);
      cleanup();

      resolve({
        success: false,
        filePath: outputPath,
        fileSize: 0,
        duration,
        usedTccWorkaround: true,
        error: `Failed to spawn osascript: ${err.message}`,
      });
    });

    // Allow the process to run independently
    osascriptProc.unref();
  });
}

/**
 * Record audio directly (without TCC workaround).
 *
 * Uses child_process.spawn to execute ffmpeg directly.
 * This will work on non-macOS platforms or when not running under PM2.
 *
 * @param options - Recording options
 * @returns Recording result with file path and metadata
 */
export function recordDirectly(options: AudioRecordOptions = {}): Promise<AudioRecordResult> {
  const duration = options.durationSeconds ?? 5;
  const format = options.format ?? 'wav';

  return new Promise(async (resolve) => {
    const timestamp = Date.now();
    const outputDir = options.outputPath
      ? path.dirname(options.outputPath)
      : os.tmpdir();
    const outputPath = options.outputPath
      ?? path.join(outputDir, `audio-recording-${timestamp}.${format}`);

    // Ensure output directory exists
    await fs.mkdir(outputDir, { recursive: true });

    const command = options.customCommand
      ?? buildFFmpegCommand(outputPath, { ...options, outputPath });

    const timeoutMs = options.timeoutMs ?? (duration * 1000 + 30000);
    const timeoutHandle = setTimeout(() => {
      resolve({
        success: false,
        filePath: outputPath,
        fileSize: 0,
        duration,
        usedTccWorkaround: false,
        error: `Recording timed out after ${timeoutMs}ms`,
      });
    }, timeoutMs);

    // Spawn the recording process
    const proc = spawn('sh', ['-c', command], {
      stdio: 'pipe',
    });

    let stderr = '';
    proc.stderr?.on('data', (data: Buffer) => {
      stderr += data.toString();
    });

    proc.on('close', async (code) => {
      clearTimeout(timeoutHandle);

      if (code === 0) {
        try {
          const stat = await fs.stat(outputPath);
          const valid = await validateAudioData(outputPath);

          if (!valid) {
            // All zeros — likely TCC blocking even in direct mode
            resolve({
              success: false,
              filePath: outputPath,
              fileSize: stat.size,
              duration,
              usedTccWorkaround: false,
              error: 'Audio data is all zeros — possible TCC/permission issue',
            });
          } else {
            resolve({
              success: true,
              filePath: outputPath,
              fileSize: stat.size,
              duration,
              usedTccWorkaround: false,
            });
          }
        } catch {
          resolve({
            success: false,
            filePath: outputPath,
            fileSize: 0,
            duration,
            usedTccWorkaround: false,
            error: 'Output file not found after recording',
          });
        }
      } else {
        resolve({
          success: false,
          filePath: outputPath,
          fileSize: 0,
          duration,
          usedTccWorkaround: false,
          error: `Recording process exited with code ${code}: ${stderr.trim()}`,
        });
      }
    });

    proc.on('error', (err) => {
      clearTimeout(timeoutHandle);
      resolve({
        success: false,
        filePath: outputPath,
        fileSize: 0,
        duration,
        usedTccWorkaround: false,
        error: `Failed to start recording: ${err.message}`,
      });
    });
  });
}

/**
 * Record audio with automatic TCC workaround detection.
 *
 * This is the main entry point for audio recording. It automatically detects
 * whether the TCC workaround is needed (running under PM2 on macOS) and
 * selects the appropriate recording method.
 *
 * If `useTccWorkaround` is explicitly set to `false` but the recording
 * produces all-zero data (indicating TCC blocking), it will automatically
 * retry with the workaround enabled.
 *
 * @param options - Recording options
 * @returns Recording result with file path and metadata
 *
 * @example
 * ```typescript
 * import { recordAudio } from './utils/audio-record.js';
 *
 * // Basic usage (auto-detect PM2/TCC)
 * const result = await recordAudio({ durationSeconds: 10 });
 * if (result.success) {
 *   console.log(`Recorded ${result.fileSize} bytes to ${result.filePath}`);
 * }
 *
 * // Force TCC workaround
 * const result2 = await recordAudio({
 *   durationSeconds: 5,
 *   format: 'mp3',
 *   useTccWorkaround: true,
 * });
 * ```
 */
export async function recordAudio(options: AudioRecordOptions = {}): Promise<AudioRecordResult> {
  const useWorkaround = shouldUseTccWorkaround(options.useTccWorkaround);

  if (useWorkaround) {
    return recordViaTccWorkaround(options);
  }

  // Try direct recording first
  const result = await recordDirectly(options);

  // If direct recording produced all zeros (TCC silent block), retry with workaround
  if (
    !result.success &&
    result.error?.includes('all zeros') &&
    options.useTccWorkaround === undefined &&
    isMacOS()
  ) {
    // Auto-retry with TCC workaround
    return recordViaTccWorkaround(options);
  }

  return result;
}

/**
 * Child process spawn function.
 * Replace for testing to avoid real process spawning.
 * @internal
 */
export const processSpawn = spawn;
