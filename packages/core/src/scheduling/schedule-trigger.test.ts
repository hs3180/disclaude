/**
 * Tests for ScheduleTrigger (packages/core/src/scheduling/schedule-trigger.ts)
 *
 * Verifies file watch-based event-driven schedule execution:
 * - Task registration and unregistration
 * - Watcher creation and cleanup
 * - Debounce mechanism
 * - Trigger callback invocation
 * - Shared watcher reuse
 *
 * Issue #1953: Event-driven schedule trigger mechanism.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { ScheduleTrigger } from './schedule-trigger.js';
import type { ScheduledTask } from './scheduled-task.js';

// Use vi.hoisted to define mock functions that can be referenced in vi.mock factory
const { mockFsWatch, mockMkdir } = vi.hoisted(() => ({
  mockFsWatch: vi.fn().mockReturnValue({
    on: vi.fn().mockReturnThis(),
    close: vi.fn(),
  }),
  mockMkdir: vi.fn().mockResolvedValue(undefined),
}));

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

// ============================================================================
// Helpers
// ============================================================================

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

function createWatchTask(id: string, paths: string[], debounce?: number): ScheduledTask {
  return createTask({
    id,
    name: `Watch Task ${id}`,
    watch: { paths, debounce },
  });
}

// ============================================================================
// Tests
// ============================================================================

describe('ScheduleTrigger', () => {
  let trigger: ScheduleTrigger;
  let onTriggered: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    onTriggered = vi.fn();
    trigger = new ScheduleTrigger({ onTriggered });
  });

  afterEach(() => {
    trigger.stop();
    vi.useRealTimers();
  });

  describe('constructor', () => {
    it('should create trigger with callback', () => {
      expect(trigger).toBeDefined();
      expect(trigger.isRunning()).toBe(false);
      expect(trigger.getTaskCount()).toBe(0);
      expect(trigger.getWatcherCount()).toBe(0);
    });
  });

  describe('registerTask', () => {
    it('should register task with watch config', () => {
      const task = createWatchTask('watch-1', ['/tmp/test']);
      trigger.registerTask(task);
      expect(trigger.getTaskCount()).toBe(1);
    });

    it('should ignore task without watch config', () => {
      const task = createTask({ id: 'no-watch' });
      trigger.registerTask(task);
      expect(trigger.getTaskCount()).toBe(0);
    });

    it('should ignore task with empty watch paths', () => {
      const task = createTask({
        id: 'empty-watch',
        watch: { paths: [] },
      });
      trigger.registerTask(task);
      expect(trigger.getTaskCount()).toBe(0);
    });

    it('should ignore task with undefined watch', () => {
      const task = createTask({ id: 'undef-watch', watch: undefined });
      trigger.registerTask(task);
      expect(trigger.getTaskCount()).toBe(0);
    });
  });

  describe('unregisterTask', () => {
    it('should unregister a registered task', () => {
      const task = createWatchTask('watch-2', ['/tmp/test']);
      trigger.registerTask(task);
      expect(trigger.getTaskCount()).toBe(1);

      trigger.unregisterTask('watch-2');
      expect(trigger.getTaskCount()).toBe(0);
    });

    it('should handle unregistering non-existent task gracefully', () => {
      expect(() => trigger.unregisterTask('nonexistent')).not.toThrow();
    });
  });

  describe('start / stop', () => {
    it('should start and create watchers for registered tasks', async () => {
      const task = createWatchTask('watch-3', ['/tmp/watch-dir']);
      trigger.registerTask(task);

      await trigger.start();

      expect(trigger.isRunning()).toBe(true);
      expect(trigger.getWatcherCount()).toBe(1);
      expect(mockFsWatch).toHaveBeenCalledWith(
        '/tmp/watch-dir',
        { persistent: true, recursive: false },
        expect.any(Function)
      );
    });

    it('should not start if already running', async () => {
      const task = createWatchTask('watch-4', ['/tmp/dir1']);
      trigger.registerTask(task);

      await trigger.start();
      await trigger.start(); // second start

      // Should only call mkdir and fs.watch once per path
      expect(mockFsWatch).toHaveBeenCalledTimes(1);
    });

    it('should stop all watchers', async () => {
      const task1 = createWatchTask('w1', ['/tmp/dir1']);
      const task2 = createWatchTask('w2', ['/tmp/dir2']);
      trigger.registerTask(task1);
      trigger.registerTask(task2);

      await trigger.start();
      expect(trigger.getWatcherCount()).toBe(2);

      trigger.stop();
      expect(trigger.isRunning()).toBe(false);
      expect(trigger.getWatcherCount()).toBe(0);
    });

    it('should be safe to call stop without start', () => {
      expect(() => trigger.stop()).not.toThrow();
    });

    it('should reuse watchers for the same directory', async () => {
      const task1 = createWatchTask('shared-1', ['/tmp/shared-dir']);
      const task2 = createWatchTask('shared-2', ['/tmp/shared-dir']);
      trigger.registerTask(task1);
      trigger.registerTask(task2);

      await trigger.start();

      // Should only create one watcher for the shared directory
      expect(mockFsWatch).toHaveBeenCalledTimes(1);
      expect(trigger.getWatcherCount()).toBe(1);
    });
  });

  describe('debounce', () => {
    it('should debounce rapid file changes', async () => {
      const task = createWatchTask('debounce-1', ['/tmp/debounce-dir'], 5000);
      trigger.registerTask(task);
      await trigger.start();

      // Get the watch callback
      const [[,,watchCallback]] = mockFsWatch.mock.calls;

      // Simulate rapid file changes
      watchCallback('change', 'file1.json');
      watchCallback('change', 'file2.json');
      watchCallback('change', 'file3.json');

      // Before debounce elapses — should not trigger
      expect(onTriggered).not.toHaveBeenCalled();

      // Advance past debounce
      vi.advanceTimersByTime(5000);
      await vi.runAllTimersAsync();

      // Should trigger exactly once
      expect(onTriggered).toHaveBeenCalledTimes(1);
      expect(onTriggered).toHaveBeenCalledWith(
        expect.objectContaining({ id: 'debounce-1' })
      );
    });

    it('should use default debounce of 1000ms when not specified', async () => {
      const task = createWatchTask('default-debounce', ['/tmp/default-db-dir']);
      trigger.registerTask(task);
      await trigger.start();

      const [[,,watchCallback]] = mockFsWatch.mock.calls;
      watchCallback('change', 'file.json');

      // Advance less than the default debounce — should NOT trigger
      vi.advanceTimersByTime(999);
      expect(onTriggered).not.toHaveBeenCalled();

      // Advance past the default debounce — should trigger exactly once
      vi.advanceTimersByTime(2);
      await vi.runAllTimersAsync();

      expect(onTriggered).toHaveBeenCalledTimes(1);
    });
  });

  describe('trigger callback', () => {
    it('should call onTriggered with the correct task', async () => {
      const task = createWatchTask('callback-test', ['/tmp/cb-dir'], 100);
      trigger.registerTask(task);
      await trigger.start();

      const [[,,watchCallback]] = mockFsWatch.mock.calls;
      watchCallback('change', 'trigger-file.json');

      vi.advanceTimersByTime(100);
      await vi.runAllTimersAsync();

      expect(onTriggered).toHaveBeenCalledWith(
        expect.objectContaining({
          id: 'callback-test',
          name: 'Watch Task callback-test',
        })
      );
    });

    it('should trigger correct task when multiple tasks share a directory', async () => {
      const task1 = createWatchTask('multi-1', ['/tmp/multi-dir'], 100);
      const task2 = createWatchTask('multi-2', ['/tmp/multi-dir'], 100);
      trigger.registerTask(task1);
      trigger.registerTask(task2);
      await trigger.start();

      const [[,,watchCallback]] = mockFsWatch.mock.calls;
      watchCallback('change', 'shared-file.json');

      vi.advanceTimersByTime(100);
      await vi.runAllTimersAsync();

      expect(onTriggered).toHaveBeenCalledTimes(2);
      const triggeredIds = onTriggered.mock.calls.map((c: unknown[]) => (c[0] as ScheduledTask).id);
      expect(triggeredIds).toContain('multi-1');
      expect(triggeredIds).toContain('multi-2');
    });
  });

  describe('watcher error handling', () => {
    it('should handle watcher creation failure gracefully', async () => {
      mockFsWatch.mockImplementationOnce(() => {
        throw new Error('Permission denied');
      });

      const task = createWatchTask('error-watch', ['/tmp/forbidden']);
      trigger.registerTask(task);

      // Should not throw
      await trigger.start();

      // Task is registered but watcher failed
      expect(trigger.getTaskCount()).toBe(1);
      expect(trigger.getWatcherCount()).toBe(0);
    });

    it('should handle mkdir failure gracefully', async () => {
      mockMkdir.mockRejectedValueOnce(new Error('Cannot create dir'));

      const task = createWatchTask('mkdir-fail', ['/tmp/no-perm']);
      trigger.registerTask(task);

      await trigger.start();

      // Should not throw, watcher not created
      expect(trigger.getWatcherCount()).toBe(0);
    });
  });

  describe('unregister during active watch', () => {
    it('should stop watcher when last task is unregistered', async () => {
      const task = createWatchTask('active-unreg', ['/tmp/active-dir']);
      trigger.registerTask(task);
      await trigger.start();

      expect(trigger.getWatcherCount()).toBe(1);

      trigger.unregisterTask('active-unreg');

      expect(trigger.getTaskCount()).toBe(0);
      // Watcher should be cleaned up
      expect(mockFsWatch.mock.results[0].value.close).toHaveBeenCalled();
    });
  });
});
