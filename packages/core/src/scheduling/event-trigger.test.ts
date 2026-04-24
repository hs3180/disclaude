/**
 * Tests for EventTrigger.
 *
 * Issue #1953: Event-driven schedule trigger mechanism.
 *
 * Verifies file watching, debounce, pattern matching,
 * and integration with the Scheduler.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { EventTrigger } from './event-trigger.js';
import type { Scheduler } from './scheduler.js';
import type { ScheduledTask } from './scheduled-task.js';

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
  let mockScheduler: { triggerNow: ReturnType<typeof vi.fn>; getTask: ReturnType<typeof vi.fn> };
  let tempDir: string;
  let eventTrigger: EventTrigger;

  beforeEach(async () => {
    tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'event-trigger-test-'));

    mockScheduler = {
      triggerNow: vi.fn().mockResolvedValue(true),
      getTask: vi.fn().mockResolvedValue(undefined),
    };

    eventTrigger = new EventTrigger({
      scheduler: mockScheduler as unknown as Scheduler,
      basePath: tempDir,
    });
  });

  afterEach(async () => {
    eventTrigger.stop();
    await fs.promises.rm(tempDir, { recursive: true, force: true });
  });

  describe('constructor', () => {
    it('should create EventTrigger with default basePath', () => {
      const et = new EventTrigger({
        scheduler: mockScheduler as unknown as Scheduler,
      });
      expect(et).toBeDefined();
      expect(et.isRunning()).toBe(false);
    });

    it('should create EventTrigger with custom basePath', () => {
      const et = new EventTrigger({
        scheduler: mockScheduler as unknown as Scheduler,
        basePath: '/tmp/test',
      });
      expect(et).toBeDefined();
    });
  });

  describe('registerTask', () => {
    it('should register a task with watch paths', () => {
      const task = createTask({
        watch: [{ path: 'workspace/chats/*.json' }],
      });

      eventTrigger.registerTask(task);

      expect(eventTrigger.getRegisteredTaskIds()).toContain('task-1');
      expect(eventTrigger.getWatchCount()).toBe(1);
    });

    it('should ignore a task without watch paths', () => {
      const task = createTask();
      eventTrigger.registerTask(task);

      expect(eventTrigger.getRegisteredTaskIds()).toHaveLength(0);
      expect(eventTrigger.getWatchCount()).toBe(0);
    });

    it('should ignore a task with empty watch array', () => {
      const task = createTask({ watch: [] });
      eventTrigger.registerTask(task);

      expect(eventTrigger.getRegisteredTaskIds()).toHaveLength(0);
    });

    it('should register multiple watch paths for the same task', () => {
      const task = createTask({
        watch: [
          { path: 'workspace/chats/*.json' },
          { path: 'workspace/events/*.json' },
        ],
      });

      eventTrigger.registerTask(task);

      expect(eventTrigger.getRegisteredTaskIds()).toHaveLength(1);
      expect(eventTrigger.getWatchCount()).toBe(2);
    });

    it('should register multiple tasks watching the same directory', () => {
      const task1 = createTask({ id: 'task-1', watch: [{ path: 'workspace/chats/*.json' }] });
      const task2 = createTask({ id: 'task-2', watch: [{ path: 'workspace/chats/*.md' }] });

      eventTrigger.registerTask(task1);
      eventTrigger.registerTask(task2);

      expect(eventTrigger.getRegisteredTaskIds()).toHaveLength(2);
      expect(eventTrigger.getWatchCount()).toBe(1); // Same directory
    });
  });

  describe('unregisterTask', () => {
    it('should unregister a task', () => {
      const task = createTask({ watch: [{ path: 'workspace/chats/*.json' }] });
      eventTrigger.registerTask(task);
      expect(eventTrigger.getRegisteredTaskIds()).toContain('task-1');

      eventTrigger.unregisterTask('task-1');
      expect(eventTrigger.getRegisteredTaskIds()).toHaveLength(0);
    });

    it('should handle unregistering non-existent task', () => {
      expect(() => eventTrigger.unregisterTask('nonexistent')).not.toThrow();
    });

    it('should remove watch entry when all tasks are unregistered', () => {
      const task1 = createTask({ id: 'task-1', watch: [{ path: 'workspace/chats/*.json' }] });
      const task2 = createTask({ id: 'task-2', watch: [{ path: 'workspace/chats/*.md' }] });

      eventTrigger.registerTask(task1);
      eventTrigger.registerTask(task2);
      expect(eventTrigger.getWatchCount()).toBe(1);

      eventTrigger.unregisterTask('task-1');
      expect(eventTrigger.getWatchCount()).toBe(1);

      eventTrigger.unregisterTask('task-2');
      expect(eventTrigger.getWatchCount()).toBe(0);
    });
  });

  describe('start / stop', () => {
    it('should start and stop watching', async () => {
      const watchDir = path.join(tempDir, 'workspace', 'chats');
      await fs.promises.mkdir(watchDir, { recursive: true });

      const task = createTask({ watch: [{ path: 'workspace/chats/*.json' }] });
      eventTrigger.registerTask(task);

      await eventTrigger.start();
      expect(eventTrigger.isRunning()).toBe(true);

      eventTrigger.stop();
      expect(eventTrigger.isRunning()).toBe(false);
    });

    it('should not start if already running', async () => {
      const watchDir = path.join(tempDir, 'workspace', 'chats');
      await fs.promises.mkdir(watchDir, { recursive: true });

      const task = createTask({ watch: [{ path: 'workspace/chats/*.json' }] });
      eventTrigger.registerTask(task);

      await eventTrigger.start();
      await eventTrigger.start(); // Second call

      eventTrigger.stop();
    });

    it('should handle stop when not running', () => {
      expect(() => eventTrigger.stop()).not.toThrow();
    });
  });

  describe('file change triggering', () => {
    it('should trigger task when watched file changes', async () => {
      const watchDir = path.join(tempDir, 'workspace', 'chats');
      await fs.promises.mkdir(watchDir, { recursive: true });

      const task = createTask({
        id: 'trigger-test',
        watch: [{ path: 'workspace/chats/*.json', debounceMs: 50 }],
      });
      eventTrigger.registerTask(task);
      await eventTrigger.start();

      // Create a file in the watched directory
      const testFile = path.join(watchDir, 'test.json');
      await fs.promises.writeFile(testFile, '{"status":"pending"}', 'utf-8');

      // Wait for debounce
      await vi.waitFor(() => {
        expect(mockScheduler.triggerNow).toHaveBeenCalledWith('trigger-test');
      }, { timeout: 3000 });
    });

    it('should not trigger task for non-matching file extension', async () => {
      const watchDir = path.join(tempDir, 'workspace', 'chats');
      await fs.promises.mkdir(watchDir, { recursive: true });

      const task = createTask({
        id: 'ext-filter-test',
        watch: [{ path: 'workspace/chats/*.json', debounceMs: 50 }],
      });
      eventTrigger.registerTask(task);
      await eventTrigger.start();

      // Create a non-matching file
      const testFile = path.join(watchDir, 'test.txt');
      await fs.promises.writeFile(testFile, 'hello', 'utf-8');

      // Wait a bit and check it was NOT triggered for this file
      await new Promise(resolve => setTimeout(resolve, 200));
      expect(mockScheduler.triggerNow).not.toHaveBeenCalledWith('ext-filter-test');
    });

    it('should debounce multiple rapid file changes', async () => {
      const watchDir = path.join(tempDir, 'workspace', 'chats');
      await fs.promises.mkdir(watchDir, { recursive: true });

      const task = createTask({
        id: 'debounce-test',
        watch: [{ path: 'workspace/chats/*.json', debounceMs: 200 }],
      });
      eventTrigger.registerTask(task);
      await eventTrigger.start();

      // Rapidly create multiple files
      for (let i = 0; i < 5; i++) {
        await fs.promises.writeFile(
          path.join(watchDir, `file-${i}.json`),
          `{"index":${i}}`,
          'utf-8'
        );
      }

      // Wait for debounce to settle
      await vi.waitFor(() => {
        expect(mockScheduler.triggerNow).toHaveBeenCalled();
      }, { timeout: 3000 });

      // Should have been called only once (debounced)
      expect(mockScheduler.triggerNow).toHaveBeenCalledTimes(1);
      expect(mockScheduler.triggerNow).toHaveBeenCalledWith('debounce-test');
    });
  });
});
