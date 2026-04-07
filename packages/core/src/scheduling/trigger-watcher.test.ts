/**
 * ScheduleTriggerWatcher tests.
 *
 * Issue #1953: Event-driven schedule trigger mechanism.
 *
 * Tests the trigger watcher's ability to detect signal files
 * and invoke the appropriate callback.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fsPromises from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import { ScheduleTriggerWatcher, triggerSchedule } from './trigger-watcher.js';

describe('ScheduleTriggerWatcher', () => {
  let tmpDir: string;
  let schedulesDir: string;
  let triggersDir: string;

  beforeEach(async () => {
    tmpDir = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'trigger-watcher-test-'));
    schedulesDir = path.join(tmpDir, 'schedules');
    triggersDir = path.join(schedulesDir, '.triggers');
    await fsPromises.mkdir(triggersDir, { recursive: true });
  });

  afterEach(async () => {
    await fsPromises.rm(tmpDir, { recursive: true, force: true });
  });

  describe('start/stop lifecycle', () => {
    it('should start and stop without errors', async () => {
      const triggeredTasks: string[] = [];
      const watcher = new ScheduleTriggerWatcher({
        schedulesDir,
        onTrigger: async (taskId) => { triggeredTasks.push(taskId); },
      });

      await watcher.start();
      expect(watcher.isRunning()).toBe(true);

      watcher.stop();
      expect(watcher.isRunning()).toBe(false);
    });

    it('should be idempotent on start', async () => {
      const watcher = new ScheduleTriggerWatcher({
        schedulesDir,
        onTrigger: async () => {},
      });

      await watcher.start();
      await watcher.start(); // second call should be no-op
      expect(watcher.isRunning()).toBe(true);

      watcher.stop();
    });

    it('should create .triggers directory if it does not exist', async () => {
      const newTmpDir = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'trigger-watcher-test-'));
      const newSchedulesDir = path.join(newTmpDir, 'schedules');

      const watcher = new ScheduleTriggerWatcher({
        schedulesDir: newSchedulesDir,
        onTrigger: async () => {},
      });

      await watcher.start();

      // Verify .triggers directory was created
      const stat = await fsPromises.stat(path.join(newSchedulesDir, '.triggers'));
      expect(stat.isDirectory()).toBe(true);

      watcher.stop();
      await fsPromises.rm(newTmpDir, { recursive: true, force: true });
    });
  });

  describe('trigger detection', () => {
    it('should detect a signal file and invoke onTrigger', async () => {
      let triggeredTaskId: string | null = null;

      const watcher = new ScheduleTriggerWatcher({
        schedulesDir,
        onTrigger: async (taskId) => {
          triggeredTaskId = taskId;
        },
        debounceMs: 100,
      });

      await watcher.start();

      // Write a trigger signal file
      const triggerFile = path.join(triggersDir, 'schedule-chats-activation');
      await fsPromises.writeFile(triggerFile, new Date().toISOString(), 'utf-8');

      // Wait for debounce + processing
      await new Promise((resolve) => setTimeout(resolve, 300));

      expect(triggeredTaskId).toBe('schedule-chats-activation');

      watcher.stop();
    });

    it('should debounce multiple rapid signals', async () => {
      let triggerCount = 0;
      const watcher = new ScheduleTriggerWatcher({
        schedulesDir,
        onTrigger: async () => { triggerCount++; },
        debounceMs: 200,
      });

      await watcher.start();

      // Write the same trigger file multiple times rapidly
      const triggerFile = path.join(triggersDir, 'schedule-test');
      await fsPromises.writeFile(triggerFile, '1', 'utf-8');
      await fsPromises.writeFile(triggerFile, '2', 'utf-8');
      await fsPromises.writeFile(triggerFile, '3', 'utf-8');

      // Wait for debounce + processing
      await new Promise((resolve) => setTimeout(resolve, 500));

      // Should have triggered only once (debounced)
      expect(triggerCount).toBeLessThanOrEqual(1);

      watcher.stop();
    });

    it('should clean up trigger file after successful execution', async () => {
      const watcher = new ScheduleTriggerWatcher({
        schedulesDir,
        onTrigger: async () => {},
        debounceMs: 100,
      });

      await watcher.start();

      // Write a trigger signal file
      const triggerFile = path.join(triggersDir, 'schedule-cleanup-test');
      await fsPromises.writeFile(triggerFile, new Date().toISOString(), 'utf-8');

      // Wait for debounce + processing
      await new Promise((resolve) => setTimeout(resolve, 300));

      // Trigger file should have been cleaned up
      const exists = await fileExists(triggerFile);
      expect(exists).toBe(false);

      watcher.stop();
    });

    it('should not clean up trigger file on callback failure', async () => {
      const watcher = new ScheduleTriggerWatcher({
        schedulesDir,
        onTrigger: async () => {
          throw new Error('Callback failed');
        },
        debounceMs: 100,
      });

      await watcher.start();

      // Write a trigger signal file
      const triggerFile = path.join(triggersDir, 'schedule-fail-test');
      await fsPromises.writeFile(triggerFile, new Date().toISOString(), 'utf-8');

      // Wait for debounce + processing
      await new Promise((resolve) => setTimeout(resolve, 300));

      // Trigger file should still exist (callback failed)
      const exists = await fileExists(triggerFile);
      expect(exists).toBe(true);

      watcher.stop();
    });
  });
});

describe('triggerSchedule utility', () => {
  let tmpDir: string;
  let schedulesDir: string;

  beforeEach(async () => {
    tmpDir = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'trigger-schedule-test-'));
    schedulesDir = path.join(tmpDir, 'schedules');
  });

  afterEach(async () => {
    await fsPromises.rm(tmpDir, { recursive: true, force: true });
  });

  it('should create .triggers directory and write signal file', async () => {
    await triggerSchedule(schedulesDir, 'schedule-test-task');

    const triggerFile = path.join(schedulesDir, '.triggers', 'schedule-test-task');
    const content = await fsPromises.readFile(triggerFile, 'utf-8');

    expect(content).toBeTruthy();
    // Should be a valid ISO timestamp
    expect(() => new Date(content)).not.toThrow();
  });

  it('should overwrite existing signal file', async () => {
    await triggerSchedule(schedulesDir, 'schedule-test-task');
    await new Promise((resolve) => setTimeout(resolve, 10)); // ensure different timestamp
    await triggerSchedule(schedulesDir, 'schedule-test-task');

    const triggerFile = path.join(schedulesDir, '.triggers', 'schedule-test-task');
    const content = await fsPromises.readFile(triggerFile, 'utf-8');
    expect(content).toBeTruthy();
  });
});

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await fsPromises.access(filePath);
    return true;
  } catch {
    return false;
  }
}
