/**
 * macOS Audio Recorder with TCC Bypass
 *
 * Provides audio recording capabilities on macOS with automatic detection and
 * workaround for the TCC (Transparency, Consent, and Control) permission issue
 * that occurs when running under PM2 process chains.
 *
 * ## Problem
 * macOS TCC tracks the entire process call chain for microphone permissions.
 * When a PM2 node process (which lacks microphone TCC permission) is an ancestor
 * of the recording process, TCC silently returns zero-filled audio data instead
 * of throwing an error or showing a permission dialog.
 *
 * ## Solution
 * This module detects PM2-managed environments and automatically uses `osascript`
 * to spawn recording processes in a Terminal.app context, bypassing the TCC
 * restriction on the PM2 process chain.
 *
 * Process chain without bypass (blocked):
 *   PM2(node) → claude → zsh → python  ❌ TCC denied at PM2 node level
 *
 * Process chain with bypass (allowed):
 *   Terminal.app → python  ✅ Terminal has TCC entry
 *
 * @see https://github.com/hs3180/disclaude/issues/1957
 * @module utils/audio-recorder
 */

import { execFile, exec } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const execFileAsync = promisify(execFile);
const execAsync = promisify(exec);

/** Recording format options */
export type AudioFormat = 'wav' | 'mp3' | 'aac' | 'flac';

/** Recording configuration */
export interface AudioRecordOptions {
  /** Output file path (default: auto-generated temp file) */
  outputPath?: string;
  /** Recording duration in seconds (default: 5) */
  duration?: number;
  /** Audio format (default: 'wav') */
  format?: AudioFormat;
  /** Sample rate in Hz (default: 44100) */
  sampleRate?: number;
  /** Number of channels (default: 1 for mono) */
  channels?: number;
  /** Audio device name or index (default: system default) */
  device?: string;
  /** Force use of osascript bypass even if not under PM2 (default: false) */
  forceBypass?: boolean;
  /** Custom Python interpreter path (default: 'python3') */
  pythonPath?: string;
  /** Timeout in milliseconds (default: duration * 2000 + 5000) */
  timeout?: number;
}

/** Result of an audio recording operation */
export interface AudioRecordResult {
  /** Path to the recorded audio file */
  filePath: string;
  /** File size in bytes */
  fileSize: number;
  /** Recording duration in seconds */
  duration: number;
  /** Whether the TCC bypass was used */
  usedBypass: boolean;
  /** Audio format */
  format: AudioFormat;
}

/** PM2 environment detection result */
export interface Pm2EnvironmentInfo {
  /** Whether running under PM2 management */
  isPm2: boolean;
  /** Full process chain from root to current */
  processChain: string[];
  /** PID of the PM2 ancestor process (if detected) */
  pm2Pid?: number;
  /** Platform */
  platform: string;
}

/** Validation result for recorded audio */
export interface AudioValidationResult {
  /** Whether the audio contains actual data (non-zero) */
  isValid: boolean;
  /** File size in bytes */
  fileSize: number;
  /** Whether the file appears to be zero-filled (TCC blocked) */
  isZeroFilled: boolean;
  /** Sample count of non-zero bytes at the beginning of audio data */
  nonZeroSampleCount: number;
}

/** Error thrown when audio recording fails */
export class AudioRecorderError extends Error {
  constructor(
    message: string,
    public readonly cause?: Error,
    public readonly code?: string,
  ) {
    super(message);
    this.name = 'AudioRecorderError';
  }
}

/**
 * Detect whether the current process is running under PM2 management.
 *
 * On macOS, TCC (Transparency, Consent, and Control) tracks the entire process
 * call chain. If any ancestor process lacks microphone permission, TCC silently
 * denies access. PM2's node process typically lacks this permission.
 *
 * Detection strategy:
 * 1. Check platform (only macOS is affected)
 * 2. Walk the process chain via PPID
 * 3. Look for PM2's God Daemon (node process with specific CLI args)
 * 4. Check for PM2 environment variables (PM2_HOME, pm_id, etc.)
 */
export async function detectPm2Environment(): Promise<Pm2EnvironmentInfo> {
  const platform = process.platform;
  const processChain: string[] = [];

  // PM2 sets these environment variables in managed processes
  const pm2EnvVars = ['PM2_HOME', 'pm_id', 'PM2_PUBLIC_KEY', 'PM2_SECRET_KEY'];
  const hasPm2Env = pm2EnvVars.some((key) => key in process.env);

  // Walk process chain via PPID (Unix/macOS/Linux)
  let currentPid = process.pid;
  const maxDepth = 20; // Prevent infinite loops
  let pm2Pid: number | undefined;

  for (let i = 0; i < maxDepth && currentPid > 1; i++) {
    try {
      const { stdout } = await execFileAsync('ps', ['-p', String(currentPid), '-o', 'pid,ppid,comm='], {
        timeout: 5000,
      });

      const lines = stdout.trim().split('\n');
      if (lines.length < 2) break;

      const parts = lines[1].trim().split(/\s+/);
      const pid = parseInt(parts[0], 10);
      const ppid = parseInt(parts[1], 10);
      const comm = parts.slice(2).join(' ');

      processChain.push(`PID ${pid}: ${comm}`);

      // Detect PM2 God Daemon: node process running PM2
      if (comm.includes('node') && !pm2Pid) {
        try {
          const { stdout: cmdOutput } = await execFileAsync(
            'ps',
            ['-p', String(pid), '-o', 'command='],
            { timeout: 5000 },
          );
          if (cmdOutput.includes('PM2') || cmdOutput.includes('pm2') || cmdOutput.includes('God Daemon')) {
            pm2Pid = pid;
          }
        } catch {
          // Process may have exited between checks
        }
      }

      currentPid = ppid;
    } catch {
      // Process may not exist or ps may fail
      break;
    }
  }

  // Also check via PM2 IPC if available
  let isPm2 = hasPm2Env || pm2Pid !== undefined;

  // Additional check: try to query PM2 list
  if (!isPm2) {
    try {
      await execFileAsync('pm2', ['list'], { timeout: 3000 });
      // If pm2 command succeeds and we can find our PID in the list, we're under PM2
      const { stdout: pm2List } = await execFileAsync('pm2', ['jlist'], { timeout: 3000 });
      const processes = JSON.parse(pm2List);
      isPm2 = processes.some(
        (p: { pid?: number; pm2_env?: { PM2_PID?: number } }) =>
          p.pid === process.pid || p.pm2_env?.PM2_PID === process.pid,
      );
    } catch {
      // PM2 not available or not managing this process
    }
  }

  return {
    isPm2,
    processChain,
    pm2Pid,
    platform,
  };
}

/**
 * Generate a Python script for audio recording using sounddevice.
 *
 * This script records audio from the default input device and saves it
 * to the specified output path. It validates the recorded data to detect
 * TCC-blocked zero-filled audio.
 */
function generateRecordingScript(options: {
  outputPath: string;
  duration: number;
  sampleRate: number;
  channels: number;
  device?: string;
  format: AudioFormat;
}): string {
  const { outputPath, duration, sampleRate, channels, device, format } = options;

  const deviceArg = device ? `sd.default.device = ${JSON.stringify(device)}` : '';

  // For WAV format, we use sounddevice's built-in WAV writing
  // For other formats, we'd need additional libraries
  if (format !== 'wav') {
    throw new AudioRecorderError(
      `Format '${format}' requires additional dependencies. Only 'wav' is supported without external libraries.`,
      undefined,
      'UNSUPPORTED_FORMAT',
    );
  }

  const escapedPath = outputPath.replace(/\\/g, '\\\\').replace(/'/g, "\\'");

  return `import sys
import sounddevice as sd
import numpy as np

try:
    ${deviceArg}

    print(f"Recording ${duration}s at ${sampleRate}Hz, ${channels}ch...", file=sys.stderr)

    # Record audio
    audio_data = sd.rec(
        int(${duration} * ${sampleRate}),
        samplerate=${sampleRate},
        channels=${channels},
        dtype='float64'
    )
    sd.wait()  # Wait until recording is finished

    # Validate: check for zero-filled data (TCC blocked)
    max_val = float(np.max(np.abs(audio_data)))
    if max_val == 0.0:
        print(f"WARNING: Recorded audio is completely silent (max=0.0). This may indicate TCC permission denial.", file=sys.stderr)

    # Save as WAV
    import soundfile as sf
    sf.write('${escapedPath}', audio_data, ${sampleRate})
    print(f"Saved to: ${escapedPath}", file=sys.stderr)
    print(f"Duration: ${duration}s, Max amplitude: {max_val:.6f}", file=sys.stderr)
    sys.exit(0)

except ImportError as e:
    print(f"ERROR: Missing dependency: {e}", file=sys.stderr)
    print("Install with: pip install sounddevice soundfile numpy", file=sys.stderr)
    sys.exit(2)
except Exception as e:
    print(f"ERROR: {e}", file=sys.stderr)
    sys.exit(1)
`;
}

/**
 * Record audio directly (without TCC bypass).
 *
 * Use this when NOT running under PM2, or when you're certain the current
 * process has microphone TCC permission.
 *
 * @throws {AudioRecorderError} If recording fails or audio is zero-filled
 */
export async function recordAudioDirectly(options: AudioRecordOptions = {}): Promise<AudioRecordResult> {
  const {
    outputPath = path.join(os.tmpdir(), `recording_${Date.now()}.wav`),
    duration = 5,
    sampleRate = 44100,
    channels = 1,
    device,
    pythonPath = 'python3',
    timeout = duration * 2000 + 10000,
  } = options;

  const format = options.format ?? 'wav';
  const script = generateRecordingScript({ outputPath, duration, sampleRate, channels, device, format });

  // Write script to temp file
  const scriptPath = path.join(os.tmpdir(), `record_audio_${Date.now()}.py`);
  fs.writeFileSync(scriptPath, script, 'utf-8');

  try {
    const { stderr } = await execAsync(`${pythonPath} ${scriptPath}`, {
      timeout,
      maxBuffer: 1024 * 1024,
    });

    // Check for warnings about zero-filled audio
    if (stderr.includes('WARNING: Recorded audio is completely silent')) {
      const validation = validateAudioFile(outputPath);
      if (validation.isZeroFilled) {
        throw new AudioRecorderError(
          'Recorded audio is zero-filled. This typically indicates macOS TCC permission denial. ' +
            'If running under PM2, use recordAudio() instead for automatic TCC bypass.',
          undefined,
          'TCC_DENIED',
        );
      }
    }

    // Verify output file exists
    if (!fs.existsSync(outputPath)) {
      throw new AudioRecorderError(
        `Recording failed: output file not created at ${outputPath}`,
        undefined,
        'NO_OUTPUT_FILE',
      );
    }

    const stat = fs.statSync(outputPath);

    return {
      filePath: outputPath,
      fileSize: stat.size,
      duration,
      usedBypass: false,
      format,
    };
  } finally {
    // Clean up temp script
    try {
      fs.unlinkSync(scriptPath);
    } catch {
      // Ignore cleanup errors
    }
  }
}

/**
 * Record audio using osascript to bypass PM2 TCC restrictions.
 *
 * This spawns the recording script in a Terminal.app context via osascript,
 * which has its own TCC entry and is not blocked by the PM2 process chain.
 *
 * The recording runs asynchronously in a Terminal window. This function
 * waits for the recording to complete by monitoring the output file.
 *
 * @throws {AudioRecorderError} If the platform is not macOS or recording fails
 */
export async function recordAudioViaBypass(options: AudioRecordOptions = {}): Promise<AudioRecordResult> {
  if (process.platform !== 'darwin') {
    throw new AudioRecorderError(
      'osascript bypass is only available on macOS. Use recordAudioDirectly() on other platforms.',
      undefined,
      'PLATFORM_NOT_SUPPORTED',
    );
  }

  const {
    outputPath = path.join(os.tmpdir(), `recording_${Date.now()}.wav`),
    duration = 5,
    sampleRate = 44100,
    channels = 1,
    device,
    pythonPath = 'python3',
    timeout = duration * 2000 + 15000,
  } = options;

  const format = options.format ?? 'wav';
  const script = generateRecordingScript({ outputPath, duration, sampleRate, channels, device, format });

  // Write script to temp file
  const scriptPath = path.join(os.tmpdir(), `record_audio_${Date.now()}.py`);
  fs.writeFileSync(scriptPath, script, 'utf-8');

  // Create a marker file that the script will create when done
  const markerPath = path.join(os.tmpdir(), `recording_done_${Date.now()}.marker`);

  try {
    // Modify script to create marker file when done
    const escapedMarker = markerPath.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
    const scriptWithMarker =
      script + `\n# Create completion marker\nopen('${escapedMarker}', 'w').close()\n`;
    fs.writeFileSync(scriptPath, scriptWithMarker, 'utf-8');

    // Escape for AppleScript string
    const escapedScriptPath = scriptPath.replace(/'/g, "' \\''");
    const command = `${pythonPath} '${escapedScriptPath}'`;

    // Escape double quotes for AppleScript
    const escapedCommand = command.replace(/"/g, '\\"');

    // Launch recording in Terminal.app via osascript
    await execAsync(`osascript -e 'tell application "Terminal" to do script "${escapedCommand}"'`, {
      timeout: 10000,
    });

    // Wait for the marker file to appear (recording complete)
    const startTime = Date.now();
    while (Date.now() - startTime < timeout) {
      await new Promise((resolve) => setTimeout(resolve, 500));
      if (fs.existsSync(markerPath)) {
        break;
      }
    }

    // Clean up marker
    try {
      fs.unlinkSync(markerPath);
    } catch {
      // Ignore
    }

    // Verify output file
    if (!fs.existsSync(outputPath)) {
      throw new AudioRecorderError(
        `Recording via bypass failed: output file not created at ${outputPath}. ` +
          `The Terminal window may have encountered an error.`,
        undefined,
        'BYPASS_NO_OUTPUT',
      );
    }

    const validation = validateAudioFile(outputPath);
    if (validation.isZeroFilled) {
      throw new AudioRecorderError(
        'Recording via bypass produced zero-filled audio. ' +
          'Terminal.app may not have microphone TCC permission either. ' +
          'Check System Settings > Privacy & Security > Microphone.',
        undefined,
        'BYPASS_TCC_DENIED',
      );
    }

    const stat = fs.statSync(outputPath);

    return {
      filePath: outputPath,
      fileSize: stat.size,
      duration,
      usedBypass: true,
      format,
    };
  } finally {
    // Clean up temp script
    try {
      fs.unlinkSync(scriptPath);
    } catch {
      // Ignore cleanup errors
    }
  }
}

/**
 * Record audio with automatic PM2/TCC detection and bypass.
 *
 * This is the primary API for audio recording. It:
 * 1. Detects whether the process is running under PM2 on macOS
 * 2. If under PM2 on macOS, uses osascript bypass automatically
 * 3. Otherwise, records directly
 *
 * @example
 * ```typescript
 * import { recordAudio } from '@disclaude/core';
 *
 * try {
 *   const result = await recordAudio({ duration: 10 });
 *   console.log(`Recorded ${result.duration}s of audio to ${result.filePath}`);
 *   console.log(`Used bypass: ${result.usedBypass}`);
 * } catch (error) {
 *   if (error instanceof AudioRecorderError) {
 *     console.error(`Recording failed: ${error.message}`);
 *   }
 * }
 * ```
 */
export async function recordAudio(options: AudioRecordOptions = {}): Promise<AudioRecordResult> {
  const env = await detectPm2Environment();

  // Use bypass when:
  // 1. Running under PM2 on macOS, OR
  // 2. Force bypass is requested
  const shouldBypass = (env.isPm2 && env.platform === 'darwin') || options.forceBypass === true;

  if (shouldBypass && env.platform === 'darwin') {
    return recordAudioViaBypass(options);
  }

  return recordAudioDirectly(options);
}

/**
 * Validate an audio file to detect TCC-blocked (zero-filled) recordings.
 *
 * Reads the beginning of the file and checks if the audio data region
 * contains only zero bytes, which indicates TCC silently denied microphone access.
 *
 * @param filePath Path to the audio file to validate
 * @param sampleSize Number of bytes to check from the audio data region (default: 4096)
 */
export function validateAudioFile(filePath: string, sampleSize = 4096): AudioValidationResult {
  try {
    const stat = fs.statSync(filePath);
    const buffer = Buffer.alloc(sampleSize);
    const fd = fs.openSync(filePath, 'r');

    try {
      // For WAV files, skip the 44-byte header
      const headerSize = filePath.endsWith('.wav') ? 44 : 0;
      fs.readSync(fd, buffer, 0, sampleSize, headerSize);
    } finally {
      fs.closeSync(fd);
    }

    // Count non-zero bytes
    let nonZeroCount = 0;
    for (let i = 0; i < buffer.length; i++) {
      if (buffer[i] !== 0) {
        nonZeroCount++;
      }
    }

    // If fewer than 1% of sampled bytes are non-zero, consider it zero-filled
    const isZeroFilled = nonZeroCount < sampleSize * 0.01;

    return {
      isValid: !isZeroFilled,
      fileSize: stat.size,
      isZeroFilled,
      nonZeroSampleCount: nonZeroCount,
    };
  } catch {
    return {
      isValid: false,
      fileSize: 0,
      isZeroFilled: true,
      nonZeroSampleCount: 0,
    };
  }
}

/**
 * Check if sounddevice Python package is available for recording.
 *
 * @param pythonPath Python interpreter path (default: 'python3')
 * @returns Whether the required Python packages are installed
 */
export async function checkPythonDependencies(pythonPath = 'python3'): Promise<{
  available: boolean;
  pythonPath: string;
  packages: Record<string, boolean>;
}> {
  const packages = ['sounddevice', 'soundfile', 'numpy'];
  const results: Record<string, boolean> = {};

  for (const pkg of packages) {
    try {
      await execAsync(`${pythonPath} -c "import ${pkg}"`, { timeout: 5000 });
      results[pkg] = true;
    } catch {
      results[pkg] = false;
    }
  }

  return {
    available: Object.values(results).every(Boolean),
    pythonPath,
    packages: results,
  };
}
