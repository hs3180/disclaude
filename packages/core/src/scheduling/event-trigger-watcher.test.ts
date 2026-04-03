/**
 * Tests for EventTriggerWatcher (Issue #1953)
 *
 * Tests the file-watching based event-driven schedule trigger mechanism.
 * Uses vi.mock for ESM module mocking.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock fs and fs/promises
const mockWatchCallbacks: Map<string, {
  eventCallback: (eventType: string, filename: string | null) => void;
  errorCallback: (error: Error) => void;
}> = new Map();

const { mockFsWatch, mockMkdir, mockAccess } = vi.hoisted(() => ({
  mockFsWatch: vi.fn(),
  mockMkdir: vi.fn().mockResolvedValue(undefined),
  mockAccess: vi.fn().mockResolvedValue(undefined),
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

const MOCK_DIR = '/tmp/test-workspace';

/** Create a mock FSWatcher that simulates fs.watch behavior */
function createMockFsWatcher(dir: string) {
  const watcherInstance = {
    close: vi.fn(() => {
      // Remove from mockWatchCallbacks
      mockWatchCallbacks.delete(dir);
    }),
    on: vi.fn((event: string, callback: (...args: any[]) => void) => {
      if (event === 'error') {
        const entry = mockWatchCallbacks.get(dir);
        if (entry) {
          entry.errorCallback = callback;
        }
      }
      return watcherInstance;
    }),
  };

  return watcherInstance;
}

/** Create a mock task with watch configuration */
function makeTask(overrides: Partial<ScheduledTask> & { id: string; watch: string[] }): ScheduledTask {
  return {
    name: 'Test Task',
    cron: '0 * * * * *',
    chatId: 'oc_test123',
    prompt: 'Execute test task',
    enabled: true,
    blocking: true,
    createdAt: '2026-01-01T00:00:00Z',
    ...overrides,
  };
}

/** Simulate a file change event in a watched directory */
function simulateFileChange(dir: string, filename: string) {
  const entry = mockWatchCallbacks.get(dir);
  if (entry) {
    entry.eventCallback('change', filename);
  }
}

// ============================================================================
// EventTriggerWatcher Tests
// ============================================================================

describe('EventTriggerWatcher', () => {
  let watcher: EventTriggerWatcher;
  let mockTriggerTask: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.clearAllMocks();
    mockWatchCallbacks.clear();
    mockTriggerTask = vi.fn().mockResolvedValue(undefined);

    // Setup mockFsWatch to register callbacks
    mockFsWatch.mockImplementation((dir: string, _options: any, callback: (eventType: string, filename: string | null) => void) => {
      const watcherInstance = createMockFsWatcher(dir);
      mockWatchCallbacks.set(dir, {
        eventCallback: callback,
        errorCallback: () => {},
      });
      return watcherInstance;
    });

    watcher = new EventTriggerWatcher({
      triggerTask: mockTriggerTask,
      baseDir: MOCK_DIR,
      debounceMs: 100, // Short debounce for tests
    });
  });

  afterEach(() => {
    watcher.stop();
    vi.restoreAllMocks();
  });

  describe('registerTask', () => {
    it('should register a task with watch patterns', async () => {
      const task = makeTask({
        id: 'schedule-test',
        watch: ['workspace/chats/*.json'],
      });

      const result = await watcher.registerTask(task);

      expect(result).toBe(true);
      expect(mockMkdir).toHaveBeenCalled();
    });

    it('should return false for task without watch patterns', async () => {
      const task = makeTask({
        id: 'schedule-no-watch',
        watch: [],
      });

      const result = await watcher.registerTask(task);
      expect(result).toBe(false);
    });

    it('should return false for task with undefined watch', async () => {
      const task = {
        id: 'schedule-no-watch-field',
        name: 'Test',
        cron: '0 * * * * *',
        chatId: 'oc_test',
        prompt: 'test',
        enabled: true,
        createdAt: '2026-01-01',
      } as ScheduledTask;

      const result = await watcher.registerTask(task);
      expect(result).toBe(false);
    });

    it('should resolve relative paths against baseDir', async () => {
      const task = makeTask({
        id: 'schedule-relative',
        watch: ['data/incoming/*.json'],
      });

      await watcher.registerTask(task);

      expect(mockMkdir).toHaveBeenCalledWith(
        expect.stringContaining('data/incoming'),
        { recursive: true }
      );
    });
  });

  describe('start/stop', () => {
    it('should start watching after start() is called', async () => {
      const task = makeTask({
        id: 'schedule-start-test',
        watch: ['workspace/chats/*.json'],
      });

      await watcher.registerTask(task);
      expect(mockFsWatch).not.toHaveBeenCalled(); // Not started yet

      await watcher.start();
      expect(mockFsWatch).toHaveBeenCalled();
      expect(watcher.isRunning()).toBe(true);
    });

    it('should start watching immediately if already running', async () => {
      await watcher.start();

      const task = makeTask({
        id: 'schedule-dynamic',
        watch: ['workspace/new-dir/*.json'],
      });

      await watcher.registerTask(task);
      // Should have called fs.watch for the new directory
      expect(mockFsWatch).toHaveBeenCalled();
    });

    it('should stop all watchers on stop()', async () => {
      const task = makeTask({
        id: 'schedule-stop-test',
        watch: ['workspace/chats/*.json'],
      });

      await watcher.registerTask(task);
      await watcher.start();

      watcher.stop();
      expect(watcher.isRunning()).toBe(false);
    });
  });

  describe('event triggering', () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it('should trigger task when file changes in watched directory', async () => {
      const task = makeTask({
        id: 'schedule-trigger-test',
        watch: ['workspace/chats/*.json'],
      });

      await watcher.registerTask(task);
      await watcher.start();

      // Simulate file change
      simulateFileChange(
        `${MOCK_DIR}/workspace/chats`,
        'new-chat.json'
      );

      // Wait for debounce
      await vi.advanceTimersByTimeAsync(200);

      expect(mockTriggerTask).toHaveBeenCalledWith('schedule-trigger-test');
    });

    it('should debounce multiple file changes', async () => {
      const task = makeTask({
        id: 'schedule-debounce-test',
        watch: ['workspace/chats/*.json'],
      });

      await watcher.registerTask(task);
      await watcher.start();

      // Simulate multiple rapid file changes
      simulateFileChange(`${MOCK_DIR}/workspace/chats`, 'chat1.json');
      simulateFileChange(`${MOCK_DIR}/workspace/chats`, 'chat2.json');
      simulateFileChange(`${MOCK_DIR}/workspace/chats`, 'chat3.json');

      // Not triggered yet (within debounce window)
      expect(mockTriggerTask).not.toHaveBeenCalled();

      // Wait for debounce
      await vi.advanceTimersByTimeAsync(200);

      // Should only trigger once
      expect(mockTriggerTask).toHaveBeenCalledTimes(1);
      expect(mockTriggerTask).toHaveBeenCalledWith('schedule-debounce-test');
    });

    it('should not trigger task for unrelated directory changes', async () => {
      const task = makeTask({
        id: 'schedule-isolated-test',
        watch: ['workspace/chats/*.json'],
      });

      await watcher.registerTask(task);
      await watcher.start();

      // Simulate change in unrelated directory
      simulateFileChange(
        `${MOCK_DIR}/workspace/other`,
        'unrelated.txt'
      );

      await vi.advanceTimersByTimeAsync(200);

      expect(mockTriggerTask).not.toHaveBeenCalled();
    });

    it('should handle trigger errors gracefully', async () => {
      mockTriggerTask.mockRejectedValue(new Error('Trigger failed'));

      const task = makeTask({
        id: 'schedule-error-test',
        watch: ['workspace/chats/*.json'],
      });

      await watcher.registerTask(task);
      await watcher.start();

      simulateFileChange(`${MOCK_DIR}/workspace/chats`, 'error-chat.json');

      await vi.advanceTimersByTimeAsync(200);

      // Should have attempted the trigger
      expect(mockTriggerTask).toHaveBeenCalledWith('schedule-error-test');
      // Should not throw
    });
  });

  describe('unregisterTask', () => {
    it('should stop watching directory when last task is unregistered', async () => {
      const task = makeTask({
        id: 'schedule-unreg-test',
        watch: ['workspace/chats/*.json'],
      });

      await watcher.registerTask(task);
      await watcher.start();

      await watcher.unregisterTask('schedule-unreg-test');

      // Verify the watcher was closed
      expect(mockWatchCallbacks.has(`${MOCK_DIR}/workspace/chats`)).toBe(false);
    });

    it('should not trigger unregistered tasks', async () => {
      vi.useFakeTimers();

      const task = makeTask({
        id: 'schedule-unreg-trigger-test',
        watch: ['workspace/chats/*.json'],
      });

      await watcher.registerTask(task);
      await watcher.start();

      await watcher.unregisterTask('schedule-unreg-trigger-test');

      simulateFileChange(`${MOCK_DIR}/workspace/chats`, 'chat.json');
      await vi.advanceTimersByTimeAsync(200);

      expect(mockTriggerTask).not.toHaveBeenCalled();

      vi.useRealTimers();
    });
  });

  describe('getStats', () => {
    it('should return correct stats', async () => {
      const task1 = makeTask({
        id: 'schedule-stats-1',
        watch: ['workspace/chats/*.json'],
      });
      const task2 = makeTask({
        id: 'schedule-stats-2',
        watch: ['workspace/other/*.json'],
      });

      await watcher.registerTask(task1);
      await watcher.registerTask(task2);
      await watcher.start();

      const stats = watcher.getStats();
      expect(stats.taskCount).toBe(2);
      expect(stats.dirCount).toBe(2);
    });
  });

  describe('edge cases', () => {
    it('should handle start() called twice gracefully', async () => {
      await watcher.start();
      await watcher.start();

      expect(watcher.isRunning()).toBe(true);
    });

    it('should handle unregisterTask for unknown task gracefully', async () => {
      // Should not throw
      await watcher.unregisterTask('non-existent-task');
    });

    it('should re-register task with updated watch config', async () => {
      const task = makeTask({
        id: 'schedule-reregister',
        watch: ['workspace/old-dir/*.json'],
      });

      await watcher.registerTask(task);
      await watcher.start();

      // Update watch config
      const updatedTask = makeTask({
        id: 'schedule-reregister',
        watch: ['workspace/new-dir/*.json'],
      });

      await watcher.registerTask(updatedTask);

      const stats = watcher.getStats();
      // Should still have 1 task
      expect(stats.taskCount).toBe(1);
    });
  });
});
