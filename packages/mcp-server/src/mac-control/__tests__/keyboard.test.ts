/**
 * Tests for mac-control/keyboard module.
 *
 * Tests text input logic and key code mapping.
 * Shell commands are mocked since osascript is macOS-specific.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('node:child_process', () => ({
  execFile: vi.fn(),
}));

import { execFile } from 'node:child_process';
import { typeText, pressKey } from '../keyboard.js';

const mockExecFile = vi.mocked(execFile);

/** Helper: mock that calls callback with success. */
function mockOk(stdout = ''): typeof mockExecFile {
  return ((...args: any[]) => {
    const cb = args.find((a: any) => typeof a === 'function');
    if (cb) {cb(null, { stdout, stderr: '' });}
    return {};
  }) as any;
}

describe('keyboard', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers({ shouldAdvanceTime: true });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('typeText', () => {
    it('should use clipboard for Chinese text', async () => {
      mockExecFile.mockImplementation(((...args: any[]) => {
        const cb = args.find((a: any) => typeof a === 'function');
        if (cb) {cb(null, { stdout: '', stderr: '' });}
        return {};
      }) as any);

      await typeText('你好世界');

      // Should have some execFile calls (pbcopy, osascript)
      expect(mockExecFile.mock.calls.length).toBeGreaterThan(0);
    });

    it('should use keystroke for ASCII text when useClipboard is false', async () => {
      mockExecFile.mockImplementation(mockOk());

      await typeText('hello', { useClipboard: false });

      // Should use osascript keystroke for each character
      const osascriptCalls = mockExecFile.mock.calls.filter(c => c[0] === 'osascript');
      expect(osascriptCalls.length).toBe(5); // h, e, l, l, o
    });

    it('should use keystroke for ASCII text by default', async () => {
      mockExecFile.mockImplementation(mockOk());

      await typeText('hello');

      const osascriptCalls = mockExecFile.mock.calls.filter(c => c[0] === 'osascript');
      expect(osascriptCalls.length).toBe(5);
    });

    it('should do nothing for empty string', async () => {
      await typeText('');
      expect(mockExecFile).not.toHaveBeenCalled();
    });
  });

  describe('pressKey', () => {
    it('should use keystroke for single characters', async () => {
      mockExecFile.mockImplementation(mockOk());

      await pressKey('a');

      const [call] = mockExecFile.mock.calls;
      const script = call[1]?.join(' ') ?? '';
      expect(script).toContain('keystroke "a"');
    });

    it('should use key code for special keys', async () => {
      mockExecFile.mockImplementation(mockOk());

      await pressKey('return');

      const [call] = mockExecFile.mock.calls;
      const script = call[1]?.join(' ') ?? '';
      expect(script).toContain('key code 36');
    });

    it('should include modifiers when specified', async () => {
      mockExecFile.mockImplementation(mockOk());

      await pressKey('v', ['cmd']);

      const [call] = mockExecFile.mock.calls;
      const script = call[1]?.join(' ') ?? '';
      expect(script).toContain('command down');
    });

    it('should throw for unknown key names', async () => {
      await expect(pressKey('unknownkey')).rejects.toThrow('Unknown key name');
    });

    it('should handle arrow keys', async () => {
      mockExecFile.mockImplementation(mockOk());

      await pressKey('left');
      const script = mockExecFile.mock.calls[0][1]?.join(' ') ?? '';
      expect(script).toContain('key code 123');

      await pressKey('right');
      const script2 = mockExecFile.mock.calls[1][1]?.join(' ') ?? '';
      expect(script2).toContain('key code 124');
    });

    it('should handle multiple modifiers', async () => {
      mockExecFile.mockImplementation(mockOk());

      await pressKey('a', ['cmd', 'shift']);

      const [call] = mockExecFile.mock.calls;
      const script = call[1]?.join(' ') ?? '';
      expect(script).toContain('command down');
      expect(script).toContain('shift down');
    });
  });
});
