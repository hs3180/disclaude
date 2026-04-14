/**
 * Tests for macOS auto-sleep detection utility.
 *
 * Issue #2263: Detect macOS auto-sleep at startup and log warning.
 *
 * Tests cover:
 * - Non-macOS platforms skip detection
 * - macOS with auto-sleep enabled logs WARNING
 * - macOS with auto-sleep disabled (sleep=0) does not warn
 * - pmset unavailable / error is silently skipped
 * - No "sleep" line in pmset output is handled gracefully
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// vi.hoisted ensures the mock reference is available when vi.mock callbacks run
// (vi.mock is hoisted above all declarations by the test framework).
const { mockWarn } = vi.hoisted(() => ({
  mockWarn: vi.fn(),
}));

// Mock logger before importing the module under test
vi.mock('@disclaude/core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@disclaude/core')>();
  return {
    ...actual,
    createLogger: vi.fn(() => ({
      debug: vi.fn(),
      info: vi.fn(),
      warn: mockWarn,
      error: vi.fn(),
      trace: vi.fn(),
    })),
  };
});

// Mock node:child_process
vi.mock('node:child_process', () => ({
  execSync: vi.fn(),
}));

import { execSync } from 'node:child_process';
import { checkMacAutoSleep } from './mac-sleep-check.js';

const mockExecSync = vi.mocked(execSync);

// Helpers to override process.platform for testing
const REAL_PLATFORM = process.platform;

function mockPlatform(platform: string): void {
  Object.defineProperty(process, 'platform', { value: platform, configurable: true });
}

function restorePlatform(): void {
  Object.defineProperty(process, 'platform', { value: REAL_PLATFORM, configurable: true });
}

describe('checkMacAutoSleep', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockExecSync.mockReset();
    restorePlatform();
  });

  it('should skip detection on non-macOS platforms', () => {
    mockPlatform('linux');
    checkMacAutoSleep();
    expect(mockExecSync).not.toHaveBeenCalled();
  });

  it('should log WARNING when macOS auto-sleep is enabled', () => {
    mockPlatform('darwin');
    mockExecSync.mockReturnValue(
      'Sleeping preventers: []\n sleep\t1\n hibernatemode\t0',
    );
    checkMacAutoSleep();
    expect(mockWarn).toHaveBeenCalledTimes(1);
    expect(mockWarn).toHaveBeenCalledWith(
      expect.objectContaining({ sleepMinutes: 1 }),
      expect.stringContaining('macOS auto-sleep is enabled'),
    );
  });

  it('should not warn when macOS auto-sleep is disabled (sleep=0)', () => {
    mockPlatform('darwin');
    mockExecSync.mockReturnValue(
      'Sleeping preventers: []\n sleep\t0\n hibernatemode\t0',
    );
    checkMacAutoSleep();
    expect(mockWarn).not.toHaveBeenCalled();
  });

  it('should silently skip when pmset throws an error', () => {
    mockPlatform('darwin');
    mockExecSync.mockImplementation(() => {
      throw new Error('pmset: command not found');
    });
    // Should not throw
    expect(() => checkMacAutoSleep()).not.toThrow();
    expect(mockWarn).not.toHaveBeenCalled();
  });

  it('should handle pmset output without sleep line gracefully', () => {
    mockPlatform('darwin');
    mockExecSync.mockReturnValue('hibernatemode\t0\ndisplaysleep\t10');
    checkMacAutoSleep();
    expect(mockWarn).not.toHaveBeenCalled();
  });
});
