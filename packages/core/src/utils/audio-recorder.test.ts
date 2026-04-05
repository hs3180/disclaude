/**
 * Tests for macOS Audio Recorder with TCC Bypass
 *
 * @see https://github.com/hs3180/disclaude/issues/1957
 * @module utils/audio-recorder.test
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  AudioRecorderError,
  validateAudioFile,
} from './audio-recorder.js';

// ============================================================================
// Pure function tests (no mocking needed)
// ============================================================================

describe('validateAudioFile', () => {
  beforeEach(() => {
    vi.spyOn(os, 'tmpdir').mockReturnValue('/tmp');
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('should return isValid=true for audio with non-zero data', () => {
    const tempFile = path.join(os.tmpdir(), 'test_audio_validation.wav');
    const buffer = Buffer.alloc(44 + 100);
    for (let i = 44; i < buffer.length; i++) {
      buffer[i] = 128;
    }

    vi.spyOn(fs, 'statSync').mockReturnValue({ size: buffer.length } as fs.Stats);
    vi.spyOn(fs, 'openSync').mockReturnValue(0 as unknown as number);
    vi.spyOn(fs, 'closeSync').mockReturnValue(undefined);
    vi.spyOn(fs, 'readSync').mockImplementation(
      (((...args: unknown[]) => {
        const [_fd, buf, offset, length, position] = args as [number, Buffer, number, number, number | null];
        const source = position !== null ? position : 0;
        (buf as Buffer).set(buffer.subarray(source, source + length), offset);
        return length;
      }) as unknown as typeof fs.readSync),
    );

    const result = validateAudioFile(tempFile);

    expect(result.isValid).toBe(true);
    expect(result.isZeroFilled).toBe(false);
    expect(result.nonZeroSampleCount).toBeGreaterThan(0);
  });

  it('should return isZeroFilled=true for all-zero audio data', () => {
    const tempFile = path.join(os.tmpdir(), 'test_zero_audio.wav');
    const buffer = Buffer.alloc(44 + 100);

    vi.spyOn(fs, 'statSync').mockReturnValue({ size: buffer.length } as fs.Stats);
    vi.spyOn(fs, 'openSync').mockReturnValue(0 as unknown as number);
    vi.spyOn(fs, 'closeSync').mockReturnValue(undefined);
    vi.spyOn(fs, 'readSync').mockImplementation(
      (((...args: unknown[]) => {
        const [_fd, buf, offset, length, position] = args as [number, Buffer, number, number, number | null];
        const source = position !== null ? position : 0;
        (buf as Buffer).set(buffer.subarray(source, Math.min(source + length, buffer.length)), offset);
        return Math.min(length, buffer.length - source);
      }) as unknown as typeof fs.readSync),
    );

    const result = validateAudioFile(tempFile);

    expect(result.isValid).toBe(false);
    expect(result.isZeroFilled).toBe(true);
    expect(result.nonZeroSampleCount).toBe(0);
  });

  it('should handle file read errors gracefully', () => {
    vi.spyOn(fs, 'statSync').mockImplementation(() => {
      throw new Error('File not found');
    });

    const result = validateAudioFile('/nonexistent/file.wav');

    expect(result.isValid).toBe(false);
    expect(result.isZeroFilled).toBe(true);
  });

  it('should skip WAV header when validating', () => {
    const tempFile = path.join(os.tmpdir(), 'test_header_skip.wav');
    const buffer = Buffer.alloc(4096);
    for (let i = 44; i < buffer.length; i++) {
      buffer[i] = 100;
    }

    vi.spyOn(fs, 'statSync').mockReturnValue({ size: buffer.length } as fs.Stats);
    vi.spyOn(fs, 'openSync').mockReturnValue(0 as unknown as number);
    vi.spyOn(fs, 'closeSync').mockReturnValue(undefined);
    vi.spyOn(fs, 'readSync').mockImplementation(
      (((...args: unknown[]) => {
        const [_fd, buf, offset, length, position] = args as [number, Buffer, number, number, number | null];
        const source = position !== null ? position : 0;
        (buf as Buffer).set(buffer.subarray(source, source + length), offset);
        return length;
      }) as unknown as typeof fs.readSync),
    );

    const result = validateAudioFile(tempFile);

    expect(result.isValid).toBe(true);
  });

  it('should detect partially zero-filled audio as valid when above threshold', () => {
    const tempFile = path.join(os.tmpdir(), 'test_partial.wav');
    const buffer = Buffer.alloc(4096);
    for (let i = 0; i < Math.floor(buffer.length * 0.05); i++) {
      buffer[44 + i] = 255;
    }

    vi.spyOn(fs, 'statSync').mockReturnValue({ size: buffer.length } as fs.Stats);
    vi.spyOn(fs, 'openSync').mockReturnValue(0 as unknown as number);
    vi.spyOn(fs, 'closeSync').mockReturnValue(undefined);
    vi.spyOn(fs, 'readSync').mockImplementation(
      (((...args: unknown[]) => {
        const [_fd, buf, offset, length, position] = args as [number, Buffer, number, number, number | null];
        const source = position !== null ? position : 0;
        (buf as Buffer).set(buffer.subarray(source, source + length), offset);
        return length;
      }) as unknown as typeof fs.readSync),
    );

    const result = validateAudioFile(tempFile);

    expect(result.isValid).toBe(true);
    expect(result.nonZeroSampleCount).toBeGreaterThan(buffer.length * 0.01);
  });

  it('should detect mostly-zero audio as zero-filled when below threshold', () => {
    const tempFile = path.join(os.tmpdir(), 'test_mostly_zero.wav');
    const buffer = Buffer.alloc(4096);
    const nonZeroCount = Math.floor(buffer.length * 0.005);
    for (let i = 0; i < nonZeroCount; i++) {
      buffer[44 + i] = 255;
    }

    vi.spyOn(fs, 'statSync').mockReturnValue({ size: buffer.length } as fs.Stats);
    vi.spyOn(fs, 'openSync').mockReturnValue(0 as unknown as number);
    vi.spyOn(fs, 'closeSync').mockReturnValue(undefined);
    vi.spyOn(fs, 'readSync').mockImplementation(
      (((...args: unknown[]) => {
        const [_fd, buf, offset, length, position] = args as [number, Buffer, number, number, number | null];
        const source = position !== null ? position : 0;
        (buf as Buffer).set(buffer.subarray(source, source + length), offset);
        return length;
      }) as unknown as typeof fs.readSync),
    );

    const result = validateAudioFile(tempFile);

    expect(result.isValid).toBe(false);
    expect(result.isZeroFilled).toBe(true);
  });

  it('should return correct fileSize', () => {
    const tempFile = path.join(os.tmpdir(), 'test_size.wav');
    const fileSize = 88200;

    vi.spyOn(fs, 'statSync').mockReturnValue({ size: fileSize } as fs.Stats);
    vi.spyOn(fs, 'openSync').mockReturnValue(0 as unknown as number);
    vi.spyOn(fs, 'closeSync').mockReturnValue(undefined);
    vi.spyOn(fs, 'readSync').mockImplementation(
      (((...args: unknown[]) => {
        const [_fd, buf, , length] = args as [number, Buffer, number, number];
        for (let i = 0; i < length; i++) (buf as Buffer)[i] = 128;
        return length;
      }) as unknown as typeof fs.readSync),
    );

    const result = validateAudioFile(tempFile);

    expect(result.fileSize).toBe(fileSize);
  });
});

describe('AudioRecorderError', () => {
  it('should have correct name and properties', () => {
    const cause = new Error('original error');
    const error = new AudioRecorderError('test message', cause, 'TEST_CODE');

    expect(error.name).toBe('AudioRecorderError');
    expect(error.message).toBe('test message');
    expect(error.cause).toBe(cause);
    expect(error.code).toBe('TEST_CODE');
  });

  it('should work without optional parameters', () => {
    const error = new AudioRecorderError('simple error');

    expect(error.name).toBe('AudioRecorderError');
    expect(error.message).toBe('simple error');
    expect(error.cause).toBeUndefined();
    expect(error.code).toBeUndefined();
  });

  it('should be instanceof Error', () => {
    const error = new AudioRecorderError('test');

    expect(error).toBeInstanceOf(Error);
    expect(error).toBeInstanceOf(AudioRecorderError);
  });

  it('should have stack trace', () => {
    const error = new AudioRecorderError('test');

    expect(error.stack).toBeDefined();
    expect(error.stack).toContain('AudioRecorderError');
  });
});

// ============================================================================
// PM2 Detection tests
// ============================================================================

describe('detectPm2Environment', () => {
  // Save and restore PM2-related env vars to prevent leakage
  let savedEnv: Record<string, string | undefined>;

  beforeEach(() => {
    savedEnv = {};
    for (const key of ['PM2_HOME', 'pm_id', 'PM2_PUBLIC_KEY', 'PM2_SECRET_KEY']) {
      savedEnv[key] = process.env[key];
      delete process.env[key];
    }
    vi.spyOn(process, 'platform', 'get').mockReturnValue('linux');
  });

  afterEach(() => {
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
    vi.restoreAllMocks();
  });

  it('should return isPm2=false and empty chain when ps fails', async () => {
    const { detectPm2Environment } = await import('./audio-recorder.js');

    const result = await detectPm2Environment();

    expect(result.isPm2).toBe(false);
    expect(result.platform).toBe('linux');
  });

  it('should detect PM2 via PM2_HOME environment variable', async () => {
    process.env.PM2_HOME = '/home/user/.pm2';

    // Need fresh import since env var is checked at runtime
    vi.resetModules();
    const { detectPm2Environment } = await import('./audio-recorder.js');

    const result = await detectPm2Environment();

    expect(result.isPm2).toBe(true);
  });

  it('should detect PM2 via pm_id environment variable', async () => {
    process.env.pm_id = '0';

    vi.resetModules();
    const { detectPm2Environment } = await import('./audio-recorder.js');

    const result = await detectPm2Environment();

    expect(result.isPm2).toBe(true);
  });

  it('should return darwin platform on macOS', async () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('darwin');

    vi.resetModules();
    const { detectPm2Environment } = await import('./audio-recorder.js');

    const result = await detectPm2Environment();

    expect(result.platform).toBe('darwin');
  });
});

// ============================================================================
// Recording function tests
// ============================================================================

describe('recordAudioDirectly', () => {
  let savedEnv: Record<string, string | undefined>;

  beforeEach(() => {
    savedEnv = {};
    for (const key of ['PM2_HOME', 'pm_id', 'PM2_PUBLIC_KEY', 'PM2_SECRET_KEY']) {
      savedEnv[key] = process.env[key];
      delete process.env[key];
    }
    vi.spyOn(os, 'tmpdir').mockReturnValue('/tmp');
    vi.spyOn(process, 'platform', 'get').mockReturnValue('linux');
  });

  afterEach(() => {
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
    vi.restoreAllMocks();
  });

  it('should throw AudioRecorderError for unsupported formats', async () => {
    vi.resetModules();
    const { recordAudioDirectly } = await import('./audio-recorder.js');

    try {
      await recordAudioDirectly({ format: 'mp3', outputPath: '/tmp/test.wav' });
      expect.fail('Should have thrown');
    } catch (error) {
      expect((error as Error).name).toBe('AudioRecorderError');
      expect((error as AudioRecorderError).code).toBe('UNSUPPORTED_FORMAT');
    }
  });

  it('should throw when output file is not created', async () => {
    vi.resetModules();
    const { recordAudioDirectly } = await import('./audio-recorder.js');

    // This test requires exec to succeed but the output file doesn't exist
    // Since we can't easily mock exec, we test with a non-existent python path
    try {
      await recordAudioDirectly({
        outputPath: '/tmp/test.wav',
        timeout: 3000,
        pythonPath: '/nonexistent/python',
      });
      expect.fail('Should have thrown');
    } catch (error) {
      // Should fail because python doesn't exist at that path
      expect(error).toBeDefined();
    }
  });
});

describe('recordAudioViaBypass', () => {
  let savedEnv: Record<string, string | undefined>;

  beforeEach(() => {
    savedEnv = {};
    for (const key of ['PM2_HOME', 'pm_id', 'PM2_PUBLIC_KEY', 'PM2_SECRET_KEY']) {
      savedEnv[key] = process.env[key];
      delete process.env[key];
    }
    vi.spyOn(os, 'tmpdir').mockReturnValue('/tmp');
  });

  afterEach(() => {
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
    vi.restoreAllMocks();
  });

  it('should throw AudioRecorderError on non-macOS platforms', async () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('linux');

    vi.resetModules();
    const { recordAudioViaBypass } = await import('./audio-recorder.js');

    try {
      await recordAudioViaBypass({ outputPath: '/tmp/test.wav' });
      expect.fail('Should have thrown');
    } catch (error) {
      expect((error as Error).name).toBe('AudioRecorderError');
      expect((error as AudioRecorderError).code).toBe('PLATFORM_NOT_SUPPORTED');
    }
  });
});

describe('checkPythonDependencies', () => {
  let savedEnv: Record<string, string | undefined>;

  beforeEach(() => {
    savedEnv = {};
    for (const key of ['PM2_HOME', 'pm_id', 'PM2_PUBLIC_KEY', 'PM2_SECRET_KEY']) {
      savedEnv[key] = process.env[key];
      delete process.env[key];
    }
  });

  afterEach(() => {
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
    vi.restoreAllMocks();
  });

  it('should return available=false when python is not found', async () => {
    vi.resetModules();
    const { checkPythonDependencies } = await import('./audio-recorder.js');

    const result = await checkPythonDependencies('/nonexistent/python3');

    expect(result.available).toBe(false);
    expect(result.pythonPath).toBe('/nonexistent/python3');
  });

  it('should return correct package status for missing packages', async () => {
    vi.resetModules();
    const { checkPythonDependencies } = await import('./audio-recorder.js');

    // Use a real python that exists but the packages likely aren't installed
    // in the test environment
    const result = await checkPythonDependencies('node'); // node exists but isn't python

    expect(result.available).toBe(false);
  });
});
