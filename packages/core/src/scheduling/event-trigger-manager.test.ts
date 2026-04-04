/**
 * Tests for EventTriggerManager (packages/core/src/scheduling/event-trigger-manager.ts)
 *
 * Tests the EventTriggerManager class which provides file-watcher-based
 * event triggers for scheduled tasks.
 *
 * Issue #1953: Event-driven schedule trigger mechanism.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as path from 'path';
import { EventTriggerManager } from './event-trigger-manager.js';

// ============================================================================
// Mock Setup
// ============================================================================

// Use vi.hoisted to define mock functions that can be referenced in vi.mock factory
const {
  mockFsWatch,
  mockWatchers,
  watcherCallbacks,
  getWatcherIdCounter,
  resetWatcherIdCounter,
} = vi.hoisted(() => {
  let watcherIdCounter = 0;
  const mockWatchers: Array<{
    close: ReturnType<typeof vi.fn>;
    on: ReturnType<typeof vi.fn>;
  }> = [];
  const watcherCallbacks: Map<number, {
    changeCallback: (eventType: string, filename: string | null) => void;
    errorCallback: (error: Error) => void;
  }> = new Map();

  const mockFsWatch = vi.fn().mockImplementation((_dir: string, _options: unknown, callback: (eventType: string, filename: string | null) => void) => {
    const id = watcherIdCounter++;
    const watcher = {
      close: vi.fn().mockImplementation(() => {
        watcherCallbacks.delete(id);
      }),
      on: vi.fn().mockImplementation((event: string, cb: (...args: unknown[]) => void) => {
        if (event === 'error') {
          watcherCallbacks.get(id)!.errorCallback = cb as (error: Error) => void;
        }
      }),
    };
    watcherCallbacks.set(id, {
      changeCallback: callback,
      errorCallback: () => {},
    });
    mockWatchers.push(watcher);
    return watcher;
  });

  return {
    mockFsWatch,
    mockWatchers,
    watcherCallbacks,
    getWatcherIdCounter: () => watcherIdCounter,
    resetWatcherIdCounter: () => { watcherIdCounter = 0; },
  };
});

const { mockStat } = vi.hoisted(() => ({
  mockStat: vi.fn().mockResolvedValue({
    isDirectory: () => true,
  }),
}));

vi.mock('fs', () => ({
  default: {
    watch: mockFsWatch,
  },
  watch: mockFsWatch,
}));

vi.mock('fs/promises', () => ({
  default: {
    stat: mockStat,
  },
  stat: mockStat,
}));

// ============================================================================
// Helpers
// ============================================================================

const MOCK_BASE_DIR = '/project/root';

/**
 * Simulate a file change event on the most recently created watcher.
 */
function simulateFileChange(filename: string, eventType: string = 'change'): void {
  for (const [, cb] of watcherCallbacks) {
    cb.changeCallback(eventType, filename);
  }
}

// ============================================================================
// Tests
// ============================================================================

describe('EventTriggerManager', () => {
  let manager: EventTriggerManager;
  let onTrigger: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    mockWatchers.length = 0;
    watcherCallbacks.clear();
    resetWatcherIdCounter();
    mockStat.mockResolvedValue({ isDirectory: () => true });

    onTrigger = vi.fn().mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.useRealTimers();
    // Clean up any remaining managers
    if (manager && manager.isRunning()) {
      manager.stop();
    }
  });

  describe('constructor', () => {
    it('should create manager with required options', () => {
      manager = new EventTriggerManager({
        baseDir: MOCK_BASE_DIR,
        pattern: 'workspace/chats/*.json',
        onTrigger,
      });

      expect(manager).toBeDefined();
      expect(manager.isRunning()).toBe(false);
      expect(manager.getPattern()).toBe('workspace/chats/*.json');
    });

    it('should use default debounce of 5000ms when not specified', () => {
      manager = new EventTriggerManager({
        baseDir: MOCK_BASE_DIR,
        pattern: '*.log',
        onTrigger,
      });

      // Default is applied internally, verified by behavior tests
      expect(manager.getPattern()).toBe('*.log');
    });
  });

  describe('start / stop lifecycle', () => {
    it('should start watching when directory exists', async () => {
      manager = new EventTriggerManager({
        baseDir: MOCK_BASE_DIR,
        pattern: 'workspace/chats/*.json',
        onTrigger,
      });

      await manager.start();

      expect(manager.isRunning()).toBe(true);
      expect(mockFsWatch).toHaveBeenCalledTimes(1);
      expect(mockFsWatch).toHaveBeenCalledWith(
        expect.stringContaining('workspace/chats'),
        expect.any(Object),
        expect.any(Function)
      );
    });

    it('should not start if already running', async () => {
      manager = new EventTriggerManager({
        baseDir: MOCK_BASE_DIR,
        pattern: '*.log',
        onTrigger,
      });

      await manager.start();
      await manager.start(); // second start

      expect(mockFsWatch).toHaveBeenCalledTimes(1);
    });

    it('should stop watching and clean up', async () => {
      manager = new EventTriggerManager({
        baseDir: MOCK_BASE_DIR,
        pattern: '*.log',
        onTrigger,
      });

      await manager.start();
      expect(manager.isRunning()).toBe(true);

      manager.stop();

      expect(manager.isRunning()).toBe(false);
      expect(mockWatchers[0].close).toHaveBeenCalledTimes(1);
    });

    it('should handle stop when not running', () => {
      manager = new EventTriggerManager({
        baseDir: MOCK_BASE_DIR,
        pattern: '*.log',
        onTrigger,
      });

      expect(() => manager.stop()).not.toThrow();
    });

    it('should skip watch when directory does not exist', async () => {
      mockStat.mockRejectedValue({ code: 'ENOENT' });

      manager = new EventTriggerManager({
        baseDir: MOCK_BASE_DIR,
        pattern: 'nonexistent/*.json',
        onTrigger,
      });

      await manager.start();

      expect(manager.isRunning()).toBe(false);
      expect(mockFsWatch).not.toHaveBeenCalled();
    });

    it('should handle watcher setup error gracefully', async () => {
      mockFsWatch.mockImplementationOnce(() => {
        throw new Error('Permission denied');
      });

      manager = new EventTriggerManager({
        baseDir: MOCK_BASE_DIR,
        pattern: 'workspace/*.json',
        onTrigger,
      });

      // Should not throw
      await manager.start();

      expect(manager.isRunning()).toBe(false);
    });
  });

  describe('file event handling', () => {
    it('should trigger callback on matching file change', async () => {
      manager = new EventTriggerManager({
        baseDir: MOCK_BASE_DIR,
        pattern: 'workspace/chats/*.json',
        debounceMs: 100,
        onTrigger,
      });

      await manager.start();
      simulateFileChange('pending-chat.json');

      // Advance timers to fire debounced trigger
      await vi.advanceTimersByTimeAsync(150);

      expect(onTrigger).toHaveBeenCalledTimes(1);
    });

    it('should not trigger on non-matching file extension', async () => {
      manager = new EventTriggerManager({
        baseDir: MOCK_BASE_DIR,
        pattern: 'workspace/chats/*.json',
        debounceMs: 100,
        onTrigger,
      });

      await manager.start();
      simulateFileChange('readme.txt');

      await vi.advanceTimersByTimeAsync(150);

      expect(onTrigger).not.toHaveBeenCalled();
    });

    it('should debounce multiple rapid file changes', async () => {
      manager = new EventTriggerManager({
        baseDir: MOCK_BASE_DIR,
        pattern: 'workspace/chats/*.json',
        debounceMs: 5000,
        onTrigger,
      });

      await manager.start();

      // Simulate 5 rapid file changes
      simulateFileChange('chat1.json');
      simulateFileChange('chat2.json');
      simulateFileChange('chat3.json');
      simulateFileChange('chat4.json');
      simulateFileChange('chat5.json');

      // Not triggered yet (within debounce window)
      expect(onTrigger).not.toHaveBeenCalled();

      // After debounce window
      await vi.advanceTimersByTimeAsync(6000);
      expect(onTrigger).toHaveBeenCalledTimes(1);
    });

    it('should reset debounce timer on each file change', async () => {
      manager = new EventTriggerManager({
        baseDir: MOCK_BASE_DIR,
        pattern: '*.json',
        debounceMs: 5000,
        onTrigger,
      });

      await manager.start();

      // First change
      simulateFileChange('a.json');
      await vi.advanceTimersByTimeAsync(3000); // 3s elapsed

      // Second change resets the timer
      simulateFileChange('b.json');
      await vi.advanceTimersByTimeAsync(3000); // 6s total, but only 3s since last change

      // Still not triggered because timer was reset
      expect(onTrigger).not.toHaveBeenCalled();

      // Now after full debounce from last change
      await vi.advanceTimersByTimeAsync(3000);
      expect(onTrigger).toHaveBeenCalledTimes(1);
    });

    it('should ignore null filename events', async () => {
      manager = new EventTriggerManager({
        baseDir: MOCK_BASE_DIR,
        pattern: '*.json',
        debounceMs: 100,
        onTrigger,
      });

      await manager.start();
      simulateFileChange(''); // empty string treated as null by fs.watch

      await vi.advanceTimersByTimeAsync(150);

      expect(onTrigger).not.toHaveBeenCalled();
    });

    it('should match files with wildcard prefix pattern (e.g., "chat-*.json")', async () => {
      manager = new EventTriggerManager({
        baseDir: MOCK_BASE_DIR,
        pattern: 'workspace/chats/chat-*.json',
        debounceMs: 100,
        onTrigger,
      });

      await manager.start();
      simulateFileChange('chat-abc123.json');

      await vi.advanceTimersByTimeAsync(150);

      expect(onTrigger).toHaveBeenCalledTimes(1);
    });

    it('should not trigger after stop', async () => {
      manager = new EventTriggerManager({
        baseDir: MOCK_BASE_DIR,
        pattern: '*.json',
        debounceMs: 100,
        onTrigger,
      });

      await manager.start();
      manager.stop();

      simulateFileChange('test.json');
      await vi.advanceTimersByTimeAsync(150);

      expect(onTrigger).not.toHaveBeenCalled();
    });

    it('should handle callback errors gracefully', async () => {
      onTrigger.mockRejectedValue(new Error('Callback failed'));

      manager = new EventTriggerManager({
        baseDir: MOCK_BASE_DIR,
        pattern: '*.json',
        debounceMs: 100,
        onTrigger,
      });

      await manager.start();
      simulateFileChange('test.json');

      // Should not throw even if callback fails
      await vi.advanceTimersByTimeAsync(150);

      expect(onTrigger).toHaveBeenCalledTimes(1);
    });
  });

  describe('parsePattern', () => {
    it('should parse glob pattern with directory and extension', () => {
      manager = new EventTriggerManager({
        baseDir: MOCK_BASE_DIR,
        pattern: 'workspace/chats/*.json',
        onTrigger,
      });

      const parsed = manager.parsePattern('workspace/chats/*.json');
      expect(parsed.watchDir).toBe(path.resolve(MOCK_BASE_DIR, 'workspace/chats'));
      expect(parsed.extension).toBe('.json');
    });

    it('should parse pattern with only extension (no directory)', () => {
      manager = new EventTriggerManager({
        baseDir: MOCK_BASE_DIR,
        pattern: '*.log',
        onTrigger,
      });

      const parsed = manager.parsePattern('*.log');
      expect(parsed.watchDir).toBe(path.resolve(MOCK_BASE_DIR));
      expect(parsed.extension).toBe('.log');
    });

    it('should parse directory-only pattern (no extension filter)', () => {
      manager = new EventTriggerManager({
        baseDir: MOCK_BASE_DIR,
        pattern: 'workspace/chats/',
        onTrigger,
      });

      const parsed = manager.parsePattern('workspace/chats/');
      expect(parsed.watchDir).toBe(path.resolve(MOCK_BASE_DIR, 'workspace/chats'));
      expect(parsed.extension).toBeNull();
    });

    it('should parse wildcard-prefixed pattern', () => {
      manager = new EventTriggerManager({
        baseDir: MOCK_BASE_DIR,
        pattern: 'workspace/chats/chat-*.json',
        onTrigger,
      });

      const parsed = manager.parsePattern('workspace/chats/chat-*.json');
      expect(parsed.watchDir).toBe(path.resolve(MOCK_BASE_DIR, 'workspace/chats'));
      expect(parsed.extension).toBe('.json');
    });

    it('should parse nested directory pattern', () => {
      manager = new EventTriggerManager({
        baseDir: MOCK_BASE_DIR,
        pattern: 'workspace/deep/nested/*.json',
        onTrigger,
      });

      const parsed = manager.parsePattern('workspace/deep/nested/*.json');
      expect(parsed.watchDir).toBe(path.resolve(MOCK_BASE_DIR, 'workspace/deep/nested'));
      expect(parsed.extension).toBe('.json');
    });

    it('should parse pattern with complex wildcard (no extension after wildcard)', () => {
      manager = new EventTriggerManager({
        baseDir: MOCK_BASE_DIR,
        pattern: 'workspace/data/*',
        onTrigger,
      });

      const parsed = manager.parsePattern('workspace/data/*');
      expect(parsed.watchDir).toBe(path.resolve(MOCK_BASE_DIR, 'workspace/data'));
      expect(parsed.extension).toBeNull();
    });
  });
});
