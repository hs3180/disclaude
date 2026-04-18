/**
 * Tests for mac-control/coordinates module.
 *
 * Tests Retina coordinate conversion logic.
 * Platform-dependent execFile calls are mocked since we run on Linux.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock child_process before importing the module
vi.mock('node:child_process', () => ({
  execFile: vi.fn(),
}));

import { execFile } from 'node:child_process';
import {
  getBackingScaleFactor,
  pixelToLogical,
  logicalToPixel,
  clearScaleCache,
  setScaleFactor,
} from '../coordinates.js';

const mockExecFile = vi.mocked(execFile);

/** Helper: mock that calls callback with success result. */
function mockOk(stdout: string): typeof mockExecFile {
  return ((..._args: any[]) => {
    const cb = _args.find((a: any) => typeof a === 'function');
    if (cb) {cb(null, { stdout, stderr: '' });}
    return {};
  }) as any;
}

/** Helper: mock that calls callback with error. */
function mockFail(msg: string): typeof mockExecFile {
  return ((..._args: any[]) => {
    const cb = _args.find((a: any) => typeof a === 'function');
    if (cb) {cb(new Error(msg));}
    return {};
  }) as any;
}

describe('coordinates', () => {
  beforeEach(() => {
    clearScaleCache();
    vi.clearAllMocks();
  });

  describe('getBackingScaleFactor', () => {
    it('should return 2 for Retina display (osascript)', async () => {
      mockExecFile.mockImplementation(mockOk('2.0\n'));

      const factor = await getBackingScaleFactor();
      expect(factor).toBe(2);
    });

    it('should fallback to system_profiler when osascript fails', async () => {
      let callCount = 0;
      mockExecFile.mockImplementation(((...args: any[]) => {
        callCount++;
        const cb = args.find((a: any) => typeof a === 'function');
        if (cb) {
          if (callCount === 1) {
            cb(new Error('osascript not available'));
          } else {
            cb(null, { stdout: 'Retina Display', stderr: '' });
          }
        }
        return {};
      }) as any);

      const factor = await getBackingScaleFactor();
      expect(factor).toBe(2);
    });

    it('should return 1 when neither osascript nor system_profiler detect Retina', async () => {
      mockExecFile.mockImplementation(mockFail('not available'));

      const factor = await getBackingScaleFactor();
      expect(factor).toBe(1);
    });

    it('should cache the result', async () => {
      mockExecFile.mockImplementation(mockOk('2.0\n'));

      await getBackingScaleFactor();
      await getBackingScaleFactor();
      await getBackingScaleFactor();

      // execFile should only be called once due to caching
      expect(mockExecFile).toHaveBeenCalledTimes(1);
    });
  });

  describe('setScaleFactor / clearScaleCache', () => {
    it('should use explicitly set scale factor', async () => {
      setScaleFactor(2);
      const factor = await getBackingScaleFactor();
      expect(factor).toBe(2);
      expect(mockExecFile).not.toHaveBeenCalled();
    });

    it('should re-query after clearing cache', async () => {
      setScaleFactor(2);
      clearScaleCache();

      mockExecFile.mockImplementation(mockOk('1\n'));

      const factor = await getBackingScaleFactor();
      expect(factor).toBe(1);
      expect(mockExecFile).toHaveBeenCalledTimes(1);
    });
  });

  describe('pixelToLogical', () => {
    it('should divide by Retina scale factor 2', async () => {
      setScaleFactor(2);
      const [lx, ly] = await pixelToLogical(1000, 600);
      expect(lx).toBe(500);
      expect(ly).toBe(300);
    });

    it('should return same values for non-Retina (factor 1)', async () => {
      setScaleFactor(1);
      const [lx, ly] = await pixelToLogical(1000, 600);
      expect(lx).toBe(1000);
      expect(ly).toBe(600);
    });

    it('should round to nearest integer', async () => {
      setScaleFactor(2);
      const [lx, ly] = await pixelToLogical(1001, 599);
      expect(lx).toBe(501); // rounds
      expect(ly).toBe(300);
    });
  });

  describe('logicalToPixel', () => {
    it('should multiply by Retina scale factor 2', async () => {
      setScaleFactor(2);
      const [px, py] = await logicalToPixel(500, 300);
      expect(px).toBe(1000);
      expect(py).toBe(600);
    });

    it('should return same values for non-Retina (factor 1)', async () => {
      setScaleFactor(1);
      const [px, py] = await logicalToPixel(500, 300);
      expect(px).toBe(500);
      expect(py).toBe(300);
    });
  });

  describe('round-trip conversion', () => {
    it('should maintain consistency: pixel→logical→pixel', async () => {
      setScaleFactor(2);
      const [lx, ly] = await pixelToLogical(1000, 600);
      const [px, py] = await logicalToPixel(lx, ly);
      expect(px).toBe(1000);
      expect(py).toBe(600);
    });
  });
});
