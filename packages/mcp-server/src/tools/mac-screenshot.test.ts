/**
 * Tests for macOS screenshot tools.
 *
 * Issue #2216: Phase 1 (Part 1/3) — Screen capture tests.
 * Tests mock shell commands so they work on any platform (not just macOS).
 *
 * @module mcp-server/tools/mac-screenshot.test
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  isMacOS,
  mac_screenshot,
  mac_calibrate,
} from './mac-screenshot.js';

// Mock node:child_process — promisified execFile used by the module
vi.mock('node:child_process', () => ({
  execFile: vi.fn(),
}));

// Mock node:fs/promises
vi.mock('node:fs/promises', () => ({
  readFile: vi.fn().mockResolvedValue(Buffer.from('fake-png-data')),
  unlink: vi.fn().mockResolvedValue(undefined),
}));

// Mock @disclaude/core logger
vi.mock('@disclaude/core', () => ({
  createLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
  }),
}));

// Import the mocked execFile after vi.mock
import { execFile } from 'node:child_process';

const mockExecFile = vi.mocked(execFile);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Make execFile succeed with given stdout/stderr.
 * The module uses promisify(execFile), which expects the callback form.
 */
function mockExecSuccess(stdout = '', stderr = '') {
  mockExecFile.mockImplementation(
    // @ts-expect-error — simplified mock for promisified callback form
    (_cmd: string, _args: string[], _opts: unknown, cb: Function) => {
      cb(null, { stdout, stderr });
    },
  );
}

/**
 * Make execFile fail with given error.
 */
function mockExecError(error: Error) {
  mockExecFile.mockImplementation(
    // @ts-expect-error — simplified mock for promisified callback form
    (_cmd: string, _args: string[], _opts: unknown, cb: Function) => {
      cb(error);
    },
  );
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('isMacOS', () => {
  it('should return a boolean based on process.platform', () => {
    expect(typeof isMacOS()).toBe('boolean');
  });
});

describe('mac_screenshot', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should return error on non-macOS platforms', async () => {
    if (process.platform !== 'darwin') {
      const result = await mac_screenshot();
      expect(result.success).toBe(false);
      expect(result.error).toContain('macOS');
    }
  });

  it('should take a screenshot with default options on macOS', async () => {
    if (process.platform !== 'darwin') { return; }

    mockExecSuccess('', '');
    const result = await mac_screenshot();

    expect(result.success).toBe(true);
    expect(result.filePath).toBeDefined();
    expect(result.message).toContain('Screenshot saved');
  });

  it('should take a screenshot with a specific region', async () => {
    if (process.platform !== 'darwin') { return; }

    mockExecSuccess('', '');
    const result = await mac_screenshot({
      region: { x: 0, y: 0, width: 800, height: 600 },
    });

    expect(result.success).toBe(true);
    expect(mockExecFile).toHaveBeenCalledWith(
      'screencapture',
      expect.arrayContaining(['-R', '0,0,800,600']),
      expect.any(Object),
    );
  });

  it('should include -C flag when cursor is false (default)', async () => {
    if (process.platform !== 'darwin') { return; }

    mockExecSuccess('', '');
    await mac_screenshot({ cursor: false });

    expect(mockExecFile).toHaveBeenCalledWith(
      'screencapture',
      expect.arrayContaining(['-C']),
      expect.any(Object),
    );
  });

  it('should not include -C flag when cursor is true', async () => {
    if (process.platform !== 'darwin') { return; }

    mockExecSuccess('', '');
    await mac_screenshot({ cursor: true });

    // When cursor=true, -C flag should NOT be present
    expect(mockExecFile).toHaveBeenCalledWith(
      'screencapture',
      expect.not.arrayContaining(['-C']),
      expect.any(Object),
    );
  });

  it('should capture a specific window by windowId', async () => {
    if (process.platform !== 'darwin') { return; }

    mockExecSuccess('', '');
    const result = await mac_screenshot({ windowId: 42 });

    expect(result.success).toBe(true);
    expect(mockExecFile).toHaveBeenCalledWith(
      'screencapture',
      expect.arrayContaining(['-l', '42']),
      expect.any(Object),
    );
  });

  it('should handle screenshot failure gracefully', async () => {
    if (process.platform !== 'darwin') { return; }

    mockExecError(new Error('screencapture: no such file or directory'));
    const result = await mac_screenshot();

    expect(result.success).toBe(false);
    expect(result.error).toContain('screencapture');
  });

  it('should always include -x flag (no sound)', async () => {
    if (process.platform !== 'darwin') { return; }

    mockExecSuccess('', '');
    await mac_screenshot();

    expect(mockExecFile).toHaveBeenCalledWith(
      'screencapture',
      expect.arrayContaining(['-x']),
      expect.any(Object),
    );
  });
});

describe('mac_calibrate', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should return error on non-macOS platforms', async () => {
    if (process.platform !== 'darwin') {
      const result = await mac_calibrate();
      expect(result.success).toBe(false);
      expect(result.error).toContain('macOS');
    }
  });

  it('should detect Retina display and calculate scale factor', async () => {
    if (process.platform !== 'darwin') { return; }

    // First call: system_profiler → returns Retina display info
    // Second call: osascript → returns logical size
    let callCount = 0;
    mockExecFile.mockImplementation(
      // @ts-expect-error — simplified mock
      (_cmd: string, _args: string[], _opts: unknown, cb: Function) => {
        callCount++;
        if (callCount === 1) {
          // system_profiler output
          cb(null, {
            stdout: 'Resolution: 2560 x 1600 Retina\n',
            stderr: '',
          });
        } else {
          // osascript output (logical size: 1280 x 800)
          cb(null, {
            stdout: '1280,800',
            stderr: '',
          });
        }
      },
    );

    const result = await mac_calibrate();

    expect(result.success).toBe(true);
    expect(result.scaleFactor).toBe(2);
    expect(result.screenWidth).toBe(2560);
    expect(result.screenHeight).toBe(1600);
    expect(result.logicalWidth).toBe(1280);
    expect(result.logicalHeight).toBe(800);
    expect(result.message).toContain('Retina');
  });

  it('should handle standard (non-Retina) display', async () => {
    if (process.platform !== 'darwin') { return; }

    let callCount = 0;
    mockExecFile.mockImplementation(
      // @ts-expect-error — simplified mock
      (_cmd: string, _args: string[], _opts: unknown, cb: Function) => {
        callCount++;
        if (callCount === 1) {
          cb(null, {
            stdout: 'Resolution: 1920 x 1080\n',
            stderr: '',
          });
        } else {
          cb(null, {
            stdout: '1920,1080',
            stderr: '',
          });
        }
      },
    );

    const result = await mac_calibrate();

    expect(result.success).toBe(true);
    expect(result.scaleFactor).toBe(1);
    expect(result.message).toContain('Standard');
  });

  it('should handle calibration failure gracefully', async () => {
    if (process.platform !== 'darwin') { return; }

    mockExecError(new Error('system_profiler: command not found'));
    const result = await mac_calibrate();

    expect(result.success).toBe(false);
    expect(result.error).toContain('system_profiler');
  });
});
