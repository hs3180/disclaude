/**
 * Tests for mac-control/screenshot module.
 *
 * Mocks child_process and fs operations since screencapture
 * is macOS-specific.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('node:child_process', () => ({
  execFile: vi.fn(),
}));

vi.mock('node:fs/promises', () => ({
  readFile: vi.fn(),
  unlink: vi.fn(),
}));

import { execFile } from 'node:child_process';
import { readFile, unlink } from 'node:fs/promises';
import { captureScreenshot, parseRectArg } from '../screenshot.js';

const mockExecFile = vi.mocked(execFile);
const mockReadFile = vi.mocked(readFile);
const mockUnlink = vi.mocked(unlink);

/** Helper: mock that calls callback with success result. */
function mockOk(stdout = ''): typeof mockExecFile {
  return ((...args: any[]) => {
    const cb = args.find((a: any) => typeof a === 'function');
    if (cb) {cb(null, { stdout, stderr: '' });}
    return {};
  }) as any;
}

/** Helper: mock that calls callback with error. */
function mockFail(msg: string): typeof mockExecFile {
  return ((...args: any[]) => {
    const cb = args.find((a: any) => typeof a === 'function');
    if (cb) {cb(new Error(msg));}
    return {};
  }) as any;
}

/** Helper: mock that inspects args and calls callback with success. */
function mockInspect(fn: (args: string[]) => void): typeof mockExecFile {
  return ((...args: any[]) => {
    fn(args[1] as unknown as string[]);
    const cb = args.find((a: any) => typeof a === 'function');
    if (cb) {cb(null, { stdout: '', stderr: '' });}
    return {};
  }) as any;
}

describe('screenshot', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('captureScreenshot', () => {
    it('should capture full screenshot to buffer', async () => {
      const fakePng = Buffer.from('fake-png-data');

      mockExecFile.mockImplementation(mockOk());
      mockReadFile.mockResolvedValue(fakePng);
      mockUnlink.mockResolvedValue();

      const result = await captureScreenshot();

      expect(result.success).toBe(true);
      expect(result.buffer).toBe(fakePng);
      // Should clean up temp file
      expect(mockUnlink).toHaveBeenCalled();
    });

    it('should capture to specified filePath', async () => {
      mockExecFile.mockImplementation(mockOk());

      const result = await captureScreenshot({ filePath: '/tmp/test.png' });

      expect(result.success).toBe(true);
      expect(result.filePath).toBe('/tmp/test.png');
      // Should NOT read file into buffer when filePath is specified
      expect(mockReadFile).not.toHaveBeenCalled();
    });

    it('should pass region argument to screencapture', async () => {
      mockExecFile.mockImplementation(mockInspect((args) => {
        expect(args).toContain('-R');
        const rIdx = args.indexOf('-R');
        expect(args[rIdx + 1]).toBe('100,200,500,300');
      }));

      mockReadFile.mockResolvedValue(Buffer.from('png'));
      mockUnlink.mockResolvedValue();

      await captureScreenshot({
        region: { x: 100, y: 200, width: 500, height: 300 },
      });
    });

    it('should pass cursor flag when requested', async () => {
      mockExecFile.mockImplementation(mockInspect((args) => {
        expect(args).toContain('-C');
      }));

      mockReadFile.mockResolvedValue(Buffer.from('png'));
      mockUnlink.mockResolvedValue();

      await captureScreenshot({ cursor: true });
    });

    it('should return error on screencapture failure', async () => {
      mockExecFile.mockImplementation(mockFail('screencapture: cannot execute'));

      const result = await captureScreenshot({ filePath: '/tmp/test.png' });

      expect(result.success).toBe(false);
      expect(result.error).toContain('screencapture');
    });

    it('should use -x flag (no sound) by default', async () => {
      mockExecFile.mockImplementation(mockInspect((args) => {
        expect(args).toContain('-x');
      }));

      mockReadFile.mockResolvedValue(Buffer.from('png'));
      mockUnlink.mockResolvedValue();

      await captureScreenshot();
    });
  });

  describe('parseRectArg', () => {
    it('should parse valid rect string', () => {
      const rect = parseRectArg('100,200,500,300');
      expect(rect).toEqual({ x: 100, y: 200, width: 500, height: 300 });
    });

    it('should return null for invalid format', () => {
      expect(parseRectArg('invalid')).toBeNull();
      expect(parseRectArg('1,2,3')).toBeNull(); // missing dimension
      expect(parseRectArg('1,2,a,4')).toBeNull(); // non-numeric
    });
  });
});
