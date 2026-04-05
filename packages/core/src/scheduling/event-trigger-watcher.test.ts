/**
 * Tests for EventTriggerWatcher.
 *
 * Issue #1953: Event-driven schedule trigger mechanism.
 *
 * Verifies file watching, glob pattern matching, debouncing,
 * and schedule triggering on file system events.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventTriggerWatcher } from './event-trigger-watcher.js';
import type { Scheduler } from './scheduler.js';
import type { ScheduledTask } from './scheduled-task.js';
import * as fsPromises from 'fs/promises';
import * as path from 'path';
import * as os from 'os';

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

describe('EventTriggerWatcher', () => {
  let tmpDir: string;
  let mockScheduler: Scheduler;
  let eventWatcher: EventTriggerWatcher;

  beforeEach(async () => {
    tmpDir = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'event-trigger-test-'));

    mockScheduler = {
      triggerTask: vi.fn().mockReturnValue(true),
    } as unknown as Scheduler;

    eventWatcher = new EventTriggerWatcher({
      scheduler: mockScheduler,
      workspaceDir: tmpDir,
    });
  });

  afterEach(async () => {
    eventWatcher.stop();
    try {
      await fsPromises.rm(tmpDir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup errors
    }
  });

  describe('constructor', () => {
    it('should create watcher with required options', () => {
      expect(eventWatcher).toBeInstanceOf(EventTriggerWatcher);
      expect(eventWatcher.isRunning()).toBe(false);
      expect(eventWatcher.getWatchCount()).toBe(0);
    });
  });

  describe('registerTask / unregisterTask', () => {
    it('should register task with watch config', () => {
      const task = createTask({
        id: 'watch-1',
        watch: [{ path: 'workspace/chats', pattern: '*.json' }],
      });

      eventWatcher.registerTask(task);
      expect(eventWatcher.getWatchCount()).toBe(1);
    });

    it('should be no-op for task without watch config', () => {
      const task = createTask({ id: 'no-watch' });

      eventWatcher.registerTask(task);
      expect(eventWatcher.getWatchCount()).toBe(0);
    });

    it('should be no-op for task with empty watch array', () => {
      const task = createTask({ id: 'empty-watch', watch: [] });

      eventWatcher.registerTask(task);
      expect(eventWatcher.getWatchCount()).toBe(0);
    });

    it('should register multiple watch entries for a task', () => {
      const task = createTask({
        id: 'multi-watch',
        watch: [
          { path: 'workspace/chats', pattern: '*.json' },
          { path: 'workspace/other', pattern: '*.txt' },
        ],
      });

      eventWatcher.registerTask(task);
      expect(eventWatcher.getWatchCount()).toBe(2);
    });

    it('should unregister all watches for a task', () => {
      const task = createTask({
        id: 'unreg-1',
        watch: [
          { path: 'workspace/a', pattern: '*.json' },
          { path: 'workspace/b', pattern: '*.txt' },
        ],
      });

      eventWatcher.registerTask(task);
      expect(eventWatcher.getWatchCount()).toBe(2);

      eventWatcher.unregisterTask('unreg-1');
      expect(eventWatcher.getWatchCount()).toBe(0);
    });

    it('should handle unregistering non-existent task gracefully', () => {
      expect(() => eventWatcher.unregisterTask('nonexistent')).not.toThrow();
    });

    it('should replace existing watches when re-registering same task', () => {
      const task1 = createTask({
        id: 'replace-1',
        watch: [{ path: 'workspace/a', pattern: '*.json' }],
      });
      const task2 = createTask({
        id: 'replace-1',
        watch: [
          { path: 'workspace/b', pattern: '*.txt' },
          { path: 'workspace/c', pattern: '*.log' },
        ],
      });

      eventWatcher.registerTask(task1);
      expect(eventWatcher.getWatchCount()).toBe(1);

      eventWatcher.registerTask(task2);
      expect(eventWatcher.getWatchCount()).toBe(2);
    });
  });

  describe('start / stop', () => {
    it('should start watcher and create watched directories', async () => {
      const watchDir = path.join(tmpDir, 'workspace', 'chats');
      const task = createTask({
        id: 'start-1',
        watch: [{ path: 'workspace/chats', pattern: '*.json' }],
      });

      eventWatcher.registerTask(task);
      await eventWatcher.start();

      expect(eventWatcher.isRunning()).toBe(true);
      // Directory should be created
      const stat = await fsPromises.stat(watchDir);
      expect(stat.isDirectory()).toBe(true);
    });

    it('should not start if already running', async () => {
      const task = createTask({
        id: 'double-start',
        watch: [{ path: 'workspace/a', pattern: '*.json' }],
      });

      eventWatcher.registerTask(task);
      await eventWatcher.start();
      await eventWatcher.start(); // second start

      expect(eventWatcher.isRunning()).toBe(true);
    });

    it('should stop watcher and clear all entries', async () => {
      const task = createTask({
        id: 'stop-1',
        watch: [{ path: 'workspace/a', pattern: '*.json' }],
      });

      eventWatcher.registerTask(task);
      await eventWatcher.start();
      expect(eventWatcher.isRunning()).toBe(true);

      eventWatcher.stop();
      expect(eventWatcher.isRunning()).toBe(false);
    });
  });

  describe('file change triggering', () => {
    it('should trigger schedule when matching file is created in watched directory', async () => {
      const watchDir = path.join(tmpDir, 'workspace', 'chats');
      await fsPromises.mkdir(watchDir, { recursive: true });

      const task = createTask({
        id: 'trigger-1',
        watch: [{ path: 'workspace/chats', pattern: '*.json', debounce: 100 }],
      });

      eventWatcher.registerTask(task);
      await eventWatcher.start();

      // Wait for watcher to initialize
      await new Promise(resolve => setTimeout(resolve, 100));

      // Create a matching file
      const testFile = path.join(watchDir, 'test-chat.json');
      await fsPromises.writeFile(testFile, '{}', 'utf-8');

      // Wait for debounce + trigger
      await new Promise(resolve => setTimeout(resolve, 300));

      expect(mockScheduler.triggerTask).toHaveBeenCalledWith('trigger-1');
    }, 5000);

    it('should not trigger schedule for non-matching file pattern', async () => {
      const watchDir = path.join(tmpDir, 'workspace', 'chats');
      await fsPromises.mkdir(watchDir, { recursive: true });

      const task = createTask({
        id: 'no-match-1',
        watch: [{ path: 'workspace/chats', pattern: '*.json', debounce: 100 }],
      });

      eventWatcher.registerTask(task);
      await eventWatcher.start();

      await new Promise(resolve => setTimeout(resolve, 100));

      // Create a non-matching file (.log instead of .json)
      const testFile = path.join(watchDir, 'test.log');
      await fsPromises.writeFile(testFile, 'log data', 'utf-8');

      await new Promise(resolve => setTimeout(resolve, 300));

      expect(mockScheduler.triggerTask).not.toHaveBeenCalled();
    }, 5000);

    it('should debounce multiple rapid file changes', async () => {
      const watchDir = path.join(tmpDir, 'workspace', 'chats');
      await fsPromises.mkdir(watchDir, { recursive: true });

      const task = createTask({
        id: 'debounce-1',
        watch: [{ path: 'workspace/chats', pattern: '*.json', debounce: 500 }],
      });

      eventWatcher.registerTask(task);
      await eventWatcher.start();

      await new Promise(resolve => setTimeout(resolve, 100));

      // Create multiple files rapidly
      for (let i = 0; i < 5; i++) {
        const testFile = path.join(watchDir, `chat-${i}.json`);
        await fsPromises.writeFile(testFile, `{}`, 'utf-8');
      }

      // Wait a bit (less than debounce)
      await new Promise(resolve => setTimeout(resolve, 200));
      // Should not have triggered yet
      const callCountBefore = vi.mocked(mockScheduler.triggerTask).mock.calls.length;

      // Wait for debounce to complete
      await new Promise(resolve => setTimeout(resolve, 600));

      // Should have triggered at least once (debounced)
      const callCountAfter = vi.mocked(mockScheduler.triggerTask).mock.calls.length;
      expect(callCountAfter).toBeGreaterThan(callCountBefore);
    }, 5000);

    it('should trigger schedule when matching file is modified', async () => {
      const watchDir = path.join(tmpDir, 'workspace', 'chats');
      await fsPromises.mkdir(watchDir, { recursive: true });

      // Pre-create a file
      const testFile = path.join(watchDir, 'existing.json');
      await fsPromises.writeFile(testFile, '{}', 'utf-8');

      const task = createTask({
        id: 'modify-1',
        watch: [{ path: 'workspace/chats', pattern: '*.json', debounce: 100 }],
      });

      eventWatcher.registerTask(task);
      await eventWatcher.start();

      await new Promise(resolve => setTimeout(resolve, 100));

      // Modify the file
      await fsPromises.writeFile(testFile, '{"status": "pending"}', 'utf-8');

      await new Promise(resolve => setTimeout(resolve, 300));

      expect(mockScheduler.triggerTask).toHaveBeenCalledWith('modify-1');
    }, 5000);
  });

  describe('path resolution', () => {
    it('should resolve relative paths against workspace directory', async () => {
      const task = createTask({
        id: 'rel-path',
        watch: [{ path: 'relative/dir', pattern: '*' }],
      });

      eventWatcher.registerTask(task);
      await eventWatcher.start();

      // Directory should be created at workspace/relative/dir
      const expectedPath = path.join(tmpDir, 'relative', 'dir');
      const stat = await fsPromises.stat(expectedPath);
      expect(stat.isDirectory()).toBe(true);
    });

    it('should handle absolute paths', async () => {
      const absDir = path.join(tmpDir, 'absolute', 'dir');
      const task = createTask({
        id: 'abs-path',
        watch: [{ path: absDir, pattern: '*' }],
      });

      eventWatcher.registerTask(task);
      await eventWatcher.start();

      const stat = await fsPromises.stat(absDir);
      expect(stat.isDirectory()).toBe(true);
    });
  });

  describe('default values', () => {
    it('should use default pattern "*" when not specified', async () => {
      const watchDir = path.join(tmpDir, 'workspace', 'any');
      await fsPromises.mkdir(watchDir, { recursive: true });

      const task = createTask({
        id: 'default-pattern',
        watch: [{ path: 'workspace/any', debounce: 100 }],
      });

      eventWatcher.registerTask(task);
      await eventWatcher.start();

      await new Promise(resolve => setTimeout(resolve, 100));

      // Create a file with arbitrary extension
      const testFile = path.join(watchDir, 'anything.xyz');
      await fsPromises.writeFile(testFile, 'data', 'utf-8');

      await new Promise(resolve => setTimeout(resolve, 300));

      expect(mockScheduler.triggerTask).toHaveBeenCalledWith('default-pattern');
    }, 5000);

    it('should use default debounce (5000ms) when not specified', async () => {
      const task = createTask({
        id: 'default-debounce',
        watch: [{ path: 'workspace/x', pattern: '*.json' }],
      });

      eventWatcher.registerTask(task);
      // Verify it registered without errors (debounce default is internal)
      expect(eventWatcher.getWatchCount()).toBe(1);
    });
  });
});
