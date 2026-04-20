/**
 * Tests for TriggerWatcher.
 *
 * Issue #1953: Event-driven schedule trigger mechanism.
 * Verifies file watching, debouncing, and task triggering.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as fsPromises from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import { TriggerWatcher } from './trigger-watcher.js';
import type { Scheduler } from './scheduler.js';
import type { ScheduleManager } from './schedule-manager.js';
import type { ScheduledTask } from './scheduled-task.js';

/** Create a temporary directory for tests (sync) */
function createTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'trigger-watcher-test-'));
}

/** Create a mock ScheduledTask with optional watch config */
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

describe('TriggerWatcher', () => {
  let tempDir: string;
  let mockScheduler: Scheduler;
  let mockScheduleManager: ScheduleManager;
  let watcher: TriggerWatcher;

  beforeEach(() => {
    tempDir = createTempDir();

    mockScheduler = {
      triggerTask: vi.fn().mockResolvedValue(true),
      isTaskRunning: vi.fn().mockReturnValue(false),
    } as unknown as Scheduler;

    mockScheduleManager = {
      listEnabled: vi.fn().mockResolvedValue([]),
      listAll: vi.fn().mockResolvedValue([]),
      get: vi.fn().mockResolvedValue(undefined),
      listByChatId: vi.fn().mockResolvedValue([]),
      getFileScanner: vi.fn(),
    } as unknown as ScheduleManager;
  });

  afterEach(async () => {
    watcher?.stop();
    try {
      await fsPromises.rm(tempDir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup errors
    }
  });

  describe('constructor', () => {
    it('should create watcher with default debounce', () => {
      watcher = new TriggerWatcher({
        scheduler: mockScheduler,
        scheduleManager: mockScheduleManager,
        workspaceDir: tempDir,
      });

      expect(watcher.isRunning()).toBe(false);
      expect(watcher.getWatchedDirCount()).toBe(0);
    });

    it('should create watcher with custom debounce', () => {
      watcher = new TriggerWatcher({
        scheduler: mockScheduler,
        scheduleManager: mockScheduleManager,
        workspaceDir: tempDir,
        debounceMs: 1000,
      });

      expect(watcher.isRunning()).toBe(false);
    });
  });

  describe('start / stop', () => {
    it('should start and stop without tasks', async () => {
      vi.mocked(mockScheduleManager.listEnabled).mockResolvedValue([]);

      watcher = new TriggerWatcher({
        scheduler: mockScheduler,
        scheduleManager: mockScheduleManager,
        workspaceDir: tempDir,
      });

      await watcher.start();
      expect(watcher.isRunning()).toBe(true);
      expect(watcher.getWatchedDirCount()).toBe(0);

      watcher.stop();
      expect(watcher.isRunning()).toBe(false);
    });

    it('should not start if already running', async () => {
      vi.mocked(mockScheduleManager.listEnabled).mockResolvedValue([]);

      watcher = new TriggerWatcher({
        scheduler: mockScheduler,
        scheduleManager: mockScheduleManager,
        workspaceDir: tempDir,
      });

      await watcher.start();
      await watcher.start(); // second start

      // Should only call listEnabled once
      expect(mockScheduleManager.listEnabled).toHaveBeenCalledTimes(1);
    });

    it('should set up watchers for tasks with watch config', async () => {
      const watchDir = path.join(tempDir, 'chats');
      await fsPromises.mkdir(watchDir, { recursive: true });

      const task = createTask({
        id: 'watch-task',
        watch: { paths: ['chats/'] },
      });

      vi.mocked(mockScheduleManager.listEnabled).mockResolvedValue([task]);

      watcher = new TriggerWatcher({
        scheduler: mockScheduler,
        scheduleManager: mockScheduleManager,
        workspaceDir: tempDir,
        debounceMs: 200, // short debounce for tests
      });

      await watcher.start();
      expect(watcher.isRunning()).toBe(true);
      expect(watcher.getWatchedDirCount()).toBe(1);
    });

    it('should skip tasks without watch config', async () => {
      const task = createTask({ id: 'no-watch' });

      vi.mocked(mockScheduleManager.listEnabled).mockResolvedValue([task]);

      watcher = new TriggerWatcher({
        scheduler: mockScheduler,
        scheduleManager: mockScheduleManager,
        workspaceDir: tempDir,
      });

      await watcher.start();
      expect(watcher.getWatchedDirCount()).toBe(0);
    });

    it('should handle stop when not running', () => {
      watcher = new TriggerWatcher({
        scheduler: mockScheduler,
        scheduleManager: mockScheduleManager,
        workspaceDir: tempDir,
      });

      expect(() => watcher.stop()).not.toThrow();
    });
  });

  describe('file change detection', () => {
    it('should trigger schedule when file is created in watched directory', async () => {
      const watchDir = path.join(tempDir, 'chats');
      await fsPromises.mkdir(watchDir, { recursive: true });

      const task = createTask({
        id: 'watch-task',
        watch: { paths: ['chats/'] },
      });

      vi.mocked(mockScheduleManager.listEnabled).mockResolvedValue([task]);

      watcher = new TriggerWatcher({
        scheduler: mockScheduler,
        scheduleManager: mockScheduleManager,
        workspaceDir: tempDir,
        debounceMs: 200,
      });

      await watcher.start();

      // Create a file in the watched directory
      const filePath = path.join(watchDir, 'test-chat.json');
      await fsPromises.writeFile(filePath, JSON.stringify({ id: 'test', status: 'pending' }), 'utf-8');

      // Wait for debounce + trigger
      await vi.waitFor(() => {
        expect(mockScheduler.triggerTask).toHaveBeenCalledWith('watch-task');
      }, { timeout: 3000 });
    });

    it('should debounce multiple file changes', async () => {
      const watchDir = path.join(tempDir, 'chats');
      await fsPromises.mkdir(watchDir, { recursive: true });

      const task = createTask({
        id: 'debounce-task',
        watch: { paths: ['chats/'] },
      });

      vi.mocked(mockScheduleManager.listEnabled).mockResolvedValue([task]);

      watcher = new TriggerWatcher({
        scheduler: mockScheduler,
        scheduleManager: mockScheduleManager,
        workspaceDir: tempDir,
        debounceMs: 500,
      });

      await watcher.start();

      // Create multiple files rapidly
      await fsPromises.writeFile(path.join(watchDir, 'chat1.json'), '{}', 'utf-8');
      await fsPromises.writeFile(path.join(watchDir, 'chat2.json'), '{}', 'utf-8');
      await fsPromises.writeFile(path.join(watchDir, 'chat3.json'), '{}', 'utf-8');

      // Should only trigger once after debounce
      await vi.waitFor(() => {
        expect(mockScheduler.triggerTask).toHaveBeenCalledTimes(1);
      }, { timeout: 2000 });

      // Wait a bit more to ensure no additional triggers
      await new Promise(resolve => setTimeout(resolve, 1000));
      expect(mockScheduler.triggerTask).toHaveBeenCalledTimes(1);
    });

    it('should ignore hidden files and lock files', async () => {
      const watchDir = path.join(tempDir, 'chats');
      await fsPromises.mkdir(watchDir, { recursive: true });

      const task = createTask({
        id: 'hidden-task',
        watch: { paths: ['chats/'] },
      });

      vi.mocked(mockScheduleManager.listEnabled).mockResolvedValue([task]);

      watcher = new TriggerWatcher({
        scheduler: mockScheduler,
        scheduleManager: mockScheduleManager,
        workspaceDir: tempDir,
        debounceMs: 200,
      });

      await watcher.start();

      // Create hidden files and lock files
      await fsPromises.writeFile(path.join(watchDir, '.hidden'), '{}', 'utf-8');
      await fsPromises.writeFile(path.join(watchDir, 'test.lock'), '{}', 'utf-8');
      await fsPromises.writeFile(path.join(watchDir, 'test.tmp'), '{}', 'utf-8');

      // Wait for potential debounce
      await new Promise(resolve => setTimeout(resolve, 500));

      // Should NOT trigger for hidden/lock/tmp files
      expect(mockScheduler.triggerTask).not.toHaveBeenCalled();
    });
  });

  describe('reload', () => {
    it('should reload watch configurations', async () => {
      const watchDir = path.join(tempDir, 'chats');
      await fsPromises.mkdir(watchDir, { recursive: true });

      const task = createTask({
        id: 'reload-task',
        watch: { paths: ['chats/'] },
      });

      vi.mocked(mockScheduleManager.listEnabled).mockResolvedValue([task]);

      watcher = new TriggerWatcher({
        scheduler: mockScheduler,
        scheduleManager: mockScheduleManager,
        workspaceDir: tempDir,
      });

      await watcher.start();
      expect(watcher.getWatchedDirCount()).toBe(1);

      // Reload with no tasks
      vi.mocked(mockScheduleManager.listEnabled).mockResolvedValue([]);
      await watcher.reload();
      expect(watcher.getWatchedDirCount()).toBe(0);
    });
  });

  describe('edge cases', () => {
    it('should create watch directory if it does not exist', async () => {
      const task = createTask({
        id: 'create-dir-task',
        watch: { paths: ['nonexistent/chats/'] },
      });

      vi.mocked(mockScheduleManager.listEnabled).mockResolvedValue([task]);

      watcher = new TriggerWatcher({
        scheduler: mockScheduler,
        scheduleManager: mockScheduleManager,
        workspaceDir: tempDir,
        debounceMs: 200,
      });

      await watcher.start();

      // Directory should have been created
      const dirExists = await fsPromises.access(path.join(tempDir, 'nonexistent', 'chats'))
        .then(() => true)
        .catch(() => false);
      expect(dirExists).toBe(true);
      expect(watcher.getWatchedDirCount()).toBe(1);
    });

    it('should share watcher for multiple tasks watching same directory', async () => {
      const watchDir = path.join(tempDir, 'shared');
      await fsPromises.mkdir(watchDir, { recursive: true });

      const task1 = createTask({ id: 'task-a', watch: { paths: ['shared/'] } });
      const task2 = createTask({ id: 'task-b', watch: { paths: ['shared/'] } });

      vi.mocked(mockScheduleManager.listEnabled).mockResolvedValue([task1, task2]);

      watcher = new TriggerWatcher({
        scheduler: mockScheduler,
        scheduleManager: mockScheduleManager,
        workspaceDir: tempDir,
        debounceMs: 200,
      });

      await watcher.start();

      // Should only have 1 watcher (shared), not 2
      expect(watcher.getWatchedDirCount()).toBe(1);

      // Create a file — both tasks should be triggered
      await fsPromises.writeFile(path.join(watchDir, 'data.json'), '{}', 'utf-8');

      await vi.waitFor(() => {
        expect(mockScheduler.triggerTask).toHaveBeenCalledWith('task-a');
        expect(mockScheduler.triggerTask).toHaveBeenCalledWith('task-b');
      }, { timeout: 3000 });
    });

    it('should handle multiple watch paths per task', async () => {
      const dir1 = path.join(tempDir, 'dir1');
      const dir2 = path.join(tempDir, 'dir2');
      await fsPromises.mkdir(dir1, { recursive: true });
      await fsPromises.mkdir(dir2, { recursive: true });

      const task = createTask({
        id: 'multi-watch',
        watch: { paths: ['dir1/', 'dir2/'] },
      });

      vi.mocked(mockScheduleManager.listEnabled).mockResolvedValue([task]);

      watcher = new TriggerWatcher({
        scheduler: mockScheduler,
        scheduleManager: mockScheduleManager,
        workspaceDir: tempDir,
        debounceMs: 200,
      });

      await watcher.start();
      expect(watcher.getWatchedDirCount()).toBe(2);
    });
  });
});
