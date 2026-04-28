/**
 * Tests for macOS caffeinate management.
 *
 * @see caffeinate.ts
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock @disclaude/core logger
vi.mock('@disclaude/core', () => ({
  createLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

// Mock child_process at module level (ESM-compatible)
const mockKill = vi.fn();
const mockOn = vi.fn();
const mockSpawn = vi.fn();
vi.mock('node:child_process', () => ({
  spawn: (...args: unknown[]) => mockSpawn(...args),
}));

/** Create a mock child process object with default behavior */
function mockChildProcess() {
  return { kill: mockKill, on: mockOn };
}

import { startCaffeinate, stopCaffeinate } from './caffeinate.js';

describe('caffeinate', () => {
  const originalPlatform = process.platform;

  beforeEach(() => {
    mockSpawn.mockReset().mockImplementation(mockChildProcess);
    mockKill.mockReset();
    mockOn.mockReset();
  });

  afterEach(() => {
    Object.defineProperty(process, 'platform', { value: originalPlatform });
  });

  describe('startCaffeinate', () => {
    describe('non-macOS platforms', () => {
      it('should return inactive handle on Linux', () => {
        Object.defineProperty(process, 'platform', { value: 'linux' });

        const handle = startCaffeinate();

        expect(handle.active).toBe(false);
        expect(handle.process).toBeNull();
        expect(mockSpawn).not.toHaveBeenCalled();
      });

      it('should return inactive handle on Windows', () => {
        Object.defineProperty(process, 'platform', { value: 'win32' });

        const handle = startCaffeinate();

        expect(handle.active).toBe(false);
        expect(handle.process).toBeNull();
        expect(mockSpawn).not.toHaveBeenCalled();
      });
    });

    describe('macOS platform', () => {
      beforeEach(() => {
        Object.defineProperty(process, 'platform', { value: 'darwin' });
      });

      it('should spawn caffeinate -s with correct arguments', () => {
        const handle = startCaffeinate();

        expect(mockSpawn).toHaveBeenCalledWith('caffeinate', ['-s'], {
          stdio: 'ignore',
          detached: false,
        });
        expect(handle.active).toBe(true);
        expect(handle.process).not.toBeNull();
      });

      it('should register error and exit handlers on the child process', () => {
        startCaffeinate();

        // Should register at least 2 handlers (error, exit)
        expect(mockOn.mock.calls.length).toBeGreaterThanOrEqual(2);
        const eventTypes = mockOn.mock.calls.map((call: unknown[]) => call[0]);
        expect(eventTypes).toContain('error');
        expect(eventTypes).toContain('exit');
      });

      it('should return inactive handle when spawn throws', () => {
        mockSpawn.mockImplementation(() => {
          throw new Error('caffeinate: command not found');
        });

        const handle = startCaffeinate();

        expect(handle.active).toBe(false);
        expect(handle.process).toBeNull();
      });
    });
  });

  describe('stopCaffeinate', () => {
    it('should send SIGTERM to the child process', () => {
      Object.defineProperty(process, 'platform', { value: 'darwin' });
      const handle = startCaffeinate();

      stopCaffeinate(handle);

      expect(mockKill).toHaveBeenCalledWith('SIGTERM');
    });

    it('should be a no-op for inactive handle', () => {
      const handle = { process: null, active: false };

      stopCaffeinate(handle);

      expect(mockKill).not.toHaveBeenCalled();
    });

    it('should be a no-op for null process', () => {
      const handle = { process: null, active: true };

      stopCaffeinate(handle);

      expect(mockKill).not.toHaveBeenCalled();
    });

    it('should handle kill errors gracefully (process already exited)', () => {
      Object.defineProperty(process, 'platform', { value: 'darwin' });
      mockKill.mockImplementation(() => {
        throw new Error('ESRCH: no such process');
      });

      const handle = startCaffeinate();

      // Should not throw
      expect(() => stopCaffeinate(handle)).not.toThrow();
    });
  });
});
