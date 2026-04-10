/**
 * Tests for ScheduleTriggerWatcher.
 *
 * Issue #1953: Event-driven schedule trigger mechanism.
 *
 * Tests the ScheduleTriggerWatcher class which watches arbitrary file paths
 * for changes and triggers associated schedule tasks.
 *
 * Uses vi.mock for ESM module mocking since vi.spyOn doesn't work with
 * ESM namespace exports.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// Use vi.hoisted to define mock functions that can be referenced in vi.mock factory
const { mockMkdir, mockFsWatch } = vi.hoisted(() => {
  const watchClose = vi.fn();
  return {
    mockMkdir: vi.fn().mockResolvedValue(undefined),
    mockFsWatch: vi.fn().mockReturnValue({
      on: vi.fn().mockReturnThis(),
      close: watchClose,
    }),
  };
});

vi.mock('fs/promises', () => ({
  default: {
    mkdir: mockMkdir,
  },
  mkdir: mockMkdir,
}));

vi.mock('fs', () => ({
  default: {
    watch: mockFsWatch,
  },
  watch: mockFsWatch,
}));

import { ScheduleTriggerWatcher } from './trigger-watcher.js';
import type { ScheduledTask } from './scheduled-task.js';

// ============================================================================
// Helpers
// ============================================================================

const WORKSPACE_DIR = '/tmp/test-workspace';

function createTask(overrides: Partial<ScheduledTask> = {}): ScheduledTask {
  return {
    id: 'task-1',
    name: 'Test Task',
    cron: '* * * * *',
    prompt: 'Run tests',
    chatId: 'oc_test',
    enabled: true,
    createdAt: '2026-01-01T00:00:00Z',
    ...overrides,
  };
}

// ============================================================================
// Tests
// ============================================================================

describe('ScheduleTriggerWatcher', () => {
  let onTrigger: ReturnType<typeof vi.fn>;
  let watcher: ScheduleTriggerWatcher;

  beforeEach(() => {
    vi.clearAllMocks();
    onTrigger = vi.fn();
    watcher = new ScheduleTriggerWatcher({
      workspaceDir: WORKSPACE_DIR,
      onTrigger,
    });
  });

  afterEach(() => {
    watcher.stop();
  });

  describe('constructor', () => {
    it('should create watcher with required options', () => {
      expect(watcher).toBeInstanceOf(ScheduleTriggerWatcher);
      expect(watcher.isRunning()).toBe(false);
      expect(watcher.getWatchCount()).toBe(0);
    });
  });

  describe('addWatch / removeWatch', () => {
    it('should add a watch for a task with watch config', () => {
      const task = createTask({ watch: 'workspace/chats/*.json' });
      watcher.addWatch(task);

      expect(watcher.getWatchCount()).toBe(1);
      expect(watcher.getWatchedTaskIds()).toContain('task-1');
    });

    it('should not add watch for a task without watch config', () => {
      const task = createTask(); // no watch field
      watcher.addWatch(task);

      expect(watcher.getWatchCount()).toBe(0);
    });

    it('should not add watch for a disabled task', () => {
      const task = createTask({ watch: 'workspace/chats/*.json', enabled: false });
      watcher.addWatch(task);

      expect(watcher.getWatchCount()).toBe(0);
    });

    it('should not add watch for empty watch path', () => {
      const task = createTask({ watch: '' });
      watcher.addWatch(task);

      expect(watcher.getWatchCount()).toBe(0);
    });

    it('should not add watch for whitespace-only watch path', () => {
      const task = createTask({ watch: '   ' });
      watcher.addWatch(task);

      expect(watcher.getWatchCount()).toBe(0);
    });

    it('should replace existing watch when adding watch for same task', () => {
      const task1 = createTask({ watch: 'workspace/chats/*.json' });
      const task2 = createTask({ watch: 'workspace/data/*.csv' });
      watcher.addWatch(task1);
      watcher.addWatch(task2);

      // Same task ID, so should replace, not add
      expect(watcher.getWatchCount()).toBe(1);
    });

    it('should remove a watch by task ID', () => {
      const task = createTask({ watch: 'workspace/chats/*.json' });
      watcher.addWatch(task);
      expect(watcher.getWatchCount()).toBe(1);

      watcher.removeWatch('task-1');
      expect(watcher.getWatchCount()).toBe(0);
    });

    it('should handle removing non-existent watch gracefully', () => {
      expect(() => watcher.removeWatch('nonexistent')).not.toThrow();
    });

    it('should support multiple tasks with different IDs', () => {
      const task1 = createTask({ id: 'task-1', watch: 'workspace/chats/*.json' });
      const task2 = createTask({ id: 'task-2', watch: 'workspace/data/*.csv' });
      watcher.addWatch(task1);
      watcher.addWatch(task2);

      expect(watcher.getWatchCount()).toBe(2);
    });

    it('should use default debounce when watchDebounce is not set', () => {
      const task = createTask({ watch: 'workspace/chats/*.json' });
      watcher.addWatch(task);
      expect(watcher.getWatchCount()).toBe(1);
    });

    it('should use custom debounce when watchDebounce is set', () => {
      const task = createTask({ watch: 'workspace/chats/*.json', watchDebounce: 5000 });
      watcher.addWatch(task);
      expect(watcher.getWatchCount()).toBe(1);
    });
  });

  describe('start / stop', () => {
    it('should start the watcher', async () => {
      const task = createTask({ watch: 'workspace/chats/*.json' });
      watcher.addWatch(task);

      await watcher.start();

      expect(watcher.isRunning()).toBe(true);
      expect(mockMkdir).toHaveBeenCalled();
      expect(mockFsWatch).toHaveBeenCalled();
    });

    it('should not start if already running', async () => {
      await watcher.start();
      await watcher.start(); // second start

      expect(mockFsWatch).toHaveBeenCalledTimes(0); // no tasks to watch
    });

    it('should stop all watches', async () => {
      const task = createTask({ watch: 'workspace/chats/*.json' });
      watcher.addWatch(task);
      await watcher.start();
      watcher.stop();

      expect(watcher.isRunning()).toBe(false);
    });

    it('should be safe to stop when not running', () => {
      expect(() => watcher.stop()).not.toThrow();
    });
  });

  describe('watch path parsing', () => {
    it('should parse glob pattern correctly', () => {
      const task = createTask({ watch: 'workspace/chats/*.json' });
      watcher.addWatch(task);
      expect(watcher.getWatchCount()).toBe(1);
    });

    it('should parse absolute paths', () => {
      const task = createTask({ watch: '/tmp/absolute/path/*.txt' });
      watcher.addWatch(task);
      expect(watcher.getWatchCount()).toBe(1);
    });

    it('should handle directory-only paths (trailing slash)', () => {
      const task = createTask({ watch: 'workspace/chats/' });
      watcher.addWatch(task);
      expect(watcher.getWatchCount()).toBe(1);
    });

    it('should handle directory paths without trailing slash', () => {
      const task = createTask({ watch: 'workspace/chats' });
      watcher.addWatch(task);
      expect(watcher.getWatchCount()).toBe(1);
    });
  });

  describe('file event handling', () => {
    let eventCallback: (eventType: string, filename: string | null) => void;

    beforeEach(async () => {
      // Set up fake timers for debounce tests
      vi.useFakeTimers();

      // Capture the event callback from fs.watch
      mockFsWatch.mockImplementation(
        (_path: unknown, _options: unknown, callback: unknown) => {
          eventCallback = callback as typeof eventCallback;
          return {
            on: vi.fn().mockReturnThis(),
            close: vi.fn(),
          };
        }
      );
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it('should trigger on file change matching extension', async () => {
      const task = createTask({ watch: 'workspace/chats/*.json', watchDebounce: 10 });
      watcher.addWatch(task);
      await watcher.start();

      eventCallback('change', 'test.json');
      vi.advanceTimersByTime(20);

      expect(onTrigger).toHaveBeenCalledWith('task-1');
    });

    it('should not trigger for files not matching extension', async () => {
      const task = createTask({ watch: 'workspace/chats/*.json', watchDebounce: 10 });
      watcher.addWatch(task);
      await watcher.start();

      eventCallback('change', 'test.txt');
      vi.advanceTimersByTime(20);

      expect(onTrigger).not.toHaveBeenCalled();
    });

    it('should ignore events without filename', async () => {
      const task = createTask({ watch: 'workspace/chats/*.json', watchDebounce: 10 });
      watcher.addWatch(task);
      await watcher.start();

      eventCallback('change', null);
      vi.advanceTimersByTime(20);

      expect(onTrigger).not.toHaveBeenCalled();
    });

    it('should debounce rapid events', async () => {
      const task = createTask({ watch: 'workspace/chats/*.json', watchDebounce: 50 });
      watcher.addWatch(task);
      await watcher.start();

      // Fire multiple rapid events
      eventCallback('change', 'file1.json');
      eventCallback('change', 'file2.json');
      eventCallback('change', 'file3.json');

      // Before debounce fires
      vi.advanceTimersByTime(30);
      expect(onTrigger).not.toHaveBeenCalled();

      // After debounce fires
      vi.advanceTimersByTime(30);
      expect(onTrigger).toHaveBeenCalledTimes(1);
    });

    it('should trigger for all files when no extension filter', async () => {
      const task = createTask({ watch: 'workspace/chats/', watchDebounce: 10 });
      watcher.addWatch(task);
      await watcher.start();

      eventCallback('change', 'anyfile.xyz');
      vi.advanceTimersByTime(20);

      expect(onTrigger).toHaveBeenCalledWith('task-1');
    });

    it('should handle rename events (create)', async () => {
      const task = createTask({ watch: 'workspace/chats/*.json', watchDebounce: 10 });
      watcher.addWatch(task);
      await watcher.start();

      eventCallback('rename', 'new-file.json');
      vi.advanceTimersByTime(20);

      expect(onTrigger).toHaveBeenCalledWith('task-1');
    });
  });

  describe('lifecycle with scheduler', () => {
    it('should register watches for tasks added after start', async () => {
      await watcher.start();

      // Add watch after start - should immediately start watching
      const task = createTask({ watch: 'workspace/chats/*.json' });
      watcher.addWatch(task);

      expect(watcher.getWatchCount()).toBe(1);
    });

    it('should remove watch from running watcher', async () => {
      const task = createTask({ watch: 'workspace/chats/*.json' });
      watcher.addWatch(task);
      await watcher.start();

      watcher.removeWatch('task-1');
      expect(watcher.getWatchCount()).toBe(0);
    });
  });
});
