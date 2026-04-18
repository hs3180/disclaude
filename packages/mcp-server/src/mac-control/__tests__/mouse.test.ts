/**
 * Tests for mac-control/mouse module.
 *
 * Shell commands are mocked since osascript/python3 are macOS-specific.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('node:child_process', () => ({
  execFile: vi.fn(),
}));

import { execFile } from 'node:child_process';
import { click, doubleClick, rightClick, move, getMousePosition } from '../mouse.js';

const mockExecFile = vi.mocked(execFile);

/** Helper: mock that calls callback with success result. */
function mockOk(stdout = ''): typeof mockExecFile {
  return ((...args: any[]) => {
    const cb = args.find((a: any) => typeof a === 'function');
    if (cb) {cb(null, { stdout, stderr: '' });}
    return {};
  }) as any;
}

/** Helper: mock that calls callback with error on first call, success on subsequent. */
function mockFirstFail(msg: string, failCmd: string): typeof mockExecFile {
  let callCount = 0;
  return ((...args: any[]) => {
    callCount++;
    const cb = args.find((a: any) => typeof a === 'function');
    const [cmd] = args;
    if (cb) {
      if (callCount === 1 && cmd === failCmd) {
        cb(new Error(msg));
      } else {
        cb(null, { stdout: '', stderr: '' });
      }
    }
    return {};
  }) as any;
}

describe('mouse', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('click', () => {
    it('should use AppleScript for single left click', async () => {
      mockExecFile.mockImplementation(mockOk());

      await click(500, 300);

      // First call should be osascript
      const [call] = mockExecFile.mock.calls;
      expect(call[0]).toBe('osascript');
      const script = call[1]?.join(' ') ?? '';
      expect(script).toContain('500');
      expect(script).toContain('300');
      expect(script).toContain('click at');
    });

    it('should fall back to CGEvent on AppleScript failure', async () => {
      mockExecFile.mockImplementation(mockFirstFail('System Events error', 'osascript'));

      await click(500, 300);

      // Should have tried both osascript and python3
      const commands = mockExecFile.mock.calls.map(c => c[0]);
      expect(commands).toContain('osascript');
      expect(commands).toContain('python3');
    });
  });

  describe('doubleClick', () => {
    it('should call CGEvent with clickCount 2', async () => {
      mockExecFile.mockImplementation(mockOk());

      await doubleClick(500, 300);

      // Should use python3 (CGEvent) for double click
      const [call] = mockExecFile.mock.calls;
      expect(call[0]).toBe('python3');
      const script = call[1]?.join(' ') ?? '';
      expect(script).toContain('kCGEventLeftMouseDown');
    });
  });

  describe('rightClick', () => {
    it('should call CGEvent with right button', async () => {
      mockExecFile.mockImplementation(mockOk());

      await rightClick(500, 300);

      const [call] = mockExecFile.mock.calls;
      expect(call[0]).toBe('python3');
      const script = call[1]?.join(' ') ?? '';
      expect(script).toContain('kCGEventRightMouseDown');
    });
  });

  describe('move', () => {
    it('should use Python Quartz for mouse move', async () => {
      mockExecFile.mockImplementation(mockOk());

      await move(500, 300);

      const [call] = mockExecFile.mock.calls;
      expect(call[0]).toBe('python3');
      const script = call[1]?.join(' ') ?? '';
      expect(script).toContain('kCGEventMouseMoved');
    });

    it('should fallback to osascript on Python failure', async () => {
      mockExecFile.mockImplementation(mockFirstFail('Python not available', 'python3'));

      await move(500, 300);

      const commands = mockExecFile.mock.calls.map(c => c[0]);
      expect(commands).toContain('python3');
      expect(commands).toContain('osascript');
    });
  });

  describe('getMousePosition', () => {
    it('should parse mouse position from osascript output', async () => {
      mockExecFile.mockImplementation(mockOk('500, 300'));

      const pos = await getMousePosition();
      expect(pos).toEqual({ x: 500, y: 300 });
    });

    it('should throw on unparseable output', async () => {
      mockExecFile.mockImplementation(mockOk('invalid output'));

      await expect(getMousePosition()).rejects.toThrow('Failed to parse mouse position');
    });
  });
});
