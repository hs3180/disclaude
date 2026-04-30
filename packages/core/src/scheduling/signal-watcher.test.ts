/**
 * Tests for SignalWatcher (Issue #1953: event-driven schedule trigger).
 *
 * Tests signal file detection, task registration, debounce behavior,
 * and the createSignalFile helper utility.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { SignalWatcher, createSignalFile, type OnTriggerSchedule } from './signal-watcher.js';
import type { ScheduledTask } from './scheduled-task.js';
import * as fsPromises from 'fs/promises';
import * as path from 'path';
import * as os from 'os';

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

// ============================================================================
// SignalWatcher Tests
// ============================================================================

describe('SignalWatcher', () => {
  let onTrigger: OnTriggerSchedule;
  let watcher: SignalWatcher;
  let tmpDir: string;

  beforeEach(async () => {
    onTrigger = vi.fn().mockResolvedValue(true);
    watcher = new SignalWatcher({ onTrigger });
    tmpDir = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'signal-test-'));
  });

  afterEach(async () => {
    watcher.stop();
    await fsPromises.rm(tmpDir, { recursive: true, force: true });
  });

  describe('registerTask', () => {
    it('should register a task with watchPath', () => {
      const task = createTask({
        id: 'signal-task',
        watchPath: '/tmp/test-watches',
      });

      watcher.registerTask(task);

      const entries = watcher.getWatchEntries();
      expect(entries).toHaveLength(1);
      expect(entries[0].taskIds).toContain('signal-task');
      expect(entries[0].signalFile).toBe('.trigger');
    });

    it('should use custom signalFile when specified', () => {
      const task = createTask({
        id: 'custom-signal',
        watchPath: '/tmp/test-watches',
        signalFile: '.run',
      });

      watcher.registerTask(task);

      const entries = watcher.getWatchEntries();
      expect(entries).toHaveLength(1);
      expect(entries[0].signalFile).toBe('.run');
    });

    it('should skip tasks without watchPath', () => {
      const task = createTask({ id: 'no-watch' });
      watcher.registerTask(task);

      expect(watcher.getWatchEntries()).toHaveLength(0);
    });

    it('should group tasks watching the same path', () => {
      const task1 = createTask({ id: 'task-a', watchPath: '/tmp/shared' });
      const task2 = createTask({ id: 'task-b', watchPath: '/tmp/shared' });

      watcher.registerTask(task1);
      watcher.registerTask(task2);

      const entries = watcher.getWatchEntries();
      expect(entries).toHaveLength(1);
      expect(entries[0].taskIds).toContain('task-a');
      expect(entries[0].taskIds).toContain('task-b');
    });

    it('should not duplicate task IDs', () => {
      const task = createTask({ id: 'dup-task', watchPath: '/tmp/test' });
      watcher.registerTask(task);
      watcher.registerTask(task); // Register again

      const entries = watcher.getWatchEntries();
      expect(entries[0].taskIds).toEqual(['dup-task']);
    });

    it('should create separate entries for different signal files on same path', () => {
      const task1 = createTask({ id: 'task-x', watchPath: '/tmp/test', signalFile: '.trigger-a' });
      const task2 = createTask({ id: 'task-y', watchPath: '/tmp/test', signalFile: '.trigger-b' });

      watcher.registerTask(task1);
      watcher.registerTask(task2);

      const entries = watcher.getWatchEntries();
      expect(entries).toHaveLength(2);
    });
  });

  describe('unregisterTask', () => {
    it('should remove a task from watch entries', () => {
      const task = createTask({ id: 'remove-me', watchPath: '/tmp/test' });
      watcher.registerTask(task);
      expect(watcher.getWatchEntries()).toHaveLength(1);

      watcher.unregisterTask('remove-me');
      expect(watcher.getWatchEntries()).toHaveLength(0);
    });

    it('should keep entry if other tasks still watch the path', () => {
      const task1 = createTask({ id: 'keep-me', watchPath: '/tmp/test' });
      const task2 = createTask({ id: 'remove-me', watchPath: '/tmp/test' });
      watcher.registerTask(task1);
      watcher.registerTask(task2);

      watcher.unregisterTask('remove-me');

      const entries = watcher.getWatchEntries();
      expect(entries).toHaveLength(1);
      expect(entries[0].taskIds).toEqual(['keep-me']);
    });

    it('should handle non-existent task gracefully', () => {
      expect(() => watcher.unregisterTask('non-existent')).not.toThrow();
    });
  });

  describe('start / stop', () => {
    it('should start and stop watching', async () => {
      const watchDir = path.join(tmpDir, 'watch-dir');
      const task = createTask({ id: 'watch-1', watchPath: watchDir });
      watcher.registerTask(task);

      await watcher.start();
      expect(watcher.isRunning()).toBe(true);

      watcher.stop();
      expect(watcher.isRunning()).toBe(false);
    });

    it('should not start if already running', async () => {
      const watchDir = path.join(tmpDir, 'watch-dir');
      const task = createTask({ id: 'watch-1', watchPath: watchDir });
      watcher.registerTask(task);

      await watcher.start();
      await watcher.start(); // Second start — should be no-op

      // Should have only one watcher
      const entries = watcher.getWatchEntries();
      expect(entries[0].watcher).toBeDefined();
      watcher.stop();
    });

    it('should handle stop when not running', () => {
      expect(() => watcher.stop()).not.toThrow();
    });

    it('should handle start with no registered tasks', async () => {
      await watcher.start();
      expect(watcher.isRunning()).toBe(true);
      watcher.stop();
    });
  });

  describe('signal file detection', () => {
    it('should trigger schedule when signal file is created', async () => {
      const watchDir = path.join(tmpDir, 'signal-test');
      const task = createTask({ id: 'signal-1', watchPath: watchDir });
      watcher.registerTask(task);

      await watcher.start();

      // Create signal file
      await createSignalFile(watchDir);

      // Wait for debounce and processing
      await vi.waitFor(() => {
        expect(onTrigger).toHaveBeenCalledWith('signal-1');
      }, { timeout: 3000 });

      // Signal file should be consumed
      const signalPath = path.join(watchDir, '.trigger');
      await expect(fsPromises.access(signalPath)).rejects.toThrow();

      watcher.stop();
    });

    it('should trigger multiple schedules watching same path', async () => {
      const watchDir = path.join(tmpDir, 'multi-signal');
      const task1 = createTask({ id: 'multi-a', watchPath: watchDir });
      const task2 = createTask({ id: 'multi-b', watchPath: watchDir });

      watcher.registerTask(task1);
      watcher.registerTask(task2);
      await watcher.start();

      await createSignalFile(watchDir);

      await vi.waitFor(() => {
        expect(onTrigger).toHaveBeenCalledTimes(2);
      }, { timeout: 3000 });

      expect(onTrigger).toHaveBeenCalledWith('multi-a');
      expect(onTrigger).toHaveBeenCalledWith('multi-b');

      watcher.stop();
    });

    it('should ignore files that are not the signal file', async () => {
      const watchDir = path.join(tmpDir, 'ignore-test');
      const task = createTask({ id: 'ignore-1', watchPath: watchDir, signalFile: '.trigger' });
      watcher.registerTask(task);

      await watcher.start();

      // Create a non-signal file
      await fsPromises.writeFile(path.join(watchDir, 'other-file.txt'), 'data');

      // Wait a bit to ensure no trigger
      await new Promise(resolve => setTimeout(resolve, 1000));
      expect(onTrigger).not.toHaveBeenCalled();

      watcher.stop();
    });

    it('should handle custom signal filename', async () => {
      const watchDir = path.join(tmpDir, 'custom-signal');
      const task = createTask({
        id: 'custom-1',
        watchPath: watchDir,
        signalFile: '.run',
      });
      watcher.registerTask(task);

      await watcher.start();

      // Create custom signal file
      await createSignalFile(watchDir, '.run');

      await vi.waitFor(() => {
        expect(onTrigger).toHaveBeenCalledWith('custom-1');
      }, { timeout: 3000 });

      // Signal file should be consumed
      await expect(fsPromises.access(path.join(watchDir, '.run'))).rejects.toThrow();

      watcher.stop();
    });
  });

  describe('lifecycle', () => {
    it('should clean up watchers on stop', async () => {
      const watchDir = path.join(tmpDir, 'lifecycle');
      const task = createTask({ id: 'lc-1', watchPath: watchDir });
      watcher.registerTask(task);

      await watcher.start();
      const entries = watcher.getWatchEntries();
      expect(entries[0].watcher).not.toBeNull();

      watcher.stop();
      // After stop, watcher should be null
      expect(entries[0].watcher).toBeNull();
    });

    it('should handle registering tasks after start', async () => {
      const watchDir = path.join(tmpDir, 'dynamic');
      await watcher.start();

      const task = createTask({ id: 'dynamic-1', watchPath: watchDir });
      watcher.registerTask(task);

      // The watcher entry should exist but watcher should be null (not auto-started)
      const entries = watcher.getWatchEntries();
      expect(entries).toHaveLength(1);

      watcher.stop();
    });
  });
});

// ============================================================================
// createSignalFile Tests
// ============================================================================

describe('createSignalFile', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'signal-create-'));
  });

  afterEach(async () => {
    await fsPromises.rm(tmpDir, { recursive: true, force: true });
  });

  it('should create a .trigger signal file', async () => {
    await createSignalFile(tmpDir);

    const signalPath = path.join(tmpDir, '.trigger');
    const content = await fsPromises.readFile(signalPath, 'utf-8');
    expect(content).toBe('');
  });

  it('should create a custom signal file', async () => {
    await createSignalFile(tmpDir, '.custom-signal');

    const signalPath = path.join(tmpDir, '.custom-signal');
    const exists = await fsPromises.access(signalPath).then(() => true).catch(() => false);
    expect(exists).toBe(true);
  });

  it('should create directory if it does not exist', async () => {
    const newDir = path.join(tmpDir, 'nested', 'dir');
    await createSignalFile(newDir);

    const signalPath = path.join(newDir, '.trigger');
    const exists = await fsPromises.access(signalPath).then(() => true).catch(() => false);
    expect(exists).toBe(true);
  });
});
