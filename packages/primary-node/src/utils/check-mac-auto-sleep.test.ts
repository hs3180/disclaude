/**
 * Tests for macOS auto-sleep detection.
 *
 * @see check-mac-auto-sleep.ts
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock child_process at module level (ESM-compatible)
const mockExecSync = vi.fn();
vi.mock('child_process', () => ({
  execSync: (...args: unknown[]) => mockExecSync(...args),
}));

// Import after mock setup
import { checkMacAutoSleep } from './check-mac-auto-sleep.js';

describe('checkMacAutoSleep', () => {
  const originalPlatform = process.platform;

  beforeEach(() => {
    mockExecSync.mockReset();
  });

  afterEach(() => {
    // Restore original platform
    Object.defineProperty(process, 'platform', { value: originalPlatform });
  });

  describe('non-macOS platforms', () => {
    it('should skip check and return checked=false on Linux', () => {
      Object.defineProperty(process, 'platform', { value: 'linux' });

      const result = checkMacAutoSleep();

      expect(result).toEqual({
        checked: false,
        sleepEnabled: false,
        sleepMinutes: null,
      });
      expect(mockExecSync).not.toHaveBeenCalled();
    });

    it('should skip check and return checked=false on Windows', () => {
      Object.defineProperty(process, 'platform', { value: 'win32' });

      const result = checkMacAutoSleep();

      expect(result).toEqual({
        checked: false,
        sleepEnabled: false,
        sleepMinutes: null,
      });
      expect(mockExecSync).not.toHaveBeenCalled();
    });
  });

  describe('macOS platform', () => {
    beforeEach(() => {
      Object.defineProperty(process, 'platform', { value: 'darwin' });
    });

    it('should detect sleep enabled (sleep=1)', () => {
      mockExecSync.mockReturnValue(
        'Active Profiles:\n' +
        'Battery Power       -*\n' +
        'AC Power            -*\n' +
        'Currently in use:\n' +
        ' standby              0\n' +
        ' proximitywake        1\n' +
        ' autorestart          0\n' +
        ' hibernatefile        /var/vm/sleepimage\n' +
        ' powernap             0\n' +
        ' gpuswitch            2\n' +
        ' displaysleep         10\n' +
        ' sleep                1\n' +
        ' tcpkeepalive         1\n' +
        ' halfdim              1\n' +
        ' hibernatemode        0\n' +
        ' womp                 0\n'
      );

      const result = checkMacAutoSleep();

      expect(result).toEqual({
        checked: true,
        sleepEnabled: true,
        sleepMinutes: 1,
      });
    });

    it('should detect sleep disabled (sleep=0)', () => {
      mockExecSync.mockReturnValue(
        'Active Profiles:\n' +
        ' sleep                0\n' +
        ' displaysleep         0\n'
      );

      const result = checkMacAutoSleep();

      expect(result).toEqual({
        checked: true,
        sleepEnabled: false,
        sleepMinutes: 0,
      });
    });

    it('should detect sleep with large value (sleep=60)', () => {
      mockExecSync.mockReturnValue(' sleep                60\n');

      const result = checkMacAutoSleep();

      expect(result).toEqual({
        checked: true,
        sleepEnabled: true,
        sleepMinutes: 60,
      });
    });

    it('should handle pmset output with no sleep line', () => {
      mockExecSync.mockReturnValue(
        'Active Profiles:\n' +
        ' displaysleep         10\n' +
        ' womp                 0\n'
      );

      const result = checkMacAutoSleep();

      expect(result).toEqual({
        checked: true,
        sleepEnabled: false,
        sleepMinutes: null,
      });
    });

    it('should handle pmset failure gracefully', () => {
      mockExecSync.mockImplementation(() => {
        throw new Error('pmset: not found');
      });

      const result = checkMacAutoSleep();

      expect(result).toEqual({
        checked: true,
        sleepEnabled: false,
        sleepMinutes: null,
      });
    });

    it('should handle sleep line with leading whitespace', () => {
      mockExecSync.mockReturnValue('  sleep                5\n');

      const result = checkMacAutoSleep();

      expect(result).toEqual({
        checked: true,
        sleepEnabled: true,
        sleepMinutes: 5,
      });
    });

    it('should call pmset -g with utf-8 encoding', () => {
      mockExecSync.mockReturnValue(' sleep                0\n');

      checkMacAutoSleep();

      expect(mockExecSync).toHaveBeenCalledWith('pmset -g', { encoding: 'utf-8' });
    });
  });
});
