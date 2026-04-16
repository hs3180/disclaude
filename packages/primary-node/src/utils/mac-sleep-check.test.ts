/**
 * Tests for macOS auto-sleep detection utility.
 *
 * Issue #2263: Verify that checkMacAutoSleep() correctly detects
 * and warns about macOS auto-sleep settings.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// vi.hoisted() ensures these are available inside vi.mock() factories
// (which are hoisted to the top of the file by Vitest)
const { mockLogger, mockExecSync } = vi.hoisted(() => ({
  mockLogger: {
    warn: vi.fn(),
    info: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
  mockExecSync: vi.fn(),
}));

vi.mock('@disclaude/core', () => ({
  createLogger: vi.fn(() => mockLogger),
}));

vi.mock('node:child_process', () => ({
  execSync: (...args: unknown[]) => mockExecSync(...args),
}));

import { checkMacAutoSleep } from './mac-sleep-check.js';

describe('checkMacAutoSleep', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('non-macOS platforms', () => {
    it('should skip detection on linux', () => {
      const originalPlatform = process.platform;
      Object.defineProperty(process, 'platform', { value: 'linux', configurable: true });

      checkMacAutoSleep();

      expect(mockExecSync).not.toHaveBeenCalled();
      expect(mockLogger.warn).not.toHaveBeenCalled();

      Object.defineProperty(process, 'platform', { value: originalPlatform, configurable: true });
    });

    it('should skip detection on win32', () => {
      const originalPlatform = process.platform;
      Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });

      checkMacAutoSleep();

      expect(mockExecSync).not.toHaveBeenCalled();
      expect(mockLogger.warn).not.toHaveBeenCalled();

      Object.defineProperty(process, 'platform', { value: originalPlatform, configurable: true });
    });
  });

  describe('macOS platform', () => {
    beforeEach(() => {
      Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true });
    });

    afterEach(() => {
      Object.defineProperty(process, 'platform', { value: 'linux', configurable: true });
    });

    it('should warn when auto-sleep is enabled (sleep > 0)', () => {
      mockExecSync.mockReturnValue(
        'Active Power Profile: AC Power\n' +
        ' sleep                1\n' +
        ' displaysleep         10\n'
      );

      checkMacAutoSleep();

      expect(mockExecSync).toHaveBeenCalledWith('pmset -g', expect.objectContaining({
        encoding: 'utf-8',
        timeout: 5000,
      }));
      expect(mockLogger.warn).toHaveBeenCalledWith(
        { sleepMinutes: 1 },
        expect.stringContaining('macOS auto-sleep is enabled')
      );
    });

    it('should not warn when auto-sleep is disabled (sleep = 0)', () => {
      mockExecSync.mockReturnValue(
        'Active Power Profile: AC Power\n' +
        ' sleep                0\n' +
        ' displaysleep         10\n'
      );

      checkMacAutoSleep();

      expect(mockExecSync).toHaveBeenCalled();
      expect(mockLogger.warn).not.toHaveBeenCalled();
    });

    it('should not warn when no sleep line is present', () => {
      mockExecSync.mockReturnValue(
        'Active Power Profile: AC Power\n' +
        ' displaysleep         10\n' +
        ' womp                 1\n'
      );

      checkMacAutoSleep();

      expect(mockExecSync).toHaveBeenCalled();
      expect(mockLogger.warn).not.toHaveBeenCalled();
    });

    it('should silently skip when pmset throws an error', () => {
      mockExecSync.mockImplementation(() => {
        throw new Error('pmset: not found');
      });

      checkMacAutoSleep();

      expect(mockExecSync).toHaveBeenCalled();
      expect(mockLogger.warn).not.toHaveBeenCalled();
      expect(mockLogger.error).not.toHaveBeenCalled();
    });

    it('should handle sleep value with leading whitespace and tabs', () => {
      mockExecSync.mockReturnValue(
        '\tsleep\t\t60\n' +
        ' displaysleep         10\n'
      );

      checkMacAutoSleep();

      expect(mockLogger.warn).toHaveBeenCalledWith(
        { sleepMinutes: 60 },
        expect.stringContaining('macOS auto-sleep is enabled')
      );
    });
  });
});
