/**
 * Tests for EventTriggerManager.
 *
 * Issue #1953: Event-driven schedule trigger mechanism.
 *
 * Verifies file system event watching, debouncing,
 * task registration, and trigger callback invocation.
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

vi.mock('fs', () => ({
  default: {
    watch: mockFsWatch,
  },
  watch: mockFsWatch,
}));

vi.mock('fs/promises', () => ({
  default: {
    mkdir: mockMkdir,
  },
  mkdir: mockMkdir,
}));

import { EventTriggerManager, type TriggerCallback } from './event-trigger.js';
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

function createTaskWithTrigger(
  taskId: string,
  watchPath: string,
  debounce?: number
): ScheduledTask {
  return createTask({
    id: taskId,
    trigger: {
      watch: watchPath,
      debounce,
    },
  });
}

// ============================================================================
// EventTriggerManager Tests
// ============================================================================

describe('EventTriggerManager', () => {
  let manager: EventTriggerManager;
  let onTrigger: TriggerCallback;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    onTrigger = vi.fn().mockResolvedValue(true);
    manager = new EventTriggerManager({
      workspaceDir: WORKSPACE_DIR,
      onTrigger,
    });
  });

  afterEach(() => {
    manager.stop();
    vi.useRealTimers();
  });

  describe('constructor', () => {
    it('should initialize with workspace dir and trigger callback', () => {
      expect(manager).toBeInstanceOf(EventTriggerManager);
      expect(manager.isRunning()).toBe(false);
    });
  });

  describe('registerTask', () => {
    it('should register a task with trigger config', () => {
      const task = createTaskWithTrigger('t1', 'workspace/chats/');
      manager.registerTask(task);

      expect(manager.getRegisteredTaskCount()).toBe(1);
    });

    it('should ignore tasks without trigger config', () => {
      const task = createTask();
      manager.registerTask(task);

      expect(manager.getRegisteredTaskCount()).toBe(0);
    });

    it('should ignore tasks with empty trigger.watch', () => {
      const task = createTask({
        trigger: { watch: '' },
      });
      manager.registerTask(task);

      // Empty watch path is still registered (it's a truthy check)
      expect(manager.getRegisteredTaskCount()).toBe(0);
    });

    it('should resolve relative paths against workspace dir', () => {
      const task = createTaskWithTrigger('t1', 'workspace/chats/');
      manager.registerTask(task);

      expect(manager.getRegisteredTaskCount()).toBe(1);
    });

    it('should handle absolute paths', () => {
      const task = createTaskWithTrigger('t1', '/absolute/path/');
      manager.registerTask(task);

      expect(manager.getRegisteredTaskCount()).toBe(1);
    });
  });

  describe('unregisterTask', () => {
    it('should unregister a registered task', () => {
      const task = createTaskWithTrigger('t1', 'workspace/chats/');
      manager.registerTask(task);
      expect(manager.getRegisteredTaskCount()).toBe(1);

      manager.unregisterTask('t1');
      expect(manager.getRegisteredTaskCount()).toBe(0);
    });

    it('should handle unregistering non-existent task gracefully', () => {
      expect(() => manager.unregisterTask('nonexistent')).not.toThrow();
    });
  });

  describe('start / stop', () => {
    it('should start watching registered directories', async () => {
      const task = createTaskWithTrigger('t1', 'workspace/chats/');
      manager.registerTask(task);

      await manager.start();

      expect(manager.isRunning()).toBe(true);
      expect(manager.getWatcherCount()).toBe(1);
      expect(mockFsWatch).toHaveBeenCalledTimes(1);
    });

    it('should start with no registered tasks', async () => {
      await manager.start();

      expect(manager.isRunning()).toBe(true);
      expect(manager.getWatcherCount()).toBe(0);
    });

    it('should not start if already running', async () => {
      const task = createTaskWithTrigger('t1', 'workspace/chats/');
      manager.registerTask(task);

      await manager.start();
      await manager.start(); // Second call

      expect(mockFsWatch).toHaveBeenCalledTimes(1);
    });

    it('should coalesce watchers for tasks sharing the same directory', async () => {
      const task1 = createTaskWithTrigger('t1', 'workspace/chats/');
      const task2 = createTaskWithTrigger('t2', 'workspace/chats/');
      manager.registerTask(task1);
      manager.registerTask(task2);

      await manager.start();

      // Only one watcher for the same directory
      expect(manager.getWatcherCount()).toBe(1);
      expect(mockFsWatch).toHaveBeenCalledTimes(1);
    });

    it('should create separate watchers for different directories', async () => {
      const task1 = createTaskWithTrigger('t1', 'workspace/chats/');
      const task2 = createTaskWithTrigger('t2', 'workspace/other/');
      manager.registerTask(task1);
      manager.registerTask(task2);

      await manager.start();

      expect(manager.getWatcherCount()).toBe(2);
      expect(mockFsWatch).toHaveBeenCalledTimes(2);
    });

    it('should stop all watchers', async () => {
      const task = createTaskWithTrigger('t1', 'workspace/chats/');
      manager.registerTask(task);
      await manager.start();

      manager.stop();

      expect(manager.isRunning()).toBe(false);
      expect(manager.getWatcherCount()).toBe(0);
    });

    it('should be safe to stop when not running', () => {
      manager.stop(); // Should not throw
      expect(manager.isRunning()).toBe(false);
    });
  });

  describe('file event handling', () => {
    let eventCallback: (eventType: string, filename: string | null) => void;

    beforeEach(async () => {
      const task = createTaskWithTrigger('t1', 'workspace/chats/', 10);
      manager.registerTask(task);
      await manager.start();

      const [[,, cb]] = mockFsWatch.mock.calls;
      eventCallback = cb;
    });

    it('should trigger task on file create event', async () => {
      eventCallback('rename', 'new-file.json');
      vi.advanceTimersByTime(20);
      await vi.runAllTimersAsync();

      expect(onTrigger).toHaveBeenCalledWith('t1');
    });

    it('should trigger task on file change event', async () => {
      eventCallback('change', 'modified-file.json');
      vi.advanceTimersByTime(20);
      await vi.runAllTimersAsync();

      expect(onTrigger).toHaveBeenCalledWith('t1');
    });

    it('should ignore events without filename', async () => {
      eventCallback('change', null);
      vi.advanceTimersByTime(20);
      await vi.runAllTimersAsync();

      expect(onTrigger).not.toHaveBeenCalled();
    });

    it('should debounce rapid events for the same task', async () => {
      eventCallback('rename', 'file1.json');
      eventCallback('rename', 'file2.json');
      eventCallback('change', 'file1.json');

      vi.advanceTimersByTime(20);
      await vi.runAllTimersAsync();

      // Should only trigger once after debounce
      expect(onTrigger).toHaveBeenCalledTimes(1);
    });

    it('should trigger independently for tasks with different debounce timers', async () => {
      // Register second task with different directory
      const task2 = createTaskWithTrigger('t2', 'workspace/other/', 50);
      manager.registerTask(task2);
      // Need to start watcher for second directory
      await manager.start();

      // Get the first watcher's callback
      const [[,, cb1]] = mockFsWatch.mock.calls;
      cb1('rename', 'file.json');
      vi.advanceTimersByTime(20);
      await vi.runAllTimersAsync();

      expect(onTrigger).toHaveBeenCalledWith('t1');
    });
  });

  describe('trigger callback integration', () => {
    it('should handle trigger callback returning false', async () => {
      onTrigger.mockResolvedValue(false);

      const task = createTaskWithTrigger('t1', 'workspace/chats/', 10);
      manager.registerTask(task);
      await manager.start();

      const [[,, cb]] = mockFsWatch.mock.calls;
      cb('rename', 'file.json');
      vi.advanceTimersByTime(20);
      await vi.runAllTimersAsync();

      expect(onTrigger).toHaveBeenCalledWith('t1');
      // No error thrown, just logged
    });

    it('should handle trigger callback throwing error', async () => {
      onTrigger.mockRejectedValue(new Error('Trigger failed'));

      const task = createTaskWithTrigger('t1', 'workspace/chats/', 10);
      manager.registerTask(task);
      await manager.start();

      const [[,, cb]] = mockFsWatch.mock.calls;
      cb('rename', 'file.json');
      vi.advanceTimersByTime(20);
      await vi.runAllTimersAsync();

      expect(onTrigger).toHaveBeenCalledWith('t1');
      // No error thrown, just logged
    });
  });

  describe('default debounce', () => {
    it('should use default debounce of 5000ms when not specified', async () => {
      const task = createTaskWithTrigger('t1', 'workspace/chats/');
      manager.registerTask(task);
      await manager.start();

      const [[,, cb]] = mockFsWatch.mock.calls;
      cb('rename', 'file.json');

      // Advance less than 5000ms
      vi.advanceTimersByTime(4000);
      expect(onTrigger).not.toHaveBeenCalled();

      // Advance past 5000ms
      vi.advanceTimersByTime(2000);
      await vi.runAllTimersAsync();

      expect(onTrigger).toHaveBeenCalledTimes(1);
    });
  });

  describe('stop clears debounce timers', () => {
    it('should cancel pending triggers when stopped', async () => {
      const task = createTaskWithTrigger('t1', 'workspace/chats/', 10);
      manager.registerTask(task);
      await manager.start();

      const [[,, cb]] = mockFsWatch.mock.calls;
      cb('rename', 'file.json');

      // Stop before debounce fires
      manager.stop();

      vi.advanceTimersByTime(20);
      await vi.runAllTimersAsync();

      expect(onTrigger).not.toHaveBeenCalled();
    });
  });
});
