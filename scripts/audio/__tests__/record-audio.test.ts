/**
 * Tests for audio/record-audio.ts — TCC-safe audio recording utilities.
 *
 * Tests cover:
 * - Input validation
 * - PM2 chain detection logic
 * - FFmpeg command building
 * - osascript command building
 * - Edge cases and error handling
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdir, rm, writeFile, mkdtemp } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import {
  validateOptions,
  detectPm2Chain,
  isFfmpegAvailable,
  buildFfmpegArgs,
  buildOsascriptCommand,
  type RecordAudioOptions,
  type Pm2DetectionResult,
} from '../record-audio.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = resolve(__dirname, '../../..');

// ---- ValidateOptions Tests ----

describe('validateOptions', () => {
  it('should reject missing output', () => {
    const result = validateOptions({});
    expect(result.valid).toBe(false);
    expect(result.error).toContain('OUTPUT is required');
  });

  it('should reject empty output', () => {
    const result = validateOptions({ output: '' });
    expect(result.valid).toBe(false);
    expect(result.error).toContain('OUTPUT is required');
  });

  it('should reject non-existent output directory', () => {
    const result = validateOptions({ output: '/nonexistent/dir/file.wav' });
    expect(result.valid).toBe(false);
    expect(result.error).toContain('does not exist');
  });

  it('should accept valid output path', async () => {
    const tmpDir = await mkdtemp(`${tmpdir()}/record-audio-test-`);
    try {
      const result = validateOptions({ output: resolve(tmpDir, 'test.wav') });
      expect(result.valid).toBe(true);
    } finally {
      await rm(tmpDir, { recursive: true, force: true });
    }
  });

  it('should reject non-integer duration', () => {
    const result = validateOptions({ output: '/tmp/test.wav', duration: 3.5 });
    expect(result.valid).toBe(false);
    expect(result.error).toContain('positive integer');
  });

  it('should reject zero duration', () => {
    const result = validateOptions({ output: '/tmp/test.wav', duration: 0 });
    expect(result.valid).toBe(false);
    expect(result.error).toContain('positive integer');
  });

  it('should reject negative duration', () => {
    const result = validateOptions({ output: '/tmp/test.wav', duration: -1 });
    expect(result.valid).toBe(false);
  });

  it('should reject duration exceeding maximum (3600s)', () => {
    const result = validateOptions({ output: '/tmp/test.wav', duration: 3601 });
    expect(result.valid).toBe(false);
    expect(result.error).toContain('maximum');
  });

  it('should accept duration at maximum boundary', () => {
    const result = validateOptions({ output: '/tmp/test.wav', duration: 3600 });
    expect(result.valid).toBe(true);
  });

  it('should accept default duration (undefined)', () => {
    const result = validateOptions({ output: '/tmp/test.wav' });
    expect(result.valid).toBe(true);
  });

  it('should accept valid duration of 1', () => {
    const result = validateOptions({ output: '/tmp/test.wav', duration: 1 });
    expect(result.valid).toBe(true);
  });
});

// ---- DetectPm2Chain Tests ----

describe('detectPm2Chain', () => {
  it('should return isUnderPm2=false on non-macOS platforms', () => {
    const originalPlatform = process.platform;
    // We can't override process.platform, but on Linux it should return false
    if (originalPlatform !== 'darwin') {
      const result = detectPm2Chain();
      expect(result.isUnderPm2).toBe(false);
      expect(result.platform).toBe(originalPlatform);
      expect(result.description).toContain('Not macOS');
    }
  });

  it('should return a Pm2DetectionResult with all fields', () => {
    const result = detectPm2Chain();
    expect(result).toHaveProperty('isUnderPm2');
    expect(result).toHaveProperty('platform');
    expect(result).toHaveProperty('description');
    expect(typeof result.isUnderPm2).toBe('boolean');
    expect(typeof result.platform).toBe('string');
    expect(typeof result.description).toBe('string');
  });
});

// ---- IsFfmpegAvailable Tests ----

describe('isFfmpegAvailable', () => {
  it('should return a boolean', () => {
    const result = isFfmpegAvailable();
    expect(typeof result).toBe('boolean');
  });
});

// ---- BuildFfmpegArgs Tests ----

describe('buildFfmpegArgs', () => {
  const originalPlatform = process.platform;

  it('should build args with default device on macOS', () => {
    // Save and mock platform
    Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true });
    try {
      const args = buildFfmpegArgs({ duration: 5, output: '/tmp/test.wav' });
      expect(args).toContain('-f');
      expect(args).toContain('avfoundation');
      expect(args).toContain('-t');
      expect(args).toContain('5');
      expect(args).toContain('-y');
      expect(args).toContain('/tmp/test.wav');
    } finally {
      Object.defineProperty(process, 'platform', { value: originalPlatform, configurable: true });
    }
  });

  it('should build args with custom device on macOS', () => {
    Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true });
    try {
      const args = buildFfmpegArgs({ duration: 10, device: '2', output: '/tmp/test.wav' });
      expect(args).toContain(':2');
      expect(args).toContain('-t');
      expect(args).toContain('10');
    } finally {
      Object.defineProperty(process, 'platform', { value: originalPlatform, configurable: true });
    }
  });

  it('should build args with pulse on Linux', () => {
    Object.defineProperty(process, 'platform', { value: 'linux', configurable: true });
    try {
      const args = buildFfmpegArgs({ duration: 3, output: '/tmp/test.wav' });
      expect(args).toContain('-f');
      expect(args).toContain('pulse');
      expect(args).toContain('default');
    } finally {
      Object.defineProperty(process, 'platform', { value: originalPlatform, configurable: true });
    }
  });

  it('should build args with custom device on Linux', () => {
    Object.defineProperty(process, 'platform', { value: 'linux', configurable: true });
    try {
      const args = buildFfmpegArgs({ duration: 3, device: 'alsa_output.pci-1', output: '/tmp/test.wav' });
      expect(args).toContain('alsa_output.pci-1');
    } finally {
      Object.defineProperty(process, 'platform', { value: originalPlatform, configurable: true });
    }
  });

  it('should include output path as last argument', () => {
    const outputPath = '/tmp/my-recording.wav';
    const args = buildFfmpegArgs({ duration: 5, output: outputPath });
    expect(args[args.length - 1]).toBe(outputPath);
  });

  it('should always include -y flag (overwrite)', () => {
    const args = buildFfmpegArgs({ duration: 5, output: '/tmp/test.wav' });
    expect(args).toContain('-y');
  });
});

// ---- BuildOsascriptCommand Tests ----

describe('buildOsascriptCommand', () => {
  it('should return osascript as first element', () => {
    const ffmpegArgs = ['-f', 'avfoundation', '-i', ':default', '-t', '5', '-y', '/tmp/test.wav'];
    const cmd = buildOsascriptCommand(ffmpegArgs);
    expect(cmd[0]).toBe('osascript');
  });

  it('should include -e flag', () => {
    const ffmpegArgs = ['-f', 'avfoundation', '-i', ':default', '-t', '5', '-y', '/tmp/test.wav'];
    const cmd = buildOsascriptCommand(ffmpegArgs);
    expect(cmd).toContain('-e');
  });

  it('should include Terminal.app do script command', () => {
    const ffmpegArgs = ['-f', 'avfoundation', '-i', ':default', '-t', '5', '-y', '/tmp/test.wav'];
    const cmd = buildOsascriptCommand(ffmpegArgs);
    const scriptPart = cmd[2]; // The -e argument
    expect(scriptPart).toContain('Terminal');
    expect(scriptPart).toContain('do script');
    expect(scriptPart).toContain('ffmpeg');
  });

  it('should escape single quotes in arguments', () => {
    const ffmpegArgs = ['-f', "avfoundation", '-i', ":default", '-t', "5", '-y', "/tmp/test's.wav"];
    const cmd = buildOsascriptCommand(ffmpegArgs);
    // Should not throw — handles single quote escaping
    expect(cmd.length).toBe(3);
  });
});

// ---- Shell Script Tests ----

describe('record-audio.sh', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(`${tmpdir()}/record-audio-sh-`);
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('should exit with error when OUTPUT is not set', async () => {
    const { execFile } = await import('node:child_process');
    const { promisify } = await import('node:util');
    const execFileAsync = promisify(execFile);

    try {
      await execFileAsync('bash', [resolve(PROJECT_ROOT, 'scripts/audio/record-audio.sh')], {
        env: { ...process.env, OUTPUT: '' },
      });
      expect.unreachable('Should have thrown');
    } catch (err: unknown) {
      const execErr = err as { code?: number; stderr?: string };
      expect(execErr.code).toBe(1);
      expect(execErr.stderr).toContain('OUTPUT');
    }
  });

  it('should exit with error when DURATION is invalid', async () => {
    const { execFile } = await import('node:child_process');
    const { promisify } = await import('node:util');
    const execFileAsync = promisify(execFile);

    try {
      await execFileAsync('bash', [resolve(PROJECT_ROOT, 'scripts/audio/record-audio.sh')], {
        env: { ...process.env, OUTPUT: resolve(tmpDir, 'test.wav'), DURATION: 'abc' },
      });
      expect.unreachable('Should have thrown');
    } catch (err: unknown) {
      const execErr = err as { code?: number; stderr?: string };
      expect(execErr.code).toBe(1);
      expect(execErr.stderr).toContain('DURATION');
    }
  });

  it('should exit with error when DURATION is zero', async () => {
    const { execFile } = await import('node:child_process');
    const { promisify } = await import('node:util');
    const execFileAsync = promisify(execFile);

    try {
      await execFileAsync('bash', [resolve(PROJECT_ROOT, 'scripts/audio/record-audio.sh')], {
        env: { ...process.env, OUTPUT: resolve(tmpDir, 'test.wav'), DURATION: '0' },
      });
      expect.unreachable('Should have thrown');
    } catch (err: unknown) {
      const execErr = err as { code?: number; stderr?: string };
      expect(execErr.code).toBe(1);
    }
  });

  it('should exit with error when output directory does not exist', async () => {
    const { execFile } = await import('node:child_process');
    const { promisify } = await import('node:util');
    const execFileAsync = promisify(execFile);

    try {
      await execFileAsync('bash', [resolve(PROJECT_ROOT, 'scripts/audio/record-audio.sh')], {
        env: { ...process.env, OUTPUT: '/nonexistent/path/test.wav', DURATION: '1' },
      });
      expect.unreachable('Should have thrown');
    } catch (err: unknown) {
      const execErr = err as { code?: number; stderr?: string };
      expect(execErr.code).toBe(1);
      expect(execErr.stderr).toContain('does not exist');
    }
  });

  it('should exit with code 3 when ffmpeg is not found', async () => {
    const { execFile } = await import('node:child_process');
    const { promisify } = await import('node:util');
    const execFileAsync = promisify(execFile);

    // Find bash path so we can keep it in PATH but remove ffmpeg
    const bashPath = await execFileAsync('which', ['bash']).then(r => r.stdout.trim());
    const pathWithoutFfmpeg = `/usr/bin:/bin:${dirname(bashPath)}`;

    try {
      await execFileAsync(bashPath, [resolve(PROJECT_ROOT, 'scripts/audio/record-audio.sh')], {
        env: {
          ...process.env,
          OUTPUT: resolve(tmpDir, 'test.wav'),
          DURATION: '1',
          PATH: pathWithoutFfmpeg,
        },
      });
      expect.unreachable('Should have thrown');
    } catch (err: unknown) {
      const execErr = err as { code?: number; stderr?: string };
      expect(execErr.code).toBe(3);
      expect(execErr.stderr).toContain('ffmpeg');
    }
  });
});
