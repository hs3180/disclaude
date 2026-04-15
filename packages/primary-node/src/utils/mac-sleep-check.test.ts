/**
 * Tests for macOS auto-sleep detection utility.
 *
 * Issue #2263: Startup warning for macOS auto-sleep.
 *
 * Tests cover:
 * - Non-macOS platforms skip detection
 * - macOS with auto-sleep enabled logs WARNING
 * - macOS with sleep disabled (sleep=0) does not warn
 * - pmset unavailable / permission denied → silent skip
 * - No sleep configuration line → no warning
 */

import { describe, it, expect, vi, beforeEach, type Mock } from 'vitest';

// vi.hoisted runs before vi.mock factories, so these variables are available
const { capturedLoggers, clearLoggerMocks } = vi.hoisted(() => {
  const captured: Array<Record<string, Mock>> = [];
  return {
    capturedLoggers: captured,
    clearLoggerMocks: () => {
      for (const logger of captured) {
        for (const fn of Object.values(logger)) {
          fn.mockClear();
        }
      }
    },
  };
});

vi.mock('@disclaude/core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@disclaude/core')>();
  return {
    ...actual,
    createLogger: vi.fn(() => {
      const logger: Record<string, Mock> = {
        debug: vi.fn(),
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
        trace: vi.fn(),
      };
      capturedLoggers.push(logger);
      return logger;
    }),
  };
});

vi.mock('node:child_process', () => ({
  execSync: vi.fn(),
}));

import { execSync } from 'node:child_process';
import { checkMacAutoSleep } from './mac-sleep-check.js';

const mockExecSync = vi.mocked(execSync);

const originalPlatform = process.platform;

function mockPlatform(platform: string): void {
  Object.defineProperty(process, 'platform', { value: platform });
}

function restorePlatform(): void {
  Object.defineProperty(process, 'platform', { value: originalPlatform });
}

describe('MacSleepCheck', () => {
  // The module-level logger is created once at import time.
  // capturedLoggers[0] is the MacSleepCheck logger instance.
  const logger = () => capturedLoggers[0];

  beforeEach(() => {
    mockExecSync.mockReset();
    clearLoggerMocks();
    restorePlatform();
  });

  it('should skip detection on non-macOS platforms', () => {
    mockPlatform('linux');
    checkMacAutoSleep();
    expect(mockExecSync).not.toHaveBeenCalled();
    expect(logger().warn).not.toHaveBeenCalled();
    restorePlatform();
  });

  it('should log WARNING when macOS auto-sleep is enabled', () => {
    mockPlatform('darwin');
    mockExecSync.mockReturnValue(
      'Sleeping preventive by: coreaudiod\n' +
      'System sleep settings:\n' +
      ' sleep\t\t10\n' +
      ' disksleep\t10\n',
    );

    checkMacAutoSleep();

    expect(mockExecSync).toHaveBeenCalledWith('pmset -g', expect.objectContaining({
      encoding: 'utf-8',
      timeout: 5000,
    }));
    expect(logger().warn).toHaveBeenCalledTimes(1);
    expect(logger().warn).toHaveBeenCalledWith(
      { sleepMinutes: 10 },
      expect.stringContaining('macOS auto-sleep is enabled'),
    );
    restorePlatform();
  });

  it('should not warn when macOS sleep is disabled (sleep=0)', () => {
    mockPlatform('darwin');
    mockExecSync.mockReturnValue(
      ' sleep\t\t0\n' +
      ' disksleep\t0\n',
    );

    checkMacAutoSleep();

    expect(mockExecSync).toHaveBeenCalled();
    expect(logger().warn).not.toHaveBeenCalled();
    restorePlatform();
  });

  it('should silently skip when pmset is unavailable', () => {
    mockPlatform('darwin');
    mockExecSync.mockImplementation(() => {
      throw new Error('pmset: command not found');
    });

    checkMacAutoSleep();

    expect(mockExecSync).toHaveBeenCalled();
    expect(logger().warn).not.toHaveBeenCalled();
    expect(logger().error).not.toHaveBeenCalled();
    restorePlatform();
  });

  it('should not warn when no sleep line is found in pmset output', () => {
    mockPlatform('darwin');
    mockExecSync.mockReturnValue(
      'No sleep settings found\n' +
      ' hibernatemode\t0\n',
    );

    checkMacAutoSleep();

    expect(mockExecSync).toHaveBeenCalled();
    expect(logger().warn).not.toHaveBeenCalled();
    restorePlatform();
  });

  it('should not warn when sleep value is 0 with extra whitespace', () => {
    mockPlatform('darwin');
    mockExecSync.mockReturnValue('   sleep    0\n');

    checkMacAutoSleep();

    expect(logger().warn).not.toHaveBeenCalled();
    restorePlatform();
  });

  it('should handle pmset timeout gracefully', () => {
    mockPlatform('darwin');
    mockExecSync.mockImplementation(() => {
      const err = new Error('spawnSync pmset ETIMEDOUT') as NodeJS.ErrnoException;
      err.code = 'ETIMEDOUT';
      throw err;
    });

    checkMacAutoSleep();

    expect(logger().warn).not.toHaveBeenCalled();
    expect(logger().error).not.toHaveBeenCalled();
    restorePlatform();
  });
});
