/**
 * Tests for EventTriggerManager (packages/core/src/scheduling/event-trigger.ts)
 *
 * Tests the event-driven trigger system that watches file system paths
 * and triggers schedule execution when changes are detected.
 *
 * Issue #1953: Event-driven schedule trigger mechanism.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// Mock fs for file watcher
const { mockFsWatch, mockMkdir } = vi.hoisted(() => {
  const watchClose = vi.fn();
  const mockOn = vi.fn().mockReturnThis();
  return {
    mockFsWatch: vi.fn().mockReturnValue({
      on: mockOn,
      close: watchClose,
    }),
    mockMkdir: vi.fn().mockResolvedValue(undefined),
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

import { EventTriggerManager } from './event-trigger.js';
import type { ScheduledTask, TriggerConfig } from './scheduled-task.js';

// ============================================================================
// Helpers
// ============================================================================

const WORKSPACE_DIR = '/tmp/test-workspace';

function createTask(trigger?: TriggerConfig, overrides: Partial<ScheduledTask> = {}): ScheduledTask {
  return {
    id: 'task-1',
    name: 'Test Task',
    cron: '* * * * *',
    prompt: 'Run test',
    chatId: 'oc_test',
    enabled: true,
    createdAt: '2026-01-01T00:00:00Z',
    trigger,
    ...overrides,
  };
}

// ============================================================================
// Tests
// ============================================================================

describe('EventTriggerManager', () => {
  let manager: EventTriggerManager;
  let onTrigger: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.clearAllMocks();
    onTrigger = vi.fn();
    manager = new EventTriggerManager({
      workspaceDir: WORKSPACE_DIR,
      onTrigger,
    });
  });

  afterEach(() => {
    manager.stop();
  });

  describe('constructor', () => {
    it('should create manager with workspace dir', () => {
      expect(manager).toBeDefined();
      expect(manager.isRunning()).toBe(false);
      expect(manager.getWatcherCount()).toBe(0);
    });
  });

  describe('start / stop', () => {
    it('should start and stop cleanly with no tasks', () => {
      manager.start();
      expect(manager.isRunning()).toBe(true);

      manager.stop();
      expect(manager.isRunning()).toBe(false);
    });

    it('should not start if already running', () => {
      manager.start();
      manager.start(); // second start

      // Should still have started once
      expect(manager.isRunning()).toBe(true);
    });

    it('should stop cleanly even when not running', () => {
      expect(() => manager.stop()).not.toThrow();
    });

    it('should create watchers for registered tasks on start', () => {
      const trigger: TriggerConfig = {
        watch: [{ path: 'workspace/chats/*.json', debounceMs: 1000 }],
      };
      const task = createTask(trigger);
      manager.registerTask(task);

      manager.start();

      expect(mockFsWatch).toHaveBeenCalledTimes(1);
    });
  });

  describe('registerTask', () => {
    it('should register a task with trigger config', () => {
      const trigger: TriggerConfig = {
        watch: [{ path: 'workspace/chats/*.json' }],
      };
      const task = createTask(trigger);

      manager.registerTask(task);

      expect(manager.getRegisteredTaskCount()).toBe(1);
      expect(manager.getRegisteredTaskIds()).toContain('task-1');
    });

    it('should be a no-op for tasks without trigger config', () => {
      const task = createTask(); // no trigger

      manager.registerTask(task);

      expect(manager.getRegisteredTaskCount()).toBe(0);
    });

    it('should be a no-op for tasks with empty trigger watch array', () => {
      const task = createTask({ watch: [] });

      manager.registerTask(task);

      expect(manager.getRegisteredTaskCount()).toBe(0);
    });

    it('should update watchers when re-registering a task', () => {
      const trigger1: TriggerConfig = {
        watch: [{ path: 'workspace/chats/*.json' }],
      };
      const trigger2: TriggerConfig = {
        watch: [{ path: 'workspace/chats/*.json' }, { path: 'workspace/events/*.json' }],
      };

      manager.registerTask(createTask(trigger1));
      expect(manager.getRegisteredTaskCount()).toBe(1);

      // Re-register with different trigger
      manager.registerTask(createTask(trigger2));
      expect(manager.getRegisteredTaskCount()).toBe(1);
    });

    it('should resolve relative paths to absolute paths', () => {
      const trigger: TriggerConfig = {
        watch: [{ path: 'chats/*.json' }],
      };
      const task = createTask(trigger);
      manager.registerTask(task);

      manager.start();

      // fs.watch should have been called with an absolute path
      expect(mockFsWatch).toHaveBeenCalled();
      const watchDir = mockFsWatch.mock.calls[0][0] as string;
      expect(watchDir).toContain('chats');
    });

    it('should handle multiple watch rules for a single task', () => {
      const trigger: TriggerConfig = {
        watch: [
          { path: 'workspace/chats/*.json' },
          { path: 'workspace/events/*.json' },
        ],
      };
      const task = createTask(trigger);
      manager.registerTask(task);

      manager.start();

      // Should create watchers for both paths (they may resolve to the same dir)
      expect(manager.getRegisteredTaskCount()).toBe(1);
    });
  });

  describe('unregisterTask', () => {
    it('should unregister a previously registered task', () => {
      const trigger: TriggerConfig = {
        watch: [{ path: 'workspace/chats/*.json' }],
      };
      const task = createTask(trigger);

      manager.registerTask(task);
      expect(manager.getRegisteredTaskCount()).toBe(1);

      manager.unregisterTask('task-1');
      expect(manager.getRegisteredTaskCount()).toBe(0);
    });

    it('should be a no-op for unregistered tasks', () => {
      expect(() => manager.unregisterTask('unknown-task')).not.toThrow();
    });

    it('should close watcher when no tasks remain', () => {
      const trigger: TriggerConfig = {
        watch: [{ path: 'workspace/chats/*.json' }],
      };
      const task = createTask(trigger);

      manager.registerTask(task);
      manager.start();

      expect(manager.getWatcherCount()).toBeGreaterThan(0);

      manager.unregisterTask('task-1');

      // Watcher should be closed since no tasks remain
      expect(manager.getWatcherCount()).toBe(0);
    });
  });

  describe('trigger firing', () => {
    it('should call onTrigger when file change is detected', async () => {
      const trigger: TriggerConfig = {
        watch: [{ path: 'workspace/chats/test.json', debounceMs: 10 }],
      };
      const task = createTask(trigger);
      manager.registerTask(task);
      manager.start();

      // Get the fs.watch callback
      const watchCallback = mockFsWatch.mock.calls[0][2] as (
        eventType: string,
        filename: string | null
      ) => void;

      // Simulate file change
      watchCallback('change', 'test.json');

      // Wait for debounce
      await new Promise((resolve) => setTimeout(resolve, 50));

      expect(onTrigger).toHaveBeenCalledWith('task-1');
    });

    it('should debounce rapid file changes', async () => {
      const trigger: TriggerConfig = {
        watch: [{ path: 'workspace/chats/test.json', debounceMs: 50 }],
      };
      const task = createTask(trigger);
      manager.registerTask(task);
      manager.start();

      const watchCallback = mockFsWatch.mock.calls[0][2] as (
        eventType: string,
        filename: string | null
      ) => void;

      // Simulate rapid changes
      watchCallback('change', 'test.json');
      watchCallback('change', 'test.json');
      watchCallback('change', 'test.json');

      // Wait for debounce
      await new Promise((resolve) => setTimeout(resolve, 100));

      // Should only trigger once
      expect(onTrigger).toHaveBeenCalledTimes(1);
    });

    it('should ignore events with null filename', async () => {
      const trigger: TriggerConfig = {
        watch: [{ path: 'workspace/chats/test.json', debounceMs: 10 }],
      };
      const task = createTask(trigger);
      manager.registerTask(task);
      manager.start();

      const watchCallback = mockFsWatch.mock.calls[0][2] as (
        eventType: string,
        filename: string | null
      ) => void;

      watchCallback('change', null);

      await new Promise((resolve) => setTimeout(resolve, 50));

      expect(onTrigger).not.toHaveBeenCalled();
    });

    it('should handle errors from onTrigger gracefully', async () => {
      onTrigger.mockImplementation(() => {
        throw new Error('Trigger callback error');
      });

      const trigger: TriggerConfig = {
        watch: [{ path: 'workspace/chats/test.json', debounceMs: 10 }],
      };
      const task = createTask(trigger);
      manager.registerTask(task);
      manager.start();

      const watchCallback = mockFsWatch.mock.calls[0][2] as (
        eventType: string,
        filename: string | null
      ) => void;

      // Should not throw
      watchCallback('change', 'test.json');

      await new Promise((resolve) => setTimeout(resolve, 50));

      expect(onTrigger).toHaveBeenCalled();
    });
  });

  describe('multiple tasks on same path', () => {
    it('should share a watcher when multiple tasks watch the same path', () => {
      const trigger: TriggerConfig = {
        watch: [{ path: 'workspace/chats/*.json' }],
      };
      const task1 = createTask(trigger, { id: 'task-1' });
      const task2 = createTask(trigger, { id: 'task-2' });

      manager.registerTask(task1);
      manager.registerTask(task2);
      manager.start();

      // Only one watcher for the same path
      expect(manager.getWatcherCount()).toBe(1);
    });

    it('should fire triggers for all tasks on a shared path', async () => {
      const trigger: TriggerConfig = {
        watch: [{ path: 'workspace/chats/*.json', debounceMs: 10 }],
      };
      const task1 = createTask(trigger, { id: 'task-1' });
      const task2 = createTask(trigger, { id: 'task-2' });

      manager.registerTask(task1);
      manager.registerTask(task2);
      manager.start();

      const watchCallback = mockFsWatch.mock.calls[0][2] as (
        eventType: string,
        filename: string | null
      ) => void;

      watchCallback('change', 'test.json');

      await new Promise((resolve) => setTimeout(resolve, 50));

      expect(onTrigger).toHaveBeenCalledWith('task-1');
      expect(onTrigger).toHaveBeenCalledWith('task-2');
      expect(onTrigger).toHaveBeenCalledTimes(2);
    });
  });
});
