/**
 * Tests for macOS auto-sleep detection utility
 *
 * @see Issue #2263
 */

import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';

// Use vi.hoisted to create mocks that are available in vi.mock factories
const { mockWarn, mockInfo } = vi.hoisted(() => ({
  mockWarn: vi.fn(),
  mockInfo: vi.fn(),
}));

// Mock child_process.execSync
vi.mock('child_process', () => ({
  execSync: vi.fn(),
}));

// Mock @disclaude/core logger — all createLogger calls share the same spies
vi.mock('@disclaude/core', () => ({
  createLogger: () => ({
    warn: mockWarn,
    info: mockInfo,
  }),
}));

import { execSync } from 'child_process';
import { checkMacAutoSleep } from './mac-sleep-check.js';

describe('checkMacAutoSleep', () => {
  const originalPlatform = process.platform;

  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterAll(() => {
    Object.defineProperty(process, 'platform', { value: originalPlatform });
  });

  it('should skip on non-macOS platforms', () => {
    Object.defineProperty(process, 'platform', { value: 'linux' });
    checkMacAutoSleep();
    expect(execSync).not.toHaveBeenCalled();
  });

  it('should warn when macOS auto-sleep is enabled', () => {
    Object.defineProperty(process, 'platform', { value: 'darwin' });
    vi.mocked(execSync).mockReturnValue(
      'Sleeping prevents further display updates\n sleep\t\t1\n'
    );

    checkMacAutoSleep();

    expect(execSync).toHaveBeenCalledWith('pmset -g', expect.objectContaining({
      encoding: 'utf-8',
    }));
    expect(mockWarn).toHaveBeenCalledWith(
      { sleepMinutes: 1 },
      expect.stringContaining('auto-sleep is enabled')
    );
  });

  it('should not warn when macOS auto-sleep is disabled (sleep=0)', () => {
    Object.defineProperty(process, 'platform', { value: 'darwin' });
    vi.mocked(execSync).mockReturnValue(
      'Sleeping prevents further display updates\n sleep\t\t0\n'
    );

    checkMacAutoSleep();

    expect(mockWarn).not.toHaveBeenCalled();
  });

  it('should silently skip if pmset throws an error', () => {
    Object.defineProperty(process, 'platform', { value: 'darwin' });
    vi.mocked(execSync).mockImplementation(() => {
      throw new Error('pmset not available');
    });

    expect(() => checkMacAutoSleep()).not.toThrow();
  });

  it('should handle output without sleep line gracefully', () => {
    Object.defineProperty(process, 'platform', { value: 'darwin' });
    vi.mocked(execSync).mockReturnValue('Some other pmset output without sleep');

    checkMacAutoSleep();

    expect(mockWarn).not.toHaveBeenCalled();
  });
});
