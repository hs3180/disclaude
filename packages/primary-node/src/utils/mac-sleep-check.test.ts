/**
 * Tests for macOS auto-sleep detection utility.
 *
 * Issue #2263: Startup warning when macOS auto-sleep is enabled.
 *
 * Tests cover:
 * - Non-macOS platform: execSync not called
 * - macOS with sleep enabled (sleep > 0): WARNING logged
 * - macOS with sleep disabled (sleep = 0): no warning
 * - pmset unavailable (execSync throws): silently skipped
 * - pmset output without sleep line: no warning
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const { mockExecSync, mockWarn, mockLogger } = vi.hoisted(() => {
  const mockWarn = vi.fn();
  const mockLogger = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: mockWarn,
    error: vi.fn(),
    trace: vi.fn(),
  };
  const mockExecSync = vi.fn();
  return { mockExecSync, mockWarn, mockLogger };
});

const originalPlatform = process.platform;

vi.mock('node:child_process', () => ({
  execSync: mockExecSync,
}));

vi.mock('@disclaude/core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@disclaude/core')>();
  return {
    ...actual,
    createLogger: vi.fn(() => mockLogger),
  };
});

import { checkMacAutoSleep } from './mac-sleep-check.js';

describe('checkMacAutoSleep', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    Object.defineProperty(process, 'platform', {
      value: originalPlatform,
      writable: true,
      configurable: true,
    });
  });

  afterEach(() => {
    Object.defineProperty(process, 'platform', {
      value: originalPlatform,
      writable: true,
      configurable: true,
    });
  });

  it('should not call execSync on non-macOS platforms', () => {
    Object.defineProperty(process, 'platform', {
      value: 'linux',
      writable: true,
      configurable: true,
    });

    checkMacAutoSleep();

    expect(mockExecSync).not.toHaveBeenCalled();
    expect(mockWarn).not.toHaveBeenCalled();
  });

  it('should log WARNING when macOS auto-sleep is enabled (sleep > 0)', () => {
    Object.defineProperty(process, 'platform', {
      value: 'darwin',
      writable: true,
      configurable: true,
    });

    mockExecSync.mockReturnValue('   sleep   1\n   displaysleep   10\n');

    checkMacAutoSleep();

    expect(mockExecSync).toHaveBeenCalledWith('pmset -g', expect.objectContaining({
      encoding: 'utf-8',
      timeout: 5000,
    }));
    expect(mockWarn).toHaveBeenCalledWith(
      { sleepMinutes: 1 },
      expect.stringContaining('macOS auto-sleep is enabled')
    );
  });

  it('should not warn when macOS auto-sleep is disabled (sleep = 0)', () => {
    Object.defineProperty(process, 'platform', {
      value: 'darwin',
      writable: true,
      configurable: true,
    });

    mockExecSync.mockReturnValue('   sleep   0\n   displaysleep   10\n');

    checkMacAutoSleep();

    expect(mockExecSync).toHaveBeenCalledWith('pmset -g', expect.objectContaining({
      encoding: 'utf-8',
      timeout: 5000,
    }));
    expect(mockWarn).not.toHaveBeenCalled();
  });

  it('should silently skip when pmset is not available', () => {
    Object.defineProperty(process, 'platform', {
      value: 'darwin',
      writable: true,
      configurable: true,
    });

    mockExecSync.mockImplementation(() => {
      throw new Error('pmset: command not found');
    });

    // Should not throw
    expect(() => checkMacAutoSleep()).not.toThrow();
    expect(mockWarn).not.toHaveBeenCalled();
  });

  it('should not warn when pmset output has no sleep line', () => {
    Object.defineProperty(process, 'platform', {
      value: 'darwin',
      writable: true,
      configurable: true,
    });

    mockExecSync.mockReturnValue('Active Profiles:\n   Battery Power\n   AC Power\n');

    checkMacAutoSleep();

    expect(mockExecSync).toHaveBeenCalled();
    expect(mockWarn).not.toHaveBeenCalled();
  });
});
