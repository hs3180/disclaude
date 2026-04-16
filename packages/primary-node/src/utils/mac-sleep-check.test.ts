/**
 * Tests for macOS auto-sleep detection utility.
 *
 * Issue #2263: System-level startup warning (not limited to Feishu channel).
 *
 * Tests cover:
 * - Non-macOS platforms are skipped
 * - macOS with auto-sleep enabled logs WARNING
 * - macOS with auto-sleep disabled (sleep=0) does not warn
 * - pmset not available / error is silently ignored
 * - No sleep line in pmset output is silently handled
 * - spawnSync throwing an exception is silently handled
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// Use vi.hoisted to create mocks that can be referenced inside vi.mock factories
const { mockWarn, mockInfo } = vi.hoisted(() => ({
  mockWarn: vi.fn(),
  mockInfo: vi.fn(),
}));

vi.mock('@disclaude/core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@disclaude/core')>();
  return {
    ...actual,
    createLogger: vi.fn(() => ({
      debug: vi.fn(),
      info: mockInfo,
      warn: mockWarn,
      error: vi.fn(),
      trace: vi.fn(),
    })),
  };
});

// Mock child_process using hoisted factory (no external references)
vi.mock('node:child_process', () => ({
  spawnSync: vi.fn(),
}));

// Save original platform descriptor so we can override it per test
const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform');

function setPlatform(platform: string): void {
  Object.defineProperty(process, 'platform', { value: platform });
}

function restorePlatform(): void {
  if (originalPlatform) {
    Object.defineProperty(process, 'platform', originalPlatform);
  }
}

import { checkMacAutoSleep } from './mac-sleep-check.js';

const mockSpawnSync = vi.mocked(
  (await import('node:child_process')).spawnSync,
);

describe('MacSleepCheck', () => {
  beforeEach(() => {
    mockSpawnSync.mockReset();
    mockWarn.mockReset();
    mockInfo.mockReset();
  });

  it('should skip on non-macOS platforms', () => {
    setPlatform('linux');
    try {
      checkMacAutoSleep();
      expect(mockSpawnSync).not.toHaveBeenCalled();
      expect(mockWarn).not.toHaveBeenCalled();
    } finally {
      restorePlatform();
    }
  });

  it('should warn when macOS auto-sleep is enabled', () => {
    setPlatform('darwin');
    try {
      mockSpawnSync.mockReturnValue({
        status: 0,
        stdout: 'Sleeping prevents displays from turning off\n sleep\t1\n',
        stderr: '',
      } as any);

      checkMacAutoSleep();

      expect(mockSpawnSync).toHaveBeenCalledWith(
        'pmset', ['-g'],
        expect.objectContaining({ timeout: 5000 }),
      );
      expect(mockWarn).toHaveBeenCalledTimes(1);
      // Verify the warning mentions the sleep minutes and message
      expect(mockWarn).toHaveBeenCalledWith(
        { sleepMinutes: 1 },
        expect.stringContaining('auto-sleep is enabled'),
      );
    } finally {
      restorePlatform();
    }
  });

  it('should not warn when macOS auto-sleep is disabled (sleep=0)', () => {
    setPlatform('darwin');
    try {
      mockSpawnSync.mockReturnValue({
        status: 0,
        stdout: ' sleep\t0\n',
        stderr: '',
      } as any);

      checkMacAutoSleep();

      expect(mockWarn).not.toHaveBeenCalled();
    } finally {
      restorePlatform();
    }
  });

  it('should silently skip when pmset is not available', () => {
    setPlatform('darwin');
    try {
      mockSpawnSync.mockReturnValue({
        error: new Error('ENOENT'),
        status: null,
        stdout: '',
        stderr: '',
      } as any);

      checkMacAutoSleep();

      expect(mockWarn).not.toHaveBeenCalled();
    } finally {
      restorePlatform();
    }
  });

  it('should silently skip when pmset returns non-zero exit code', () => {
    setPlatform('darwin');
    try {
      mockSpawnSync.mockReturnValue({
        status: 1,
        stdout: '',
        stderr: 'some error',
      } as any);

      checkMacAutoSleep();

      expect(mockWarn).not.toHaveBeenCalled();
    } finally {
      restorePlatform();
    }
  });

  it('should handle pmset output without sleep line', () => {
    setPlatform('darwin');
    try {
      mockSpawnSync.mockReturnValue({
        status: 0,
        stdout: 'displaysleep\t10\n',
        stderr: '',
      } as any);

      checkMacAutoSleep();

      expect(mockWarn).not.toHaveBeenCalled();
    } finally {
      restorePlatform();
    }
  });

  it('should handle spawnSync throwing an exception', () => {
    setPlatform('darwin');
    try {
      mockSpawnSync.mockImplementation(() => {
        throw new Error('Unexpected spawn failure');
      });

      // Should not throw — silently skip
      checkMacAutoSleep();

      expect(mockWarn).not.toHaveBeenCalled();
    } finally {
      restorePlatform();
    }
  });
});
