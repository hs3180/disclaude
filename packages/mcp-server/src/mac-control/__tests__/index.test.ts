/**
 * Integration tests for MacControl main class.
 *
 * Tests the unified MacControl API with mocked sub-modules.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock all sub-modules
vi.mock('node:child_process', () => ({
  execFile: vi.fn(),
}));

vi.mock('node:fs/promises', () => ({
  readFile: vi.fn(),
  unlink: vi.fn(),
}));

vi.mock('../coordinates.js', () => ({
  pixelToLogical: vi.fn(async (px: number, py: number) => await Promise.resolve([px / 2, py / 2])),
  logicalToPixel: vi.fn(async (lx: number, ly: number) => await Promise.resolve([lx * 2, ly * 2])),
  getBackingScaleFactor: vi.fn(async () => await Promise.resolve(2)),
  clearScaleCache: vi.fn(),
  setScaleFactor: vi.fn(),
}));

vi.mock('../screenshot.js', () => ({
  captureScreenshot: vi.fn(),
}));

vi.mock('../mouse.js', () => ({
  click: vi.fn(),
  doubleClick: vi.fn(),
  rightClick: vi.fn(),
  drag: vi.fn(),
  move: vi.fn(),
  getMousePosition: vi.fn(),
}));

vi.mock('../keyboard.js', () => ({
  typeText: vi.fn(),
  pressKey: vi.fn(),
}));

import { execFile } from 'node:child_process';
import { MacControl } from '../index.js';
import { captureScreenshot } from '../screenshot.js';
import { click, doubleClick, rightClick, drag, move, getMousePosition } from '../mouse.js';
import { typeText, pressKey } from '../keyboard.js';
import { pixelToLogical } from '../coordinates.js';

const mockCaptureScreenshot = vi.mocked(captureScreenshot);
const mockClick = vi.mocked(click);
const mockDoubleClick = vi.mocked(doubleClick);
const mockRightClick = vi.mocked(rightClick);
const mockDrag = vi.mocked(drag);
const mockMove = vi.mocked(move);
const mockGetMousePosition = vi.mocked(getMousePosition);
const mockTypeText = vi.mocked(typeText);
const mockPressKey = vi.mocked(pressKey);
const mockExecFile = vi.mocked(execFile);
const mockPixelToLogical = vi.mocked(pixelToLogical);

/** Helper: mock that calls callback with success result. */
function mockOk(stdout = ''): typeof mockExecFile {
  return ((...args: any[]) => {
    const cb = args.find((a: any) => typeof a === 'function');
    if (cb) {cb(null, { stdout, stderr: '' });}
    return {};
  }) as any;
}

/** Helper: mock that calls callback with error. */
function mockFail(): typeof mockExecFile {
  return ((...args: any[]) => {
    const cb = args.find((a: any) => typeof a === 'function');
    if (cb) {cb(new Error('Not available'));}
    return {};
  }) as any;
}

describe('MacControl', () => {
  let mac: MacControl;

  beforeEach(() => {
    vi.clearAllMocks();
    mac = new MacControl();
  });

  describe('screenshot', () => {
    it('should delegate to captureScreenshot', async () => {
      mockCaptureScreenshot.mockResolvedValue({
        success: true,
        buffer: Buffer.from('png'),
      });

      const result = await mac.screenshot({ cursor: true });

      expect(result.success).toBe(true);
      expect(mockCaptureScreenshot).toHaveBeenCalledWith({ cursor: true });
    });
  });

  describe('mouse operations', () => {
    it('click should delegate to mouse.click', async () => {
      await mac.click(500, 300);
      expect(mockClick).toHaveBeenCalledWith(500, 300, undefined);
    });

    it('click should pass options', async () => {
      await mac.click(500, 300, { button: 'right' });
      expect(mockClick).toHaveBeenCalledWith(500, 300, { button: 'right' });
    });

    it('doubleClick should delegate', async () => {
      await mac.doubleClick(500, 300);
      expect(mockDoubleClick).toHaveBeenCalledWith(500, 300);
    });

    it('rightClick should delegate', async () => {
      await mac.rightClick(500, 300);
      expect(mockRightClick).toHaveBeenCalledWith(500, 300);
    });

    it('drag should delegate with options', async () => {
      await mac.drag({ x: 100, y: 200 }, { x: 300, y: 400 }, { duration: 1 });
      expect(mockDrag).toHaveBeenCalledWith(
        { x: 100, y: 200 }, { x: 300, y: 400 }, { duration: 1 },
      );
    });

    it('move should delegate', async () => {
      await mac.move(500, 300);
      expect(mockMove).toHaveBeenCalledWith(500, 300);
    });

    it('getMousePosition should delegate', async () => {
      mockGetMousePosition.mockResolvedValue({ x: 500, y: 300 });
      const pos = await mac.getMousePosition();
      expect(pos).toEqual({ x: 500, y: 300 });
    });
  });

  describe('keyboard operations', () => {
    it('type should delegate to typeText', async () => {
      await mac.type('hello', { interval: 10 });
      expect(mockTypeText).toHaveBeenCalledWith('hello', { interval: 10 });
    });

    it('key should delegate to pressKey', async () => {
      await mac.key('return');
      expect(mockPressKey).toHaveBeenCalledWith('return', undefined);
    });

    it('shortcut should delegate to pressKey with modifiers', async () => {
      await mac.shortcut('v', ['cmd']);
      expect(mockPressKey).toHaveBeenCalledWith('v', ['cmd']);
    });
  });

  describe('application operations', () => {
    it('activateApp should call osascript', async () => {
      mockExecFile.mockImplementation(mockOk());

      await mac.activateApp('Feishu');

      const [call] = mockExecFile.mock.calls;
      expect(call[0]).toBe('osascript');
      const script = call[1]?.join(' ') ?? '';
      expect(script).toContain('Feishu');
      expect(script).toContain('activate');
    });

    it('getFrontmostApp should parse app info', async () => {
      mockExecFile.mockImplementation(mockOk('Feishu|com.bytedance.lark|100,200,900,700'));

      const info = await mac.getFrontmostApp();
      expect(info.name).toBe('Feishu');
      expect(info.bundleId).toBe('com.bytedance.lark');
      expect(info.frontmost).toBe(true);
      expect(info.windowBounds).toEqual({
        x: 100, y: 200, width: 800, height: 500,
      });
    });
  });

  describe('clickAtPixel', () => {
    it('should convert pixel to logical and click', async () => {
      await mac.clickAtPixel(1000, 600);

      // pixelToLogical should have been called
      expect(mockPixelToLogical).toHaveBeenCalledWith(1000, 600);
      // click should have been called with logical coordinates
      expect(mockClick).toHaveBeenCalledWith(500, 300, undefined);
    });

    it('should pass click options', async () => {
      await mac.clickAtPixel(1000, 600, { clickCount: 2 });

      expect(mockClick).toHaveBeenCalledWith(500, 300, { clickCount: 2 });
    });
  });

  describe('queryElements', () => {
    it('should return empty array on osascript failure', async () => {
      mockExecFile.mockImplementation(mockFail());

      const elements = await mac.queryElements();
      expect(elements).toEqual([]);
    });
  });
});
