/**
 * Tests for EventTriggerWatcher (Issue #1953: Event-driven schedule trigger mechanism).
 *
 * Tests the EventTriggerWatcher class which watches file paths for changes
 * and triggers schedule execution.
 */

import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';

// Mock fs and fs/promises
const { mockMkdir, mockWatch, mockAccess } = vi.hoisted(() => ({
  mockMkdir: vi.fn().mockResolvedValue(undefined),
  mockWatch: vi.fn().mockReturnValue({
    on: vi.fn().mockReturnThis(),
    close: vi.fn(),
  }),
  mockAccess: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('fs', () => ({
  default: {
    watch: mockWatch,
  },
  watch: mockWatch,
}));

vi.mock('fs/promises', () => ({
  default: {
    mkdir: mockMkdir,
    access: mockAccess,
  },
  mkdir: mockMkdir,
  access: mockAccess,
}));

import { EventTriggerWatcher } from './event-trigger-watcher.js';
import type { ScheduledTask } from './scheduled-task.js';

// ============================================================================
// Helpers
// ============================================================================

const MOCK_WORKSPACE = '/tmp/test-workspace';

function makeTask(overrides: Partial<ScheduledTask> = {}): ScheduledTask {
  return {
    id: 'schedule-test-task',
    name: 'Test Task',
    cron: '0 * * * *',
    prompt: 'Do something',
    chatId: 'oc_test',
    enabled: true,
    createdAt: '2026-01-01T00:00:00Z',
    ...overrides,
  };
}

// ============================================================================
// EventTriggerWatcher Tests
// ============================================================================

describe('EventTriggerWatcher', () => {
  let watcher: EventTriggerWatcher;
  let mockTriggerTask: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.clearAllMocks();
    mockTriggerTask = vi.fn().mockResolvedValue(undefined);
    watcher = new EventTriggerWatcher({
      workspaceDir: MOCK_WORKSPACE,
      triggerTask: mockTriggerTask,
    });
  });

  afterEach(() => {
    watcher.stop();
  });

  describe('registerTask', () => {
    it('should not register a task without watch triggers', () => {
      const task = makeTask();
      watcher.registerTask(task);
      expect(watcher.getWatchCount()).toBe(0);
    });

    it('should not register a task with empty watch array', () => {
      const task = makeTask({ watch: [] });
      watcher.registerTask(task);
      expect(watcher.getWatchCount()).toBe(0);
    });

    it('should register a task with watch triggers', async () => {
      const task = makeTask({
        watch: [{ path: 'workspace/sessions/*.json', debounce: 3000 }],
      });

      watcher.registerTask(task);
      await watcher.start();

      expect(watcher.getWatchCount()).toBe(1);
      expect(mockMkdir).toHaveBeenCalled();
      expect(mockWatch).toHaveBeenCalled();
    });

    it('should register multiple watch paths for a single task', async () => {
      const task = makeTask({
        watch: [
          { path: 'workspace/sessions/*.json' },
          { path: 'workspace/other/*.txt' },
        ],
      });

      watcher.registerTask(task);
      await watcher.start();

      expect(watcher.getWatchCount()).toBe(2);
    });

    it('should support simple string-style watch paths', async () => {
      const task = makeTask({
        watch: [{ path: 'workspace/data/' }],
      });

      watcher.registerTask(task);
      await watcher.start();

      expect(watcher.getWatchCount()).toBe(1);
    });
  });

  describe('unregisterTask', () => {
    it('should unregister a previously registered task', () => {
      const task = makeTask({
        watch: [{ path: 'workspace/sessions/*.json' }],
      });

      watcher.registerTask(task);
      watcher.unregisterTask(task.id);

      // Should not set up watches when started since task is unregistered
      expect(watcher.getWatchCount()).toBe(0);
    });

    it('should be a no-op for unregistered tasks', () => {
      watcher.unregisterTask('nonexistent-task');
      expect(watcher.getWatchCount()).toBe(0);
    });
  });

  describe('start / stop', () => {
    it('should start watching registered tasks', async () => {
      const task = makeTask({
        watch: [{ path: 'workspace/sessions/*.json' }],
      });

      watcher.registerTask(task);
      await watcher.start();

      expect(watcher.isRunning()).toBe(true);
      expect(mockWatch).toHaveBeenCalledTimes(1);
    });

    it('should be idempotent on double start', async () => {
      const task = makeTask({
        watch: [{ path: 'workspace/sessions/*.json' }],
      });

      watcher.registerTask(task);
      await watcher.start();
      await watcher.start();

      expect(mockWatch).toHaveBeenCalledTimes(1);
    });

    it('should close watchers on stop', async () => {
      const mockClose = vi.fn();
      mockWatch.mockReturnValue({
        on: vi.fn().mockReturnThis(),
        close: mockClose,
      });

      const task = makeTask({
        watch: [{ path: 'workspace/sessions/*.json' }],
      });

      watcher.registerTask(task);
      await watcher.start();
      watcher.stop();

      expect(mockClose).toHaveBeenCalled();
      expect(watcher.isRunning()).toBe(false);
    });

    it('should handle tasks registered after start', async () => {
      await watcher.start();

      const task = makeTask({
        watch: [{ path: 'workspace/sessions/*.json' }],
      });

      watcher.registerTask(task);

      // Wait for async setup to complete (registerTask fires setupWatchForTask with void)
      await new Promise(resolve => setTimeout(resolve, 50));

      // Watch should have been set up immediately after registration
      expect(mockWatch).toHaveBeenCalledTimes(1);
    });
  });

  describe('file change events', () => {
    it('should trigger task on matching file change', async () => {
      let watchCallback: (eventType: string, filename: string | null) => void = () => {};
      mockWatch.mockImplementation((_dir, _opts, callback) => {
        watchCallback = callback;
        return {
          on: vi.fn().mockReturnThis(),
          close: vi.fn(),
        };
      });

      const task = makeTask({
        watch: [{ path: 'workspace/sessions/*.json', debounce: 100 }],
      });

      watcher.registerTask(task);
      await watcher.start();

      // Simulate a file change event
      watchCallback('change', 'new-session.json');

      // Wait for debounce
      await new Promise(resolve => setTimeout(resolve, 200));

      expect(mockTriggerTask).toHaveBeenCalledWith('schedule-test-task');
    });

    it('should debounce multiple rapid file changes', async () => {
      let watchCallback: (eventType: string, filename: string | null) => void = () => {};
      mockWatch.mockImplementation((_dir, _opts, callback) => {
        watchCallback = callback;
        return {
          on: vi.fn().mockReturnThis(),
          close: vi.fn(),
        };
      });

      const task = makeTask({
        watch: [{ path: 'workspace/sessions/*.json', debounce: 500 }],
      });

      watcher.registerTask(task);
      await watcher.start();

      // Simulate multiple rapid changes
      watchCallback('change', 'session1.json');
      watchCallback('change', 'session2.json');
      watchCallback('change', 'session3.json');

      // Should not have triggered yet (still in debounce window)
      expect(mockTriggerTask).not.toHaveBeenCalled();

      // Wait for debounce
      await new Promise(resolve => setTimeout(resolve, 600));

      // Should have triggered exactly once (debounced)
      expect(mockTriggerTask).toHaveBeenCalledTimes(1);
    });

    it('should ignore non-matching file extensions', async () => {
      let watchCallback: (eventType: string, filename: string | null) => void = () => {};
      mockWatch.mockImplementation((_dir, _opts, callback) => {
        watchCallback = callback;
        return {
          on: vi.fn().mockReturnThis(),
          close: vi.fn(),
        };
      });

      const task = makeTask({
        watch: [{ path: 'workspace/sessions/*.json', debounce: 100 }],
      });

      watcher.registerTask(task);
      await watcher.start();

      // Simulate change to non-matching file
      watchCallback('change', 'readme.txt');

      await new Promise(resolve => setTimeout(resolve, 200));

      expect(mockTriggerTask).not.toHaveBeenCalled();
    });

    it('should ignore null filename events', async () => {
      let watchCallback: (eventType: string, filename: string | null) => void = () => {};
      mockWatch.mockImplementation((_dir, _opts, callback) => {
        watchCallback = callback;
        return {
          on: vi.fn().mockReturnThis(),
          close: vi.fn(),
        };
      });

      const task = makeTask({
        watch: [{ path: 'workspace/sessions/*.json', debounce: 100 }],
      });

      watcher.registerTask(task);
      await watcher.start();

      watchCallback('change', null);

      await new Promise(resolve => setTimeout(resolve, 200));

      expect(mockTriggerTask).not.toHaveBeenCalled();
    });
  });

  describe('edge cases', () => {
    it('should handle watch directory creation failure gracefully', async () => {
      mockMkdir.mockRejectedValue(new Error('Permission denied'));

      const task = makeTask({
        watch: [{ path: 'workspace/sessions/*.json' }],
      });

      watcher.registerTask(task);
      await watcher.start();

      // Should not crash, but also not set up a watcher
      expect(watcher.getWatchCount()).toBe(0);
    });

    it('should use default debounce of 5000ms when not specified', async () => {
      let watchCallback: (eventType: string, filename: string | null) => void = () => {};
      mockWatch.mockImplementation((_dir, _opts, callback) => {
        watchCallback = callback;
        return {
          on: vi.fn().mockReturnThis(),
          close: vi.fn(),
        };
      });

      const task = makeTask({
        watch: [{ path: 'workspace/sessions/*.json' }],
      });

      watcher.registerTask(task);
      await watcher.start();

      watchCallback('change', 'session.json');

      // After 1 second, should NOT have triggered (default debounce is 5s)
      await new Promise(resolve => setTimeout(resolve, 100));
      expect(mockTriggerTask).not.toHaveBeenCalled();
    });
  });
});
