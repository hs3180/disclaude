/**
 * Tests for EventTrigger.
 *
 * Issue #1953: Event-driven schedule trigger mechanism.
 *
 * Tests file watching, debouncing, pattern matching, and lifecycle.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const { mockMkdir, mockFsWatch, mockStat } = vi.hoisted(() => {
  const watchClose = vi.fn();
  return {
    mockMkdir: vi.fn().mockResolvedValue(undefined),
    mockFsWatch: vi.fn().mockReturnValue({
      on: vi.fn().mockReturnThis(),
      close: watchClose,
    }),
    mockStat: vi.fn().mockResolvedValue({ isDirectory: () => true }),
  };
});

vi.mock('fs', () => ({
  default: {
    watch: mockFsWatch,
  },
  watch: mockFsWatch,
}));

vi.mock('fs/promises', () => ({
  default: {
    mkdir: mockMkdir,
    stat: mockStat,
  },
  mkdir: mockMkdir,
  stat: mockStat,
}));

import { EventTrigger } from './event-trigger.js';

describe('EventTrigger', () => {
  let onTrigger: ReturnType<typeof vi.fn>;
  let trigger: EventTrigger;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    onTrigger = vi.fn();
  });

  afterEach(() => {
    vi.useRealTimers();
    if (trigger) {
      trigger.stop();
    }
  });

  function createTrigger(watchPaths: string[], debounce = 5000) {
    trigger = new EventTrigger({
      taskId: 'schedule-test-task',
      watchPaths,
      debounce,
      onTrigger,
    });
    return trigger;
  }

  describe('constructor', () => {
    it('should create with default debounce', () => {
      const t = new EventTrigger({
        taskId: 'test',
        watchPaths: ['./workspace/chats'],
        onTrigger,
      });
      expect(t).toBeInstanceOf(EventTrigger);
      expect(t.isRunning()).toBe(false);
      t.stop();
    });

    it('should accept custom debounce', () => {
      const t = new EventTrigger({
        taskId: 'test',
        watchPaths: ['./workspace/chats'],
        debounce: 10000,
        onTrigger,
      });
      expect(t).toBeInstanceOf(EventTrigger);
      t.stop();
    });
  });

  describe('start / stop', () => {
    it('should start watching directory', async () => {
      createTrigger(['./workspace/chats']);
      await trigger.start();

      expect(mockFsWatch).toHaveBeenCalledWith(
        expect.stringContaining('workspace/chats'),
        { persistent: true, recursive: false },
        expect.any(Function),
      );
      expect(trigger.isRunning()).toBe(true);
    });

    it('should not start if already running', async () => {
      createTrigger(['./workspace/chats']);
      await trigger.start();
      expect(mockFsWatch).toHaveBeenCalledTimes(1);

      await trigger.start();
      expect(mockFsWatch).toHaveBeenCalledTimes(1);
    });

    it('should stop and close watchers', async () => {
      createTrigger(['./workspace/chats']);
      await trigger.start();
      expect(trigger.isRunning()).toBe(true);

      trigger.stop();
      expect(trigger.isRunning()).toBe(false);
    });

    it('should be safe to stop without starting', () => {
      createTrigger(['./workspace/chats']);
      trigger.stop(); // should not throw
      expect(trigger.isRunning()).toBe(false);
    });

    it('should handle watch failure gracefully', async () => {
      mockFsWatch.mockImplementation(() => {
        throw new Error('Watch failed');
      });

      createTrigger(['./workspace/chats']);
      await trigger.start();

      // Should not be running if watch failed
      expect(trigger.isRunning()).toBe(false);
    });

    it('should resolve glob patterns to directories', async () => {
      createTrigger(['./workspace/chats/*.json']);
      await trigger.start();

      // Should watch the parent directory, not the glob
      expect(mockFsWatch).toHaveBeenCalledWith(
        expect.stringContaining('workspace/chats'),
        expect.any(Object),
        expect.any(Function),
      );
    });
  });

  describe('file event handling', () => {
    let eventCallback: (eventType: string, filename: string | null) => void;

    beforeEach(async () => {
      createTrigger(['./workspace/chats/*.json'], 100);
      await trigger.start();

      const [[,, cb]] = mockFsWatch.mock.calls;
      eventCallback = cb;
    });

    it('should ignore events without filename', () => {
      eventCallback('change', null);
      vi.advanceTimersByTime(200);
      expect(onTrigger).not.toHaveBeenCalled();
    });

    it('should debounce rapid events', () => {
      eventCallback('rename', 'test1.json');
      eventCallback('rename', 'test2.json');
      eventCallback('rename', 'test3.json');

      // Not called immediately
      expect(onTrigger).not.toHaveBeenCalled();

      vi.advanceTimersByTime(200);

      // Only called once after debounce
      expect(onTrigger).toHaveBeenCalledTimes(1);
      expect(onTrigger).toHaveBeenCalledWith('schedule-test-task');
    });

    it('should filter files by glob pattern', () => {
      eventCallback('rename', 'test.json');
      vi.advanceTimersByTime(200);
      expect(onTrigger).toHaveBeenCalledTimes(1);
    });

    it('should ignore files not matching glob pattern', () => {
      eventCallback('rename', 'test.txt');
      vi.advanceTimersByTime(200);
      expect(onTrigger).not.toHaveBeenCalled();
    });

    it('should match all files when watch is a bare directory', async () => {
      // Create trigger with bare directory (no glob)
      trigger.stop();
      mockFsWatch.mockClear();
      onTrigger.mockClear();

      createTrigger(['./workspace/chats'], 100);
      await trigger.start();

      const [[,, cb]] = mockFsWatch.mock.calls;

      cb('rename', 'test.txt');
      vi.advanceTimersByTime(200);
      expect(onTrigger).toHaveBeenCalledTimes(1);
    });

    it('should reset debounce timer on new event', () => {
      eventCallback('rename', 'test1.json');

      // Advance part way through debounce
      vi.advanceTimersByTime(50);

      // New event resets timer
      eventCallback('rename', 'test2.json');

      // Advance another 50ms — not enough for full debounce
      vi.advanceTimersByTime(50);
      expect(onTrigger).not.toHaveBeenCalled();

      // Advance past debounce from last event
      vi.advanceTimersByTime(100);
      expect(onTrigger).toHaveBeenCalledTimes(1);
    });

    it('should clear debounce timer on stop', () => {
      eventCallback('rename', 'test.json');
      trigger.stop();

      vi.advanceTimersByTime(200);
      expect(onTrigger).not.toHaveBeenCalled();
    });
  });

  describe('fireNow', () => {
    it('should immediately call onTrigger', () => {
      createTrigger(['./workspace/chats']);
      trigger.fireNow();

      expect(onTrigger).toHaveBeenCalledTimes(1);
      expect(onTrigger).toHaveBeenCalledWith('schedule-test-task');
    });

    it('should bypass debounce', () => {
      createTrigger(['./workspace/chats'], 10000);
      trigger.fireNow();

      expect(onTrigger).toHaveBeenCalledTimes(1);
    });
  });

  describe('resolveDirectory', () => {
    it('should resolve glob patterns to parent directory', async () => {
      createTrigger(['workspace/chats/*.json']);
      await trigger.start();

      expect(mockFsWatch).toHaveBeenCalledWith(
        expect.not.stringContaining('*'),
        expect.any(Object),
        expect.any(Function),
      );
    });

    it('should handle double-star glob patterns', async () => {
      createTrigger(['workspace/**/*.json']);
      await trigger.start();

      expect(mockFsWatch).toHaveBeenCalledWith(
        expect.not.stringContaining('*'),
        expect.any(Object),
        expect.any(Function),
      );
    });

    it('should handle multiple watch paths', async () => {
      createTrigger(['./workspace/chats', './workspace/data']);
      await trigger.start();

      expect(mockFsWatch).toHaveBeenCalledTimes(2);
    });

    it('should deduplicate directories', async () => {
      createTrigger(['./workspace/chats/*.json', './workspace/chats']);
      await trigger.start();

      // Both resolve to same directory
      expect(mockFsWatch).toHaveBeenCalledTimes(1);
    });
  });
});
