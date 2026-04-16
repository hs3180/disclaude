/**
 * Tests for EventTrigger - Filesystem event-driven schedule triggering.
 *
 * Issue #1953: Event-driven schedule trigger mechanism.
 *
 * Tests the EventTrigger class which watches filesystem paths and
 * triggers schedule tasks when matching files are created or modified.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { EventTrigger, type OnTriggerCallback } from './event-trigger.js';
import type { ScheduledTask } from './scheduled-task.js';

// Use vi.hoisted for mock functions
const { mockFsWatch, mockMkdir, mockStat } = vi.hoisted(() => {
  return {
    mockFsWatch: vi.fn().mockReturnValue({
      on: vi.fn().mockReturnThis(),
      close: vi.fn(),
    }),
    mockMkdir: vi.fn().mockResolvedValue(undefined),
    mockStat: vi.fn().mockResolvedValue({
      isDirectory: () => true,
      mtime: new Date('2026-01-01'),
    }),
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

// Helpers
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

describe('EventTrigger', () => {
  let onTrigger: OnTriggerCallback;
  let trigger: EventTrigger;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    onTrigger = vi.fn().mockResolvedValue(undefined);
    trigger = new EventTrigger({ onTrigger });
  });

  afterEach(() => {
    trigger.stop();
    vi.useRealTimers();
  });

  describe('constructor', () => {
    it('should create an EventTrigger instance', () => {
      expect(trigger).toBeInstanceOf(EventTrigger);
      expect(trigger.isRunning()).toBe(false);
      expect(trigger.getRegisteredTaskCount()).toBe(0);
    });
  });

  describe('registerTask', () => {
    it('should register a task with watch configuration', () => {
      const task = createTask({
        watch: { paths: ['/tmp/chats'] },
      });

      trigger.registerTask(task);

      expect(trigger.getRegisteredTaskCount()).toBe(1);
    });

    it('should ignore tasks without watch configuration', () => {
      const task = createTask();

      trigger.registerTask(task);

      expect(trigger.getRegisteredTaskCount()).toBe(0);
    });

    it('should ignore tasks with empty paths', () => {
      const task = createTask({
        watch: { paths: [] },
      });

      trigger.registerTask(task);

      expect(trigger.getRegisteredTaskCount()).toBe(0);
    });
  });

  describe('unregisterTask', () => {
    it('should unregister a previously registered task', () => {
      const task = createTask({
        id: 'remove-me',
        watch: { paths: ['/tmp/chats'] },
      });

      trigger.registerTask(task);
      expect(trigger.getRegisteredTaskCount()).toBe(1);

      trigger.unregisterTask('remove-me');
      expect(trigger.getRegisteredTaskCount()).toBe(0);
    });

    it('should handle unregistering unknown task gracefully', () => {
      expect(() => trigger.unregisterTask('unknown')).not.toThrow();
    });
  });

  describe('start / stop', () => {
    it('should start watching registered paths', async () => {
      const task = createTask({
        watch: { paths: ['/tmp/chats'] },
      });

      trigger.registerTask(task);
      await trigger.start();

      expect(trigger.isRunning()).toBe(true);
      expect(trigger.getActiveWatcherCount()).toBe(1);
      expect(mockFsWatch).toHaveBeenCalledWith(
        expect.stringContaining('/tmp/chats'),
        { persistent: true, recursive: false },
        expect.any(Function),
      );
    });

    it('should not start if already running', async () => {
      const task = createTask({
        watch: { paths: ['/tmp/chats'] },
      });

      trigger.registerTask(task);
      await trigger.start();
      await trigger.start(); // second start

      expect(mockFsWatch).toHaveBeenCalledTimes(1);
    });

    it('should stop all watchers', async () => {
      const task = createTask({
        watch: { paths: ['/tmp/chats'] },
      });

      trigger.registerTask(task);
      await trigger.start();
      expect(trigger.isRunning()).toBe(true);

      trigger.stop();
      expect(trigger.isRunning()).toBe(false);
      expect(trigger.getActiveWatcherCount()).toBe(0);
    });

    it('should be safe to stop without starting', () => {
      trigger.stop();
      expect(trigger.isRunning()).toBe(false);
    });

    it('should skip non-directory paths', async () => {
      mockStat.mockResolvedValueOnce({
        isDirectory: () => false,
      });

      const task = createTask({
        watch: { paths: ['/tmp/file.txt'] },
      });

      trigger.registerTask(task);
      await trigger.start();

      expect(trigger.getActiveWatcherCount()).toBe(0);
    });

    it('should create directory if it does not exist', async () => {
      mockStat.mockRejectedValueOnce(new Error('ENOENT'));

      const task = createTask({
        watch: { paths: ['/tmp/new-dir'] },
      });

      trigger.registerTask(task);
      await trigger.start();

      expect(mockMkdir).toHaveBeenCalledWith(
        expect.stringContaining('/tmp/new-dir'),
        { recursive: true },
      );
      expect(trigger.getActiveWatcherCount()).toBe(1);
    });
  });

  describe('event handling', () => {
    it('should trigger task when file event occurs', async () => {
      const task = createTask({
        id: 'event-task',
        watch: { paths: ['/tmp/chats'], debounce: 50 },
      });

      trigger.registerTask(task);
      await trigger.start();

      // Get the watch callback
      const [[,,watchCallback]] = mockFsWatch.mock.calls;

      // Simulate a file creation event
      watchCallback('rename', 'new-chat.json');
      vi.advanceTimersByTime(100);

      // Wait for async operations
      await vi.runAllTimersAsync();

      expect(onTrigger).toHaveBeenCalledWith('event-task');
    });

    it('should debounce rapid events', async () => {
      const task = createTask({
        id: 'debounce-task',
        watch: { paths: ['/tmp/chats'], debounce: 100 },
      });

      trigger.registerTask(task);
      await trigger.start();

      const [[,,watchCallback]] = mockFsWatch.mock.calls;

      // Rapid events
      watchCallback('rename', 'file1.json');
      watchCallback('rename', 'file2.json');
      watchCallback('rename', 'file3.json');

      // Before debounce period
      vi.advanceTimersByTime(50);
      expect(onTrigger).not.toHaveBeenCalled();

      // After debounce period
      vi.advanceTimersByTime(100);
      await vi.runAllTimersAsync();

      // Should only trigger once
      expect(onTrigger).toHaveBeenCalledTimes(1);
      expect(onTrigger).toHaveBeenCalledWith('debounce-task');
    });

    it('should filter events by type', async () => {
      const task = createTask({
        id: 'filter-task',
        watch: {
          paths: ['/tmp/chats'],
          events: ['create'],
          debounce: 50,
        },
      });

      trigger.registerTask(task);
      await trigger.start();

      const [[,,watchCallback]] = mockFsWatch.mock.calls;

      // 'change' event should be filtered out (only 'create' is watched)
      watchCallback('change', 'modified.json');
      vi.advanceTimersByTime(100);
      await vi.runAllTimersAsync();

      expect(onTrigger).not.toHaveBeenCalled();

      // 'rename' maps to 'create' — should trigger
      watchCallback('rename', 'new-file.json');
      vi.advanceTimersByTime(100);
      await vi.runAllTimersAsync();

      expect(onTrigger).toHaveBeenCalledWith('filter-task');
    });

    it('should ignore events without filename', async () => {
      const task = createTask({
        id: 'null-name-task',
        watch: { paths: ['/tmp/chats'], debounce: 50 },
      });

      trigger.registerTask(task);
      await trigger.start();

      const [[,,watchCallback]] = mockFsWatch.mock.calls;

      watchCallback('rename', null);
      vi.advanceTimersByTime(100);
      await vi.runAllTimersAsync();

      expect(onTrigger).not.toHaveBeenCalled();
    });

    it('should use default debounce of 1000ms', async () => {
      const task = createTask({
        id: 'default-debounce',
        watch: { paths: ['/tmp/chats'] }, // no debounce specified
      });

      trigger.registerTask(task);
      await trigger.start();

      const [[,,watchCallback]] = mockFsWatch.mock.calls;

      watchCallback('rename', 'file.json');

      // At 999ms — should not have triggered yet
      vi.advanceTimersByTime(999);
      expect(onTrigger).not.toHaveBeenCalled();

      // At 1000ms — should trigger now
      vi.advanceTimersByTime(1);
      await vi.runAllTimersAsync();

      expect(onTrigger).toHaveBeenCalledWith('default-debounce');
    });
  });

  describe('multiple tasks', () => {
    it('should trigger different tasks watching different directories', async () => {
      const task1 = createTask({
        id: 'task-a',
        watch: { paths: ['/tmp/chats'], debounce: 50 },
      });
      const task2 = createTask({
        id: 'task-b',
        watch: { paths: ['/tmp/other'], debounce: 50 },
      });

      trigger.registerTask(task1);
      trigger.registerTask(task2);
      await trigger.start();

      expect(trigger.getActiveWatcherCount()).toBe(2);

      // Trigger event in /tmp/chats
      const [call1] = mockFsWatch.mock.calls;
      const watchCallback1 = call1[2] as (eventType: string, filename: string | null) => void;
      watchCallback1('rename', 'file.json');
      vi.advanceTimersByTime(100);
      await vi.runAllTimersAsync();

      expect(onTrigger).toHaveBeenCalledWith('task-a');
      // task-b should NOT be triggered since it watches a different path
    });

    it('should trigger multiple tasks watching the same directory', async () => {
      const task1 = createTask({
        id: 'shared-a',
        watch: { paths: ['/tmp/chats'], debounce: 50 },
      });
      const task2 = createTask({
        id: 'shared-b',
        watch: { paths: ['/tmp/chats'], debounce: 50 },
      });

      trigger.registerTask(task1);
      trigger.registerTask(task2);
      await trigger.start();

      // Only one watcher for the same directory
      expect(trigger.getActiveWatcherCount()).toBe(1);

      const [[,,watchCallback]] = mockFsWatch.mock.calls;
      watchCallback('rename', 'file.json');
      vi.advanceTimersByTime(100);
      await vi.runAllTimersAsync();

      // Both tasks should be triggered
      expect(onTrigger).toHaveBeenCalledWith('shared-a');
      expect(onTrigger).toHaveBeenCalledWith('shared-b');
      expect(onTrigger).toHaveBeenCalledTimes(2);
    });
  });

  describe('dynamic registration', () => {
    it('should start watching when task is registered after start', async () => {
      await trigger.start();

      const task = createTask({
        id: 'dynamic-task',
        watch: { paths: ['/tmp/chats'] },
      });

      trigger.registerTask(task);

      // registerTask calls startWatchingPaths asynchronously (void return)
      // Wait for the async path watching to complete
      await vi.waitFor(() => {
        expect(mockFsWatch).toHaveBeenCalled();
      }, { timeout: 2000 });
    });

    it('should cleanup watchers when task is unregistered', async () => {
      const task = createTask({
        id: 'cleanup-task',
        watch: { paths: ['/tmp/chats'] },
      });

      trigger.registerTask(task);
      await trigger.start();
      expect(trigger.getActiveWatcherCount()).toBe(1);

      trigger.unregisterTask('cleanup-task');
      // Watcher should be stopped since no tasks use it anymore
      expect(trigger.getActiveWatcherCount()).toBe(0);
    });
  });

  describe('error handling', () => {
    it('should handle trigger callback errors gracefully', async () => {
      onTrigger = vi.fn().mockRejectedValue(new Error('Trigger failed'));
      trigger = new EventTrigger({ onTrigger });

      const task = createTask({
        id: 'error-task',
        watch: { paths: ['/tmp/chats'], debounce: 50 },
      });

      trigger.registerTask(task);
      await trigger.start();

      const [[,,watchCallback]] = mockFsWatch.mock.calls;
      watchCallback('rename', 'file.json');
      vi.advanceTimersByTime(100);
      await vi.runAllTimersAsync();

      // Should have been called despite the error
      expect(onTrigger).toHaveBeenCalledWith('error-task');
    });

    it('should handle watcher creation failure', async () => {
      mockFsWatch.mockImplementation(() => {
        throw new Error('Watch failed');
      });

      const task = createTask({
        id: 'fail-task',
        watch: { paths: ['/tmp/chats'] },
      });

      trigger.registerTask(task);
      // Should not throw
      await trigger.start();

      expect(trigger.getActiveWatcherCount()).toBe(0);
    });
  });
});
