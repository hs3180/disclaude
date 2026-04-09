/**
 * Tests for the macOS screen control module.
 *
 * Since these tests run in CI (Linux containers) and not on actual macOS,
 * all tests use mocked child_process calls to verify correct command generation
 * and error handling behavior.
 *
 * Issue #2216: Mac 屏幕控制能力 - 辅助功能自动化模块
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock child_process before importing the module
const mockExecFile = vi.fn();
vi.mock('child_process', () => ({
  execFile: (...args: unknown[]) => mockExecFile(...args),
}));

// promisify should pass through if the function returns a promise
vi.mock('util', () => ({
  promisify: (fn: unknown) => {
    return (...args: unknown[]) => {
      const result = (fn as Function)(...args);
      if (result && typeof result.then === 'function') return result;
      return Promise.resolve(result);
    };
  },
}));

vi.mock('fs/promises', () => ({
  readFile: vi.fn(),
  unlink: vi.fn(),
}));

// Import after mocks are set up
import { parsePngDimensions, MacControlError } from './screen-capture.js';
import {
  click, move, drag, doubleClick, rightClick,
} from './mouse-control.js';
import { getAppWindow, activateApp, listAppWindows, getScreenResolution } from './window-info.js';
import { calibrate, pixelToLogical, logicalToPixel, pixelToWindowRelative, clearCalibrationCache } from './calibration.js';

// Helper to create a minimal valid PNG buffer
function createPngBuffer(width: number, height: number): Buffer {
  const buf = Buffer.alloc(28);
  // PNG signature
  buf[0] = 0x89; buf[1] = 0x50; buf[2] = 0x4E; buf[3] = 0x47;
  buf[4] = 0x0D; buf[5] = 0x0A; buf[6] = 0x1A; buf[7] = 0x0A;
  // IHDR chunk: length(4) + "IHDR"(4) + width(4) + height(4)
  buf.writeUInt32BE(13, 8);  // chunk length
  buf[12] = 0x49; buf[13] = 0x48; buf[14] = 0x44; buf[15] = 0x52; // "IHDR"
  buf.writeUInt32BE(width, 16);
  buf.writeUInt32BE(height, 20);
  return buf;
}

describe('parsePngDimensions', () => {
  it('should parse PNG dimensions correctly', () => {
    const buf = createPngBuffer(2560, 1600);
    const result = parsePngDimensions(buf);
    expect(result).toEqual({ width: 2560, height: 1600 });
  });

  it('should throw for invalid PNG signature', () => {
    const buf = Buffer.alloc(24, 0);
    expect(() => parsePngDimensions(buf)).toThrow(MacControlError);
    expect(() => parsePngDimensions(buf)).toThrow('signature mismatch');
  });

  it('should throw for buffer that is too short', () => {
    const buf = Buffer.alloc(10);
    buf[0] = 0x89; buf[1] = 0x50; buf[2] = 0x4E; buf[3] = 0x47;
    expect(() => parsePngDimensions(buf)).toThrow(MacControlError);
  });

  it('should parse large Retina dimensions', () => {
    const buf = createPngBuffer(5120, 3200);
    const result = parsePngDimensions(buf);
    expect(result).toEqual({ width: 5120, height: 3200 });
  });
});

describe('MacControlError', () => {
  it('should have correct name and message', () => {
    const error = new MacControlError('test error');
    expect(error.name).toBe('MacControlError');
    expect(error.message).toBe('test error');
  });

  it('should preserve cause', () => {
    const cause = new Error('original');
    const error = new MacControlError('wrapped', cause);
    expect(error.cause).toBe(cause);
  });
});

describe('calibration', () => {
  const originalPlatform = process.platform;

  beforeEach(() => {
    clearCalibrationCache();
    // Mock platform as macOS for calibration tests
    Object.defineProperty(process, 'platform', { value: 'darwin', writable: true });
  });

  afterEach(() => {
    Object.defineProperty(process, 'platform', { value: originalPlatform, writable: true });
  });

  it('should calculate scale factor from screenshot dimensions', async () => {
    // Mock getScreenResolution to return logical resolution
    mockExecFile.mockImplementation((_cmd: string, _args: string[]) => {
      if (_args[0] === 'which') {
        return Promise.resolve({ stdout: '/usr/bin/osascript', stderr: '' });
      }
      // osascript for getScreenResolution fallback
      return Promise.resolve({ stdout: '2560,1600', stderr: '' });
    });

    const screenshot = {
      filePath: '/tmp/test.png',
      width: 5120,
      height: 3200,
      buffer: createPngBuffer(5120, 3200),
    };

    const result = await calibrate(screenshot);
    expect(result.scaleFactor).toBe(2);
    expect(result.screenResolution.width).toBe(2560);
    expect(result.screenResolution.height).toBe(1600);
    expect(result.calibratedAt).toBeGreaterThan(0);
  });

  it('should detect scale factor 1.0 for non-Retina', async () => {
    mockExecFile.mockImplementation((_cmd: string, _args: string[]) => {
      return Promise.resolve({ stdout: '1920,1080', stderr: '' });
    });

    const screenshot = {
      filePath: '/tmp/test.png',
      width: 1920,
      height: 1080,
      buffer: createPngBuffer(1920, 1080),
    };

    const result = await calibrate(screenshot);
    expect(result.scaleFactor).toBe(1);
  });

  it('should cache calibration result', async () => {
    mockExecFile.mockImplementation((_cmd: string, _args: string[]) => {
      return Promise.resolve({ stdout: '2560,1600', stderr: '' });
    });

    const screenshot = {
      filePath: '/tmp/test.png',
      width: 5120,
      height: 3200,
      buffer: createPngBuffer(5120, 3200),
    };

    const { getCachedCalibration } = await import('./calibration.js');
    expect(getCachedCalibration()).toBeNull();

    await calibrate(screenshot);
    const cached = getCachedCalibration();
    expect(cached).not.toBeNull();
    expect(cached!.scaleFactor).toBe(2);
  });

  it('should throw when screenshot is smaller than screen', async () => {
    mockExecFile.mockImplementation((_cmd: string, _args: string[]) => {
      return Promise.resolve({ stdout: '2560,1600', stderr: '' });
    });

    const screenshot = {
      filePath: '/tmp/test.png',
      width: 100,
      height: 100,
      buffer: createPngBuffer(100, 100),
    };

    await expect(calibrate(screenshot)).rejects.toThrow(MacControlError);
    await expect(calibrate(screenshot)).rejects.toThrow('Invalid scale factor');
  });
});

describe('coordinate conversion', () => {
  const calibration = {
    scaleFactor: 2,
    screenResolution: { x: 0, y: 0, width: 2560, height: 1600 },
    calibratedAt: Date.now(),
  };

  it('should convert pixel to logical coordinates', () => {
    expect(pixelToLogical(5120, 3200, calibration)).toEqual({ x: 2560, y: 1600 });
    expect(pixelToLogical(100, 50, calibration)).toEqual({ x: 50, y: 25 });
  });

  it('should convert logical to pixel coordinates', () => {
    expect(logicalToPixel(2560, 1600, calibration)).toEqual({ x: 5120, y: 3200 });
    expect(logicalToPixel(50, 25, calibration)).toEqual({ x: 100, y: 50 });
  });

  it('should handle scale factor 1', () => {
    const cal1 = { ...calibration, scaleFactor: 1 };
    expect(pixelToLogical(1920, 1080, cal1)).toEqual({ x: 1920, y: 1080 });
    expect(logicalToPixel(1920, 1080, cal1)).toEqual({ x: 1920, y: 1080 });
  });

  it('should convert pixel to window-relative coordinates', () => {
    const windowBounds = { x: 100, y: 100, width: 1200, height: 800 };
    expect(pixelToWindowRelative(400, 300, windowBounds, calibration)).toEqual({
      x: 100,
      y: 50,
    });
  });
});

describe('mouse-control (platform check)', () => {
  const originalPlatform = process.platform;

  afterEach(() => {
    Object.defineProperty(process, 'platform', { value: originalPlatform, writable: true });
  });

  it('should throw on non-macOS for click', async () => {
    Object.defineProperty(process, 'platform', { value: 'linux' });
    await expect(click(100, 200)).rejects.toThrow(MacControlError);
    await expect(click(100, 200)).rejects.toThrow('only supported on macOS');
  });

  it('should throw on non-macOS for move', async () => {
    Object.defineProperty(process, 'platform', { value: 'linux' });
    await expect(move(100, 200)).rejects.toThrow(MacControlError);
  });

  it('should throw on non-macOS for drag', async () => {
    Object.defineProperty(process, 'platform', { value: 'linux' });
    await expect(drag({ x: 0, y: 0 }, { x: 100, y: 100 })).rejects.toThrow(MacControlError);
  });

  it('should throw on non-macOS for doubleClick', async () => {
    Object.defineProperty(process, 'platform', { value: 'linux' });
    await expect(doubleClick(100, 200)).rejects.toThrow(MacControlError);
  });

  it('should throw on non-macOS for rightClick', async () => {
    Object.defineProperty(process, 'platform', { value: 'linux' });
    await expect(rightClick(100, 200)).rejects.toThrow(MacControlError);
  });
});

describe('window-info (platform check)', () => {
  const originalPlatform = process.platform;

  afterEach(() => {
    Object.defineProperty(process, 'platform', { value: originalPlatform, writable: true });
  });

  it('should throw on non-macOS for getAppWindow', async () => {
    Object.defineProperty(process, 'platform', { value: 'linux' });
    await expect(getAppWindow('Feishu')).rejects.toThrow(MacControlError);
  });

  it('should throw on non-macOS for activateApp', async () => {
    Object.defineProperty(process, 'platform', { value: 'linux' });
    await expect(activateApp('Feishu')).rejects.toThrow(MacControlError);
  });

  it('should throw on non-macOS for listAppWindows', async () => {
    Object.defineProperty(process, 'platform', { value: 'linux' });
    await expect(listAppWindows('Feishu')).rejects.toThrow(MacControlError);
  });

  it('should throw on non-macOS for getScreenResolution', async () => {
    Object.defineProperty(process, 'platform', { value: 'linux' });
    await expect(getScreenResolution()).rejects.toThrow(MacControlError);
  });
});

describe('types', () => {
  it('should export correct CLICK_BUTTON_MAP', async () => {
    const { CLICK_BUTTON_MAP } = await import('./types.js');
    expect(CLICK_BUTTON_MAP.left).toBe('');
    expect(CLICK_BUTTON_MAP.right).toBe('rc');
    expect(CLICK_BUTTON_MAP.middle).toBe('mc');
  });

  it('should export correct MODIFIER_MAP', async () => {
    const { MODIFIER_MAP } = await import('./types.js');
    expect(MODIFIER_MAP.cmd).toBe('cmd');
    expect(MODIFIER_MAP.shift).toBe('shift');
    expect(MODIFIER_MAP.alt).toBe('alt');
    expect(MODIFIER_MAP.ctrl).toBe('ctrl');
  });
});
