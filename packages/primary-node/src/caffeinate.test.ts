/**
 * Tests for caffeinate module.
 *
 * @see Issue #2975
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock node:os before importing the module under test
const mockPlatform = vi.fn(() => 'darwin');
vi.mock('node:os', () => ({
  platform: () => mockPlatform(),
}));

// Mock node:child_process
const mockExecSync = vi.fn();
const mockSpawn = vi.fn();
vi.mock('node:child_process', () => ({
  execSync: (...args: unknown[]) => mockExecSync(...args),
  spawn: (...args: unknown[]) => mockSpawn(...args),
}));

// Mock @disclaude/core logger
vi.mock('@disclaude/core', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

// Import after mocks are set up
import { isCaffeinateAvailable, spawnCaffeinate } from './caffeinate.js';

describe('caffeinate', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('isCaffeinateAvailable', () => {
    it('returns false on non-macOS platforms', () => {
      mockPlatform.mockReturnValue('linux');
      expect(isCaffeinateAvailable()).toBe(false);
      expect(mockExecSync).not.toHaveBeenCalled();
    });

    it('returns true on macOS when caffeinate exists', () => {
      mockPlatform.mockReturnValue('darwin');
      mockExecSync.mockReturnValue('/usr/bin/caffeinate\n');
      expect(isCaffeinateAvailable()).toBe(true);
      expect(mockExecSync).toHaveBeenCalledWith(
        'which caffeinate',
        expect.objectContaining({ encoding: 'utf-8' }),
      );
    });

    it('returns false on macOS when caffeinate not found', () => {
      mockPlatform.mockReturnValue('darwin');
      mockExecSync.mockImplementation(() => {
        throw new Error('not found');
      });
      expect(isCaffeinateAvailable()).toBe(false);
    });
  });

  describe('spawnCaffeinate', () => {
    it('returns null on non-macOS platforms', () => {
      mockPlatform.mockReturnValue('linux');
      expect(spawnCaffeinate()).toBeNull();
      expect(mockSpawn).not.toHaveBeenCalled();
    });

    it('returns null when caffeinate is not available', () => {
      mockPlatform.mockReturnValue('darwin');
      mockExecSync.mockImplementation(() => {
        throw new Error('not found');
      });
      expect(spawnCaffeinate()).toBeNull();
      expect(mockSpawn).not.toHaveBeenCalled();
    });

    it('spawns caffeinate -s on macOS', () => {
      mockPlatform.mockReturnValue('darwin');
      mockExecSync.mockReturnValue('/usr/bin/caffeinate\n');

      const fakeChild = {
        on: vi.fn(),
        pid: 12345,
      };
      mockSpawn.mockReturnValue(fakeChild);

      const result = spawnCaffeinate();

      expect(result).toBe(fakeChild);
      expect(mockSpawn).toHaveBeenCalledWith(
        'caffeinate',
        ['-s'],
        expect.objectContaining({
          stdio: 'ignore',
          detached: false,
        }),
      );
    });

    it('registers error and exit handlers on child process', () => {
      mockPlatform.mockReturnValue('darwin');
      mockExecSync.mockReturnValue('/usr/bin/caffeinate\n');

      const fakeChild = {
        on: vi.fn(),
        pid: 12345,
      };
      mockSpawn.mockReturnValue(fakeChild);

      spawnCaffeinate();

      // Should register 'error' and 'exit' handlers
      expect(fakeChild.on).toHaveBeenCalledTimes(2);
      expect(fakeChild.on).toHaveBeenCalledWith('error', expect.any(Function));
      expect(fakeChild.on).toHaveBeenCalledWith('exit', expect.any(Function));
    });

    it('returns null if spawn throws', () => {
      mockPlatform.mockReturnValue('darwin');
      mockExecSync.mockReturnValue('/usr/bin/caffeinate\n');
      mockSpawn.mockImplementation(() => {
        throw new Error('spawn failed');
      });

      const result = spawnCaffeinate();
      expect(result).toBeNull();
    });
  });
});
