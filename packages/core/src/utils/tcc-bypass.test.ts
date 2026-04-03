/**
 * Tests for macOS TCC bypass utility.
 *
 * Issue #1957: PM2 process chain causes macOS TCC to silently deny
 * microphone and other permissions. This module provides utilities
 * to spawn commands in independent Terminal.app contexts.
 *
 * All tests are pure unit tests — no actual Terminal.app or osascript
 * calls are made. The `child_process.execFile` module is mocked using
 * callback-style mocks compatible with `promisify`.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  isMacOS,
  isRunningUnderPm2,
  tccBypassStatus,
  escapeAppleScriptString,
  spawnOutsideProcessChain,
  buildStatusScript,
  readStatusFile,
  waitForStatusFile,
} from './tcc-bypass.js';

// Mock child_process to avoid actual subprocess spawning.
// IMPORTANT: execFile must use callback-style since the source code
// wraps it with promisify(). Using mockResolvedValue/mockRejectedValue
// causes promisify to double-wrap and hang.
vi.mock('node:child_process', () => ({
  execFile: vi.fn(),
}));

// Mock node:fs/promises for readStatusFile tests
vi.mock('node:fs/promises', () => ({
  readFile: vi.fn(),
}));

import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';

const mockedExecFile = vi.mocked(execFile);
const mockedReadFile = vi.mocked(readFile);

/**
 * Helper: mock execFile to succeed with callback pattern.
 */
function mockExecFileSuccess(stdout = '', stderr = '') {
  mockedExecFile.mockImplementation(
    (cmd: string, args: string[], opts: unknown, callback: Function) => {
      callback(null, { stdout, stderr });
    }
  );
}

/**
 * Helper: mock execFile to fail with callback pattern.
 */
function mockExecFileError(error: Error) {
  mockedExecFile.mockImplementation(
    (cmd: string, args: string[], opts: unknown, callback: Function) => {
      callback(error);
    }
  );
}

describe('isMacOS', () => {
  const originalPlatform = process.platform;

  afterEach(() => {
    Object.defineProperty(process, 'platform', { value: originalPlatform });
  });

  it('should return true on darwin platform', () => {
    Object.defineProperty(process, 'platform', { value: 'darwin' });
    expect(isMacOS()).toBe(true);
  });

  it('should return false on linux platform', () => {
    Object.defineProperty(process, 'platform', { value: 'linux' });
    expect(isMacOS()).toBe(false);
  });

  it('should return false on win32 platform', () => {
    Object.defineProperty(process, 'platform', { value: 'win32' });
    expect(isMacOS()).toBe(false);
  });
});

describe('isRunningUnderPm2', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it('should return true when PM2_HOME is set', () => {
    process.env.PM2_HOME = '/home/user/.pm2';
    expect(isRunningUnderPm2()).toBe(true);
  });

  it('should return true when pm_id is set', () => {
    delete process.env.PM2_HOME;
    process.env.pm_id = '0';
    expect(isRunningUnderPm2()).toBe(true);
  });

  it('should return false when no PM2 env vars are set', () => {
    delete process.env.PM2_HOME;
    delete process.env.pm_id;
    expect(isRunningUnderPm2()).toBe(false);
  });
});

describe('tccBypassStatus', () => {
  const originalPlatform = process.platform;
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    Object.defineProperty(process, 'platform', { value: originalPlatform });
    process.env = originalEnv;
  });

  it('should return not needed on non-macOS', () => {
    Object.defineProperty(process, 'platform', { value: 'linux' });
    const status = tccBypassStatus();
    expect(status.needed).toBe(false);
    expect(status.available).toBe(false);
    expect(status.reason).toContain('linux');
  });

  it('should return not needed on macOS without PM2', () => {
    Object.defineProperty(process, 'platform', { value: 'darwin' });
    delete process.env.PM2_HOME;
    delete process.env.pm_id;
    const status = tccBypassStatus();
    expect(status.needed).toBe(false);
    expect(status.available).toBe(true);
    expect(status.reason).toContain('Not running under PM2');
  });

  it('should return needed on macOS with PM2', () => {
    Object.defineProperty(process, 'platform', { value: 'darwin' });
    process.env.PM2_HOME = '/home/user/.pm2';
    const status = tccBypassStatus();
    expect(status.needed).toBe(true);
    expect(status.available).toBe(true);
    expect(status.reason).toContain('PM2');
    expect(status.reason).toContain('TCC');
  });
});

describe('escapeAppleScriptString', () => {
  it('should escape double quotes', () => {
    expect(escapeAppleScriptString('echo "hello"')).toBe('echo \\"hello\\"');
  });

  it('should escape backslashes', () => {
    expect(escapeAppleScriptString('path\\to\\file')).toBe('path\\\\to\\\\file');
  });

  it('should escape both backslashes and double quotes', () => {
    // Input: echo "path\to\"
    // After escaping \: echo "path\\to\\"
    // After escaping ": echo \"path\\to\\\"
    expect(escapeAppleScriptString('echo "path\\to\\"')).toBe('echo \\"path\\\\to\\\\\\"');
  });

  it('should return unchanged string when no escaping needed', () => {
    expect(escapeAppleScriptString('python3 record.py')).toBe('python3 record.py');
  });

  it('should handle empty string', () => {
    expect(escapeAppleScriptString('')).toBe('');
  });
});

describe('spawnOutsideProcessChain', () => {
  beforeEach(() => {
    mockedExecFile.mockReset();
    Object.defineProperty(process, 'platform', { value: 'darwin' });
  });

  afterEach(() => {
    Object.defineProperty(process, 'platform', { value: process.platform });
  });

  it('should reject on non-macOS platforms', async () => {
    Object.defineProperty(process, 'platform', { value: 'linux' });
    const result = await spawnOutsideProcessChain('python3 test.py');
    expect(result.success).toBe(false);
    expect(result.message).toContain('linux');
    expect(mockedExecFile).not.toHaveBeenCalled();
  });

  it('should call osascript with correct AppleScript on macOS', async () => {
    mockExecFileSuccess();

    const result = await spawnOutsideProcessChain('python3 record.py --output /tmp/audio.wav');

    expect(result.success).toBe(true);
    expect(result.message).toContain('Terminal.app');
    expect(mockedExecFile).toHaveBeenCalledTimes(1);

    // Verify osascript was called with correct arguments
    expect(mockedExecFile).toHaveBeenCalledWith(
      'osascript',
      ['-e', expect.stringContaining('do script')],
      expect.objectContaining({ timeout: 10000 }),
      expect.any(Function)
    );
    // Verify the command is embedded in the AppleScript
    const scriptArg = mockedExecFile.mock.calls[0][1][1]; // eslint-disable-line prefer-destructuring
    expect(scriptArg).toContain('python3 record.py --output /tmp/audio.wav');
  });

  it('should escape special characters in command', async () => {
    mockExecFileSuccess();

    await spawnOutsideProcessChain('echo "hello world"');

    // Verify quotes are escaped in the AppleScript string
    const scriptArg = mockedExecFile.mock.calls[0][1][1]; // eslint-disable-line prefer-destructuring
    expect(scriptArg).toContain('\\"hello world\\"');
  });

  it('should return error when osascript fails', async () => {
    mockExecFileError(new Error('osascript: Terminal.app not found'));

    const result = await spawnOutsideProcessChain('python3 test.py');

    expect(result.success).toBe(false);
    expect(result.message).toContain('Failed to launch');
    expect(result.message).toContain('Terminal.app not found');
  });

  it('should use open command when useOpen option is true', async () => {
    mockExecFileSuccess();

    const result = await spawnOutsideProcessChain('python3 record.py', { useOpen: true });

    expect(result.success).toBe(true);
    expect(result.message).toContain('open');

    expect(mockedExecFile).toHaveBeenCalledWith(
      'open',
      expect.arrayContaining(['-a', 'Terminal']),
      expect.any(Object),
      expect.any(Function)
    );
  });

  it('should pass timeout option to execFile', async () => {
    mockExecFileSuccess();

    await spawnOutsideProcessChain('python3 test.py', { timeoutMs: 5000 });

    expect(mockedExecFile).toHaveBeenCalledWith(
      'osascript',
      expect.any(Array),
      expect.objectContaining({ timeout: 5000 }),
      expect.any(Function)
    );
  });
});

describe('buildStatusScript', () => {
  it('should build script with status file only', () => {
    const script = buildStatusScript('python3 record.py', '/tmp/status');
    expect(script).toBe('python3 record.py; echo $? > "/tmp/status"');
  });

  it('should build script with status file and output file', () => {
    const script = buildStatusScript('python3 record.py', '/tmp/status', '/tmp/output');
    expect(script).toBe('python3 record.py > "/tmp/output" 2>&1; echo $? > "/tmp/status"');
  });

  it('should handle commands with special characters', () => {
    const script = buildStatusScript('echo "hello"', '/tmp/status', '/tmp/out');
    expect(script).toContain('echo "hello"');
    expect(script).toContain('> "/tmp/out" 2>&1');
    expect(script).toContain('echo $? > "/tmp/status"');
  });
});

describe('readStatusFile', () => {
  beforeEach(() => {
    mockedReadFile.mockReset();
  });

  it('should return exit code when file exists', async () => {
    mockedReadFile.mockResolvedValue('0\n');
    expect(await readStatusFile('/tmp/status')).toBe(0);
  });

  it('should return non-zero exit code', async () => {
    mockedReadFile.mockResolvedValue('1\n');
    expect(await readStatusFile('/tmp/status')).toBe(1);
  });

  it('should return undefined when file does not exist', async () => {
    mockedReadFile.mockRejectedValue(new Error('ENOENT'));
    expect(await readStatusFile('/tmp/nonexistent')).toBeUndefined();
  });

  it('should return undefined for non-numeric content', async () => {
    mockedReadFile.mockResolvedValue('not a number');
    expect(await readStatusFile('/tmp/bad_status')).toBeUndefined();
  });
});

describe('waitForStatusFile', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    mockedReadFile.mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('should return exit code when status file becomes available', async () => {
    // First call: file not found, second call: file found with code 0
    mockedReadFile
      .mockRejectedValueOnce(new Error('ENOENT'))
      .mockResolvedValueOnce('0\n');

    const promise = waitForStatusFile('/tmp/status', {
      intervalMs: 100,
      timeoutMs: 5000,
    });

    // Advance time by 100ms for first poll
    await vi.advanceTimersByTimeAsync(100);

    const result = await promise;
    expect(result).toBe(0);
  });

  it('should return undefined on timeout', async () => {
    mockedReadFile.mockRejectedValue(new Error('ENOENT'));

    const promise = waitForStatusFile('/tmp/status', {
      intervalMs: 100,
      timeoutMs: 300,
    });

    await vi.advanceTimersByTimeAsync(400);

    const result = await promise;
    expect(result).toBeUndefined();
  });
});
