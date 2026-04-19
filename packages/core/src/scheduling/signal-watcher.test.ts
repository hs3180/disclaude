/**
 * Tests for SignalWatcher.
 *
 * Issue #1953: Event-driven schedule trigger mechanism (Method C — Signal File).
 *
 * Verifies signal file detection, consumption, debouncing, and task triggering.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fsPromises from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import { SignalWatcher, type OnTrigger } from './signal-watcher.js';
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

describe('SignalWatcher', () => {
  let tmpDir: string;
  let onTrigger: OnTrigger;
  let watcher: SignalWatcher;

  beforeEach(async () => {
    tmpDir = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'signal-test-'));
    onTrigger = vi.fn();
    watcher = new SignalWatcher({ onTrigger });
  });

  afterEach(async () => {
    watcher.stop();
    await fsPromises.rm(tmpDir, { recursive: true, force: true });
  });

  describe('constructor', () => {
    it('should create a SignalWatcher', () => {
      expect(watcher).toBeInstanceOf(SignalWatcher);
      expect(watcher.isRunning()).toBe(false);
    });
  });

  describe('registerTask', () => {
    it('should register a task with signal trigger', () => {
      const signalPath = path.join(tmpDir, '.trigger');
      const task = createTask({
        trigger: { signalPath },
      });

      watcher.registerTask(task);

      expect(watcher.getWatchedSignalCount()).toBe(1);
    });

    it('should skip tasks without trigger config', () => {
      const task = createTask();
      watcher.registerTask(task);
      expect(watcher.getWatchedSignalCount()).toBe(0);
    });

    it('should skip tasks without signalPath', () => {
      const task = createTask({ trigger: {} as any });
      watcher.registerTask(task);
      expect(watcher.getWatchedSignalCount()).toBe(0);
    });

    it('should share watcher for tasks with same signal path', () => {
      const signalPath = path.join(tmpDir, '.trigger');
      const task1 = createTask({ id: 'task-1', trigger: { signalPath } });
      const task2 = createTask({ id: 'task-2', trigger: { signalPath } });

      watcher.registerTask(task1);
      watcher.registerTask(task2);

      expect(watcher.getWatchedSignalCount()).toBe(1);
    });

    it('should handle re-registration of the same task', () => {
      const signalPath = path.join(tmpDir, '.trigger');
      const task = createTask({ trigger: { signalPath } });

      watcher.registerTask(task);
      watcher.registerTask(task);

      expect(watcher.getWatchedSignalCount()).toBe(1);
    });
  });

  describe('unregisterTask', () => {
    it('should unregister a task', () => {
      const signalPath = path.join(tmpDir, '.trigger');
      const task = createTask({ id: 'task-1', trigger: { signalPath } });

      watcher.registerTask(task);
      expect(watcher.getWatchedSignalCount()).toBe(1);

      watcher.unregisterTask('task-1');
      expect(watcher.getWatchedSignalCount()).toBe(0);
    });

    it('should not remove signal if other tasks still use it', () => {
      const signalPath = path.join(tmpDir, '.trigger');
      const task1 = createTask({ id: 'task-1', trigger: { signalPath } });
      const task2 = createTask({ id: 'task-2', trigger: { signalPath } });

      watcher.registerTask(task1);
      watcher.registerTask(task2);

      watcher.unregisterTask('task-1');
      expect(watcher.getWatchedSignalCount()).toBe(1);
    });

    it('should handle unregistering unknown task', () => {
      expect(() => watcher.unregisterTask('unknown')).not.toThrow();
    });
  });

  describe('start / stop', () => {
    it('should start and stop the watcher', async () => {
      const signalPath = path.join(tmpDir, '.trigger');
      const task = createTask({ trigger: { signalPath } });
      watcher.registerTask(task);

      await watcher.start();
      expect(watcher.isRunning()).toBe(true);
      expect(watcher.getWatcherCount()).toBe(1);

      watcher.stop();
      expect(watcher.isRunning()).toBe(false);
      expect(watcher.getWatcherCount()).toBe(0);
    });

    it('should not start if already running', async () => {
      const signalPath = path.join(tmpDir, '.trigger');
      const task = createTask({ trigger: { signalPath } });
      watcher.registerTask(task);

      await watcher.start();
      await watcher.start(); // second start

      expect(watcher.getWatcherCount()).toBe(1);
    });

    it('should handle stop when not running', () => {
      expect(() => watcher.stop()).not.toThrow();
    });

    it('should watch directories registered after start', async () => {
      const dir1 = path.join(tmpDir, 'dir1');
      const signalPath1 = path.join(dir1, '.trigger');
      const task1 = createTask({ id: 'task-1', trigger: { signalPath: signalPath1 } });

      watcher.registerTask(task1);
      await watcher.start();
      expect(watcher.getWatcherCount()).toBe(1);

      // Register a task with a new directory after start
      const dir2 = path.join(tmpDir, 'dir2');
      const signalPath2 = path.join(dir2, '.trigger');
      const task2 = createTask({ id: 'task-2', trigger: { signalPath: signalPath2 } });

      watcher.registerTask(task2);

      // Wait for async directory creation and watcher setup
      await vi.waitFor(() => {
        expect(watcher.getWatcherCount()).toBe(2);
      }, { timeout: 2000 });
    });
  });

  describe('signal detection', () => {
    it('should trigger task when signal file appears', async () => {
      const signalPath = path.join(tmpDir, '.trigger');
      const task = createTask({ trigger: { signalPath, debounce: 100 } });

      watcher.registerTask(task);
      await watcher.start();

      // Create signal file
      await fsPromises.writeFile(signalPath, '', 'utf-8');

      // Wait for debounce + processing
      await vi.waitFor(() => {
        expect(onTrigger).toHaveBeenCalledWith(
          expect.objectContaining({ id: 'task-1' })
        );
      }, { timeout: 3000 });

      // Signal file should be consumed (deleted)
      await expect(fsPromises.access(signalPath)).rejects.toThrow();
    });

    it('should trigger multiple tasks sharing the same signal', async () => {
      const signalPath = path.join(tmpDir, '.trigger');
      const task1 = createTask({ id: 'task-1', trigger: { signalPath, debounce: 100 } });
      const task2 = createTask({ id: 'task-2', trigger: { signalPath, debounce: 100 } });

      watcher.registerTask(task1);
      watcher.registerTask(task2);
      await watcher.start();

      // Create signal file
      await fsPromises.writeFile(signalPath, '', 'utf-8');

      // Wait for debounce + processing
      await vi.waitFor(() => {
        expect(onTrigger).toHaveBeenCalledTimes(2);
      }, { timeout: 3000 });
    });

    it('should not trigger disabled tasks', async () => {
      const signalPath = path.join(tmpDir, '.trigger');
      const task = createTask({ enabled: false, trigger: { signalPath, debounce: 100 } });

      watcher.registerTask(task);
      await watcher.start();

      // Create signal file
      await fsPromises.writeFile(signalPath, '', 'utf-8');

      // Wait for debounce period
      await new Promise(resolve => setTimeout(resolve, 500));

      expect(onTrigger).not.toHaveBeenCalled();
    });

    it('should debounce multiple signal files', async () => {
      const signalPath = path.join(tmpDir, '.trigger');
      const task = createTask({ trigger: { signalPath, debounce: 300 } });

      watcher.registerTask(task);
      await watcher.start();

      // Create signal file multiple times rapidly
      await fsPromises.writeFile(signalPath, '', 'utf-8');
      await new Promise(resolve => setTimeout(resolve, 50));
      await fsPromises.writeFile(signalPath, '', 'utf-8');
      await new Promise(resolve => setTimeout(resolve, 50));
      await fsPromises.writeFile(signalPath, '', 'utf-8');

      // Wait for all triggers to settle
      await new Promise(resolve => setTimeout(resolve, 1000));

      // Should only be triggered once (debounced)
      expect(onTrigger).toHaveBeenCalledTimes(1);
    });

    it('should ignore files that do not match any signal path', async () => {
      const signalPath = path.join(tmpDir, '.trigger');
      const task = createTask({ trigger: { signalPath, debounce: 100 } });

      watcher.registerTask(task);
      await watcher.start();

      // Create unrelated file
      await fsPromises.writeFile(path.join(tmpDir, 'other-file.txt'), '', 'utf-8');

      await new Promise(resolve => setTimeout(resolve, 500));

      expect(onTrigger).not.toHaveBeenCalled();
    });
  });

  describe('lifecycle', () => {
    it('should clean up watchers on stop', async () => {
      const signalPath = path.join(tmpDir, '.trigger');
      const task = createTask({ trigger: { signalPath } });

      watcher.registerTask(task);
      await watcher.start();
      expect(watcher.getWatcherCount()).toBe(1);

      watcher.stop();
      expect(watcher.getWatcherCount()).toBe(0);
      expect(watcher.isRunning()).toBe(false);
    });

    it('should not trigger after stop', async () => {
      const signalPath = path.join(tmpDir, '.trigger');
      const task = createTask({ trigger: { signalPath, debounce: 100 } });

      watcher.registerTask(task);
      await watcher.start();

      watcher.stop();

      // Create signal file after stop
      await fsPromises.writeFile(signalPath, '', 'utf-8');
      await new Promise(resolve => setTimeout(resolve, 500));

      expect(onTrigger).not.toHaveBeenCalled();
    });
  });
});
