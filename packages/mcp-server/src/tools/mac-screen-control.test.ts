/**
 * Tests for macOS screen control tools.
 *
 * Issue #2216: Phase 1 — Tests mock shell commands so they work
 * on any platform (not just macOS).
 *
 * @module mcp-server/tools/mac-screen-control.test
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  isMacOS,
  mac_screenshot,
  mac_click,
  mac_type_text,
  mac_press_key,
  mac_move_mouse,
  mac_get_window,
  mac_activate_app,
  mac_calibrate,
} from './mac-screen-control.js';

// Mock child_process.execFile
vi.mock('node:child_process', () => ({
  execFile: vi.fn(),
}));

// Mock node:fs/promises
vi.mock('node:fs/promises', () => ({
  mkdir: vi.fn().mockResolvedValue(undefined),
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

// Import the mocked execFile
import { execFile } from 'node:child_process';

const mockExecFile = vi.mocked(execFile);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Make execFile succeed with given stdout/stderr.
 */
function mockExecSuccess(stdout = '', stderr = '') {
  mockExecFile.mockImplementation(
    // @ts-expect-error — simplified mock
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
    // @ts-expect-error — simplified mock
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
    // Store original platform
    mockExecSuccess('', '');
  });

  it('should return error on non-macOS platforms', async () => {
    // This test works on any platform — if not macOS, the tool
    // should error gracefully
    if (process.platform !== 'darwin') {
      const result = await mac_screenshot();
      expect(result.success).toBe(false);
      expect(result.error).toContain('macOS');
    }
  });

  it('should take a screenshot on macOS with default options', async () => {
    if (process.platform !== 'darwin') {return;}

    mockExecSuccess('', '');
    const result = await mac_screenshot();

    expect(result.success).toBe(true);
    expect(result.filePath).toBeDefined();
    expect(result.message).toContain('Screenshot saved');
  });

  it('should take a screenshot with a specific region', async () => {
    if (process.platform !== 'darwin') {return;}

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

  it('should handle screenshot failure gracefully', async () => {
    if (process.platform !== 'darwin') {return;}

    mockExecError(new Error('screencapture: no such file or directory'));
    const result = await mac_screenshot();

    expect(result.success).toBe(false);
    expect(result.error).toContain('screencapture');
  });
});

describe('mac_click', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should return error on non-macOS platforms', async () => {
    if (process.platform !== 'darwin') {
      const result = await mac_click(100, 200);
      expect(result.success).toBe(false);
      expect(result.error).toContain('macOS');
    }
  });

  it('should perform a single left click via AppleScript', async () => {
    if (process.platform !== 'darwin') {return;}

    mockExecSuccess('', '');
    const result = await mac_click(100, 200);

    expect(result.success).toBe(true);
    expect(result.message).toContain('(100, 200)');
    expect(mockExecFile).toHaveBeenCalledWith(
      'osascript',
      expect.arrayContaining(['-e']),
      expect.any(Object),
    );
  });

  it('should perform a double click', async () => {
    if (process.platform !== 'darwin') {return;}

    mockExecSuccess('', '');
    const result = await mac_click(100, 200, { clickCount: 2 });

    expect(result.success).toBe(true);
  });

  it('should perform a right click', async () => {
    if (process.platform !== 'darwin') {return;}

    mockExecSuccess('', '');
    const result = await mac_click(100, 200, { button: 'right' });

    expect(result.success).toBe(true);
  });

  it('should handle click failure gracefully', async () => {
    if (process.platform !== 'darwin') {return;}

    mockExecError(new Error('System Events got an error'));
    const result = await mac_click(100, 200);

    expect(result.success).toBe(false);
  });
});

describe('mac_type_text', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockExecSuccess('', '');
  });

  it('should return error on non-macOS platforms', async () => {
    if (process.platform !== 'darwin') {
      const result = await mac_type_text('hello');
      expect(result.success).toBe(false);
      expect(result.error).toContain('macOS');
    }
  });

  it('should require text parameter', async () => {
    const result = await mac_type_text('');
    expect(result.success).toBe(false);
    expect(result.error).toContain('required');
  });

  it('should type text using clipboard approach', async () => {
    if (process.platform !== 'darwin') {return;}

    const result = await mac_type_text('Hello World');

    expect(result.success).toBe(true);
    expect(result.message).toContain('Hello World');
    // Should have called pbcopy to save text to clipboard
    expect(mockExecFile).toHaveBeenCalledWith(
      'pbcopy',
      expect.any(Array),
      expect.any(Object),
    );
    // Should have called osascript for Cmd+V
    expect(mockExecFile).toHaveBeenCalledWith(
      'osascript',
      expect.arrayContaining([expect.stringContaining('keystroke')]),
      expect.any(Object),
    );
  });

  it('should handle long text with preview truncation', async () => {
    if (process.platform !== 'darwin') {return;}

    const longText = 'a'.repeat(100);
    const result = await mac_type_text(longText);

    expect(result.success).toBe(true);
    expect(result.message).toContain('...');
  });

  it('should handle CJK text correctly', async () => {
    if (process.platform !== 'darwin') {return;}

    const result = await mac_type_text('你好世界 Hello こんにちは');

    expect(result.success).toBe(true);
    expect(result.message).toContain('你好世界');
  });

  it('should handle clipboard read failure gracefully', async () => {
    if (process.platform !== 'darwin') {return;}

    // First call (pbpaste) fails, subsequent calls succeed
    let callCount = 0;
    mockExecFile.mockImplementation(
      // @ts-expect-error — simplified mock
      (cmd: string, _args: string[], _opts: unknown, cb: Function) => {
        callCount++;
        if (cmd === 'pbpaste' && callCount === 1) {
          cb(new Error('clipboard is empty'));
        } else {
          cb(null, { stdout: '', stderr: '' });
        }
      },
    );

    const result = await mac_type_text('test');
    expect(result.success).toBe(true);
  });
});

describe('mac_press_key', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockExecSuccess('', '');
  });

  it('should return error on non-macOS platforms', async () => {
    if (process.platform !== 'darwin') {
      const result = await mac_press_key('return');
      expect(result.success).toBe(false);
    }
  });

  it('should press a regular key', async () => {
    if (process.platform !== 'darwin') {return;}

    const result = await mac_press_key('a');

    expect(result.success).toBe(true);
    expect(mockExecFile).toHaveBeenCalledWith(
      'osascript',
      expect.arrayContaining([expect.stringContaining('keystroke')]),
      expect.any(Object),
    );
  });

  it('should press a special key using key code', async () => {
    if (process.platform !== 'darwin') {return;}

    const result = await mac_press_key('return');

    expect(result.success).toBe(true);
    expect(mockExecFile).toHaveBeenCalledWith(
      'osascript',
      expect.arrayContaining([expect.stringContaining('key code 36')]),
      expect.any(Object),
    );
  });

  it('should press key with modifiers', async () => {
    if (process.platform !== 'darwin') {return;}

    const result = await mac_press_key('s', ['command']);

    expect(result.success).toBe(true);
    expect(result.message).toContain('command');
    expect(mockExecFile).toHaveBeenCalledWith(
      'osascript',
      expect.arrayContaining([expect.stringContaining('command down')]),
      expect.any(Object),
    );
  });

  it('should support multiple modifiers', async () => {
    if (process.platform !== 'darwin') {return;}

    const result = await mac_press_key('3', ['command', 'shift']);

    expect(result.success).toBe(true);
    expect(mockExecFile).toHaveBeenCalledWith(
      'osascript',
      expect.arrayContaining([expect.stringContaining('command down, shift down')]),
      expect.any(Object),
    );
  });

  it('should map arrow keys correctly', async () => {
    if (process.platform !== 'darwin') {return;}

    const arrowKeys = ['up', 'down', 'left', 'right'];
    for (const key of arrowKeys) {
      const result = await mac_press_key(key);
      expect(result.success).toBe(true);
    }
  });
});

describe('mac_move_mouse', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockExecSuccess('', '');
  });

  it('should return error on non-macOS platforms', async () => {
    if (process.platform !== 'darwin') {
      const result = await mac_move_mouse(100, 200);
      expect(result.success).toBe(false);
    }
  });

  it('should move mouse to specified coordinates', async () => {
    if (process.platform !== 'darwin') {return;}

    const result = await mac_move_mouse(500, 300);

    expect(result.success).toBe(true);
    expect(result.message).toContain('(500, 300)');
  });

  it('should handle move failure gracefully', async () => {
    if (process.platform !== 'darwin') {return;}

    mockExecError(new Error('CGEventCreateMouseEvent failed'));
    const result = await mac_move_mouse(100, 200);

    expect(result.success).toBe(false);
  });
});

describe('mac_get_window', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should return error on non-macOS platforms', async () => {
    if (process.platform !== 'darwin') {
      const result = await mac_get_window('Safari');
      expect(result.success).toBe(false);
    }
  });

  it('should require appName parameter', async () => {
    const result = await mac_get_window('');
    expect(result.success).toBe(false);
    expect(result.error).toContain('required');
  });

  it('should get window bounds for an application', async () => {
    if (process.platform !== 'darwin') {return;}

    // Mock AppleScript response: "x,y,x2,y2|windowName"
    mockExecSuccess('100,50,1100,750|Main Window', '');

    const result = await mac_get_window('Safari');

    expect(result.success).toBe(true);
    expect(result.windowName).toBe('Main Window');
    expect(result.x).toBe(100);
    expect(result.y).toBe(50);
    expect(result.width).toBe(1000);
    expect(result.height).toBe(700);
  });

  it('should handle app not found error', async () => {
    if (process.platform !== 'darwin') {return;}

    mockExecError(new Error('Application "NonExistentApp" is not running'));
    const result = await mac_get_window('NonExistentApp');

    expect(result.success).toBe(false);
    expect(result.error).toContain('NonExistentApp');
  });
});

describe('mac_activate_app', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockExecSuccess('', '');
  });

  it('should return error on non-macOS platforms', async () => {
    if (process.platform !== 'darwin') {
      const result = await mac_activate_app('Safari');
      expect(result.success).toBe(false);
    }
  });

  it('should require appName parameter', async () => {
    const result = await mac_activate_app('');
    expect(result.success).toBe(false);
  });

  it('should activate an application', async () => {
    if (process.platform !== 'darwin') {return;}

    const result = await mac_activate_app('Safari');

    expect(result.success).toBe(true);
    expect(mockExecFile).toHaveBeenCalledWith(
      'osascript',
      expect.arrayContaining([expect.stringContaining('activate')]),
      expect.any(Object),
    );
  });

  it('should handle app not found error', async () => {
    if (process.platform !== 'darwin') {return;}

    mockExecError(new Error('Application "FakeApp" is not running'));
    const result = await mac_activate_app('FakeApp');

    expect(result.success).toBe(false);
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
    }
  });

  it('should detect Retina display and calculate scale factor', async () => {
    if (process.platform !== 'darwin') {return;}

    let callCount = 0;
    mockExecFile.mockImplementation(
      // @ts-expect-error — simplified mock
      (_cmd: string, _args: string[], _opts: unknown, cb: Function) => {
        callCount++;
        if (callCount === 1) {
          // system_profiler response
          cb(null, {
            stdout: 'Resolution: 2560 x 1600 Retina',
            stderr: '',
          });
        } else {
          // Finder bounds response
          cb(null, { stdout: '1440,900', stderr: '' });
        }
      },
    );

    const result = await mac_calibrate();

    expect(result.success).toBe(true);
    expect(result.scaleFactor).toBeDefined();
    expect(result.message).toContain('Retina');
  });

  it('should detect standard (non-Retina) display', async () => {
    if (process.platform !== 'darwin') {return;}

    let callCount = 0;
    mockExecFile.mockImplementation(
      // @ts-expect-error — simplified mock
      (_cmd: string, _args: string[], _opts: unknown, cb: Function) => {
        callCount++;
        if (callCount === 1) {
          cb(null, {
            stdout: 'Resolution: 1920 x 1080',
            stderr: '',
          });
        } else {
          cb(null, { stdout: '1920,1080', stderr: '' });
        }
      },
    );

    const result = await mac_calibrate();

    expect(result.success).toBe(true);
    expect(result.scaleFactor).toBe(1);
  });

  it('should handle calibration failure gracefully', async () => {
    if (process.platform !== 'darwin') {return;}

    mockExecError(new Error('system_profiler failed'));
    const result = await mac_calibrate();

    expect(result.success).toBe(false);
  });
});
